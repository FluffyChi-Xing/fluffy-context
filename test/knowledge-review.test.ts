import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { learnKnowledge, listKnowledge, verifyKnowledge } from '../src/runtime/knowledge.js';
import { reviewKnowledge, batchKnowledge, type KnowledgeBatchOptions } from '../src/cognition/knowledge-review.js';
import { importMemory } from '../src/cognition/import-memory.js';
import { injectContext } from '../src/compiler/inject.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { readJournal } from '../src/cognition/journal.js';
import { withLock } from '../src/storage/lock.js';
import { locksDirectory } from '../src/storage/layout.js';
import { v1Synced } from '../src/cognition/v1-bridge.js';
import { checkpoint } from '../src/runtime/runtime.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await mkdir(path.join(root, 'memory'));
  return root;
}
async function apply(root: string, options: KnowledgeBatchOptions) {
  const preview = await batchKnowledge(root, options);
  return batchKnowledge(root, { ...options, apply: true, expectedToken: preview.token });
}

test('review is read-only, filtered, paginated and bounded across all serialized entries', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'memory', 'rules.md'), 'Payment callbacks must preserve idempotency across retries.');
  const imported = await importMemory(root, true);
  const first = imported.results[0].knowledgeId!;
  await learnKnowledge(root, 'Payment '.repeat(1000), { evidence: ['evidence'.repeat(1000)] });
  const before = await readFile(path.join(root, '.context', 'knowledge.json'), 'utf8');
  const files = await readdir(path.join(root, '.context'));
  const scoped = await reviewKnowledge(root, { source: 'memory/rules.md' });
  assert.deepEqual(scoped.items.map((item) => item.knowledgeId), [first]);
  const page = await reviewKnowledge(root, { limit: 1, maxChars: 600 });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextOffset, 1);
  const next = await reviewKnowledge(root, { offset: 1, maxChars: 600 });
  assert.equal(next.items.length, 1);
  assert.notEqual(page.items[0].knowledgeId, next.items[0].knowledgeId);
  for (const result of [page, next]) assert.ok(result.items.reduce((n, item) => n + JSON.stringify(item).length, 0) <= 600);
  assert.equal((await reviewKnowledge(root, { maxChars: 0 })).items.length, 0);
  assert.equal((await reviewKnowledge(root, { reviewRequired: true })).total, 0);
  assert.equal(await readFile(path.join(root, '.context', 'knowledge.json'), 'utf8'), before);
  assert.deepEqual(await readdir(path.join(root, '.context')), files);
  await assert.rejects(reviewKnowledge(root, { limit: 101 }), /limit/);
});

test('batch requires explicit preview and evidence, preflights all IDs, and rejects stale state', async (t) => {
  const root = await fixture(t);
  const a = await learnKnowledge(root, 'Payment A requires verification.');
  const b = await learnKnowledge(root, 'Payment B requires verification.');
  const options: KnowledgeBatchOptions = { ids: [a.knowledgeId, b.knowledgeId], action: 'verify', reason: 'Checked implementation', evidence: ['test/payment.test.ts'] };
  const before = await readFile(path.join(root, '.context', 'knowledge.json'), 'utf8');
  const preview = await batchKnowledge(root, options);
  assert.equal(preview.applied, false);
  assert.equal(await readFile(path.join(root, '.context', 'knowledge.json'), 'utf8'), before);
  await assert.rejects(batchKnowledge(root, { ...options, apply: true }), /expectedToken/);
  await assert.rejects(batchKnowledge(root, { ...options, evidence: [] }), /evidence/);
  await assert.rejects(batchKnowledge(root, { ...options, ids: [a.knowledgeId, 'know-missing'] }), /not found/);
  assert.equal((await listKnowledge(root)).length, 0);
  await verifyKnowledge(root, b.knowledgeId);
  await assert.rejects(batchKnowledge(root, { ...options, apply: true, expectedToken: preview.token }), /invalid.*transition/);
  assert.equal((await listKnowledge(root, true)).find((item) => item.knowledgeId === a.knowledgeId)?.status, 'candidate');
  const single = { ...options, ids: [a.knowledgeId] };
  const p = await batchKnowledge(root, single);
  await assert.rejects(batchKnowledge(root, { ...single, reason: 'different reason', apply: true, expectedToken: p.token }), /stale/);
});

test('batch deprecation retracts injected evidence and retry is idempotent', async (t) => {
  const root = await fixture(t);
  await importV1(root);
  const item = await learnKnowledge(root, 'Payment requires a unique transaction key.');
  await apply(root, { ids: [item.knowledgeId], action: 'verify', reason: 'Verified by test', evidence: ['test/payment.ts'] });
  const session = { query: 'payment', sessionId: 'review-session' };
  assert.match((await injectContext(root, session)).text, /unique transaction key/);
  const options: KnowledgeBatchOptions = { ids: [item.knowledgeId], action: 'deprecate', reason: 'Replaced by current payment contract' };
  const preview = await batchKnowledge(root, options);
  await batchKnowledge(root, { ...options, apply: true, expectedToken: preview.token });
  const before = await readFile(path.join(root, '.context', 'knowledge.json'), 'utf8');
  const retry = await batchKnowledge(root, { ...options, apply: true, expectedToken: preview.token });
  assert.equal(retry.alreadyApplied, true);
  assert.equal(await readFile(path.join(root, '.context', 'knowledge.json'), 'utf8'), before);
  const packet = await injectContext(root, session);
  assert.equal(packet.delivery.replacePrevious, true);
  assert.doesNotMatch(packet.text, /unique transaction key/);
});

test('batch preview binds related source hashes even when the statement is unchanged', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'memory', 'rules.md');
  await writeFile(source, 'Payment callbacks require a stable event identifier.');
  const id = (await importMemory(root, true)).results[0].knowledgeId!;
  const options: KnowledgeBatchOptions = { ids: [id], action: 'verify', reason: 'Reviewed source', evidence: ['src/payment.ts'] };
  const preview = await batchKnowledge(root, options);
  await writeFile(source, '# Payments\n\nPayment callbacks require a stable event identifier.');
  assert.deepEqual((await importMemory(root)).reviewRequired, [id]);
  await assert.rejects(batchKnowledge(root, { ...options, apply: true, expectedToken: preview.token }), /stale/);
  assert.equal((await listKnowledge(root)).length, 0);
});

test('keep closes a specific source revision and a later edit reopens review', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'memory', 'rules.md');
  await writeFile(source, 'Payment callbacks require a stable event ID.');
  const id = (await importMemory(root, true)).results[0].knowledgeId!;
  await verifyKnowledge(root, id);
  await writeFile(source, 'Payment callbacks require a transaction key.');
  await importMemory(root, true);
  assert.deepEqual((await reviewKnowledge(root, { reviewRequired: true })).items.map((item) => item.knowledgeId), [id]);
  const keep: KnowledgeBatchOptions = { ids: [id], action: 'keep', reason: 'Code still supports original rule', evidence: ['src/payments.ts:42'] };
  await apply(root, keep);
  assert.deepEqual((await importMemory(root)).reviewRequired, []);
  assert.deepEqual((await importMemory(root, true)).reviewRequired, []);
  assert.equal((await listKnowledge(root)).find((item) => item.knowledgeId === id)?.status, 'verified');
  await writeFile(source, 'Payment callbacks use a revised settlement contract.');
  assert.ok((await importMemory(root)).reviewRequired.includes(id));
  const preview = await batchKnowledge(root, keep);
  await writeFile(source, 'Payment callbacks use another settlement contract.');
  await assert.rejects(batchKnowledge(root, { ...keep, apply: true, expectedToken: preview.token }), /stale/);
  await writeFile(source, 'password=do-not-import-this-value');
  await assert.rejects(batchKnowledge(root, keep), /incomplete/);
});

test('batch locking prevents concurrent writes; journal failure is reported and retry repairs it', async (t) => {
  const root = await fixture(t);
  await importV1(root);
  const a = await learnKnowledge(root, 'Payment first invariant for batch mirroring.');
  const b = await learnKnowledge(root, 'Payment second invariant for batch mirroring.');
  const options: KnowledgeBatchOptions = { ids: [a.knowledgeId, b.knowledgeId], action: 'verify', reason: 'Tests passed', evidence: ['test/payment.ts'] };
  const preview = await batchKnowledge(root, options);
  const request = { ...options, apply: true, expectedToken: preview.token };
  await withLock(path.join(locksDirectory(root), 'knowledge.lock'), async () => {
    await assert.rejects(batchKnowledge(root, request), /busy/);
    assert.equal((await listKnowledge(root)).length, 0);
  });
  await withLock(path.join(locksDirectory(root), 'cognition-journal.lock'), async () => {
    const applied = await batchKnowledge(root, request);
    assert.equal(applied.applied, true);
    assert.equal(applied.synchronization?.status, 'pending');
    assert.equal((await listKnowledge(root)).length, 2);
    assert.equal(await v1Synced(root), false);
  });
  const repaired = await batchKnowledge(root, request);
  assert.equal(repaired.alreadyApplied, true);
  assert.equal(repaired.synchronization?.status, 'complete');
  assert.equal(await v1Synced(root), true);
  const count = (await readJournal(root)).length;
  await batchKnowledge(root, request);
  assert.equal((await readJournal(root)).length, count);
});

test('unrelated successful mirroring cannot reintroduce a retired record after pending batch synchronization', async (t) => {
  const root = await fixture(t);
  await checkpoint(root, { title: 'Payment review', progressSummary: 'Review payment invariants' });
  await importV1(root);
  const item = await learnKnowledge(root, 'Payment obsolete batch invariant must never return.');
  await verifyKnowledge(root, item.knowledgeId);
  assert.match((await injectContext(root, { query: 'payment' })).text, /obsolete batch invariant/);
  const request: KnowledgeBatchOptions = { ids: [item.knowledgeId], action: 'deprecate', reason: 'No longer applies' };
  const preview = await batchKnowledge(root, request);
  await withLock(path.join(locksDirectory(root), 'cognition-journal.lock'), async () => {
    const result = await batchKnowledge(root, { ...request, apply: true, expectedToken: preview.token });
    assert.equal(result.synchronization?.status, 'pending');
  });
  await learnKnowledge(root, 'Unrelated candidate recorded after the pending batch.');
  assert.doesNotMatch((await injectContext(root, { query: 'payment' })).text, /obsolete batch invariant/);
});
