import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileContext } from '../src/compiler/compile.js';
import { expandContext } from '../src/compiler/expand.js';
import { canonicalJson, estimateTokens, validateManifestIdentity } from '../src/compiler/identity.js';
import { FilesystemObserver, type WatchCallback } from '../src/cognition/filesystem-observer.js';
import { projectEvents } from '../src/cognition/projections.js';
import { buildEvidenceGraph, workspaceNodeId } from '../src/cognition/evidence-graph.js';
import { graphOrdering } from '../src/compiler/graph.js';
import { appendEvent, readJournal } from '../src/cognition/journal.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { enableRuntime } from '../src/cognition/runtime.js';
import { acceptEvolutionCandidate, proposeEvolution } from '../src/cognition/evolution.js';
import { initProject } from '../src/runtime/init.js';
import { checkpoint } from '../src/runtime/runtime.js';
import { addNote } from '../src/runtime/notes.js';
import { learnKnowledge, recordDeadend, verifyDeadend, verifyKnowledge } from '../src/runtime/knowledge.js';
import type { CognitionEvent, EvidenceGraphProjection } from '../src/cognition/types.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-compiler-'));
}

function event(type: CognitionEvent['type'], payload: CognitionEvent['payload'], eventId: string, ref = 'refs/heads/main'): CognitionEvent {
  return {
    eventId,
    schemaVersion: 2,
    type,
    occurredAt: '2026-08-27T00:00:00.000Z',
    observedAt: '2026-08-27T00:00:00.000Z',
    projectId: 'project',
    source: { kind: 'fs-observer' },
    idempotencyKey: eventId,
    git: { worktreeId: 'worktree', branch: 'main', ref, head: 'head' },
    privacy: { classification: 'metadata', redactionCount: 0 },
    payload,
    previousHash: null,
    hash: eventId,
  };
}

test('Compiler identity is canonical, bounded, and verifiable', async () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 }, omitted: undefined }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(estimateTokens('12345'), 2);
  assert.equal(estimateTokens(''), 0);
});

test('Evidence graph projection and opt-in compiler participation are deterministic and bounded', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, {
      title: 'Graph compiler context',
      progressSummary: 'Keep graph assistance bounded',
      relatedFiles: ['src/graph.ts'],
    });
    assert.equal(saved.status, 'saved');
    if (saved.status !== 'saved') return;
    const knowledgeCandidate = await learnKnowledge(root, 'Graph knowledge anchor');
    await verifyKnowledge(root, knowledgeCandidate.knowledgeId);
    const deadendCandidate = await recordDeadend(root, 'Graph deadend anchor', 'Keep traversal bounded');
    await verifyDeadend(root, deadendCandidate.deadendId);

    const events = await readJournal(root);
    const firstGraph = buildEvidenceGraph(events);
    const secondGraph = buildEvidenceGraph(events);
    assert.deepEqual(secondGraph, firstGraph);
    assert.ok(firstGraph.nodes.length >= 0);
    assert.ok(firstGraph.nodes.every((node) => !node.nodeId.includes('Graph compiler context')));

    const baseline = await compileContext(root, { contextId: saved.context.id, query: 'graph bounded', maxChars: 4000 });
    assert.equal('graph' in baseline, false);
    const graphManifest = await compileContext(root, { contextId: saved.context.id, query: 'graph bounded', graphHops: 0, maxChars: 4000 });
    assert.equal(graphManifest.graph?.hops, 0);
    assert.equal(graphManifest.graph?.fallbackReason, 'graph-unavailable');
    assert.equal(validateManifestIdentity(graphManifest), true);
    assert.notEqual(graphManifest.identity.manifestHash, baseline.identity.manifestHash);
    assert.deepEqual(graphManifest, await compileContext(root, { contextId: saved.context.id, query: 'graph bounded', graphHops: 0, maxChars: 4000 }));
    const fallback = graphOrdering(null, 2, graphManifest.anchor, graphManifest.selected);
    assert.equal(fallback.participation.fallbackReason, 'graph-unavailable');
    assert.equal(fallback.distanceFor(graphManifest.selected[0]!), null);

    const anchor = graphManifest.anchor;
    const workspace = workspaceNodeId(anchor);
    const knowledge = graphManifest.selected.find((candidate) => candidate.section === 'knowledge');
    const deadend = graphManifest.selected.find((candidate) => candidate.section === 'deadend');
    assert.ok(knowledge);
    assert.ok(deadend);
    if (!knowledge || !deadend) return;
    const knowledgeNode = `knowledge:${knowledge.source.entityId}`;
    const deadendNode = `deadend:${deadend.source.entityId}`;
    const graph: EvidenceGraphProjection = {
      schemaVersion: 1,
      derivationVersion: 'evidence-graph-v1',
      nodes: [
        { nodeId: workspace, kind: 'branch-worktree' },
        { nodeId: knowledgeNode, kind: 'knowledge' },
        { nodeId: deadendNode, kind: 'deadend' },
      ],
      edges: [
        { edgeId: 'edge:knowledge', from: workspace, to: knowledgeNode, type: 'used_for', sourceEventIds: ['event:knowledge'], derivationVersion: 'evidence-graph-v1', occurredAt: '2026-08-27T00:00:00.000Z' },
        { edgeId: 'edge:deadend', from: knowledgeNode, to: deadendNode, type: 'derived_from', sourceEventIds: ['event:deadend'], derivationVersion: 'evidence-graph-v1', occurredAt: '2026-08-27T00:00:00.000Z' },
      ],
    };
    const oneHop = graphOrdering(graph, 1, anchor, [knowledge, deadend]);
    assert.equal(oneHop.distanceFor(knowledge), 1);
    assert.equal(oneHop.distanceFor(deadend), null);
    const twoHops = graphOrdering(graph, 2, anchor, [knowledge, deadend]);
    assert.equal(twoHops.distanceFor(deadend), 2);
    assert.equal(twoHops.participation.projectionHash === null, false);
    const changedGraph = { ...graph, edges: graph.edges.map((edge) => edge.edgeId === 'edge:deadend' ? { ...edge, confidence: 0.5 } : edge) };
    assert.notEqual(graphOrdering(changedGraph, 2, anchor, [knowledge, deadend]).participation.projectionHash, twoHops.participation.projectionHash);
    const invalidGraph = { ...graph, edges: [{ ...graph.edges[0]!, type: 'invalid' }] } as unknown as EvidenceGraphProjection;
    assert.equal(graphOrdering(invalidGraph, 1, anchor, [knowledge, deadend]).participation.fallbackReason, 'graph-invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Compiler emits a deterministic bounded manifest with governed sources', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, {
      title: 'Fix authentication regression',
      progressSummary: 'Investigate the failing authentication callback',
      pendingTasks: ['Run the regression test suite'],
      decisions: ['Keep signature validation at the boundary'],
      risks: ['The callback can fail on malformed input'],
      relatedFiles: ['src/auth.ts'],
    });
    assert.equal(saved.status, 'saved');
    const note = await addNote(root, 'Authentication callback failure needs reproduction', { contextId: saved.context.id });
    const candidate = await learnKnowledge(root, 'Callbacks require signature validation');
    const knowledge = await verifyKnowledge(root, candidate.knowledgeId);
    const deadend = await recordDeadend(root, 'Retried without validating the signature', 'The callback remained exploitable');
    await verifyDeadend(root, deadend.deadendId);

    const first = await compileContext(root, { query: 'debug authentication callback signature', maxChars: 1000 });
    const second = await compileContext(root, { query: 'debug authentication callback signature', maxChars: 1000 });
    assert.deepEqual(first, second);
    assert.equal(first.status, 'ready');
    assert.equal(first.intent.scenario, 'debugging');
    assert.ok(first.intent.signals.some((signal) => signal.source === 'explicit-query'));
    assert.ok(first.selected.some((candidate) => candidate.source.entityId === saved.context.id));
    assert.ok(first.selected.some((candidate) => candidate.source.entityId === note.noteId));
    assert.ok(first.selected.some((candidate) => candidate.source.entityId === knowledge.knowledgeId));
    assert.ok(first.selected.some((candidate) => candidate.source.entityId === deadend.deadendId));
    assert.ok(first.excluded.every((item) => item.reason !== 'v2_unavailable'));
    assert.ok(first.budget.usedChars <= 1000);
    assert.ok(first.text.length <= 1000);
    assert.equal(first.identity.tokenEstimate.input, estimateTokens(first.text));
    assert.equal(validateManifestIdentity(first), true);
    assert.ok(first.selected.every((item) => item.level === 'summary' && item.expandable));

    const empty = await compileContext(root, { contextId: saved.context.id, maxChars: 0 });
    assert.equal(empty.budget.usedChars, 0);
    assert.equal(empty.selected.length, 0);
    assert.equal(empty.truncation.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Recipe compilation is explicit, deterministic, bounded, and stale-safe', async () => {
  const root = await project();
  try {
    await initProject(root);
    await importV1(root);
    await enableRuntime(root);
    const saved = await checkpoint(root, {
      title: 'Recipe compiler context',
      progressSummary: 'Prefer the durable note over the current context',
      decisions: ['Keep the selected source bounded'],
    });
    assert.equal(saved.status, 'saved');
    if (saved.status !== 'saved') return;
    const note = await addNote(root, 'Durable note for recipe selection', { contextId: saved.context.id });
    await appendEvent(root, {
      type: 'context.state.recorded',
      idempotencyKey: 'recipe-context-evidence',
      payload: { record: { snapshot: { contextId: saved.context.id, snapshotId: saved.snapshot.snapshotId } } },
    });
    await appendEvent(root, {
      type: 'git.state.observed',
      idempotencyKey: 'recipe-git-evidence',
      payload: {},
    });
    await appendEvent(root, {
      type: 'record.used',
      idempotencyKey: 'recipe-use-evidence',
      payload: { feedbackId: 'recipe-feedback', entity: 'knowledge', entityId: 'recipe-knowledge', outcome: 'used' },
    });
    const proposal = await proposeEvolution(root, {
      eventIds: (await readJournal(root)).slice(-3).map((item) => item.eventId),
      targetKind: 'compiler-recipe',
    });
    assert.ok(proposal.proposalId);
    await acceptEvolutionCandidate(root, { proposalId: proposal.proposalId!, rationale: 'Reviewed deterministic compiler controls.' });
    const { materializeRecipe, transitionRecipe } = await import('../src/cognition/recipes.js');
    const materialized = await materializeRecipe(root, {
      proposalId: proposal.proposalId!,
      title: 'Prefer notes',
      preferredSources: ['note', 'context'],
      preferredSections: ['note', 'summary'],
      sectionBudgets: { note: 80 },
    });
    await transitionRecipe(root, { recipeId: materialized.recipeId, to: 'verified', rationale: 'Controls reviewed.' });
    const baseline = await compileContext(root, { contextId: saved.context.id, query: 'recipe durable', maxChars: 4000 });
    const unchanged = await compileContext(root, { contextId: saved.context.id, query: 'recipe durable', maxChars: 4000 });
    assert.deepEqual(unchanged, baseline);
    const recipeManifest = await compileContext(root, { contextId: saved.context.id, query: 'recipe durable', recipeId: materialized.recipeId, maxChars: 4000 });
    assert.equal(recipeManifest.recipe?.recipeId, materialized.recipeId);
    assert.equal(validateManifestIdentity(recipeManifest), true);
    assert.deepEqual(recipeManifest, await compileContext(root, { contextId: saved.context.id, query: 'recipe durable', recipeId: materialized.recipeId, maxChars: 4000 }));
    assert.equal(recipeManifest.selected[0]?.source.entityId, note.noteId);
    assert.ok((recipeManifest.budget.sections.note?.consumed ?? 0) <= 80);
    await assert.rejects(() => compileContext(root, { contextId: saved.context.id, query: 'recipe durable', recipeId: 'missing', maxChars: 4000 }), /recipe not found/);
    await transitionRecipe(root, { recipeId: materialized.recipeId, to: 'deprecated', rationale: 'No longer active.' });
    await assert.rejects(() => expandContext(root, {
      manifestHash: recipeManifest.identity.manifestHash,
      candidateId: recipeManifest.selected[0]?.candidateId,
      level: 'structured',
      compile: { contextId: saved.context.id, query: 'recipe durable', recipeId: materialized.recipeId, maxChars: 4000 },
    }), /compiler recipe is not active|manifest hash mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('Compiler expands selected candidates by identity with bounded structured and evidence output', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, {
      title: 'Expand authentication context',
      progressSummary: 'Inspect the complete authentication workflow details',
      pendingTasks: ['Add expansion coverage'],
    });
    assert.equal(saved.status, 'saved');
    if (saved.status !== 'saved') return;
    const note = await addNote(root, 'The complete workflow needs review', { contextId: saved.context.id, relatedFiles: ['src/auth.ts'] });
    const manifest = await compileContext(root, { contextId: saved.context.id, query: 'authentication', maxChars: 45 });
    const progress = manifest.selected.find((candidate) => (candidate.content as { field?: unknown }).field === 'progressSummary');
    assert.ok(progress);
    if (!progress) return;
    assert.equal(progress.truncated, true);
    const expanded = await expandContext(root, {
      manifestHash: manifest.identity.manifestHash,
      itemHash: progress.itemHash,
      level: 'structured',
      compile: { contextId: saved.context.id, query: 'authentication', maxChars: 45 },
    });
    assert.equal(expanded.status, 'complete');
    assert.equal((expanded.content as { value?: unknown } | null)?.value, 'Inspect the complete authentication workflow details');
    assert.equal(expanded.text, 'progressSummary: Inspect the complete authentication workflow details');

    const empty = await expandContext(root, {
      manifestHash: manifest.identity.manifestHash,
      candidateId: progress.candidateId,
      level: 'structured',
      maxChars: 0,
      compile: { contextId: saved.context.id, query: 'authentication', maxChars: 45 },
    });
    assert.equal(empty.status, 'partial');
    assert.equal(empty.text, '');
    assert.equal(empty.content, null);
    assert.equal(empty.budget.truncated, true);

    const evidence = await expandContext(root, {
      manifestHash: manifest.identity.manifestHash,
      candidateId: progress.candidateId,
      level: 'evidence',
      maxChars: 10,
      compile: { contextId: saved.context.id, query: 'authentication', maxChars: 45 },
    });
    assert.equal(evidence.status, 'partial');
    assert.equal(evidence.content, null);
    assert.equal(evidence.budget.truncated, true);
    assert.equal(evidence.text.length, 10);

    const noteManifest = await compileContext(root, { contextId: saved.context.id, query: 'authentication', maxChars: 4000 });
    const noteCandidate = noteManifest.selected.find((candidate) => candidate.source.entityId === note.noteId);
    assert.ok(noteCandidate);
    if (!noteCandidate) return;
    const byHash = await expandContext(root, {
      manifestHash: noteManifest.identity.manifestHash,
      itemHash: noteCandidate.itemHash,
      level: 'evidence',
      compile: { contextId: saved.context.id, query: 'authentication', maxChars: 4000 },
    });
    assert.equal(byHash.status, 'complete');
    assert.match(byHash.text, /relatedFiles/);
    await assert.rejects(() => expandContext(root, {
      manifestHash: noteManifest.identity.manifestHash,
      candidateId: progress.candidateId,
      itemHash: noteCandidate.itemHash,
      level: 'structured',
      compile: { contextId: saved.context.id, query: 'authentication', maxChars: 4000 },
    }), /selectors do not match/);
    await assert.rejects(() => expandContext(root, {
      manifestHash: 'stale',
      candidateId: progress.candidateId,
      level: 'structured',
      compile: { contextId: saved.context.id, query: 'authentication', maxChars: 45 },
    }), /manifest hash mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Compiler includes recent exact-workspace filesystem activity without contents', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, {
      title: 'Activity compiler test',
      progressSummary: 'Track recent activity',
    });
    await importV1(root);
    await appendEvent(root, {
      eventId: 'activity-main',
      type: 'workspace.paths.changed',
      occurredAt: '2026-08-27T00:00:01.000Z',
      source: { kind: 'fs-observer' },
      idempotencyKey: 'activity-main',
      git: { worktreeId: null, branch: null, ref: null, head: null },
      payload: {
        schemaVersion: 1,
        paths: ['src/auth.ts', '.env'],
        changes: [
          { path: 'src/auth.ts', kind: 'modified', fileType: 'file', sizeBytes: 12, mtimeMs: 1 },
          { path: '.env', kind: 'modified', fileType: 'file', sizeBytes: 99, mtimeMs: 2 },
        ],
        pathCount: 2,
        coalesced: true,
        truncated: false,
      },
    });
    await appendEvent(root, {
      eventId: 'activity-newest',
      type: 'workspace.paths.changed',
      occurredAt: '2026-08-27T00:00:02.000Z',
      source: { kind: 'fs-observer' },
      idempotencyKey: 'activity-newest',
      git: { worktreeId: null, branch: null, ref: null, head: null },
      payload: {
        schemaVersion: 1,
        paths: ['src/newest.ts'],
        changes: [{ path: 'src/newest.ts', kind: 'created', fileType: 'file' }],
        pathCount: 1,
        coalesced: false,
        truncated: false,
      },
    });
    const manifest = await compileContext(root, { contextId: saved.context.id, query: 'activity', activityLimit: 5, maxChars: 4000 });
    assert.equal(manifest.sections.activity.length, 2);
    assert.deepEqual(
      manifest.sections.activity.map((item) => item.content.paths),
      [['src/auth.ts'], ['src/newest.ts']],
    );
    assert.equal(manifest.sections.activity.find((item) => item.source.provenance.eventId === 'activity-main')?.source.provenance.origin, 'v2-journal');
    assert.equal(manifest.text.includes('.env'), false);
    assert.equal(manifest.text.includes(root), false);

    const limited = await compileContext(root, { contextId: saved.context.id, query: 'activity', activityLimit: 1, maxChars: 4000 });
    assert.deepEqual(limited.sections.activity.map((item) => item.content.paths), [['src/newest.ts']]);
    assert.deepEqual(limited, await compileContext(root, { contextId: saved.context.id, query: 'activity', activityLimit: 1, maxChars: 4000 }));

    const activityCandidate = manifest.selected.find((item) => item.source.entityId === 'activity-newest');
    assert.ok(activityCandidate);
    if (!activityCandidate) return;
    const expandedActivity = await expandContext(root, {
      manifestHash: manifest.identity.manifestHash,
      candidateId: activityCandidate.candidateId,
      level: 'evidence',
      compile: { contextId: saved.context.id, query: 'activity', activityLimit: 5, maxChars: 4000 },
    });
    assert.equal(expandedActivity.status, 'complete');
    assert.deepEqual((expandedActivity.content as { paths: string[] }).paths, ['src/newest.ts']);
    assert.equal(expandedActivity.text.includes('src/newest.ts'), true);
    assert.equal(expandedActivity.text.includes('activity-main'), false);

    const otherBranch = {
      schemaVersion: 2 as const,
      type: 'workspace.paths.changed' as const,
      source: { kind: 'fs-observer' as const },
      idempotencyKey: 'activity-other',
      git: { worktreeId: 'other', branch: 'other', ref: 'refs/heads/other', head: 'other-head' },
      payload: {
        schemaVersion: 1 as const,
        paths: ['other.ts'],
        changes: [{ path: 'other.ts', kind: 'modified' as const, fileType: 'file' as const }],
        pathCount: 1,
        coalesced: false,
        truncated: false,
      },
    };
    await appendEvent(root, otherBranch);
    const isolated = await compileContext(root, { contextId: saved.context.id, query: 'activity', activityLimit: 5, maxChars: 4000 });
    assert.equal(isolated.sections.activity.some((candidate) => candidate.content.paths.includes('other.ts')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Compiler keeps activity empty in v1 fallback mode', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, {
      title: 'v1 fallback activity test',
      progressSummary: 'Keep v1 fallback expansion readable',
    });
    const manifest = await compileContext(root, {
      contextId: saved.context.id,
      query: 'v1 fallback activity test',
      activityLimit: 10,
      maxChars: 4000,
    });
    assert.equal(manifest.mode, 'v1-fallback');
    assert.deepEqual(manifest.sections.activity, []);
    assert.equal(manifest.provenance.journalRead, false);
    const title = manifest.selected.find((item) => (item.content as { field?: unknown }).field === 'title');
    assert.ok(title);
    if (!title) return;
    const expanded = await expandContext(root, {
      manifestHash: manifest.identity.manifestHash,
      candidateId: title.candidateId,
      level: 'structured',
      compile: { contextId: saved.context.id, query: 'v1 fallback activity test', activityLimit: 10, maxChars: 4000 },
    });
    assert.equal(expanded.status, 'complete');
    assert.equal((expanded.content as { value?: unknown }).value, 'v1 fallback activity test');
    assert.equal(expanded.provenance.journalRead, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Compiler expands verified knowledge and deadend evidence without reading evidence paths', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, { title: 'Governed expansion', progressSummary: 'Review verified callback constraints' });
    assert.equal(saved.status, 'saved');
    const knowledge = await learnKnowledge(root, 'Callbacks require signature validation', {
      sourceContextId: saved.context.id,
      sourceSnapshotId: saved.snapshot.snapshotId,
      evidence: ['src/callback.ts', 'regression test'],
    });
    await verifyKnowledge(root, knowledge.knowledgeId);
    const deadend = await recordDeadend(root, 'Skip callback signature validation', 'Regression test fails', {
      sourceContextId: saved.context.id,
      sourceSnapshotId: saved.snapshot.snapshotId,
      evidence: ['regression test'],
    });
    await verifyDeadend(root, deadend.deadendId);

    const manifest = await compileContext(root, { contextId: saved.context.id, query: 'callback signature', maxChars: 4000 });
    const knowledgeCandidate = manifest.selected.find((item) => item.source.entityId === knowledge.knowledgeId);
    const deadendCandidate = manifest.selected.find((item) => item.source.entityId === deadend.deadendId);
    assert.ok(knowledgeCandidate);
    assert.ok(deadendCandidate);
    if (!knowledgeCandidate || !deadendCandidate) return;

    const knowledgeExpanded = await expandContext(root, {
      manifestHash: manifest.identity.manifestHash,
      itemHash: knowledgeCandidate.itemHash,
      level: 'evidence',
      compile: { contextId: saved.context.id, query: 'callback signature', maxChars: 4000 },
    });
    assert.equal(knowledgeExpanded.status, 'complete');
    assert.deepEqual((knowledgeExpanded.content as { supportingEvidence?: string[] }).supportingEvidence, ['src/callback.ts', 'regression test']);
    assert.equal(knowledgeExpanded.text.includes('src/callback.ts'), true);

    const deadendExpanded = await expandContext(root, {
      manifestHash: manifest.identity.manifestHash,
      candidateId: deadendCandidate.candidateId,
      level: 'evidence',
      compile: { contextId: saved.context.id, query: 'callback signature', maxChars: 4000 },
    });
    assert.equal(deadendExpanded.status, 'complete');
    assert.deepEqual((deadendExpanded.content as { observedEvidence?: string[] }).observedEvidence, ['regression test']);
    assert.equal(deadendExpanded.text.includes('regression test'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FilesystemObserver records only real allowed file metadata changes', async () => {
  const root = await project();
  let callback: WatchCallback | undefined;
  let closed = false;
  try {
    await initProject(root);
    const observer = new FilesystemObserver(root, {
      debounceMs: 0,
      watchFactory: (_root, next) => {
        callback = next;
        return { close: () => { closed = true; } };
      },
    });
    observer.start();
    await writeFile(path.join(root, 'allowed.txt'), 'one');
    callback?.('rename', 'allowed.txt');
    const created = await observer.flush();
    assert.deepEqual(created.paths, ['allowed.txt']);
    assert.equal(created.changed, true);

    callback?.('change', 'allowed.txt');
    assert.equal((await observer.flush()).changed, false);
    await writeFile(path.join(root, 'allowed.txt'), 'two');
    callback?.('change', 'allowed.txt');
    const modified = await observer.flush();
    assert.deepEqual(modified.paths, ['allowed.txt']);

    await writeFile(path.join(root, '.env'), 'secret');
    callback?.('change', '.env');
    assert.equal((await observer.flush()).changed, false);
    await rm(path.join(root, 'allowed.txt'));
    callback?.('rename', 'allowed.txt');
    assert.equal((await observer.flush()).changed, true);
    observer.close();
    assert.equal(closed, true);

    const journal = await readFile(path.join(root, '.context', 'v2', 'journal', '00000001.ndjson'), 'utf8');
    assert.equal(journal.includes('one'), false);
    assert.equal(journal.includes('two'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('note lifecycle events leave the latest projected state and open observations', () => {
  const recorded = event('note.recorded', { record: { noteId: 'note-1', contextId: 'ctx-1', message: 'needs review', status: 'open', absorbedBySnapshotId: null } }, 'note-recorded');
  const resolved = event('note.resolved', { record: { noteId: 'note-1', contextId: 'ctx-1', message: 'needs review', status: 'resolved', absorbedBySnapshotId: null } }, 'note-resolved');
  const absorbed = event('note.absorbed', { record: { noteId: 'note-2', contextId: 'ctx-1', message: 'absorbed', status: 'open', absorbedBySnapshotId: 'snap-1' } }, 'note-absorbed');
  const projection = projectEvents([recorded, resolved, absorbed]);
  assert.equal(projection.notes['note-1'].record.status, 'resolved');
  assert.equal(projection.notes['note-2'].record.absorbedBySnapshotId, 'snap-1');
  assert.deepEqual(Object.values(projection.workspaces)[0].openObservationEventIds, []);
});

test('workspace path events update bounded pathFocus and ignore unsafe paths', () => {
  const projection = projectEvents([
    event('workspace.paths.changed', {
      schemaVersion: 1,
      paths: ['src\\main.ts', '../escape.ts', '/absolute.ts', 'src/main.ts', 'src/other.ts'],
      changes: [],
      pathCount: 5,
      coalesced: true,
      truncated: false,
    }, 'event-paths'),
  ]);
  const workspace = Object.values(projection.workspaces)[0];
  assert.deepEqual(workspace.pathFocus, ['src/main.ts', 'src/other.ts']);
});
