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
import { cognitionRuntimeLeasePath, cognitionRuntimeSecretPath, cognitionRuntimeStartupPath, locksDirectory } from '../src/storage/layout.js';
import { withLock } from '../src/storage/lock.js';
import { loadRuntimePolicy, writeRuntimePolicy } from '../src/cognition/policy.js';
import { GitObserver } from '../src/cognition/git-observer.js';
import { readRuntimeDiagnostic } from '../src/cognition/runtime-diagnostics.js';

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

test('startup retries a busy publication lock instead of abandoning the background launch', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withLock(path.join(locksDirectory(root), 'cognition-runtime-start.lock'), async () => {
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await locked;
    runtime = await serveRuntime(root);
    await holder;
    assert.equal((await runtimeStatus(root)).running, true);
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('background bootstrap exit is reported promptly and a clean retry succeeds', async () => {
  const root = await project();
  const original = process.env.NODE_OPTIONS;
  try {
    await initializedRuntime(root);
    const preload = path.join(root, 'exit.cjs');
    await writeFile(preload, 'process.exit(37);');
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    const before = Date.now();
    await assert.rejects(startRuntime(root), /background process failed.*exit 37/);
    assert.ok(Date.now() - before < 5_000, 'must not wait for the ten second startup deadline');
    const diagnostic = await readRuntimeDiagnostic(root);
    assert.equal(diagnostic?.phase, 'spawn');
    assert.equal(diagnostic?.failure?.exitCode, 37);
    assert.equal(diagnostic?.outcome, 'failed');
    assert.equal((await runtimeStatus(root)).lease, null);
    await assert.rejects(access(cognitionRuntimeStartupPath(root)));
    if (original === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
    assert.equal((await startRuntime(root)).running, true);
    assert.equal((await readRuntimeDiagnostic(root))?.outcome, 'ready');
  } finally {
    if (original === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
    await stopRuntime(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('start does not report readiness while a live endpoint is still initializing', async (t) => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  let serving: ReturnType<typeof serveRuntime> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await initializedRuntime(root);
    const original = GitObserver.prototype.observeNow;
    t.mock.method(GitObserver.prototype, 'observeNow', async function (this: GitObserver) {
      await gate;
      return original.call(this);
    });
    await writeFile(cognitionRuntimeStartupPath(root), JSON.stringify({ attemptId: 'slow-fixture', pid: process.pid, createdAt: new Date().toISOString() }));
    serving = serveRuntime(root, { pollIntervalMs: 60_000 });
    for (let i = 0; i < 100; i++) {
      if ((await runtimeStatus(root)).running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await runtimeStatus(root)).diagnostics?.state, 'starting');
    await assert.rejects(startRuntime(root, { timeoutMs: 100 }), /startup is not yet confirmed/);
    release();
    runtime = await serving;
    await rm(cognitionRuntimeStartupPath(root));
    assert.equal((await startRuntime(root)).diagnostics?.state, 'ready');
  } finally {
    release();
    runtime ??= await serving?.catch(() => null) ?? null;
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('background exit immediately after lease publication is diagnosed and recoverable', async () => {
  const root = await project();
  const original = process.env.NODE_OPTIONS;
  try {
    await initializedRuntime(root);
    const preload = path.join(root, 'exit-after-lease.cjs');
    await writeFile(preload, `
      const fs = require('node:fs/promises');
      const rename = fs.rename;
      fs.rename = async (...args) => {
        const result = await rename(...args);
        if (String(args[1]).replaceAll('\\\\', '/').endsWith('/runtime/lease.json')) process.exit(41);
        return result;
      };
      require('node:module').syncBuiltinESMExports();
    `);
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    await assert.rejects(startRuntime(root), /background process failed.*exit 41/);
    const failed = await runtimeStatus(root);
    assert.equal(failed.running, false);
    assert.equal(failed.lease, null);
    assert.equal(failed.diagnostics?.state, 'failed');
    assert.equal(failed.diagnostics?.startup?.failure?.exitCode, 41);
    assert.equal(failed.diagnostics?.startup?.phase, 'publish-lease');
    if (original === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
    assert.equal((await startRuntime(root)).diagnostics?.state, 'ready');
  } finally {
    if (original === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
    await stopRuntime(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('malformed and reset IPC clients cannot terminate a runtime process', async () => {
  const root = await project();
  try {
    await initializedRuntime(root);
    const runtimeUrl = new URL('../src/cognition/runtime.js', import.meta.url).href;
    const script = `
      import { createConnection } from 'node:net';
      const { serveRuntime, runtimeStatus } = await import(${JSON.stringify(runtimeUrl)});
      const root = process.argv[1];
      const runtime = await serveRuntime(root);
      try {
        for (const frame of ['null', '{"token":123}', '{"token":{}}']) {
          await new Promise((resolve, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port: runtime.lease.port });
            socket.on('error', reject);
            socket.on('data', () => socket.end());
            socket.on('close', resolve);
            socket.on('connect', () => socket.write(frame + '\\n'));
          });
        }
        for (let i = 0; i < 10; i++) {
          await new Promise(resolve => {
            const socket = createConnection({ host: '127.0.0.1', port: runtime.lease.port });
            socket.on('error', () => {});
            socket.on('close', resolve);
            socket.on('connect', () => socket.resetAndDestroy());
          });
        }
        if (!(await runtimeStatus(root)).running) throw new Error('runtime died');
      } finally { await runtime.close('test'); }
    `;
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script, root], { timeout: 15_000, windowsHide: true });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

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

test('stop retries a temporarily busy journal before publishing completion', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    runtime = await serveRuntime(root, { pollIntervalMs: 60_000 });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const holder = withLock(path.join(locksDirectory(root), 'cognition-journal.lock'), async () => {
      locked();
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await acquired;
    const stopped = await stopRuntime(root);
    await holder;
    assert.equal(stopped.lease, null);
    assert.ok((await readJournal(root)).some((event) => event.type === 'runtime.stopped' && event.source.instanceId === runtime?.lease.instanceId));
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('restart waits for the old stopped event before publishing a new lease', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    runtime = await serveRuntime(root, { pollIntervalMs: 60_000 });
    const oldId = runtime.lease.instanceId;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const holder = withLock(path.join(locksDirectory(root), 'cognition-journal.lock'), async () => {
      locked();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    });
    await acquired;
    const closing = runtime.close('test-restart');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await runtimeStatus(root);
      if (!status.running && status.lease) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const restarted = await startRuntime(root);
    await Promise.all([holder, closing]);
    const events = await readJournal(root);
    const stoppedIndex = events.findIndex((event) => event.type === 'runtime.stopped' && event.source.instanceId === oldId);
    const startedIndex = events.findIndex((event) => event.type === 'runtime.started' && event.source.instanceId === restarted.lease?.instanceId);
    assert.ok(stoppedIndex >= 0 && startedIndex > stoppedIndex);
    await stopRuntime(root);
  } finally {
    await runtime?.close('test');
    await stopRuntime(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('stop clears an abandoned lease after its heartbeat expires', async () => {
  const root = await project();
  try {
    await initializedRuntime(root);
    await writeFile(cognitionRuntimeLeasePath(root), JSON.stringify({
      schemaVersion: 2, protocolVersion: 1, projectId: 'stale', instanceId: 'abandoned',
      pid: process.pid, host: '127.0.0.1', port: 1,
      startedAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z',
    }));
    const stopped = await stopRuntime(root);
    assert.equal(stopped.running, false);
    assert.equal(stopped.lease, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stop issued during startup waits for the new runtime to exit', async () => {
  const root = await project();
  try {
    await initializedRuntime(root);
    const started = startRuntime(root);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await access(cognitionRuntimeStartupPath(root)).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await access(cognitionRuntimeStartupPath(root)).then(() => true, () => false), true);
    const stopped = stopRuntime(root);
    await started.catch(() => undefined);
    const result = await stopped;
    assert.equal(result.running, false);
    assert.equal(result.lease, null);
  } finally {
    await stopRuntime(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    runtime = await serveRuntime(root, { inactivityTimeoutMs: 1_500, heartbeatIntervalMs: 50, pollIntervalMs: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(await touchRuntime(root), true);
    await new Promise((resolve) => setTimeout(resolve, 900));
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
