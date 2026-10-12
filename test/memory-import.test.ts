import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryBlocks } from '../src/cognition/memory-blocks.js';
import { importMemory } from '../src/cognition/import-memory.js';
import { initProject } from '../src/runtime/init.js';
import { listKnowledge, verifyKnowledge, transitionKnowledge } from '../src/runtime/knowledge.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { readJournal } from '../src/cognition/journal.js';
import { v1Synced } from '../src/cognition/v1-bridge.js';
import { withLock } from '../src/storage/lock.js';
import { locksDirectory } from '../src/storage/layout.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await mkdir(path.join(root, 'memory'));
  return root;
}

test('empty import explains project boundaries and the direct knowledge alternative', async (t) => {
  const root = await fixture(t);
  const result = await importMemory(root);
  assert.equal(result.discovery.status, 'no-source-files');
  assert.equal(result.discovery.scope, 'project-only');
  assert.ok(result.discovery.searchedSources.includes('.zcode'));
  assert.match(result.guidance, /ctx learn/);
  assert.match(result.guidance, /context_learn/);
  assert.match(result.guidance, /Do not create, copy or move/);
  await assert.rejects(importMemory(path.join(root, 'missing')), /target project.*ctx learn/);
});

test('forty imported records preserve journal parity, source evidence and retry deduplication', async (t) => {
  const root = await fixture(t);
  await importV1(root);
  const text = Array.from({ length: 40 }, (_, i) => `- Rule ${i}: preserve the payment request identifier.`).join('\n');
  await writeFile(path.join(root, 'memory', 'rules.md'), text);
  const applied = await importMemory(root, true);
  assert.equal(applied.results.length, 40);
  assert.equal(applied.synchronization, 'complete');
  assert.equal(await v1Synced(root), true);
  const knowledge = await listKnowledge(root, true);
  assert.equal(knowledge.length, 40);
  assert.ok(knowledge.every((item) => item.status === 'candidate' && item.supportingEvidence.some((value) => value.startsWith('memory/rules.md:'))));
  const journal = await readJournal(root);
  assert.equal(journal.filter((event) => event.type === 'knowledge.proposed').length, 40);
  assert.ok((await importMemory(root, true)).results.every((item) => item.status === 'duplicate'));
  assert.equal((await readJournal(root)).length, journal.length);
});

test('import retry repairs pending journal synchronization without duplicate knowledge', async (t) => {
  const root = await fixture(t);
  await importV1(root);
  await writeFile(path.join(root, 'memory', 'rules.md'), '- First payment rule preserves its request identifier.\n- Second payment rule preserves its original currency.');
  await withLock(path.join(locksDirectory(root), 'cognition-journal.lock'), async () => {
    const applied = await importMemory(root, true);
    assert.equal(applied.synchronization, 'pending');
    assert.equal((await listKnowledge(root, true)).length, 2);
  });
  const retry = await importMemory(root, true);
  assert.equal(retry.synchronization, 'complete');
  assert.ok(retry.results.every((item) => item.status === 'duplicate'));
  assert.equal((await listKnowledge(root, true)).length, 2);
  assert.equal(await v1Synced(root), true);
  assert.equal((await readJournal(root)).filter((event) => event.type === 'knowledge.proposed').length, 2);
});

test('memory blocks preserve wrapped paragraphs, list continuations, tables and source ranges', () => {
  const result = memoryBlocks([
    '---', 'description: Do not import this front matter description', '---', '# Payments',
    'The payment callback must use', 'an idempotency key before changing the order.', '',
    '- Refunds reference the original charge', '  and preserve its currency.',
    '- Failed callbacks can be retried safely.', '',
    '| Scenario | Upload |', '| --- | --- |', '| Face failure | No |', '',
    '~~~~js', 'This example must never become a knowledge candidate.', '~~~', 'Still inside a longer fence.', '~~~~',
    '<!-- fluffy-context:start -->', 'Generated agent instructions must not be imported.', '<!-- fluffy-context:end -->',
  ].join('\n'));
  assert.equal(result.blocks.length, 4);
  assert.deepEqual(result.blocks[0], { line: 5, endLine: 6, headings: ['Payments'], statement: 'The payment callback must use an idempotency key before changing the order.' });
  assert.match(result.blocks[1].statement, /charge and preserve/);
  assert.match(result.blocks[3].statement, /Scenario.*\n.*---.*\n.*Face failure/s);
  assert.doesNotMatch(JSON.stringify(result), /front matter description|never become|Generated agent/);
  assert.equal(memoryBlocks('---\ndescription: unclosed metadata should not become knowledge').blocks.length, 0);
  const privateBlock = memoryBlocks('# secret=private-header-value\nA harmless preface to a paragraph\npassword=private-body-value\n\nA separate paragraph is safe to import.');
  assert.equal(privateBlock.blocks.length, 1);
  assert.doesNotMatch(JSON.stringify(privateBlock), /private-header-value|private-body-value|harmless preface/);
  assert.equal(privateBlock.skipped[0].reason, 'potential-secret');
});

test('source changes remain reviewable after apply, never change trust, and terminal decisions stay terminal', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'memory', 'payment.md');
  const receipt = path.join(root, '.context', 'memory-import.json');
  await writeFile(source, '# Payments\nPayment callbacks require an idempotency key.\n');
  const before = await readdir(path.join(root, '.context'));
  const preview = await importMemory(root);
  assert.equal(preview.changes[0].status, 'new');
  assert.deepEqual(await readdir(path.join(root, '.context')), before);
  const applied = await importMemory(root, true);
  const oldId = applied.results[0].knowledgeId!;
  await verifyKnowledge(root, oldId);
  const baseline = await readFile(receipt, 'utf8');
  await writeFile(source, '# Payments\n\nPayment callbacks require an idempotency key.\n');
  const shifted = await importMemory(root);
  assert.equal(shifted.results[0].status, 'duplicate');
  assert.equal(shifted.results[0].knowledgeId, oldId);
  assert.deepEqual(shifted.reviewRequired, []);
  assert.equal(await readFile(receipt, 'utf8'), baseline);
  await writeFile(source, '# Payments\nPayment callbacks must check the event identifier before committing.\n');
  const changed = await importMemory(root, true);
  assert.deepEqual(changed.reviewRequired, [oldId]);
  assert.equal(changed.changes[0].status, 'modified');
  assert.equal(changed.results[0].knowledgeStatus, 'candidate');
  assert.equal((await listKnowledge(root)).find((item) => item.knowledgeId === oldId)?.status, 'verified');
  assert.deepEqual((await importMemory(root, true)).reviewRequired, [oldId], 'apply must not acknowledge unresolved review');
  await transitionKnowledge(root, oldId, 'deprecated', 'Source changed; replacement reviewed separately.');
  assert.deepEqual((await importMemory(root)).reviewRequired, []);
  const newId = changed.results[0].knowledgeId!;
  await transitionKnowledge(root, newId, 'rejected', 'Not supported by code.');
  const rejected = await importMemory(root, true);
  assert.equal(rejected.results[0].knowledgeStatus, 'rejected');
  assert.equal((await listKnowledge(root, true)).length, 2);
  await rm(source);
  const removed = await importMemory(root, true);
  assert.equal(removed.changes[0].status, 'removed');
  assert.equal((await importMemory(root)).changes[0].status, 'unchanged');
});

test('partial and ignored sources retain the baseline; actual removal requires review', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'memory', 'rules.md');
  await writeFile(source, 'A trusted invariant must remain until explicitly reviewed.');
  const applied = await importMemory(root, true);
  const id = applied.results[0].knowledgeId!;
  const baseline = await readFile(path.join(root, '.context', 'memory-import.json'), 'utf8');
  await writeFile(source, 'password=secret-value-do-not-import\n');
  const partial = await importMemory(root, true);
  assert.equal(partial.changes[0].status, 'partial');
  assert.deepEqual(partial.reviewRequired, []);
  assert.equal(await readFile(path.join(root, '.context', 'memory-import.json'), 'utf8'), baseline);
  await writeFile(path.join(root, '.contextignored'), 'memory/\n');
  await rm(source);
  assert.equal((await importMemory(root, true)).changes[0].status, 'unavailable');
  await writeFile(path.join(root, '.contextignored'), '');
  const removed = await importMemory(root, true);
  assert.deepEqual(removed.reviewRequired, [id]);
  assert.deepEqual((await importMemory(root)).reviewRequired, [id]);
});

test('receipt corruption refuses writes and concurrent imports do not duplicate candidates', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'memory', 'facts.md'), 'Concurrent imports must preserve a single candidate for this fact.');
  const runs = await Promise.allSettled([importMemory(root, true), importMemory(root, true)]);
  assert.ok(runs.some((run) => run.status === 'fulfilled'));
  for (const run of runs) if (run.status === 'rejected') assert.match(String(run.reason), /busy/);
  await importMemory(root, true);
  assert.equal((await listKnowledge(root, true)).length, 1);
  const receipt = path.join(root, '.context', 'memory-import.json');
  await writeFile(receipt, '{broken');
  await assert.rejects(importMemory(root, true));
  assert.equal(await readFile(receipt, 'utf8'), '{broken');
  assert.equal((await listKnowledge(root, true)).length, 1);
});

test('candidate limits and symlinked source directories cannot retract previously imported evidence', async (t) => {
  const root = await fixture(t);
  const source = path.join(root, 'memory', 'facts.md');
  await writeFile(source, 'The final durable invariant must remain linked to its source.');
  const applied = await importMemory(root, true);
  const baseline = await readFile(path.join(root, '.context', 'memory-import.json'), 'utf8');
  await writeFile(source, Array.from({ length: 501 }, (_, index) => `- Candidate ${index} is a bounded imported statement.`).join('\n'));
  const preview = await importMemory(root);
  assert.equal(preview.results.length, 500);
  assert.equal(preview.changes[0].status, 'partial');
  assert.deepEqual(preview.reviewRequired, []);
  assert.equal(await readFile(path.join(root, '.context', 'memory-import.json'), 'utf8'), baseline);
  await rm(path.join(root, 'memory'), { recursive: true });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ctx-memory-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'facts.md'), 'An external fact must not be read through a directory symlink.');
  await symlink(outside, path.join(root, 'memory'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await importMemory(root, true);
  assert.equal(linked.results.length, 0);
  assert.equal(linked.changes[0].status, 'unavailable');
  assert.deepEqual(linked.reviewRequired, []);
  assert.equal((await listKnowledge(root, true))[0].knowledgeId, applied.results[0].knowledgeId);
});

test('Claude worktree storage and nested repositories do not become project memory', async (t) => {
  const root = await fixture(t);
  const worktree = path.join(root, '.claude', 'worktrees', 'old-agent');
  const nested = path.join(root, 'memory', 'other-project');
  await mkdir(worktree, { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(worktree, 'README.md'), 'Old checkout documentation must not be imported as current project memory.');
  await writeFile(path.join(nested, 'MEMORY.md'), 'Another repository must not supply facts for the outer project.');
  const initial = await importMemory(root, true);
  assert.equal(initial.results.length, 1);
  await writeFile(path.join(nested, '.git'), 'gitdir: unused-fixture');
  const excluded = await importMemory(root, true);
  assert.equal(excluded.results.length, 0);
  assert.ok(excluded.skipped.some((item) => item.reason === 'worktree-storage'));
  assert.ok(excluded.skipped.some((item) => item.reason === 'nested-repository'));
  assert.equal(excluded.changes[0].status, 'unavailable');
  assert.deepEqual(excluded.reviewRequired, []);
});
