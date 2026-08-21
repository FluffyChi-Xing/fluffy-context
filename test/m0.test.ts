import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { checkpoint, resume } from '../src/runtime/runtime.js';
import { addNote, listActivity, listNotes } from '../src/runtime/notes.js';
import { doctor, status } from '../src/runtime/diagnostics.js';
import { learnKnowledge, listKnowledge, verifyKnowledge, recordDeadend, listDeadends, verifyDeadend } from '../src/runtime/knowledge.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-runtime-'));
}

test('init is idempotent and creates compact JSON layout', async () => {
  const root = await project();
  try {
    const first = await initProject(root);
    const ignoredBefore = await readFile(path.join(root, '.contextignored'), 'utf8');
    const second = await initProject(root);
    assert.equal(first.alreadyInitialized, false);
    assert.equal(second.alreadyInitialized, true);
    assert.equal(await readFile(path.join(root, '.context', 'manifest.json'), 'utf8') !== '', true);
    assert.equal(await readFile(path.join(root, '.context', 'index.json'), 'utf8') !== '', true);
    assert.equal(await readFile(path.join(root, '.contextignored'), 'utf8'), ignoredBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint creates baseline, patch and no-op snapshots', async () => {
  const root = await project();
  try {
    await initProject(root);
    const baseline = await checkpoint(root, { title: 'Order refactor', progressSummary: 'Started', pendingTasks: ['Write tests'] });
    assert.equal(baseline.status, 'saved');
    assert.equal(baseline.snapshot.mode, 'baseline');

    const patch = await checkpoint(root, { contextId: baseline.context.id, title: 'Order refactor', progressSummary: 'Started', pendingTasks: ['Run tests'] }, { minSaveIntervalMs: 0 });
    assert.equal(patch.status, 'saved');
    assert.equal(patch.snapshot.mode, 'patch');
    assert.equal(patch.snapshot.parentSnapshotId, baseline.snapshot.snapshotId);

    const noChange = await checkpoint(root, { contextId: baseline.context.id, title: 'Order refactor', progressSummary: 'Started', pendingTasks: ['Run tests'] }, { minSaveIntervalMs: 0 });
    assert.equal(noChange.status, 'no_change');
    const snapshots = await readdir(path.join(root, '.context', 'contexts', baseline.context.id, 'snaps'));
    assert.equal(snapshots.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume rebuilds patch chain and reports git drift safely', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, {
      title: 'Bug investigation',
      progressSummary: 'Found the failing boundary',
      lastError: 'Test environment unavailable',
      completed: ['Reproduced bug'],
      pendingTasks: ['Request test credentials'],
    });
    const result = await resume(root, saved.context.id);
    assert.equal(result.resumeSummary.progressSummary, 'Found the failing boundary');
    assert.equal(result.resumeSummary.lastError, 'Test environment unavailable');
    assert.deepEqual(result.resumeSummary.pendingTasks, ['Request test credentials']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor and status report initialized project', async () => {
  const root = await project();
  try {
    await initProject(root);
    const healthy = await doctor(root);
    const current = await status(root);
    assert.equal(healthy.healthy, true);
    assert.equal(current.initialized, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint rate limits changed saves and resume applies a character budget', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, { title: 'Budget', progressSummary: 'A long progress summary', pendingTasks: ['First task', 'Second task'] });
    const limited = await checkpoint(root, { contextId: saved.context.id, progressSummary: 'Changed summary' });
    assert.equal(limited.status, 'rate_limited');
    if (limited.status === 'rate_limited') assert.ok(limited.retryAt);
    const resumed = await resume(root, saved.context.id, 12);
    assert.ok(resumed.resumeSummary.progressSummary.length <= 12);
    assert.notEqual(resumed.resumeSummary.progressSummary, resumed.details.progressSummary);
    assert.equal(resumed.details.pendingTasks.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('knowledge and deadends stay candidate until verified', async () => {
  const root = await project();
  try {
    await initProject(root);
    const knowledge = await learnKnowledge(root, 'Orders require an idempotency key');
    assert.deepEqual(await listKnowledge(root), []);
    assert.equal((await listKnowledge(root, true)).length, 1);
    await verifyKnowledge(root, knowledge.knowledgeId);
    assert.equal((await listKnowledge(root)).length, 1);

    const deadend = await recordDeadend(root, 'Use a shared mutable singleton', 'Caused cross-test state leakage');
    assert.deepEqual(await listDeadends(root), []);
    await verifyDeadend(root, deadend.deadendId);
    assert.equal((await listDeadends(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('knowledge and deadend sources must exist', async () => {
  const root = await project();
  try {
    await initProject(root);
    await assert.rejects(() => learnKnowledge(root, 'invalid source', { sourceContextId: 'missing' }));
    await assert.rejects(() => recordDeadend(root, 'invalid source', 'missing context', { sourceContextId: 'missing' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor reports malformed context metadata', async () => {
  const root = await project();
  try {
    await initProject(root);
    await writeFile(path.join(root, '.context', 'index.json'), '{broken', 'utf8');
    const result = await doctor(root);
    assert.equal(result.healthy, false);
    assert.ok(result.checks.some((check) => check.startsWith('index:')));
    assert.ok(result.checks.some((check) => check.startsWith('index rebuild:')) || result.checks.some((check) => check.startsWith('contexts:')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint normalizes blank values and explicit empty lists', async () => {
  const root = await project();
  try {
    await initProject(root);
    const baseline = await checkpoint(root, {
      title: '  Example  ',
      progressSummary: '  Started  ',
      lastError: '  failure  ',
      completed: [' done ', ' ', 'next'],
      pendingTasks: [' pending '],
    });
    assert.equal(baseline.snapshot.content?.progressSummary, 'Started');
    assert.equal(baseline.snapshot.content?.lastError, 'failure');
    assert.deepEqual(baseline.snapshot.content?.completed, ['done', 'next']);

    const cleared = await checkpoint(root, {
      contextId: baseline.context.id,
      progressSummary: '   ',
      lastError: '   ',
      completed: [],
      pendingTasks: [],
    }, { minSaveIntervalMs: 0 });
    assert.equal(cleared.status, 'saved');
    const resumed = await resume(root, baseline.context.id);
    assert.equal(resumed.details.progressSummary, '');
    assert.equal(resumed.details.lastError, null);
    assert.deepEqual(resumed.details.completed, []);
    assert.deepEqual(resumed.details.pendingTasks, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('formatting-only checkpoint is a no-op', async () => {
  const root = await project();
  try {
    await initProject(root);
    const baseline = await checkpoint(root, { progressSummary: 'Started', completed: ['done'] });
    const result = await checkpoint(root, { contextId: baseline.context.id, progressSummary: '  Started  ', completed: [' done '] }, { minSaveIntervalMs: 0 });
    assert.equal(result.status, 'no_change');
    assert.equal((await readdir(path.join(root, '.context', 'contexts', baseline.context.id, 'snaps'))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor validates snapshot chain without rewriting files', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, { progressSummary: 'Valid' });
    const snapshotPath = path.join(root, '.context', 'contexts', saved.context.id, 'snaps', `${saved.snapshot.snapshotId}.json`);
    const before = await readFile(snapshotPath, 'utf8');
    const snapshot = JSON.parse(before) as { contentHash: string };
    snapshot.contentHash = 'corrupt';
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');
    const result = await doctor(root);
    assert.equal(result.healthy, false);
    assert.ok(result.checks.some((check) => check.startsWith('contexts:')));
    assert.equal(await readFile(snapshotPath, 'utf8'), JSON.stringify(snapshot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('notes support low-friction recording, filtering and checkpoint absorption', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, { title: 'Note flow' });
    const first = await addNote(root, '  Third-party credential is missing  ', { contextId: saved.context.id, kind: 'problem' });
    await addNote(root, 'Keep the raw request body for signature validation', { contextId: saved.context.id, kind: 'decision', status: 'resolved' });
    assert.equal((await listNotes(root, { contextId: saved.context.id })).length, 2);
    assert.equal((await listNotes(root, { contextId: saved.context.id, openOnly: true })).length, 1);
    assert.equal((await listNotes(root, { contextId: saved.context.id, maxChars: 8 }))[0].message, 'Keep th…');

    const beforeAbsorb = await listActivity(root, { contextId: saved.context.id });
    assert.ok(beforeAbsorb.items.some((item) => item.type === 'note' && item.noteId === first.noteId));
    const checkpointed = await checkpoint(root, { contextId: saved.context.id, progressSummary: 'Absorb notes', absorbNotes: true }, { minSaveIntervalMs: 0 });
    assert.equal(checkpointed.status, 'saved');
    const notes = await listNotes(root, { contextId: saved.context.id });
    assert.ok(notes.every((note) => note.absorbedBySnapshotId === checkpointed.snapshot.snapshotId));
    assert.equal((await listNotes(root, { contextId: saved.context.id, openOnly: true })).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no-change and rate-limited checkpoints do not absorb notes', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, { progressSummary: 'same' });
    const note = await addNote(root, 'Do not absorb yet', { contextId: saved.context.id });
    const noChange = await checkpoint(root, { contextId: saved.context.id, progressSummary: 'same', absorbNotes: true });
    assert.equal(noChange.status, 'no_change');
    assert.equal((await listNotes(root, { contextId: saved.context.id }))[0].noteId, note.noteId);
    const rateLimitedNote = await addNote(root, 'Still waiting', { contextId: saved.context.id });
    const rateLimited = await checkpoint(root, { contextId: saved.context.id, progressSummary: 'changed', absorbNotes: true });
    assert.equal(rateLimited.status, 'rate_limited');
    assert.equal((await listNotes(root, { contextId: saved.context.id }))[0].noteId, rateLimitedNote.noteId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint preserves structured paths without reading ignored files', async () => {
  const root = await project();
  try {
    await initProject(root);
    await writeFile(path.join(root, '.contextignored'), 'private/\n', 'utf8');
    const saved = await checkpoint(root, { title: 'Filtering', progressSummary: 'Only structured input is saved', relatedFiles: ['private/secret.txt', 'src/order.ts', '../outside.txt', 'C:/secret.txt', '.env'] });
    assert.deepEqual(saved.snapshot.content?.relatedFiles, ['src/order.ts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
