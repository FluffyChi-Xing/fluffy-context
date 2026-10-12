import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { readJournal } from '../src/cognition/journal.js';
import { disableRuntime, enableRuntime, ensureRuntimeForSession, observeRuntime, runtimeStatus, serveRuntime, setFilesystemEvents, startRuntime, stopRuntime, touchRuntime } from '../src/cognition/runtime.js';
import { cognitionRuntimeSecretPath, cognitionRuntimeStartupPath } from '../src/storage/layout.js';
import { loadRuntimePolicy, writeRuntimePolicy } from '../src/cognition/policy.js';
import { GitObserver } from '../src/cognition/git-observer.js';

const execFileAsync = promisify(execFile);

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-runtime-'));
}

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

async function initializedRuntime(root: string): Promise<void> {
  await initProject(root);
  await importV1(root);
  await enableRuntime(root);
}

test('explicit observation waits for slow Git work beyond the ping deadline', async (t) => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    runtime = await serveRuntime(root, { pollIntervalMs: 60_000 });
    const original = GitObserver.prototype.observeNow;
    t.mock.method(GitObserver.prototype, 'observeNow', async function (this: GitObserver) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return original.call(this);
    });
    assert.equal(await observeRuntime(root), true);
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('stop waits for pending writes beyond the old two second deadline', async (t) => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    runtime = await serveRuntime(root, { pollIntervalMs: 60_000 });
    const original = GitObserver.prototype.drain;
    t.mock.method(GitObserver.prototype, 'drain', async function (this: GitObserver) {
      await new Promise((resolve) => setTimeout(resolve, 2300));
      return original.call(this);
    });
    const stopped = await stopRuntime(root);
    assert.equal(stopped.running, false);
    assert.equal(stopped.lease, null);
    assert.equal((await runtimeStatus(root)).running, false);
    assert.ok((await readJournal(root)).some((event) => event.type === 'runtime.stopped'));
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('migrated projects auto-start one runtime and reuse concurrent ensure calls', async () => {
  const root = await project();
  try {
    await initProject(root);
    await importV1(root);
    const results = await Promise.all([
      ensureRuntimeForSession(root, { timeoutMs: 2_000 }),
      ensureRuntimeForSession(root, { timeoutMs: 2_000 }),
      ensureRuntimeForSession(root, { timeoutMs: 2_000 }),
    ]);
    assert.ok(results.some((result) => result.started && result.running));
    assert.ok(results.every((result) => result.running));
    const events = await readJournal(root);
    assert.equal(events.filter((event) => event.type === 'runtime.started').length, 1);
    const stopped = await stopRuntime(root);
    assert.equal(stopped.running, false);
  } finally {
    await stopRuntime(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('runtime disable is a persistent opt-out from automatic startup', async () => {
  const root = await project();
  try {
    await initProject(root);
    await importV1(root);
    const disabled = await disableRuntime(root);
    assert.equal(disabled.enabled, false);
    const ensured = await ensureRuntimeForSession(root);
    assert.deepEqual(ensured, { projectRoot: root, started: false, running: false, skipped: 'disabled' });
    assert.equal((await runtimeStatus(root)).running, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime serves authenticated loopback IPC without exposing its capability token', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    runtime = await serveRuntime(root);
    const status = await runtimeStatus(root);
    assert.equal(status.running, true);
    assert.equal(status.lease?.host, '127.0.0.1');
    assert.ok((status.lease?.port ?? 0) > 0);
    assert.equal('projectId' in (status.lease ?? {}), false);
    const secret = await readFile(cognitionRuntimeSecretPath(root), 'utf8');
    assert.ok(secret.length >= 40);
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(await observeRuntime(root), true);
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime stops after inactivity without external activity', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    runtime = await serveRuntime(root, { inactivityTimeoutMs: 300, heartbeatIntervalMs: 50, pollIntervalMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await assert.rejects(() => access(path.join(root, '.context', 'v2', 'runtime', 'lease.json')));
    runtime = null;
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime inactivity is refreshed by explicit activity', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    runtime = await serveRuntime(root, { inactivityTimeoutMs: 1_000, heartbeatIntervalMs: 50, pollIntervalMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await touchRuntime(root), true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await runtimeStatus(root)).running, true);
    await runtime.close('test');
    runtime = null;
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime records allowed filesystem changes without recording file contents', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    const policy = await loadRuntimePolicy(root);
    await writeRuntimePolicy(root, { ...policy, filesystemEventsEnabled: true });
    runtime = await serveRuntime(root, { inactivityTimeoutMs: 2_000, heartbeatIntervalMs: 50, pollIntervalMs: 100 });
    await writeFile(path.join(root, 'runtime-observed.txt'), 'private file content');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const events = await readJournal(root);
      if (events.some((event) => event.type === 'workspace.paths.changed')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const events = await readJournal(root);
    const changed = events.find((event) => event.type === 'workspace.paths.changed');
    assert.ok(changed);
    assert.deepEqual((changed.payload as { paths: string[] }).paths, ['runtime-observed.txt']);
    assert.equal(JSON.stringify(changed).includes('private file content'), false);
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem observation can be enabled explicitly and still respects .contextignored', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initProject(root);
    await importV1(root);
    await writeFile(path.join(root, '.contextignored'), 'ignored.txt\n');
    const disabled = await loadRuntimePolicy(root);
    assert.equal(disabled.filesystemEventsEnabled, false);
    const status = await setFilesystemEvents(root, true);
    assert.equal(status.running, false);
    assert.equal((await loadRuntimePolicy(root)).filesystemEventsEnabled, true);
    runtime = await serveRuntime(root, { pollIntervalMs: 100, heartbeatIntervalMs: 50 });
    await writeFile(path.join(root, 'observed.txt'), 'recorded');
    await writeFile(path.join(root, 'ignored.txt'), 'not recorded');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const events = await readJournal(root);
      if (events.some((event) => event.type === 'workspace.paths.changed')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const events = await readJournal(root);
    const changed = events.filter((event) => event.type === 'workspace.paths.changed');
    assert.ok(changed.length > 0);
    const paths = changed.flatMap((event) => (event.payload as { paths: string[] }).paths);
    assert.ok(paths.includes('observed.txt'));
    assert.equal(paths.includes('ignored.txt'), false);
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime observes exact Git branch and HEAD transitions', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await git(['init'], root);
    await git(['config', 'user.email', 'runtime@example.test'], root);
    await git(['config', 'user.name', 'Runtime Test'], root);
    await git(['commit', '--allow-empty', '-m', 'initial'], root);
    await initializedRuntime(root);
    runtime = await serveRuntime(root);
    await git(['checkout', '-b', 'feature/runtime'], root);
    assert.equal(await observeRuntime(root), true);
    await git(['commit', '--allow-empty', '-m', 'runtime branch'], root);
    assert.equal(await observeRuntime(root), true);
    const events = await readJournal(root);
    assert.ok(events.some((event) => event.type === 'git.branch.changed' && event.git.branch === 'feature/runtime'));
    assert.ok(events.some((event) => event.type === 'git.head.changed' && event.git.branch === 'feature/runtime'));
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});
