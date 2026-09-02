import test from 'node:test';
import assert from 'node:assert/strict';
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { checkpoint } from '../src/runtime/runtime.js';
import { addNote } from '../src/runtime/notes.js';
import { learnKnowledge, recordDeadend, verifyDeadend, verifyKnowledge } from '../src/runtime/knowledge.js';
import { importV1, verifyV1Import } from '../src/cognition/migration-v1.js';
import { appendEvent, readJournal } from '../src/cognition/journal.js';
import { cognitionJournalDirectory, cognitionManifestPath, cognitionProjectionCursorPath, cognitionQuarantineDirectory, cognitionV1ImportPath, contextMetadataPath, snapshotPath } from '../src/storage/layout.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-migration-'));
}

test('migration quarantines invalid v1 data without changing its source', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, { title: 'Invalid', progressSummary: 'Invalid snapshot fixture' });
    const filePath = snapshotPath(root, saved.context.id, saved.snapshot!.snapshotId);
    await writeFile(filePath, '{', 'utf8');
    const result = await importV1(root);
    assert.equal(result.applied, false);
    assert.equal(await readFile(filePath, 'utf8'), '{');
    await access(path.join(cognitionQuarantineDirectory(root), 'v1-readiness.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('journal ignores only an incomplete final record and rejects damaged durable records', async () => {
  const root = await project();
  try {
    await initProject(root);
    await checkpoint(root, { title: 'Journal', progressSummary: 'Created one event' });
    await importV1(root);
    const journalPath = path.join(cognitionJournalDirectory(root), '00000001.ndjson');
    await appendFile(journalPath, '{', 'utf8');
    assert.equal((await readJournal(root)).length, 1);
    await appendEvent(root, { type: 'git.state.observed', idempotencyKey: 'recover-tail', payload: {} });
    assert.equal((await readJournal(root)).length, 2);
    await appendFile(journalPath, '{bad}\n', 'utf8');
    await assert.rejects(() => readJournal(root), /invalid journal record/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('journal rejects empty semantic payloads but preserves lifecycle events', async () => {
  const root = await project();
  try {
    await initProject(root);
    await assert.rejects(() => appendEvent(root, { type: 'host.prompt.submitted', idempotencyKey: 'empty-prompt', payload: {} }), /intent must not be empty/);
    await assert.rejects(() => appendEvent(root, { type: 'workspace.paths.changed', idempotencyKey: 'empty-activity', payload: {} }), /contain changes/);
    const lifecycle = await appendEvent(root, { type: 'runtime.started', idempotencyKey: 'runtime-start', payload: {} });
    assert.equal(lifecycle.appended, true);
    assert.equal((await readJournal(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('journal validates bounded evolution contracts and preserves idempotency', async () => {
  const root = await project();
  try {
    await initProject(root);
    const now = '2026-09-02T00:00:00.000Z';
    const anchor = { worktreeId: null, branch: 'master', ref: 'refs/heads/master', head: 'abc123' };
    const experience = {
      experienceId: 'exp-1', schemaVersion: 1, sourceEventIds: ['evt-source'], sourceContextIds: [], sourceSnapshotIds: [], paths: ['src/cognition/journal.ts'], git: anchor,
      privacy: { classification: 'metadata', redactionCount: 0 }, extractor: { id: 'deterministic-maintainer', version: '1' }, contentHash: 'hash-exp-1', summary: 'Validated journal boundaries', createdAt: now,
    };
    await assert.rejects(() => appendEvent(root, { type: 'experience.recorded', idempotencyKey: 'invalid-experience', payload: { record: { ...experience, sourceEventIds: [] } } }), /invalid experience record/);
    await appendEvent(root, { type: 'experience.recorded', idempotencyKey: 'experience-1', payload: { record: experience } });

    const proposal = {
      proposalId: 'proposal-1', schemaVersion: 1, targetKind: 'skill', targetId: 'skill-1', status: 'candidate', sourceExperienceIds: ['exp-1'],
      evidence: [{ eventId: 'evt-source', relation: 'derived_from' }], lineage: [], applicability: { project: true, branchMode: 'global' }, contentHash: 'hash-proposal-1', summary: 'Review a journal validation procedure', extractor: { id: 'deterministic-maintainer', version: '1' }, createdAt: now,
    };
    await assert.rejects(() => appendEvent(root, { type: 'evolution.proposed', idempotencyKey: 'invalid-proposal', payload: { record: { ...proposal, evidence: [] } } }), /invalid evolution proposal record/);
    await appendEvent(root, { type: 'evolution.proposed', idempotencyKey: 'proposal-1', payload: { record: proposal } });
    await assert.rejects(() => appendEvent(root, { type: 'evolution.published', idempotencyKey: 'invalid-transition', payload: { transition: { entity: 'skill', entityId: 'skill-1', from: 'candidate', to: 'published', reason: 'skip review' } } }), /invalid evolution lifecycle transition/);
    await appendEvent(root, { type: 'evolution.verified', idempotencyKey: 'skill-verified', payload: { transition: { entity: 'skill', entityId: 'skill-1', from: 'candidate', to: 'verified', reason: 'reviewed evidence' } } });
    await appendEvent(root, { type: 'skill.invoked', idempotencyKey: 'invocation-1', payload: { record: { invocationId: 'invoke-1', skillId: 'skill-1', callerEventId: 'evt-source', inputHash: 'input-hash', occurredAt: now } } });
    await assert.rejects(() => appendEvent(root, { type: 'skill.outcome.recorded', idempotencyKey: 'invalid-outcome', payload: { record: { outcomeId: 'outcome-1', invocationId: 'invoke-1', callerEventId: 'evt-source', outcome: 'success', summary: '', occurredAt: now } } }), /invalid skill outcome record/);
    await appendEvent(root, { type: 'skill.outcome.recorded', idempotencyKey: 'outcome-1', payload: { record: { outcomeId: 'outcome-1', invocationId: 'invoke-1', callerEventId: 'evt-source', outcome: 'success', summary: 'Completed review', occurredAt: now } } });
    assert.equal((await readJournal(root)).length, 5);

    const duplicate = await appendEvent(root, { type: 'experience.recorded', idempotencyKey: 'experience-1', payload: { record: experience } });
    assert.equal(duplicate.appended, false);
    await assert.rejects(() => appendEvent(root, { type: 'experience.recorded', idempotencyKey: 'experience-1', payload: { record: { ...experience, summary: 'Different meaning' } } }), /idempotency key conflict/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v1 import journals immutable provenance, rebuilds projections, and is idempotent', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, { title: 'Claims', progressSummary: 'Mapped claim states' });
    await addNote(root, 'Verify claim retry policy', { contextId: saved.context.id, snapshotId: saved.snapshot!.snapshotId });
    const knowledge = await learnKnowledge(root, 'Claims are retried with a backoff', { sourceContextId: saved.context.id, sourceSnapshotId: saved.snapshot!.snapshotId });
    await verifyKnowledge(root, knowledge.knowledgeId);
    const deadend = await recordDeadend(root, 'Retry without idempotency keys', 'Creates duplicate claims', { sourceContextId: saved.context.id, sourceSnapshotId: saved.snapshot!.snapshotId });
    await verifyDeadend(root, deadend.deadendId);
    const before = await readFile(contextMetadataPath(root, saved.context.id), 'utf8');

    const first = await importV1(root);
    assert.equal(first.applied, true);
    assert.equal(first.importedEventIds.length, 4);
    assert.equal((await readJournal(root)).length, 4);
    await access(cognitionManifestPath(root));
    await access(cognitionProjectionCursorPath(root));
    await access(cognitionV1ImportPath(root));
    assert.equal(await readFile(contextMetadataPath(root, saved.context.id), 'utf8'), before);

    const second = await importV1(root);
    assert.deepEqual(second.importedEventIds, first.importedEventIds);
    assert.equal((await readJournal(root)).length, 4);
    assert.deepEqual(await verifyV1Import(root), { verified: true, issues: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
