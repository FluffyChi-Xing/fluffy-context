import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpServer } from '../src/mcp/server.js';
import { initProject } from '../src/runtime/init.js';
import { saveContext } from '../src/agent/api.js';
import { compileContext } from '../src/compiler/compile.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { runtimeStatus, stopRuntime } from '../src/cognition/runtime.js';

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
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['context_orient', 'context_expand']);

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

test('MCP context_expand returns structured and partial results and keeps serving after errors', async () => {
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
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['context_orient', 'context_expand']);
    const result = await client.callTool({ name: 'context_orient', arguments: { path: root } });
    assert.notEqual(result.isError, true);
    assert.equal(orientPayload(result).status, 'no_context');
    assert.equal(stderr, '');
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
