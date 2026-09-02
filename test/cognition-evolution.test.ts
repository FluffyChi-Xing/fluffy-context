import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { enableRuntime } from '../src/cognition/runtime.js';
import { appendEvent, readJournal } from '../src/cognition/journal.js';
import { acceptEvolutionCandidate, inspectEvolutionProposal, proposeEvolution, transitionEvolutionProposal } from '../src/cognition/evolution.js';
import { rebuildProjections } from '../src/cognition/projections.js';
import { cognitionExperiencesProjectionPath, cognitionProposalsProjectionPath, snapshotPath } from '../src/storage/layout.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-evolution-'));
}

async function initialized(root: string): Promise<void> {
  await initProject(root);
  await importV1(root);
  await enableRuntime(root);
}

test('deterministic evolution extraction writes metadata-only records and rebuilds projections', async () => {
  const root = await project();
  try {
    await initialized(root);
    const snapshotFile = snapshotPath(root, 'missing-context', 'missing-snapshot');
    await appendEvent(root, { type: 'context.state.recorded', idempotencyKey: 'context', payload: { record: { snapshot: { contextId: 'ctx-1', snapshotId: 'snap-1' } } } });
    await appendEvent(root, { type: 'workspace.paths.changed', idempotencyKey: 'paths', payload: { schemaVersion: 1, paths: ['src/example.ts'], changes: [{ path: 'src/example.ts', kind: 'modified', fileType: 'file' }], pathCount: 1, coalesced: false, truncated: false } });
    await appendEvent(root, { type: 'record.used', idempotencyKey: 'used', payload: { feedbackId: 'feedback-1', entity: 'knowledge', entityId: 'knowledge-1', outcome: 'used' } });
    await appendEvent(root, { type: 'host.prompt.submitted', idempotencyKey: 'prompt', payload: { intent: 'Sensitive prompt text must not be copied.' } });
    const eventIds = (await readJournal(root)).slice(-4).map((event) => event.eventId);
    const first = await proposeEvolution(root, { eventIds });
    const second = await proposeEvolution(root, { eventIds });
    assert.equal(first.recorded, true);
    assert.equal(second.recorded, false);
    assert.equal(first.experienceId, second.experienceId);
    assert.equal(first.proposalId, second.proposalId);
    assert.ok(first.proposalId);
    const serialized = JSON.stringify(await readJournal(root));
    assert.equal(serialized.includes('Sensitive prompt text must not be copied.'), true);
    const experienceProjection = await readFile(cognitionExperiencesProjectionPath(root), 'utf8');
    const proposalProjection = await readFile(cognitionProposalsProjectionPath(root), 'utf8');
    assert.equal(experienceProjection.includes('Sensitive prompt text must not be copied.'), false);
    assert.equal(proposalProjection.includes('Sensitive prompt text must not be copied.'), false);
    await assert.rejects(() => readFile(snapshotFile, 'utf8'), { code: 'ENOENT' });
    await rm(cognitionExperiencesProjectionPath(root), { force: true });
    await rm(cognitionProposalsProjectionPath(root), { force: true });
    await rebuildProjections(root);
    assert.ok((await readFile(cognitionExperiencesProjectionPath(root), 'utf8')).includes(first.experienceId));
    assert.ok((await readFile(cognitionProposalsProjectionPath(root), 'utf8')).includes(first.proposalId!));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('proposal reviews retain lifecycle history and enforce allowed transitions', async () => {
  const root = await project();
  try {
    await initialized(root);
    await appendEvent(root, { type: 'context.state.recorded', idempotencyKey: 'context', payload: { record: { snapshot: { contextId: 'ctx-1', snapshotId: 'snap-1' } } } });
    await appendEvent(root, { type: 'git.state.observed', idempotencyKey: 'git', payload: {} });
    await appendEvent(root, { type: 'record.used', idempotencyKey: 'used', payload: { feedbackId: 'feedback-1', entity: 'knowledge', entityId: 'knowledge-1', outcome: 'used' } });
    const result = await proposeEvolution(root, { eventIds: (await readJournal(root)).slice(-3).map((event) => event.eventId), targetKind: 'skill' });
    assert.ok(result.proposalId);
    await acceptEvolutionCandidate(root, { proposalId: result.proposalId!, rationale: 'Reviewed as a bounded candidate.' });
    await transitionEvolutionProposal(root, { proposalId: result.proposalId!, to: 'verified', rationale: 'Evidence reviewed.' });
    const verified = await inspectEvolutionProposal(root, result.proposalId!);
    assert.equal(verified.status, 'verified');
    assert.ok(verified.acceptedArtifact);
    assert.equal(verified.lifecycle.length, 1);
    await transitionEvolutionProposal(root, { proposalId: result.proposalId!, to: 'superseded', rationale: 'Replaced by successor.', supersedes: { entity: 'skill', entityId: 'skill-successor', relation: 'supersedes' } });
    const superseded = await inspectEvolutionProposal(root, result.proposalId!);
    assert.equal(superseded.status, 'superseded');
    assert.equal(superseded.lifecycle.length, 2);
    await assert.rejects(() => transitionEvolutionProposal(root, { proposalId: result.proposalId!, to: 'verified', rationale: 'Cannot revive.' }), /invalid evolution lifecycle transition/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evolution extraction rejects missing, duplicate, and disallowed evidence before writes', async () => {
  const root = await project();
  try {
    await initialized(root);
    const before = await readJournal(root);
    await assert.rejects(() => proposeEvolution(root, { eventIds: ['missing'] }), /not found/);
    const disallowed = await appendEvent(root, { type: 'runtime.started', idempotencyKey: 'disallowed', payload: {} });
    await assert.rejects(() => proposeEvolution(root, { eventIds: [disallowed.event.eventId] }), /not allowed/);
    await assert.rejects(() => proposeEvolution(root, { eventIds: [disallowed.event.eventId, disallowed.event.eventId] }), /unique/);
    assert.equal((await readJournal(root)).length, before.length + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
