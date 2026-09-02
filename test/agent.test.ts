import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { discoverKnowledge, recordDeadend, verifyDeadend, verifyKnowledge, learnKnowledge } from '../src/runtime/knowledge.js';
import { addNote } from '../src/runtime/notes.js';
import { contextCompile, contextExpand, contextOrient, saveContext, loadContext, recordContextUse, searchContext, inspectRecipe, listRecipes, materializeContextRecipe, transitionContextRecipe, inspectSkill, listSkills, materializeContextSkill, recordContextSkillInvocation, recordContextSkillOutcome, transitionContextSkill } from '../src/agent/api.js';
import { appendEvent, readJournal } from '../src/cognition/journal.js';
import { acceptEvolutionCandidate, proposeEvolution } from '../src/cognition/evolution.js';
import { enableRuntime } from '../src/cognition/runtime.js';

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: root, windowsHide: true });
}

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-agent-'));
}

test('Agent Skill wrappers preserve lifecycle and invocation policy', async () => {
  const root = await project();
  try {
    await initProject(root);
    await importV1(root);
    await enableRuntime(root);
    await appendEvent(root, { type: 'context.state.recorded', idempotencyKey: 'context', payload: { record: { snapshot: { contextId: 'ctx-1', snapshotId: 'snap-1' } } } });
    await appendEvent(root, { type: 'git.state.observed', idempotencyKey: 'git', payload: {} });
    await appendEvent(root, { type: 'record.used', idempotencyKey: 'used', payload: { feedbackId: 'feedback-1', entity: 'knowledge', entityId: 'knowledge-1', outcome: 'used' } });
    const proposal = await proposeEvolution(root, { eventIds: (await readJournal(root)).slice(-3).map((event) => event.eventId), targetKind: 'skill' });
    assert.ok(proposal.proposalId);
    await acceptEvolutionCandidate(root, { proposalId: proposal.proposalId!, rationale: 'Reviewed.' });

    const skill = await materializeContextSkill(root, { proposalId: proposal.proposalId!, title: 'Agent wrapper skill', procedure: ['Inspect state'] });
    assert.equal((await listSkills(root)).length, 1);
    assert.equal((await inspectSkill(root, skill.skillId)).status, 'candidate');
    await transitionContextSkill(root, { skillId: skill.skillId, to: 'verified', rationale: 'Verified.' });
    await transitionContextSkill(root, { skillId: skill.skillId, to: 'published', rationale: 'Published.' });
    await recordContextSkillInvocation(root, { skillId: skill.skillId, invocationId: 'invoke-1', callerEventId: 'caller-1', inputHash: 'hash-1' });
    await recordContextSkillOutcome(root, { skillId: skill.skillId, invocationId: 'invoke-1', outcomeId: 'outcome-1', callerEventId: 'caller-1', outcome: 'success', summary: 'Succeeded.' });
    assert.equal((await inspectSkill(root, skill.skillId)).outcomes[0].outcome, 'success');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Recipe wrappers preserve lifecycle and compile propagation', async () => {
  const root = await project();
  try {
    await initProject(root);
    await importV1(root);
    await enableRuntime(root);
    const saved = await saveContext(root, {
      title: 'Recipe context',
      progressSummary: 'Keep recipe compilation bounded',
    });
    assert.equal(saved.result.status, 'saved');
    if (saved.result.status !== 'saved') return;

    await appendEvent(root, { type: 'context.state.recorded', idempotencyKey: 'recipe-context', payload: { record: { snapshot: { contextId: saved.result.context.id, snapshotId: saved.result.snapshot.snapshotId } } } });
    await appendEvent(root, { type: 'git.state.observed', idempotencyKey: 'recipe-git', payload: {} });
    await appendEvent(root, { type: 'record.used', idempotencyKey: 'recipe-use', payload: { feedbackId: 'recipe-feedback', entity: 'knowledge', entityId: 'knowledge-1', outcome: 'used' } });
    const proposal = await proposeEvolution(root, {
      eventIds: (await readJournal(root)).slice(-3).map((event) => event.eventId),
      targetKind: 'compiler-recipe',
    });
    assert.ok(proposal.proposalId);
    await acceptEvolutionCandidate(root, { proposalId: proposal.proposalId!, rationale: 'Reviewed declarative controls.' });

    const materialized = await materializeContextRecipe(root, {
      proposalId: proposal.proposalId!,
      title: 'Agent Recipe',
      preferredSources: ['context'],
      preferredSections: ['summary'],
      sectionBudgets: { summary: 1000 },
    });
    assert.equal(materialized.materialized, true);
    const beforeReads = await readJournal(root);
    assert.equal((await listRecipes(root)).length, 1);
    assert.equal((await inspectRecipe(root, materialized.recipeId)).status, 'candidate');
    assert.deepEqual(await readJournal(root), beforeReads);

    await transitionContextRecipe(root, {
      recipeId: materialized.recipeId,
      to: 'verified',
      rationale: 'Verified bounded controls.',
    });
    const manifest = await contextCompile(root, {
      contextId: saved.result.context.id,
      recipeId: materialized.recipeId,
      query: 'recipe compilation',
      maxChars: 4000,
    });
    assert.equal(manifest.recipe?.recipeId, materialized.recipeId);
    assert.equal(manifest.recipe?.interpreterVersion, 'recipe-interpreter-v1');
    const candidate = manifest.selected.find((item) => item.content && typeof item.content === 'object' && (item.content as { field?: string }).field === 'progressSummary');
    assert.ok(candidate);
    if (!candidate) return;

    const expanded = await contextExpand(root, {
      manifestHash: manifest.identity.manifestHash,
      candidateId: candidate.candidateId,
      level: 'structured',
      compile: {
        contextId: saved.result.context.id,
        recipeId: materialized.recipeId,
        query: 'recipe compilation',
        maxChars: 4000,
      },
    });
    assert.equal(expanded.status, 'complete');
    assert.equal(expanded.candidateId, candidate.candidateId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
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

test('contextExpand is publicly available and read-only', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await saveContext(root, { title: 'Expand API', progressSummary: 'Keep expansion read-only' });
    assert.equal(saved.result.status, 'saved');
    if (saved.result.status !== 'saved') return;
    const before = await readFile(path.join(root, '.context', 'index.json'), 'utf8');
    const { compileContext } = await import('../src/compiler/compile.js');
    const manifest = await compileContext(root, { contextId: saved.result.context.id, query: 'expansion', maxChars: 4000 });
    const candidate = manifest.selected.find((item) => (item.content as { field?: unknown }).field === 'progressSummary');
    assert.ok(candidate);
    if (!candidate) return;
    const result = await contextExpand(root, {
      manifestHash: manifest.identity.manifestHash,
      candidateId: candidate.candidateId,
      level: 'structured',
      compile: { contextId: saved.result.context.id, query: 'expansion', maxChars: 4000 },
    });
    assert.equal(result.status, 'complete');
    assert.equal((result.content as { value?: unknown } | null)?.value, 'Keep expansion read-only');
    assert.equal(await readFile(path.join(root, '.context', 'index.json'), 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('contextOrient composes bounded verified consensus without writing runtime state', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await saveContext(root, {
      title: 'Applicant authentication',
      progressSummary: 'Reuse the existing authentication workflow',
      pendingTasks: ['Connect the new entry point'],
    });
    assert.equal(saved.result.status, 'saved');
    if (saved.result.status !== 'saved') return;

    const candidate = await learnKnowledge(root, 'Applicant authentication must be rebuilt', { scope: 'web' });
    const verified = await learnKnowledge(root, 'Applicant authentication uses SMS verification', { scope: 'web', sourceContextId: saved.result.context.id, sourceSnapshotId: saved.result.snapshot.snapshotId });
    await verifyKnowledge(root, verified.knowledgeId);
    const deadend = await recordDeadend(root, 'Use a shared mutable authentication singleton', 'Causes state leakage', { scope: 'web', sourceContextId: saved.result.context.id, sourceSnapshotId: saved.result.snapshot.snapshotId });
    await verifyDeadend(root, deadend.deadendId);
    await addNote(root, 'Keep the state transition explicit', { contextId: saved.result.context.id, kind: 'decision' });
    await addNote(root, 'Ignore notes from other work', { kind: 'observation' });

    const contextPath = path.join(root, '.context', 'contexts', saved.result.context.id, 'context.json');
    const indexPath = path.join(root, '.context', 'index.json');
    const beforeContext = await readFile(contextPath, 'utf8');
    const beforeIndex = await readFile(indexPath, 'utf8');
    const result = await contextOrient(root, { query: 'applicant authentication', scope: 'web', maxChars: 500, knowledgeLimit: 1, deadendLimit: 1, noteLimit: 1 });

    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.equal(result.context.id, saved.result.context.id);
    assert.equal('patch' in result.snapshot, false);
    assert.equal('content' in result.snapshot, false);
    assert.equal(result.knowledge.total, 1);
    assert.equal(result.knowledge.hits[0].knowledge.knowledgeId, verified.knowledgeId);
    assert.equal(result.knowledge.hits.some((hit) => hit.knowledge.knowledgeId === candidate.knowledgeId), false);
    assert.equal(result.deadends.hits[0].deadend.deadendId, deadend.deadendId);
    assert.deepEqual(result.notes.map((note) => note.message), ['Keep the state transition explicit']);

    const budgeted = await contextOrient(root, { query: 'applicant authentication', scope: 'web', maxChars: 10 });
    assert.equal(budgeted.status, 'ready');
    if (budgeted.status !== 'ready') return;
    assert.equal(budgeted.resumeSummary.progressSummary, 'Reuse the…');
    assert.deepEqual(budgeted.knowledge.hits, []);
    assert.deepEqual(budgeted.deadends.hits, []);
    assert.deepEqual(budgeted.notes, []);
    assert.ok(budgeted.truncated);

    assert.equal(await readFile(contextPath, 'utf8'), beforeContext);
    assert.equal(await readFile(indexPath, 'utf8'), beforeIndex);

    const noQuery = await contextOrient(root, { contextId: saved.result.context.id });
    assert.equal(noQuery.status, 'ready');
    assert.equal(noQuery.query, null);
    assert.equal(noQuery.knowledge.total, 0);
    assert.equal(noQuery.deadends.total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v2 orientation mirrors live checkpoint state after migration', async () => {
  const root = await project();
  try {
    await initProject(root);
    const initial = await saveContext(root, { title: 'Initial context', progressSummary: 'Initial state' });
    assert.equal(initial.result.status, 'saved');
    if (initial.result.status !== 'saved') return;
    await importV1(root);
    await enableRuntime(root);
    const updated = await saveContext(root, { contextId: initial.result.context.id, progressSummary: 'Live mirrored state' }, { minSaveIntervalMs: 0 });
    assert.equal(updated.result.status, 'saved');
    const result = await contextOrient(root);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.equal(result.resumeSummary.progressSummary, 'Live mirrored state');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v2 orientation retrieves journal-projected consensus and explains feedback ranking', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await saveContext(root, { title: 'Payments', progressSummary: 'Use gateway validation' });
    assert.equal(saved.result.status, 'saved');
    if (saved.result.status !== 'saved') return;
    const first = await learnKnowledge(root, 'Payment callback validates the gateway signature');
    const second = await learnKnowledge(root, 'Payment callback validates the payload signature');
    await verifyKnowledge(root, first.knowledgeId);
    await verifyKnowledge(root, second.knowledgeId);
    await importV1(root);
    await enableRuntime(root);
    const initial = await contextOrient(root, { query: 'payment callback validates', knowledgeLimit: 2 });
    assert.equal(initial.status, 'ready');
    if (initial.status !== 'ready') return;
    assert.equal(initial.explanation.mode, 'v2');
    assert.equal(initial.knowledge.total, 2);
    const use = await recordContextUse(root, { entity: 'knowledge', entityId: second.knowledgeId, eventId: 'feedback-1' });
    assert.equal(use.recorded, true);
    assert.equal((await recordContextUse(root, { entity: 'knowledge', entityId: second.knowledgeId, eventId: 'feedback-1' })).recorded, false);
    const ranked = await contextOrient(root, { query: 'payment callback validates', knowledgeLimit: 2 });
    assert.equal(ranked.status, 'ready');
    if (ranked.status !== 'ready') return;
    assert.equal(ranked.knowledge.hits[0].knowledge.knowledgeId, second.knowledgeId);
    assert.ok(ranked.knowledge.hits[0].why.includes('prior recorded use'));
    assert.ok(Object.hasOwn(ranked.explanation.retrieval.knowledge, 'status_not_verified'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v2 orientation selects only the current branch workspace', async () => {
  const root = await project();
  try {
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await git(root, ['config', 'user.name', 'Test']);
    await initProject(root);
    const main = await saveContext(root, { title: 'Main context', progressSummary: 'Main branch work' });
    assert.equal(main.result.status, 'saved');
    if (main.result.status !== 'saved') return;
    await git(root, ['add', '.context']);
    await git(root, ['commit', '-m', 'main context']);
    await git(root, ['switch', '-c', 'feature/orient']);
    const feature = await saveContext(root, { title: 'Feature context', progressSummary: 'Feature branch work' });
    assert.equal(feature.result.status, 'saved');
    if (feature.result.status !== 'saved') return;
    await importV1(root);
    await enableRuntime(root);

    const onFeature = await contextOrient(root);
    assert.equal(onFeature.status, 'ready');
    if (onFeature.status !== 'ready') return;
    assert.equal(onFeature.context.id, feature.result.context.id);

    await git(root, ['switch', 'master']);
    const onMain = await contextOrient(root);
    assert.equal(onMain.status, 'ready');
    if (onMain.status !== 'ready') return;
    assert.equal(onMain.context.id, main.result.context.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('contextOrient returns no_context but preserves initialization errors', async () => {
  const root = await project();
  const uninitialized = await project();
  try {
    await initProject(root);
    const result = await contextOrient(root, { query: 'authentication' });
    assert.equal(result.status, 'no_context');
    assert.equal(result.query, 'authentication');
    assert.equal(result.context, null);
    await assert.rejects(() => contextOrient(root, { query: '   ' }), /context orient query/);
    await assert.rejects(() => contextOrient(uninitialized), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(uninitialized, { recursive: true, force: true });
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
