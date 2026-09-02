import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpServer } from '../src/mcp/server.js';
import { initProject } from '../src/runtime/init.js';
import { saveContext } from '../src/agent/api.js';
import { compileContext } from '../src/compiler/compile.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { runtimeStatus, stopRuntime, enableRuntime } from '../src/cognition/runtime.js';

const cli = path.resolve('dist/src/cli/main.js');

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-mcp-'));
}

interface OrientPayload {
  status: 'ready' | 'no_context';
  context: { title: string } | null;
}

function orientPayload(result: CallToolResult): OrientPayload {
  return result.structuredContent as OrientPayload;
}

function textContent(result: CallToolResult): string {
  const content = result.content[0];
  assert.equal(content.type, 'text');
  return content.text;
}

async function connectInMemory() {
  const server = createMcpServer();
  const client = new Client({ name: 'context-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('MCP context_orient exposes bounded orientation and keeps serving after tool errors', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    const saved = await saveContext(root, {
      title: 'Applicant authentication',
      progressSummary: 'Reuse the existing authentication workflow',
    });
    assert.equal(saved.result.status, 'saved');

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      'context_orient',
      'context_expand',
      'context_compile',
      'context_resume',
      'context_note_list',
      'context_note_add',
      'context_usage_report',
      'skill_list',
      'skill_inspect',
      'skill_materialize',
      'skill_transition',
      'skill_record_invocation',
      'skill_record_outcome',
      'context_checkpoint',
    ]);

    const ready = await client.callTool({ name: 'context_orient', arguments: { path: root, query: 'authentication' } });
    assert.notEqual(ready.isError, true);
    assert.equal(orientPayload(ready).status, 'ready');
    assert.equal(orientPayload(ready).context?.title, 'Applicant authentication');
    assert.equal((JSON.parse(textContent(ready)) as OrientPayload).status, 'ready');

    const blank = await client.callTool({ name: 'context_orient', arguments: { path: root, query: '   ' } });
    assert.equal(blank.isError, true);
    assert.match(textContent(blank), /context orient query/);

    const noQuery = await client.callTool({ name: 'context_orient', arguments: { path: root } });
    assert.notEqual(noQuery.isError, true);
    assert.equal(orientPayload(noQuery).status, 'ready');
  } finally {
    await Promise.all([client.close(), server.close(), rm(root, { recursive: true, force: true })]);
  }
});


test('MCP Skill tools expose bounded reads and preserve server availability', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    await importV1(root);
    await enableRuntime(root);
    const journalPath = path.join(root, '.context', 'v2', 'journal', '00000001.ndjson');
    let before = '';
    try { before = await readFile(journalPath, 'utf8'); } catch { before = ''; }
    const listed = await client.callTool({ name: 'skill_list', arguments: { path: root } });
    assert.notEqual(listed.isError, true);
    assert.deepEqual(listed.structuredContent, { result: [] });
    assert.equal(await readFile(journalPath, 'utf8').catch(() => ''), before);
    const missing = await client.callTool({ name: 'skill_inspect', arguments: { path: root, skillId: 'missing' } });
    assert.equal(missing.isError, true);
    assert.match(textContent(missing), /skill not found/);
    const invalid = await client.callTool({ name: 'skill_record_outcome', arguments: { path: root, skillId: 'missing', invocationId: 'i', outcomeId: 'o', callerEventId: 'c', outcome: 'invalid', summary: 'Nope' } });
    assert.equal(invalid.isError, true);
    assert.notEqual((await client.callTool({ name: 'skill_list', arguments: { path: root } })).isError, true);
  } finally {
    await Promise.all([client.close(), server.close(), rm(root, { recursive: true, force: true })]);
  }
});


test('MCP context_usage_report returns structured read-only metrics', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    const before = await readdir(path.join(root, '.context'));
    const journalPath = path.join(root, '.context', 'v2', 'journal', '00000001.ndjson');
    let beforeJournal = '';
    try { beforeJournal = await readFile(journalPath, 'utf8'); } catch { beforeJournal = ''; }
    const report = await client.callTool({
      name: 'context_usage_report',
      arguments: { path: root, days: 7, granularity: 'day', baselineTokens: 100, baselineSource: 'manual' },
    });
    assert.notEqual(report.isError, true);
    const structured = report.structuredContent as { schemaVersion: number; payback: { baselineTokens: number; baselineSource: string } };
    assert.equal(structured.schemaVersion, 1);
    assert.equal(structured.payback.baselineTokens, 100);
    assert.equal(structured.payback.baselineSource, 'manual');
    assert.deepEqual(JSON.parse(textContent(report)), structured);
    assert.deepEqual(await readdir(path.join(root, '.context')), before);
    assert.equal(await readFile(journalPath, 'utf8').catch(() => ''), beforeJournal);
  } finally {
    await Promise.all([client.close(), server.close(), rm(root, { recursive: true, force: true })]);
  }
});

test('MCP context expansion preserves bounded read and write contracts', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    const saved = await saveContext(root, {
      title: 'MCP expansion',
      progressSummary: 'Keep MCP expansion bounded and read-only',
    });
    assert.equal(saved.result.status, 'saved');
    if (saved.result.status !== 'saved') return;

    const manifest = await compileContext(root, {
      contextId: saved.result.context.id,
      query: 'MCP expansion',
      maxChars: 4000,
    });
    const candidate = manifest.selected.find(
      (item) => (item.content as { field?: unknown }).field === 'progressSummary',
    );
    assert.ok(candidate);
    if (!candidate) return;

    const expanded = await client.callTool({
      name: 'context_expand',
      arguments: {
        path: root,
        manifestHash: manifest.identity.manifestHash,
        candidateId: candidate.candidateId,
        level: 'structured',
        compile: {
          contextId: saved.result.context.id,
          query: 'MCP expansion',
          maxChars: 4000,
        },
      },
    });
    assert.notEqual(expanded.isError, true);
    assert.equal((expanded.structuredContent as { status: string }).status, 'complete');
    assert.equal((JSON.parse(textContent(expanded)) as { status: string }).status, 'complete');

    const partial = await client.callTool({
      name: 'context_expand',
      arguments: {
        path: root,
        manifestHash: manifest.identity.manifestHash,
        itemHash: candidate.itemHash,
        level: 'evidence',
        maxChars: 5,
        compile: {
          contextId: saved.result.context.id,
          query: 'MCP expansion',
          maxChars: 4000,
        },
      },
    });
    assert.notEqual(partial.isError, true);
    assert.equal((partial.structuredContent as { status: string; content: unknown }).status, 'partial');
    assert.equal((partial.structuredContent as { content: unknown }).content, null);

    const invalid = await client.callTool({
      name: 'context_expand',
      arguments: {
        path: root,
        manifestHash: 'stale',
        candidateId: candidate.candidateId,
        level: 'structured',
        compile: {
          contextId: saved.result.context.id,
          query: 'MCP expansion',
          maxChars: 4000,
        },
      },
    });
    assert.equal(invalid.isError, true);
    assert.match(textContent(invalid), /manifest hash mismatch/);

    const orient = await client.callTool({ name: 'context_orient', arguments: { path: root } });
    assert.notEqual(orient.isError, true);
  } finally {
    await Promise.all([client.close(), server.close(), rm(root, { recursive: true, force: true })]);
  }
});

test('MCP compile, resume, notes, and checkpoint preserve their read and write contracts', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    const checkpoint = await client.callTool({
      name: 'context_checkpoint',
      arguments: { path: root, title: 'MCP lifecycle', progressSummary: 'Save context through MCP' },
    });
    assert.notEqual(checkpoint.isError, true);
    const saved = checkpoint.structuredContent as { projectRoot: string; result: { status: string; context: { id: string }; snapshot: { snapshotId: string } } };
    assert.equal(saved.projectRoot, root);
    assert.equal(saved.result.status, 'saved');

    const compiled = await client.callTool({
      name: 'context_compile',
      arguments: { path: root, contextId: saved.result.context.id, query: 'lifecycle', maxChars: 4000 },
    });
    assert.notEqual(compiled.isError, true);
    const manifest = compiled.structuredContent as { status: string; identity: { manifestHash: string } };
    assert.equal(manifest.status, 'ready');
    assert.ok(manifest.identity.manifestHash);
    assert.deepEqual(JSON.parse(textContent(compiled)), manifest);

    const resumed = await client.callTool({
      name: 'context_resume',
      arguments: { path: root, contextId: saved.result.context.id, includeDetails: true, maxChars: 4000 },
    });
    assert.notEqual(resumed.isError, true);
    const loaded = resumed.structuredContent as { snapshot: { snapshotId: string }; details?: { progressSummary: string } };
    assert.equal(loaded.snapshot.snapshotId, saved.result.snapshot.snapshotId);
    assert.equal(loaded.details?.progressSummary, 'Save context through MCP');

    const added = await client.callTool({
      name: 'context_note_add',
      arguments: {
        path: root,
        message: 'Capture one explicit observation',
        kind: 'observation',
        actor: 'agent',
        contextId: saved.result.context.id,
        relatedFiles: ['src/mcp/server.ts', '../unsafe.ts'],
      },
    });
    assert.notEqual(added.isError, true);
    const note = added.structuredContent as { contextId: string; relatedFiles: string[] };
    assert.equal(note.contextId, saved.result.context.id);
    assert.deepEqual(note.relatedFiles, ['src/mcp/server.ts']);

    const notes = await client.callTool({
      name: 'context_note_list',
      arguments: { path: root, contextId: saved.result.context.id, openOnly: true, limit: 1, maxChars: 4000 },
    });
    assert.notEqual(notes.isError, true);
    assert.equal((notes.structuredContent as { notes: Array<{ message: string }> }).notes[0].message, 'Capture one explicit observation');

    const unchanged = await client.callTool({
      name: 'context_checkpoint',
      arguments: { path: root, contextId: saved.result.context.id },
    });
    assert.notEqual(unchanged.isError, true);
    assert.equal((unchanged.structuredContent as { result: { status: string } }).result.status, 'no_change');

    const invalid = await client.callTool({ name: 'context_note_add', arguments: { path: root, message: '   ' } });
    assert.equal(invalid.isError, true);
    assert.match(textContent(invalid), /note message must not be empty/);
    assert.notEqual((await client.callTool({ name: 'context_orient', arguments: { path: root } })).isError, true);

    const invalidSchema = await client.callTool({ name: 'context_compile', arguments: { path: root, maxChars: -1 } });
    assert.equal(invalidSchema.isError, true);
  } finally {
    await Promise.all([client.close(), server.close(), rm(root, { recursive: true, force: true })]);
  }
});

test('MCP context_orient auto-starts a migrated project runtime and remains fail-open when stopped', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    await importV1(root);
    const result = await client.callTool({ name: 'context_orient', arguments: { path: root } });
    assert.notEqual(result.isError, true);
    assert.equal((await runtimeStatus(root)).running, true);
    await stopRuntime(root);
    assert.equal((await runtimeStatus(root)).running, false);
  } finally {
    await stopRuntime(root).catch(() => undefined);
    await Promise.all([client.close(), server.close(), rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  }
});

test('MCP context_orient returns no_context and rejects invalid numeric input', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    const noContext = await client.callTool({ name: 'context_orient', arguments: { path: root } });
    assert.notEqual(noContext.isError, true);
    assert.equal(orientPayload(noContext).status, 'no_context');

    const invalid = await client.callTool({ name: 'context_orient', arguments: { path: root, maxChars: -1 } });
    assert.equal(invalid.isError, true);
    assert.match(textContent(invalid), /Input validation error|Too small/);
  } finally {
    await Promise.all([client.close(), server.close(), rm(root, { recursive: true, force: true })]);
  }
});

test('ctx agent serve communicates over stdio without diagnostic output', async () => {
  const root = await project();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'agent', 'serve'],
    cwd: root,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'context-mcp-stdio-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await initProject(root);
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      'context_orient',
      'context_expand',
      'context_compile',
      'context_resume',
      'context_note_list',
      'context_note_add',
      'context_usage_report',
      'skill_list',
      'skill_inspect',
      'skill_materialize',
      'skill_transition',
      'skill_record_invocation',
      'skill_record_outcome',
      'context_checkpoint',
    ]);
    const result = await client.callTool({ name: 'context_orient', arguments: { path: root } });
    assert.notEqual(result.isError, true);
    assert.equal(orientPayload(result).status, 'no_context');
    assert.equal(stderr, '');
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
