import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrationReadiness } from '../src/cognition/readiness.js';
import { initProject } from '../src/runtime/init.js';
import { checkpoint } from '../src/runtime/runtime.js';
import { addNote } from '../src/runtime/notes.js';
import { learnKnowledge, recordDeadend } from '../src/runtime/knowledge.js';
import { doctor } from '../src/runtime/diagnostics.js';
import { cognitionManifestPath, cognitionProjectionCursorPath, cognitionRuntimeLeasePath } from '../src/storage/layout.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-cognition-'));
}

test('v2 layout paths remain dormant until migration or runtime enablement', async () => {
  const root = await project();
  try {
    await initProject(root);
    await assert.rejects(() => access(cognitionManifestPath(root)), /ENOENT/);
    await assert.rejects(() => access(cognitionProjectionCursorPath(root)), /ENOENT/);
    await assert.rejects(() => access(cognitionRuntimeLeasePath(root)), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration readiness validates v1 authorities without writing v2 data', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, { title: 'Payments', progressSummary: 'Mapped payment states' });
    await addNote(root, 'Verify callback retries', { contextId: saved.context.id, snapshotId: saved.snapshot.snapshotId });
    await learnKnowledge(root, 'Payment callbacks are idempotent', { sourceContextId: saved.context.id, sourceSnapshotId: saved.snapshot.snapshotId });
    await recordDeadend(root, 'Use a shared callback state singleton', 'It leaks state between requests', { sourceContextId: saved.context.id, sourceSnapshotId: saved.snapshot.snapshotId });
    const contextBefore = await readFile(path.join(root, '.context', 'contexts', saved.context.id, 'context.json'), 'utf8');

    const readiness = await migrationReadiness(root);
    assert.equal(readiness.eligible, true);
    assert.equal(readiness.v1Present, true);
    assert.equal(readiness.v2Present, false);
    assert.deepEqual(readiness.counts, { contexts: 1, snapshots: 1, notes: 1, knowledge: 1, deadends: 1 });
    assert.deepEqual(readiness.issues, []);
    assert.equal(await readFile(path.join(root, '.context', 'contexts', saved.context.id, 'context.json'), 'utf8'), contextBefore);
    await assert.rejects(() => access(cognitionManifestPath(root)), /ENOENT/);
    assert.equal((await doctor(root)).healthy, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migration readiness reports malformed v1 authorities without repairing them', async () => {
  const root = await project();
  try {
    await initProject(root);
    await writeFile(path.join(root, '.context', 'knowledge.json'), '{', 'utf8');
    const readiness = await migrationReadiness(root);
    assert.equal(readiness.eligible, false);
    assert.match(readiness.issues.join('\n'), /knowledge/);
    assert.equal(await readFile(path.join(root, '.context', 'knowledge.json'), 'utf8'), '{');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
