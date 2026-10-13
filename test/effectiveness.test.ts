import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEffectiveness } from '../src/cognition/effectiveness.js';

const control = { task: 'resume', variant: 'control', repositoryCommit: 'abc123', model: 'same-model', acceptanceId: 'resume-test', success: true, testsPassed: true, durationMs: 1200, retries: 2 };
const context = { ...control, variant: 'context', durationMs: 850, retries: 1, evidenceUsedIds: ['knowledge:one'] };

test('paired task evaluation uses only supplied outcomes and marks missing usage unavailable', () => {
  const result = evaluateEffectiveness({ schemaVersion: 1, runs: [control, context] });
  assert.equal(result.sampleCount, 1);
  assert.equal(result.missingTasks.length, 4);
  assert.equal(result.pairs[0].durationDeltaMs, -350);
  assert.equal(result.pairs[0].providerTokenQuality, 'unavailable');
  assert.equal(result.aggregate.providerTokenDelta, null);
  assert.equal(result.aggregate.evidenceUsedCount, 1);
  assert.equal(result.aggregate.correctnessRegressions, 0);
});

test('paired task evaluation rejects unmatched baselines and duplicate runs', () => {
  assert.throws(() => evaluateEffectiveness({ schemaVersion: 1, runs: [control] }), /unpaired/);
  assert.throws(() => evaluateEffectiveness({ schemaVersion: 1, runs: [control, { ...context, model: 'other' }] }), /incompatible/);
  assert.throws(() => evaluateEffectiveness({ schemaVersion: 1, runs: [control, control, context] }), /duplicate/);
  const measured = evaluateEffectiveness({ schemaVersion: 1, runs: [{ ...control, providerInputTokens: 100, providerOutputTokens: 30 }, { ...context, providerInputTokens: 70, providerOutputTokens: 20, success: false }] });
  assert.equal(measured.aggregate.providerTokenDelta, -40);
  assert.equal(measured.aggregate.correctnessRegressions, 1);
});
