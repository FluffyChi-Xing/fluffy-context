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
import { appendEvent, readJournal } from '../src/cognition/journal.js';
import { acceptEvolutionCandidate, proposeEvolution } from '../src/cognition/evolution.js';
import { materializeRecipe, transitionRecipe } from '../src/cognition/recipes.js';
import { runtimeStatus, stopRuntime, enableRuntime } from '../src/cognition/runtime.js';
import { learnKnowledge, listKnowledge } from '../src/runtime/knowledge.js';

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

test('MCP continuity checkpoint to inject to expand works with returned arguments unchanged', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    const saved = await client.callTool({ name: 'context_checkpoint', arguments: { path: root,
      objective: 'Payment MCP handoff', constraints: ['Keep the public contract'],
      validationRefs: ['test/payments.ts; recorded validation'], openQuestions: ['Production retest pending'] } });
    assert.notEqual(saved.isError, true);
    const injected = await client.callTool({ name: 'context_inject', arguments: { path: root, scenario: 'handoff', maxReferenceChars: 16000 } });
    assert.notEqual(injected.isError, true);
    const packet = injected.structuredContent as { text: string; expandRefs: Record<string, unknown>[] };
    assert.match(packet.text, /Keep the public contract/);
    assert.ok(packet.expandRefs.length);
    const expanded = await client.callTool({ name: 'context_expand', arguments: packet.expandRefs[0] });
    assert.notEqual(expanded.isError, true);
    assert.match(textContent(expanded), /Payment MCP handoff/);
  } finally {
    await client.close(); await server.close(); await stopRuntime(root);
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP empty import leads to direct candidate recording without an import file', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    const empty = await client.callTool({ name: 'context_import', arguments: { path: root } });
    assert.notEqual(empty.isError, true);
    assert.match(textContent(empty), /context_learn/);
    const learned = await client.callTool({ name: 'context_learn', arguments: {
      path: root, statement: 'Callbacks require a stable request identifier.', evidence: ['user .zcode memory; checked src/payments.ts'],
    } });
    assert.notEqual(learned.isError, true);
    assert.equal((await listKnowledge(root, true)).length, 1);
    assert.equal((await listKnowledge(root)).length, 0);
  } finally {
    await client.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});

test('MCP knowledge governance requires preview and evidence and exposes bounded reviews', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    const item = await learnKnowledge(root, 'Payment MCP governance invariant.');
    const review = await client.callTool({ name: 'context_knowledge_review', arguments: { path: root, maxChars: 1000 } });
    assert.notEqual(review.isError, true);
    assert.equal((review.structuredContent as { total: number }).total, 1);
    const args = { path: root, ids: [item.knowledgeId], action: 'verify', reason: 'Checked test', evidence: ['test/mcp.test.ts'] };
    const preview = await client.callTool({ name: 'context_knowledge_batch', arguments: args });
    assert.notEqual(preview.isError, true);
    assert.equal((await listKnowledge(root)).length, 0);
    const missingToken = await client.callTool({ name: 'context_knowledge_batch', arguments: { ...args, apply: true } });
    assert.equal(missingToken.isError, true);
    const applied = await client.callTool({ name: 'context_knowledge_batch', arguments: { ...args, apply: true, expectedToken: (preview.structuredContent as { token: string }).token } });
    assert.notEqual(applied.isError, true);
    assert.equal((await listKnowledge(root)).length, 1);
  } finally {
    await client.close(); await server.close(); await rm(root, { recursive: true, force: true });
  }
});

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
      'context_knowledge_review',
      'context_knowledge_batch',
      'context_inject',
      'context_import',
      'context_learn',
      'context_orient',
      'context_expand',
      'context_compile',
      'context_resume',
      'context_note_list',
      'context_note_add',
      'context_usage_report',
      'context_host_capabilities',
      'recipe_list',
      'recipe_inspect',
      'recipe_materialize',
      'recipe_transition',
      'skill_list',
      'skill_inspect',
      'skill_materialize',
      'skill_transition',
      'skill_record_invocation',
      'skill_record_outcome',
      'evolution_propose',
      'evolution_list',
      'evolution_inspect',
      'evolution_accept',
      'evolution_transition',
      'context_checkpoint',
    ]);
    const injected = await client.callTool({ name: 'context_inject', arguments: { path: root, query: 'authentication error', maxChars: 200 } });
    assert.notEqual(injected.isError, true);
    const injection = injected.structuredContent as { text: string; scenario: string };
    assert.equal(injection.scenario, 'debugging');
    assert.ok(injection.text.length <= 200);
    const imported = await client.callTool({ name: 'context_import', arguments: { path: root } });
    assert.notEqual(imported.isError, true);
    assert.equal((imported.structuredContent as { applied: boolean }).applied, false);

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


test('MCP Recipe tools enforce explicit lifecycle and read-only reads', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    await importV1(root);
    await enableRuntime(root);
    const saved = await saveContext(root, { title: 'MCP Recipe', progressSummary: 'Use bounded recipe controls' });
    assert.equal(saved.result.status, 'saved');
    if (saved.result.status !== 'saved') return;
    await appendEvent(root, { type: 'context.state.recorded', idempotencyKey: 'mcp-recipe-context', payload: { record: { snapshot: { contextId: saved.result.context.id, snapshotId: saved.result.snapshot.snapshotId } } } });
    await appendEvent(root, { type: 'git.state.observed', idempotencyKey: 'mcp-recipe-git', payload: {} });
    await appendEvent(root, { type: 'record.used', idempotencyKey: 'mcp-recipe-use', payload: { feedbackId: 'mcp-recipe-feedback', entity: 'knowledge', entityId: 'knowledge-1', outcome: 'used' } });
    const proposal = await proposeEvolution(root, { eventIds: (await readJournal(root)).slice(-3).map((event) => event.eventId), targetKind: 'compiler-recipe' });
    assert.ok(proposal.proposalId);
    await acceptEvolutionCandidate(root, { proposalId: proposal.proposalId!, rationale: 'Review MCP Recipe.' });

    const invalid = await client.callTool({ name: 'recipe_materialize', arguments: { path: root, proposalId: proposal.proposalId, title: 'Invalid', preferredSources: ['shell'] } });
    assert.equal(invalid.isError, true);
    const beforeReads = await readJournal(root);
    const empty = await client.callTool({ name: 'recipe_list', arguments: { path: root } });
    assert.notEqual(empty.isError, true);
    assert.deepEqual(empty.structuredContent, { result: [] });
    assert.deepEqual(await readJournal(root), beforeReads);

    const materialized = await client.callTool({ name: 'recipe_materialize', arguments: { path: root, proposalId: proposal.proposalId, title: 'MCP Recipe', preferredSources: ['context'], preferredSections: ['summary'], sectionBudgets: { summary: 1000 } } });
    assert.notEqual(materialized.isError, true);
    const recipeId = (materialized.structuredContent as { recipeId: string }).recipeId;
    const inspected = await client.callTool({ name: 'recipe_inspect', arguments: { path: root, recipeId } });
    assert.notEqual(inspected.isError, true);
    assert.equal((inspected.structuredContent as { status: string }).status, 'candidate');
    const verified = await client.callTool({ name: 'recipe_transition', arguments: { path: root, recipeId, to: 'verified', rationale: 'Verified MCP controls.' } });
    assert.notEqual(verified.isError, true);
    assert.equal((verified.structuredContent as { transitioned: boolean }).transitioned, true);
    const compiled = await client.callTool({ name: 'context_compile', arguments: { path: root, contextId: saved.result.context.id, recipeId, query: 'recipe controls', maxChars: 4000 } });
    assert.notEqual(compiled.isError, true);
    assert.equal((compiled.structuredContent as { recipe?: { recipeId: string } }).recipe?.recipeId, recipeId);
  } finally {
    await Promise.all([client.close(), server.close()]);
    await stopRuntime(root);
    await rm(root, { recursive: true, force: true });
  }
});
test('MCP Evolution tools preserve explicit governance and server availability', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    await importV1(root);
    await enableRuntime(root);
    await appendEvent(root, { type: 'context.state.recorded', idempotencyKey: 'mcp-evolution-context', payload: { record: { snapshot: { contextId: 'ctx-1', snapshotId: 'snap-1' } } } });
    await appendEvent(root, { type: 'git.state.observed', idempotencyKey: 'mcp-evolution-git', payload: {} });
    await appendEvent(root, { type: 'record.used', idempotencyKey: 'mcp-evolution-used', payload: { feedbackId: 'mcp-evolution-feedback', entity: 'knowledge', entityId: 'knowledge-1', outcome: 'used' } });
    const proposed = await client.callTool({ name: 'evolution_propose', arguments: { path: root, eventIds: (await readJournal(root)).slice(-3).map((event) => event.eventId), targetKind: 'skill' } });
    assert.notEqual(proposed.isError, true);
    const proposalId = (proposed.structuredContent as { proposalId: string }).proposalId;
    const beforeReads = await readJournal(root);
    const listed = await client.callTool({ name: 'evolution_list', arguments: { path: root } });
    assert.notEqual(listed.isError, true);
    assert.equal((listed.structuredContent as { result: unknown[] }).result.length, 1);
    const inspected = await client.callTool({ name: 'evolution_inspect', arguments: { path: root, proposalId } });
    assert.notEqual(inspected.isError, true);
    assert.equal((inspected.structuredContent as { status: string }).status, 'candidate');
    assert.deepEqual(await readJournal(root), beforeReads);
    const accepted = await client.callTool({ name: 'evolution_accept', arguments: { path: root, proposalId, rationale: 'Reviewed MCP evidence.' } });
    assert.notEqual(accepted.isError, true);
    const verified = await client.callTool({ name: 'evolution_transition', arguments: { path: root, proposalId, to: 'verified', rationale: 'Verified MCP proposal.' } });
    assert.notEqual(verified.isError, true);
    const invalid = await client.callTool({ name: 'evolution_transition', arguments: { path: root, proposalId, to: 'verified', rationale: '' } });
    assert.equal(invalid.isError, true);
    assert.notEqual((await client.callTool({ name: 'evolution_list', arguments: { path: root } })).isError, true);
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

test('MCP host capability inspection is read-only', async () => {
  const root = await project();
  const { client, server } = await connectInMemory();
  try {
    await initProject(root);
    const response = await client.callTool({ name: 'context_host_capabilities', arguments: { path: root } });
    assert.notEqual(response.isError, true);
    const report = response.structuredContent as { schemaVersion: number; capabilities: Array<{ interface: string }>; observations: { total: number } };
    assert.equal(report.schemaVersion, 1);
    assert.ok(report.capabilities.some((item) => item.interface === 'mcp'));
    assert.equal(report.observations.total, 0);
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
    for (const graphHops of [0, 1, 2] as const) {
      const graphManifest = await compileContext(root, { contextId: saved.result.context.id, graphHops, query: 'MCP expansion', maxChars: 4000 });
      const graphCandidate = graphManifest.selected.find((item) => (item.content as { field?: unknown }).field === 'progressSummary');
      assert.ok(graphCandidate);
      if (!graphCandidate) continue;
      const graphExpanded = await client.callTool({
        name: 'context_expand',
        arguments: { path: root, manifestHash: graphManifest.identity.manifestHash, candidateId: graphCandidate.candidateId, level: 'structured', compile: { contextId: saved.result.context.id, graphHops, query: 'MCP expansion', maxChars: 4000 } },
      });
      assert.notEqual(graphExpanded.isError, true);
      assert.equal((graphExpanded.structuredContent as { status: string }).status, 'complete');
    }

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
    for (const graphHops of [0, 1, 2] as const) {
      const graphCompiled = await client.callTool({
        name: 'context_compile',
        arguments: { path: root, contextId: saved.result.context.id, graphHops, query: 'lifecycle', maxChars: 4000 },
      });
      assert.notEqual(graphCompiled.isError, true);
      assert.equal((graphCompiled.structuredContent as { graph?: { hops: number } }).graph?.hops, graphHops);
    }

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
    const invalidGraph = await client.callTool({ name: 'context_compile', arguments: { path: root, graphHops: 3 } });
    assert.equal(invalidGraph.isError, true);
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
      'context_knowledge_review',
      'context_knowledge_batch',
      'context_inject',
      'context_import',
      'context_learn',
      'context_orient',
      'context_expand',
      'context_compile',
      'context_resume',
      'context_note_list',
      'context_note_add',
      'context_usage_report',
      'context_host_capabilities',
      'recipe_list',
      'recipe_inspect',
      'recipe_materialize',
      'recipe_transition',
      'skill_list',
      'skill_inspect',
      'skill_materialize',
      'skill_transition',
      'skill_record_invocation',
      'skill_record_outcome',
      'evolution_propose',
      'evolution_list',
      'evolution_inspect',
      'evolution_accept',
      'evolution_transition',
      'context_checkpoint',
    ]);
    const result = await client.callTool({ name: 'context_orient', arguments: { path: root } });
    assert.notEqual(result.isError, true);
    assert.equal(orientPayload(result).status, 'no_context');
    const saved = await client.callTool({ name: 'context_checkpoint', arguments: { path: root, title: 'Session transport', progressSummary: 'Check MCP session delivery' } });
    assert.notEqual(saved.isError, true);
    const inject = async (resetSession = false) => {
      const result = await client.callTool({ name: 'context_inject', arguments: { path: root, query: 'session', sessionId: 'stdio-conversation', taskId: 'session-task', resetSession } });
      assert.notEqual(result.isError, true);
      return result.structuredContent as { text: string; delivery: { mode: string; reason: string } };
    };
    assert.equal((await inject()).delivery.mode, 'full');
    const repeat = await inject();
    assert.equal(repeat.delivery.mode, 'unchanged');
    assert.equal(repeat.text, '');
    assert.equal((await inject(true)).delivery.reason, 'reset');
    const invalidSession = await client.callTool({ name: 'context_inject', arguments: { path: root, sessionId: '' } });
    assert.equal(invalidSession.isError, true);
    assert.equal((await inject()).delivery.mode, 'unchanged');
    assert.equal(stderr, '');
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
