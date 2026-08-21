import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { discoverKnowledge, recordDeadend, verifyDeadend, verifyKnowledge, learnKnowledge } from '../src/runtime/knowledge.js';
import { saveContext, loadContext, searchContext } from '../src/agent/api.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-agent-'));
}

test('Agent API completes save, load and search without exposing storage layout', async () => {
  const root = await project();
  try {
    await initProject(root);
    const baseline = await saveContext(root, {
      title: 'Applicant authentication',
      progressSummary: 'Reuse the existing authentication flow',
      pendingTasks: ['Connect the new entry point'],
      relatedFiles: ['src/authentication.ts'],
    });
    assert.equal(baseline.result.status, 'saved');
    assert.equal(baseline.projectRoot, root);
    if (baseline.result.status !== 'saved') return;

    const patch = await saveContext(root, {
      contextId: baseline.result.context.id,
      progressSummary: 'Reuse the existing authentication flow',
      pendingTasks: ['Connect the new entry point', 'Add integration coverage'],
    }, { minSaveIntervalMs: 0 });
    assert.equal(patch.result.status, 'saved');

    const loaded = await loadContext(root, { contextId: baseline.result.context.id, maxChars: 30 });
    assert.equal(loaded.context.id, baseline.result.context.id);
    assert.equal(loaded.details, undefined);
    assert.ok(loaded.resumeSummary.progressSummary.length <= 30);
    assert.equal(loaded.knowledge, null);

    const detailed = await loadContext(root, { contextId: baseline.result.context.id, includeDetails: true, maxChars: 30 });
    assert.ok(detailed.details);
    assert.deepEqual(detailed.details?.pendingTasks, ['Connect the new entry point', 'Add integration coverage']);

    const before = await readFile(path.join(root, '.context', 'index.json'), 'utf8');
    const searched = await searchContext(root, 'authentication', { maxChars: 20, limit: 1 });
    assert.equal(searched.total, 1);
    assert.equal(searched.hits[0].context.id, baseline.result.context.id);
    assert.ok(searched.hits[0].matchedFields.includes('title'));
    assert.ok(searched.hits[0].summary.progressSummary.length <= 20);
    assert.equal(searched.knowledge.total, 0);
    assert.deepEqual(searched.verifiedDeadendIds, []);
    assert.equal(await readFile(path.join(root, '.context', 'index.json'), 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent API preserves checkpoint statuses and composes verified consensus only', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await saveContext(root, { title: 'Auth', progressSummary: 'Authentication workflow' });
    assert.equal(saved.result.status, 'saved');
    if (saved.result.status !== 'saved') return;

    const candidate = await learnKnowledge(root, 'Authentication requires an existing workflow', { sourceContextId: saved.result.context.id, sourceSnapshotId: saved.result.snapshot.snapshotId });
    const verified = await learnKnowledge(root, 'Authentication uses SMS verification', { sourceContextId: saved.result.context.id, sourceSnapshotId: saved.result.snapshot.snapshotId });
    await verifyKnowledge(root, verified.knowledgeId);
    const deadend = await recordDeadend(root, 'Use a shared mutable singleton', 'Causes state leakage', { sourceContextId: saved.result.context.id, sourceSnapshotId: saved.result.snapshot.snapshotId });
    await verifyDeadend(root, deadend.deadendId);

    const loaded = await loadContext(root, { contextId: saved.result.context.id, query: 'authentication', maxChars: 100 });
    assert.equal(loaded.knowledge?.total, 1);
    assert.equal(loaded.knowledge?.hits[0].knowledge.knowledgeId, verified.knowledgeId);
    assert.deepEqual(loaded.verifiedDeadendIds, [deadend.deadendId]);
    const searched = await searchContext(root, 'shared mutable singleton', { maxChars: 100 });
    assert.deepEqual(searched.verifiedDeadendIds, [deadend.deadendId]);
    assert.equal(loaded.knowledge?.hits.some((hit) => hit.knowledge.knowledgeId === candidate.knowledgeId), false);

    const noChange = await saveContext(root, { contextId: saved.result.context.id, progressSummary: 'Authentication workflow' });
    assert.equal(noChange.result.status, 'no_change');
    const limited = await saveContext(root, { contextId: saved.result.context.id, progressSummary: 'Changed during the same interval' });
    assert.equal(limited.result.status, 'rate_limited');
    if (limited.result.status === 'rate_limited') assert.ok(limited.result.retryAt);
    assert.equal((await readdir(path.join(root, '.context', 'contexts', saved.result.context.id, 'snaps'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent search applies scope and status boundaries deterministically', async () => {
  const root = await project();
  try {
    await initProject(root);
    const first = await saveContext(root, { title: 'Payment authentication', progressSummary: 'Use authentication for payment' });
    assert.equal(first.result.status, 'saved');
    if (first.result.status !== 'saved') return;
    const second = await saveContext(root, { title: 'Legacy authentication', progressSummary: 'Old authentication adapter' });
    assert.equal(second.result.status, 'saved');
    const result = await searchContext(root, 'authentication', { limit: 1, maxChars: 12 });
    assert.equal(result.total, 2);
    assert.equal(result.hits.length, 1);
    assert.ok(result.truncated);
    assert.ok(result.hits[0].summary.progressSummary.length <= 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent API rejects empty and missing context queries', async () => {
  const root = await project();
  try {
    await initProject(root);
    await assert.rejects(() => searchContext(root, '   '), /context search query/);
    await assert.rejects(() => loadContext(root, { contextId: 'missing' }), /no active context found|ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
