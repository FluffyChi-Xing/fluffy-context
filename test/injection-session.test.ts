import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { checkpoint } from '../src/runtime/runtime.js';
import { learnKnowledge, verifyKnowledge, transitionKnowledge } from '../src/runtime/knowledge.js';
import { injectContext } from '../src/compiler/inject.js';
import { inspectInjectionSession } from '../src/compiler/session.js';

const execFileAsync = promisify(execFile);

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-injection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  return root;
}

async function fact(root: string, statement: string) {
  const candidate = await learnKnowledge(root, statement);
  return verifyKnowledge(root, candidate.knowledgeId);
}

test('session delivery is opt-in, hash-only, incremental, and resets after evidence retraction', async (t) => {
  const root = await fixture(t);
  await checkpoint(root, { title: 'Payment task', progressSummary: 'Check payment', pendingTasks: ['Run payment regression'] });
  const firstFact = await fact(root, 'Payment requires an idempotency key.');
  const stateless = await injectContext(root, { query: 'payment' });
  assert.equal(stateless.delivery.reason, 'stateless');
  assert.equal((await injectContext(root, { query: 'payment' })).text, stateless.text);
  await assert.rejects(readFile(path.join(root, '.context', 'injection-cache.json')), /ENOENT/);

  const options = { query: 'payment', sessionId: 'private-session-value', taskId: 'private-task-value' };
  assert.equal((await injectContext(root, options)).delivery.reason, 'first-in-session');
  const repeat = await injectContext(root, { ...options, eventId: 'another-event' });
  assert.equal(repeat.delivery.mode, 'unchanged');
  assert.equal(repeat.text, '');
  assert.equal(repeat.budget.usedChars, 0);
  assert.equal(repeat.sourceCount, 0);
  assert.ok(repeat.budget.compiledChars > 0);
  await learnKnowledge(root, 'Payment unverified secret conclusion');
  assert.equal((await injectContext(root, options)).delivery.mode, 'unchanged');

  await fact(root, 'Payment refund must reference the original charge.');
  const delta = await injectContext(root, options);
  assert.equal(delta.delivery.mode, 'delta');
  assert.match(delta.text, /refund/);
  assert.doesNotMatch(delta.text, /idempotency|progressSummary|unverified/);
  assert.equal(delta.budget.usedChars, delta.text.length);
  await transitionKnowledge(root, firstFact.knowledgeId, 'deprecated', 'Replaced by the new boundary');
  const replacement = await injectContext(root, options);
  assert.equal(replacement.delivery.reason, 'evidence-changed');
  assert.equal(replacement.delivery.replacePrevious, true);
  assert.match(replacement.text, /progressSummary/);
  assert.doesNotMatch(replacement.text, /idempotency/);

  const cache = await readFile(path.join(root, '.context', 'injection-cache.json'), 'utf8');
  assert.doesNotMatch(cache, /private-session-value|private-task-value|Payment|idempotency|refund/);
  const diagnostics = await inspectInjectionSession(root, 'agent:agent');
  assert.equal(diagnostics.lastLocalInvocation?.mode, 'full');
  assert.equal(diagnostics.hostAcceptance, 'not-observed');
});

test('session, task, budget, scope, adapter, and explicit reset boundaries force full delivery', async (t) => {
  const root = await fixture(t);
  await fact(root, 'Payment refund policy');
  const base = { query: 'payment', sessionId: 'one' };
  await injectContext(root, base);
  assert.equal((await injectContext(root, base)).delivery.mode, 'unchanged');
  for (const options of [
    { ...base, query: 'refund' }, { ...base, maxChars: 1200 }, { ...base, scope: 'other' },
    { ...base, paths: ['src/payment.ts'] }, { ...base, scenario: 'resume' as const },
    { ...base, resetSession: true }, { ...base, sessionId: 'two' }, { ...base, adapter: 'different-host' },
  ]) {
    await injectContext(root, base);
    assert.equal((await injectContext(root, options)).delivery.mode, 'full');
  }
  assert.equal((await injectContext(root, base, 'mcp')).delivery.mode, 'full');
  for (const options of [{ sessionId: '' }, { sessionId: ' '.repeat(2) }, { sessionId: 'x'.repeat(257) }, { taskId: 'orphan' }, { resetSession: true }]) {
    await assert.rejects(injectContext(root, options), /sessionId|require sessionId/);
  }
});

test('branch changes invalidate session delivery even when the selected evidence is identical', async (t) => {
  const root = await fixture(t);
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: root, windowsHide: true });
  await fact(root, 'Payment global invariant');
  const options = { query: 'payment', sessionId: 'branch-session' };
  await injectContext(root, options);
  assert.equal((await injectContext(root, options)).delivery.mode, 'unchanged');
  await execFileAsync('git', ['switch', '-c', 'other'], { cwd: root, windowsHide: true });
  const changed = await injectContext(root, options);
  assert.equal(changed.delivery.reason, 'task-or-scope-changed');
  assert.match(changed.text, /global invariant/);
});

test('expired, corrupt and contended receipts fail open and never suppress available context', async (t) => {
  const root = await fixture(t);
  await fact(root, 'Payment durable evidence');
  const options = { query: 'payment', sessionId: 'fallback' };
  await injectContext(root, options);
  const cachePath = path.join(root, '.context', 'injection-cache.json');
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  cache.sessions[0].updatedAt = Date.now() - 25 * 60 * 60 * 1000;
  await writeFile(cachePath, JSON.stringify(cache));
  assert.equal((await injectContext(root, options)).delivery.reason, 'first-in-session');
  await writeFile(cachePath, '{broken');
  assert.equal((await injectContext(root, options)).delivery.mode, 'full');
  await writeFile(cachePath, JSON.stringify({ schemaVersion: 999, sessions: [] }));
  const corrupt = await injectContext(root, options);
  assert.equal(corrupt.delivery.reason, 'cache-unavailable');
  assert.match(corrupt.text, /durable evidence/);
  await writeFile(path.join(root, '.context', 'injection-cache.lock'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  assert.equal((await injectContext(root, options)).delivery.reason, 'cache-unavailable');
});

test('session receipts stay bounded and do not follow symlinked cache files', async (t) => {
  const root = await fixture(t);
  await fact(root, 'Payment bounded evidence');
  for (let index = 0; index < 34; index++) await injectContext(root, { query: 'payment', sessionId: `session-${index}` });
  const cachePath = path.join(root, '.context', 'injection-cache.json');
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).sessions.length, 32);
  const target = path.join(root, 'outside-cache.txt');
  await writeFile(target, 'do not modify');
  await rm(cachePath);
  try { await symlink(target, cachePath, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.diagnostic('File symlinks unavailable on this platform; capacity checks completed.'); return; } throw error; }
  const result = await injectContext(root, { query: 'payment', sessionId: 'symlink' });
  assert.equal(result.delivery.reason, 'cache-unavailable');
  assert.equal(await readFile(target, 'utf8'), 'do not modify');
});
