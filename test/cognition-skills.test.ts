import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { enableRuntime } from '../src/cognition/runtime.js';
import { appendEvent, readJournal, verifyJournal } from '../src/cognition/journal.js';
import { acceptEvolutionCandidate, proposeEvolution } from '../src/cognition/evolution.js';
import { rebuildProjections } from '../src/cognition/projections.js';
import { cognitionSkillsProjectionPath } from '../src/storage/layout.js';
import { inspectSkill, materializeSkill, recordSkillInvocation, recordSkillOutcome, transitionSkill } from '../src/cognition/skills.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-skills-'));
}

async function initialized(root: string): Promise<void> {
  await initProject(root);
  await importV1(root);
  await enableRuntime(root);
}

async function acceptedSkillProposal(root: string): Promise<string> {
  await appendEvent(root, { type: 'context.state.recorded', idempotencyKey: 'context', payload: { record: { snapshot: { contextId: 'ctx-1', snapshotId: 'snap-1' } } } });
  await appendEvent(root, { type: 'git.state.observed', idempotencyKey: 'git', payload: {} });
  await appendEvent(root, { type: 'record.used', idempotencyKey: 'used', payload: { feedbackId: 'feedback-1', entity: 'knowledge', entityId: 'knowledge-1', outcome: 'used' } });
  const proposal = await proposeEvolution(root, { eventIds: (await readJournal(root)).slice(-3).map((event) => event.eventId), targetKind: 'skill' });
  assert.ok(proposal.proposalId);
  await acceptEvolutionCandidate(root, { proposalId: proposal.proposalId!, rationale: 'Reviewed bounded procedure.' });
  return proposal.proposalId!;
}

test('Skills require accepted candidate proposals and retain immutable lifecycle history', async () => {
  const root = await project();
  try {
    await initialized(root);
    await assert.rejects(() => materializeSkill(root, { proposalId: 'missing', title: 'Missing', procedure: ['Do nothing'] }), /proposal not found/);

    const proposalId = await acceptedSkillProposal(root);
    const first = await materializeSkill(root, { proposalId, title: 'Review deployment', procedure: ['Inspect deployment state', 'Record the result'] });
    assert.equal(first.materialized, true);
    const retry = await materializeSkill(root, { proposalId, title: 'Review deployment', procedure: ['Inspect deployment state', 'Record the result'] });
    assert.deepEqual(retry, { materialized: false, skillId: first.skillId, eventId: first.eventId });
    await assert.rejects(() => materializeSkill(root, { proposalId, title: 'Different title', procedure: ['Inspect deployment state'] }), /conflicting content/);

    await assert.rejects(() => transitionSkill(root, { skillId: first.skillId, to: 'published', rationale: 'Cannot publish directly.' }), /invalid Skill transition/);
    const verified = await transitionSkill(root, { skillId: first.skillId, to: 'verified', rationale: 'Procedure reviewed.' });
    assert.equal(verified.transitioned, true);
    assert.deepEqual(await transitionSkill(root, { skillId: first.skillId, to: 'verified', rationale: 'Procedure reviewed.' }), { transitioned: false, eventId: verified.eventId });
    await transitionSkill(root, { skillId: first.skillId, to: 'published', rationale: 'Ready for use.' });

    const published = await inspectSkill(root, first.skillId);
    assert.equal(published.status, 'published');
    assert.equal(published.lifecycle.length, 2);
    assert.deepEqual(published.skill.procedure, ['Inspect deployment state', 'Record the result']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('published Skills record hash-only invocations and one retry-safe outcome', async () => {
  const root = await project();
  try {
    await initialized(root);
    const proposalId = await acceptedSkillProposal(root);
    const materialized = await materializeSkill(root, { proposalId, title: 'Review deployment', procedure: ['Inspect deployment state'] });
    await assert.rejects(() => recordSkillInvocation(root, { skillId: materialized.skillId, invocationId: 'invoke-1', callerEventId: 'caller-1', inputHash: 'hash-1' }), /published Skill/);
    await transitionSkill(root, { skillId: materialized.skillId, to: 'verified', rationale: 'Reviewed.' });
    await transitionSkill(root, { skillId: materialized.skillId, to: 'published', rationale: 'Released.' });

    const invocation = await recordSkillInvocation(root, { skillId: materialized.skillId, invocationId: 'invoke-1', callerEventId: 'caller-1', inputHash: 'hash-1' });
    assert.equal(invocation.recorded, true);
    assert.deepEqual(await recordSkillInvocation(root, { skillId: materialized.skillId, invocationId: 'invoke-1', callerEventId: 'caller-1', inputHash: 'hash-1' }), { recorded: false, eventId: invocation.eventId });
    await assert.rejects(() => recordSkillInvocation(root, { skillId: materialized.skillId, invocationId: 'invoke-1', callerEventId: 'caller-2', inputHash: 'hash-2' }), /already exists/);

    const outcome = await recordSkillOutcome(root, { skillId: materialized.skillId, invocationId: 'invoke-1', outcomeId: 'outcome-1', callerEventId: 'caller-1', outcome: 'success', summary: 'Completed safely.' });
    assert.equal(outcome.recorded, true);
    assert.deepEqual(await recordSkillOutcome(root, { skillId: materialized.skillId, invocationId: 'invoke-1', outcomeId: 'outcome-1', callerEventId: 'caller-1', outcome: 'success', summary: 'Completed safely.' }), { recorded: false, eventId: outcome.eventId });
    await assert.rejects(() => recordSkillOutcome(root, { skillId: materialized.skillId, invocationId: 'invoke-1', outcomeId: 'outcome-2', callerEventId: 'caller-1', outcome: 'failure', summary: 'Conflicting result.' }), /already recorded/);

    const journal = JSON.stringify(await readJournal(root));
    assert.equal(journal.includes('inputHash'), true);
    assert.equal(journal.includes('raw deployment input'), false);
    assert.equal((await inspectSkill(root, materialized.skillId)).outcomes.length, 1);
    assert.ok((await verifyJournal(root)).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Skill projection rebuilds from journal history', async () => {
  const root = await project();
  try {
    await initialized(root);
    const proposalId = await acceptedSkillProposal(root);
    const materialized = await materializeSkill(root, { proposalId, title: 'Review deployment', procedure: ['Inspect deployment state'] });
    await transitionSkill(root, { skillId: materialized.skillId, to: 'verified', rationale: 'Reviewed.' });
    const before = await readFile(cognitionSkillsProjectionPath(root), 'utf8');
    await rm(cognitionSkillsProjectionPath(root));
    await rebuildProjections(root);
    assert.equal(await readFile(cognitionSkillsProjectionPath(root), 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
