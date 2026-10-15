import { addNote } from '../src/runtime/notes.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initProject } from '../src/runtime/init.js';
import { checkpoint, rebuildSnapshot, resume } from '../src/runtime/runtime.js';
import { injectContext } from '../src/compiler/inject.js';
import { expandContext } from '../src/compiler/expand.js';
import { importMemory } from '../src/cognition/import-memory.js';
import { batchKnowledge, reviewKnowledge } from '../src/cognition/knowledge-review.js';
import { learnKnowledge, listKnowledge, verifyKnowledge } from '../src/runtime/knowledge.js';
import { inspectKnowledgeSources } from '../src/cognition/source-state.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { contextExpand, contextUsageReport } from '../src/agent/api.js';

const exec = promisify(execFile);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-engineering-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  return root;
}
async function imported(root: string) {
  await mkdir(path.join(root, 'memory'));
  const file = path.join(root, 'memory', 'payments.md');
  await writeFile(file, '- Payment must retain the request identifier.');
  const result = await importMemory(root, true);
  const id = result.results[0].knowledgeId!;
  await verifyKnowledge(root, id);
  return { file, id };
}

test('handoff preserves legacy snapshots, patches optional fields, and exposes recorded provenance', async (t) => {
  const root = await fixture(t);
  const old = await checkpoint(root, { title: 'Payment recovery', progressSummary: 'Investigating callback', pendingTasks: ['Run regression'] });
  assert.equal(old.status, 'saved');
  const id = old.context.id;
  const oldDetails = await rebuildSnapshot(root, id, old.snapshot!.snapshotId);
  assert.equal(oldDetails.objective, undefined);
  const updated = await checkpoint(root, { contextId: id, objective: 'Restore payment callback', constraints: ['Never charge twice'],
    validationRefs: ['test/payments.test.ts; recorded run at commit abc'], openQuestions: ['Does retry preserve the key?'], lastError: 'Callback timed out' }, { minSaveIntervalMs: 0 });
  assert.equal(updated.status, 'saved');
  assert.deepEqual(await rebuildSnapshot(root, id, old.snapshot!.snapshotId), oldDetails);
  const result = await injectContext(root, { query: 'handoff', scenario: 'handoff', maxChars: 2400, maxReferenceChars: 16000 });
  for (const fact of ['Restore payment callback', 'Never charge twice', 'commit abc', 'Does retry', 'Callback timed out', 'Run regression']) assert.ok(result.text.includes(fact), fact);
  assert.equal(result.handoff?.snapshotId, updated.snapshot!.snapshotId);
  assert.match(result.handoff!.validation, /not verified/);
  const ref = result.expandRefs.find((item) => item.candidateId?.includes('constraints'))!;
  assert.ok(ref);
  assert.match((await expandContext(ref.path, ref)).text, /Never charge twice/);
  await checkpoint(root, { contextId: id, objective: '', constraints: [] }, { minSaveIntervalMs: 0 });
  const details = (await resume(root, id)).details;
  assert.equal(details.objective, '');
  assert.deepEqual(details.constraints, []);
  assert.deepEqual(details.validationRefs, ['test/payments.test.ts; recorded run at commit abc']);
  const tiny = (await resume(root, id, 0)).resumeSummary;
  assert.equal(tiny.progressSummary, '');
  assert.deepEqual(tiny.validationRefs, []);
});

test('references are directly executable, bounded, refreshable, and reject mismatched selectors', async (t) => {
  const root = await fixture(t);
  const fact = await learnKnowledge(root, 'Payment details ' + 'preserve the original key. '.repeat(100));
  await verifyKnowledge(root, fact.knowledgeId);
  const result = await injectContext(root, { query: 'payment', maxChars: 160, sessionId: 'one', taskId: 'payment' });
  assert.ok(result.text.length <= 160);
  assert.equal(result.expandRefs.length, 1);
  const ref = result.expandRefs[0];
  assert.equal(ref.compile.maxChars, 160);
  assert.ok((await expandContext(root, ref)).text.length > result.text.length);
  const cli = await exec(process.execPath, [path.resolve('dist/src/cli/main.js'), 'expand', '--ref', JSON.stringify(ref)], { cwd: root });
  assert.equal(JSON.parse(cli.stdout).candidateId, ref.candidateId);
  await assert.rejects(expandContext(root, { ...ref, itemHash: '0'.repeat(64) }), /selectors/);
  assert.equal((await injectContext(root, { query: 'payment', maxReferenceChars: 0 })).expandRefs.length, 0);
  assert.equal((await injectContext(root, { query: 'payment', maxReferenceChars: 1 })).referenceBudget.usedChars, 0);
  await assert.rejects(injectContext(root, { maxReferenceChars: 16001 }), /maxReferenceChars/);
  assert.equal((await injectContext(root, { query: 'payment', maxChars: 160, sessionId: 'one', taskId: 'payment' })).expandRefs.length, 0);
  await checkpoint(root, { objective: 'Payment changed' });
  await assert.rejects(expandContext(root, ref), /inject again/);
});

test('source modification retracts session evidence without changing verified history; keep binds exact fingerprint', async (t) => {
  const root = await fixture(t);
  const { file, id } = await imported(root);
  const options = { query: 'payment', sessionId: 'source-session', explain: true };
  const original = await injectContext(root, options);
  assert.match(original.text, /request identifier/);
  const oldRef = original.expandRefs[0];
  await writeFile(file, '- Payment now uses a different identifier.');
  const changed = await injectContext(root, options);
  assert.doesNotMatch(changed.text, /request identifier/);
  assert.equal(changed.sourceReview.required, 1);
  assert.equal(changed.delivery.replacePrevious, true);
  assert.equal(changed.sourceReview.items[0].state, 'changed');
  await assert.rejects(expandContext(root, oldRef), /inject again/);
  assert.equal((await listKnowledge(root, true))[0].status, 'verified');
  assert.equal((await reviewKnowledge(root, { reviewRequired: true })).items[0].knowledgeId, id);
  const decision = { ids: [id], action: 'keep' as const, reason: 'Checked code; original contract still applies', evidence: ['test/payment.ts'] };
  const preview = await batchKnowledge(root, decision);
  await batchKnowledge(root, { ...decision, apply: true, expectedToken: preview.token });
  const kept = await injectContext(root, options);
  assert.equal(kept.sourceReview.required, 0);
  assert.match(kept.text, /request identifier/);
  await writeFile(file, '- Payment contract changes again.');
  assert.equal((await injectContext(root, options)).sourceReview.required, 1);
});

test('missing sources require review, ignored/oversized sources are unknown, and manual knowledge stays usable', async (t) => {
  const root = await fixture(t);
  const { file, id } = await imported(root);
  const manual = await learnKnowledge(root, 'Payment manual contract remains available.');
  await verifyKnowledge(root, manual.knowledgeId);
  await rm(file);
  let result = await injectContext(root, { query: 'payment', explain: true });
  assert.equal(result.sourceReview.items[0].state, 'missing');
  assert.match(result.text, /manual contract/);
  await importMemory(root, true); // Store pending review; an incomplete check must not clear it.
  await writeFile(file, 'x'.repeat(65537));
  result = await injectContext(root, { query: 'payment' });
  assert.equal(result.sourceReview.items[0].state, 'unknown');
  assert.equal(result.sourceReview.items[0].knowledgeId, id);
  await writeFile(path.join(root, '.contextignored'), 'memory/\n');
  const states = await inspectKnowledgeSources(root, await listKnowledge(root, true));
  assert.equal(states.readBytes, 0);
  assert.equal(states.states.get(id)?.state, 'unknown');
  assert.equal(states.states.get(id)?.reviewRequired, true);
  assert.equal(states.states.get(manual.knowledgeId)?.state, 'unknown');
  assert.equal(states.states.get(manual.knowledgeId)?.reviewRequired, false);
});

test('reimport cannot silently acknowledge a changed file even when its old statement is retained', async (t) => {
  const root = await fixture(t);
  const { file, id } = await imported(root);
  await writeFile(file, '- Payment must retain the request identifier.\n- Payment also records the settlement currency.');
  assert.equal((await injectContext(root, { query: 'payment' })).sourceReview.required, 1);
  const reapplied = await importMemory(root, true);
  assert.ok(reapplied.reviewRequired.includes(id));
  assert.equal((await injectContext(root, { query: 'payment' })).sourceReview.required, 1);
  const keep = { ids: [id], action: 'keep' as const, reason: 'Original contract remains supported', evidence: ['test/payment.ts'] };
  const preview = await batchKnowledge(root, keep);
  await batchKnowledge(root, { ...keep, apply: true, expectedToken: preview.token });
  assert.equal((await injectContext(root, { query: 'payment' })).sourceReview.required, 0);
});

test('damaged optional receipts withhold imported evidence without blocking task recovery', async (t) => {
  const root = await fixture(t);
  await imported(root);
  await checkpoint(root, { objective: 'Payment recovery still works' });
  await writeFile(path.join(root, '.context', 'memory-import.json'), '{damaged');
  const packet = await injectContext(root, { query: 'payment', scenario: 'handoff' });
  assert.match(packet.text, /recovery still works/);
  assert.doesNotMatch(packet.text, /request identifier/);
  assert.equal(packet.sourceReview.items[0].reason, 'receipt-unavailable');
  assert.equal(packet.sourceReview.required, 1);
  await assert.rejects(importMemory(root, true));
});

test('handoff does not inject another branch or unrelated task; explicit context remains recoverable', async (t) => {
  const root = await fixture(t);
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  const saved = await checkpoint(root, { title: 'Payment', objective: 'Payment objective', constraints: ['Payment only'] });
  await addNote(root, 'Payment branch-specific observation', { contextId: saved.context.id });
  assert.doesNotMatch((await injectContext(root, { query: 'unrelated astronomy', scenario: 'implementation' })).text, /Payment/);
  await exec('git', ['checkout', '--orphan', 'other'], { cwd: root });
  assert.doesNotMatch((await injectContext(root, { scenario: 'handoff' })).text, /Payment/);
  assert.match((await injectContext(root, { scenario: 'handoff', contextId: saved.context.id })).text, /Payment/);
});

test('CLI checkpoint and injection expose continuity fields without implicit verification', async (t) => {
  const root = await fixture(t);
  const cli = path.resolve('dist/src/cli/main.js');
  await exec(process.execPath, [cli, 'checkpoint', '--objective', 'Payment CLI objective', '--constraints', 'Keep contract', '--validation-refs', 'test/payment.ts', '--open-questions', 'Pending production retest'], { cwd: root });
  const { stdout } = await exec(process.execPath, [cli, 'inject', '--scenario', 'handoff', '--max-reference-chars', '16000'], { cwd: root });
  const result = JSON.parse(stdout);
  assert.match(result.text, /Keep contract/);
  assert.match(result.text, /Pending production retest/);
  assert.match(result.handoff.validation, /not verified/);
  assert.ok(result.expandRefs.length > 0);
  assert.equal((await listKnowledge(root, true)).length, 0);
});

test('report counts real local handoff and expansion operations without claiming model adoption', async (t) => {
  const root = await fixture(t);
  await checkpoint(root, { objective: 'Payment telemetry', constraints: ['Do not infer test success'] });
  await importV1(root);
  const packet = await injectContext(root, { scenario: 'handoff' });
  await contextExpand(root, packet.expandRefs[0]);
  const report = await contextUsageReport(root);
  const metrics = report.delivery.contextEngineering as { observations: number; totals: { handoffs: number; references: number }; expansions: number; interpretation: string };
  assert.equal(metrics.observations, 1);
  assert.equal(metrics.totals.handoffs, 1);
  assert.equal(metrics.totals.references, packet.expandRefs.length);
  assert.equal(metrics.expansions, 1);
  assert.match(metrics.interpretation, /not model adoption/);
});
