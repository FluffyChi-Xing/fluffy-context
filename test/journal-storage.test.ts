import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, appendFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/runtime/init.js';
import { checkpoint } from '../src/runtime/runtime.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { appendEvent, appendEvents, compactJournal, readJournal, verifyJournal } from '../src/cognition/journal.js';
import { projectEvents } from '../src/cognition/projections.js';
import { cognitionJournalDirectory, locksDirectory } from '../src/storage/layout.js';
import { JOURNAL_SEGMENT_BYTES, journalStorage } from '../src/cognition/journal-segments.js';
import { loadRuntimePolicy, writeRuntimePolicy } from '../src/cognition/policy.js';
import { readAdmissionStats } from '../src/cognition/admission.js';
import { withLock } from '../src/storage/lock.js';
import { filterPaths } from '../src/capture/context-filter.js';
import { readJournalIndexed, rebuildJournalIndex } from '../src/cognition/journal-index.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-journal-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  return root;
}

test('batch append preserves hash links, duplicate semantics and partial retry recovery', async (t) => {
  const root = await fixture(t);
  const a = { type: 'runtime.enabled' as const, idempotencyKey: 'batch-a', payload: { value: 1 } };
  const b = { ...a, idempotencyKey: 'batch-b' };
  const result = await appendEvents(root, [a, a, b]);
  assert.deepEqual(result.map((item) => item.appended), [true, false, true]);
  assert.equal(result[2].event.previousHash, result[0].event.hash);
  await assert.rejects(appendEvents(root, [{ ...a, idempotencyKey: 'batch-c' }, { ...a, payload: { value: 2 } }]), /idempotency key conflict/);
  const retry = await appendEvents(root, [{ ...a, idempotencyKey: 'batch-c' }, a]);
  assert.ok(retry.every((item) => !item.appended));
  assert.equal((await verifyJournal(root)).length, 3);
});

test('archive preview is read-only; gzip replay preserves identities, projections and idempotency', async (t) => {
  const root = await fixture(t);
  await checkpoint(root, { progressSummary: '可追溯的真实项目状态', decisions: ['保留所有权威事件'] });
  await importV1(root);
  const input = { type: 'runtime.enabled' as const, idempotencyKey: 'same-after-archive', payload: {} };
  await appendEvent(root, input);
  const before = await readJournal(root);
  const directory = cognitionJournalDirectory(root);
  const raw = await readFile(path.join(directory, '00000001.ndjson'));
  const preview = await compactJournal(root);
  assert.equal(preview.applied, false);
  assert.deepEqual(await readFile(path.join(directory, '00000001.ndjson')), raw);
  const result = await compactJournal(root, { apply: true });
  assert.ok(result.savedBytes > 0);
  assert.deepEqual(await verifyJournal(root), before);
  assert.deepEqual(projectEvents(await readJournal(root)), projectEvents(before));
  assert.equal((await appendEvent(root, input)).appended, false);
  const next = await appendEvent(root, { ...input, idempotencyKey: 'next' });
  assert.equal(next.event.previousHash, before.at(-1)?.hash);
  assert.deepEqual((await readdir(directory)).sort(), ['00000001.ndjson.gz', '00000002.ndjson']);
  assert.equal((await verifyJournal(root)).length, before.length + 1);
});

test('sealed-segment index accelerates repeat reads and falls back safely when stale or corrupt', async (t) => {
  const root = await fixture(t);
  await appendEvent(root, { type: 'runtime.enabled', idempotencyKey: 'index-one', payload: {} });
  await compactJournal(root, { apply: true });
  await appendEvent(root, { type: 'runtime.started', idempotencyKey: 'index-two', payload: {} });
  const expected = await readJournal(root);
  const initiallyIndexed = await readJournalIndexed(root);
  assert.equal(initiallyIndexed.mode, 'indexed');
  assert.deepEqual(initiallyIndexed.events, expected);
  const built = await rebuildJournalIndex(root);
  assert.equal(built.segments, 1);
  assert.equal(built.sealedEventCount, 1);
  const indexed = await readJournalIndexed(root);
  assert.equal(indexed.mode, 'indexed');
  assert.deepEqual(indexed.events, expected);
  const cache = path.join(root, '.context', 'v2', 'cache', 'journal-index.json');
  await writeFile(cache, '{broken');
  const recovered = await readJournalIndexed(root);
  assert.equal(recovered.mode, 'full');
  assert.deepEqual(recovered.events, expected);
  assert.equal((await rebuildJournalIndex(root)).sealedEventCount, 1);
  await compactJournal(root, { apply: true });
  assert.equal((await readJournalIndexed(root)).mode, 'full');
  assert.deepEqual(await readJournal(root), expected);
});

test('failed journal index rebuild preserves the previous cache', async (t) => {
  const root = await fixture(t);
  await appendEvent(root, { type: 'runtime.enabled', idempotencyKey: 'cache-preservation', payload: {} });
  await compactJournal(root, { apply: true });
  await rebuildJournalIndex(root);
  const cache = path.join(root, '.context', 'v2', 'cache', 'journal-index.json');
  const before = await readFile(cache);
  await writeFile(path.join(cognitionJournalDirectory(root), '00000002.ndjson'), '{broken\n');
  await assert.rejects(() => rebuildJournalIndex(root), /invalid journal record/);
  assert.deepEqual(await readFile(cache), before);
});

test('interrupted archive publication deduplicates matching bytes and refuses conflicting copies', async (t) => {
  const root = await fixture(t);
  await appendEvent(root, { type: 'runtime.enabled', idempotencyKey: 'one', payload: {} });
  const directory = cognitionJournalDirectory(root);
  const file = path.join(directory, '00000001.ndjson');
  const raw = await readFile(file);
  await compactJournal(root, { apply: true });
  await writeFile(file, raw);
  assert.equal((await readJournal(root)).length, 1);
  const duplicateBytes = (await journalStorage(root)).bytes;
  await compactJournal(root, { apply: true });
  assert.equal(duplicateBytes - (await journalStorage(root)).bytes, raw.length);
  await writeFile(file, Buffer.concat([raw, Buffer.from('changed')]));
  await assert.rejects(() => compactJournal(root, { apply: true }), /archive\/raw mismatch/);
  assert.equal((await readFile(file)).length, raw.length + 7);
  await rm(file);
  await writeFile(`${file}.gz`, 'corrupt gzip');
  await assert.rejects(() => verifyJournal(root), /invalid journal archive/);
});

test('automatic rotation retains the cross-segment hash chain', async (t) => {
  const root = await fixture(t);
  const first = await appendEvent(root, { type: 'runtime.enabled', idempotencyKey: 'large', payload: { details: 'x'.repeat(JOURNAL_SEGMENT_BYTES) } });
  const next = await appendEvent(root, { type: 'runtime.stopped', idempotencyKey: 'next', payload: {} });
  assert.equal(next.event.previousHash, first.event.hash);
  assert.equal((await journalStorage(root)).archives, 1);
  assert.equal((await verifyJournal(root)).length, 2);
});

test('partial-tail recovery truncates UTF-8 bytes correctly and never ignores a sealed tail', async (t) => {
  const root = await fixture(t);
  await appendEvent(root, { type: 'runtime.enabled', idempotencyKey: 'unicode', payload: { message: '中文项目知识 🐾' } });
  const directory = cognitionJournalDirectory(root);
  const firstFile = path.join(directory, '00000001.ndjson');
  await appendFile(firstFile, '{"中断');
  await appendEvent(root, { type: 'runtime.stopped', idempotencyKey: 'recovered', payload: {} });
  assert.equal((await verifyJournal(root)).length, 2);
  await appendFile(firstFile, '{broken');
  await writeFile(path.join(directory, '00000002.ndjson'), '');
  await assert.rejects(() => readJournal(root), /invalid journal record/);
  await assert.rejects(() => compactJournal(root, { apply: true }), /invalid journal record/);
});

test('observation budget drops optional capture with counters, preserving semantic writes', async (t) => {
  const root = await fixture(t);
  await importV1(root);
  await writeRuntimePolicy(root, { ...await loadRuntimePolicy(root), retentionMaxBytes: 1 });
  await assert.rejects(() => appendEvent(root, { type: 'host.prompt.submitted', idempotencyKey: 'noise', payload: { intent: 'bounded test prompt' } }), /observation budget/);
  assert.equal((await readAdmissionStats(root)).dropped['host.prompt.submitted'], 1);
  assert.equal((await readJournal(root)).length, 0);
  await checkpoint(root, { progressSummary: '不能因为容量限制丢失已验证的工作结果' });
  assert.equal((await readJournal(root)).length, 1);
  assert.deepEqual(await filterPaths(root, ['src/main.ts', 'debug.log', 'fluffy-context.tgz']), ['src/main.ts']);
});

test('live old locks and fresh incomplete locks cannot be stolen', async (t) => {
  const root = await fixture(t);
  const lock = path.join(locksDirectory(root), 'long-operation.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00Z' }));
  await assert.rejects(() => withLock(lock, async () => assert.fail('stolen')), /busy/);
  await writeFile(lock, '');
  await assert.rejects(() => withLock(lock, async () => assert.fail('stolen')), /busy/);
});

test('expired lock is recovered even when Windows reports its PID as alive', async (t) => {
  const root = await fixture(t);
  const lock = path.join(locksDirectory(root), 'abandoned.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00Z' }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal(await withLock(lock, async () => 'recovered'), 'recovered');
  assert.deepEqual(await readdir(locksDirectory(root)), []);
});

test('simultaneous reclaimers never enter the same critical section', async (t) => {
  const root = await fixture(t);
  const lock = path.join(locksDirectory(root), 'contended.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: '2000-01-01T00:00:00Z' }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  let active = 0;
  let entered = 0;
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => withLock(lock, async () => {
    active += 1;
    assert.equal(active, 1);
    entered += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    active -= 1;
  })));
  assert.equal(entered, 1);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
});
