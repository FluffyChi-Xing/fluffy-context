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
import { cognitionRecipesProjectionPath } from '../src/storage/layout.js';
import { inspectRecipe, materializeRecipe, transitionRecipe } from '../src/cognition/recipes.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-recipes-'));
}

async function initialized(root: string): Promise<void> {
  await initProject(root);
  await importV1(root);
  await enableRuntime(root);
}

async function acceptedRecipeProposal(root: string): Promise<string> {
  await appendEvent(root, { type: 'context.state.recorded', idempotencyKey: 'context', payload: { record: { snapshot: { contextId: 'ctx-1', snapshotId: 'snap-1' } } } });
  await appendEvent(root, { type: 'git.state.observed', idempotencyKey: 'git', payload: {} });
  await appendEvent(root, { type: 'record.used', idempotencyKey: 'used', payload: { feedbackId: 'feedback-1', entity: 'knowledge', entityId: 'knowledge-1', outcome: 'used' } });
  const proposal = await proposeEvolution(root, { eventIds: (await readJournal(root)).slice(-3).map((event) => event.eventId), targetKind: 'compiler-recipe' });
  assert.ok(proposal.proposalId);
  await acceptEvolutionCandidate(root, { proposalId: proposal.proposalId!, rationale: 'Reviewed declarative compiler controls.' });
  return proposal.proposalId!;
}

test('Recipes require accepted candidates and retain immutable lifecycle history', async () => {
  const root = await project();
  try {
    await initialized(root);
    await assert.rejects(() => materializeRecipe(root, { proposalId: 'missing', title: 'Missing' }), /proposal not found/);

    const proposalId = await acceptedRecipeProposal(root);
    const first = await materializeRecipe(root, {
      proposalId,
      title: 'Prioritize context and decisions',
      preferredSources: ['context', 'note'],
      preferredSections: ['summary', 'decision'],
      sectionBudgets: { summary: 200, decision: 300 },
    });
    assert.equal(first.materialized, true);
    assert.deepEqual(await materializeRecipe(root, {
      proposalId,
      title: 'Prioritize context and decisions',
      preferredSources: ['context', 'note'],
      preferredSections: ['summary', 'decision'],
      sectionBudgets: { summary: 200, decision: 300 },
    }), { materialized: false, recipeId: first.recipeId, eventId: first.eventId });
    await assert.rejects(() => materializeRecipe(root, { proposalId, title: 'Different controls' }), /conflicting content/);

    await assert.rejects(() => transitionRecipe(root, { recipeId: first.recipeId, to: 'published', rationale: 'Cannot publish directly.' }), /invalid Recipe transition/);
    const verified = await transitionRecipe(root, { recipeId: first.recipeId, to: 'verified', rationale: 'Controls reviewed.' });
    assert.equal(verified.transitioned, true);
    assert.deepEqual(await transitionRecipe(root, { recipeId: first.recipeId, to: 'verified', rationale: 'Controls reviewed.' }), { transitioned: false, eventId: verified.eventId });
    await transitionRecipe(root, { recipeId: first.recipeId, to: 'published', rationale: 'Ready for explicit use.' });

    const published = await inspectRecipe(root, first.recipeId);
    assert.equal(published.status, 'published');
    assert.deepEqual(published.recipe.preferredSources, ['context', 'note']);
    assert.deepEqual(published.recipe.sectionBudgets, { summary: 200, decision: 300 });
    assert.ok((await verifyJournal(root)).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Recipe journal payloads reject unsafe controls and projections rebuild', async () => {
  const root = await project();
  try {
    await initialized(root);
    await assert.rejects(() => appendEvent(root, {
      type: 'recipe.materialized',
      idempotencyKey: 'unsafe-recipe',
      payload: { record: { recipeId: 'recipe-1', schemaVersion: 1, proposalId: 'proposal-1', title: 'Unsafe', applicability: { project: true, branchMode: 'global' }, status: 'candidate', contentHash: 'hash', lineage: [], createdAt: new Date().toISOString(), command: 'rm -rf /' } },
    }), /invalid compiler recipe record/);

    const proposalId = await acceptedRecipeProposal(root);
    const recipe = await materializeRecipe(root, { proposalId, title: 'Safe recipe' });
    await transitionRecipe(root, { recipeId: recipe.recipeId, to: 'verified', rationale: 'Reviewed.' });
    const before = await readFile(cognitionRecipesProjectionPath(root), 'utf8');
    await rm(cognitionRecipesProjectionPath(root));
    await rebuildProjections(root);
    assert.equal(await readFile(cognitionRecipesProjectionPath(root), 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
