import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { loadManifest } from '../runtime/init.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { readJson } from '../storage/json-store.js';
import { withLock } from '../storage/lock.js';
import { cognitionManifestPath, cognitionRuntimeLeasePath, cognitionRuntimeSecretPath, cognitionRuntimeStartupPath, locksDirectory } from '../storage/layout.js';
import { appendEvent } from './journal.js';
import type { AppendEventInput } from './journal.js';
import { rebuildProjections } from './projections.js';
import { loadRuntimePolicy, writeRuntimePolicy } from './policy.js';
import { FilesystemObserver } from './filesystem-observer.js';
import { GitObserver } from './git-observer.js';
import { reconcileV1State } from './migration-v1.js';
import { v1Synced } from './v1-bridge.js';
import type { CognitionRuntimePolicy, RuntimeLease, RuntimeStatus } from './types.js';
import { readRuntimeDiagnostic, runtimeFailureCode, runtimeProcessAlive, writeRuntimeDiagnostic, type StartupPhase } from './runtime-diagnostics.js';

const host = '127.0.0.1' as const;
const protocolVersion = 1 as const;
const maxFrameBytes = 16 * 1024;
const pollIntervalMs = 2_000;
const workerPath = fileURLToPath(new URL('./runtime-worker.js', import.meta.url));
const startupPromises = new Map<string, Promise<RuntimeStatus>>();

interface RuntimeRequest {
  token: string;
  method: 'ping' | 'observe' | 'stop';
}

interface RuntimeResponse {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

export interface RuntimeServer {
  lease: RuntimeLease;
  close(reason?: string): Promise<void>;
}

interface RuntimeServeOptions {
  onStartupPhase?: (phase: StartupPhase) => Promise<void>;
  inactivityTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
}

export interface EnsureRuntimeOptions {
  source?: 'claude-hook' | 'mcp' | 'cli';
  timeoutMs?: number;
}

export interface EnsureRuntimeResult {
  projectRoot: string;
  started: boolean;
  running: boolean;
  skipped: 'disabled' | 'not-migrated' | 'already-running' | 'startup-in-progress' | 'startup-failed' | 'unavailable' | null;
}

interface StartupMarker {
  attemptId: string;
  pid: number;
  createdAt: string;
}

const startupMarkerTimeoutMs = 10_000;

function createInstanceId(): string {
  return crypto.randomBytes(12).toString('hex');
}

function createToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function sameToken(left: string, right: string): boolean {
  const expected = Buffer.from(left);
  const actual = Buffer.from(right);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function publicLease(lease: RuntimeLease): Omit<RuntimeLease, 'projectId'> {
  const { projectId: _, ...visible } = lease;
  return visible;
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function loadPolicy(projectRoot: string): Promise<CognitionRuntimePolicy> {
  return loadRuntimePolicy(projectRoot);
}

async function loadLease(projectRoot: string): Promise<RuntimeLease | null> {
  return readJson<RuntimeLease>(cognitionRuntimeLeasePath(projectRoot)).catch(() => null);
}

async function loadStartupMarker(projectRoot: string): Promise<StartupMarker | null> {
  return readJson<StartupMarker>(cognitionRuntimeStartupPath(projectRoot)).catch(() => null);
}

export async function clearRuntimeStartup(projectRoot: string, attemptId: string): Promise<void> {
  await publishWithRetry(projectRoot, async () => {
    if ((await loadStartupMarker(projectRoot))?.attemptId === attemptId) {
      await rm(cognitionRuntimeStartupPath(projectRoot), { force: true });
    }
  });
}

async function removeOwnedRuntimeFiles(projectRoot: string, instanceId: string): Promise<void> {
  const current = await loadLease(projectRoot);
  if (current?.instanceId !== instanceId) return;
  await rm(cognitionRuntimeSecretPath(projectRoot), { force: true });
  await rm(cognitionRuntimeLeasePath(projectRoot), { force: true });
}

async function removeAbandonedRuntimeFiles(projectRoot: string, lease: RuntimeLease): Promise<void> {
  const heartbeat = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat < 15_000) return;
  try {
    await withLock(`${locksDirectory(projectRoot)}/cognition-runtime-start.lock`, async () => {
      const current = await loadLease(projectRoot);
      if (current?.instanceId !== lease.instanceId || Date.now() - Date.parse(current.heartbeatAt) < 15_000) return;
      if (await liveLease(projectRoot, current)) return;
      await removeOwnedRuntimeFiles(projectRoot, current.instanceId);
    });
  } catch { /* A concurrent start or stop owns the coordination lock. */ }
}

async function request(projectRoot: string, lease: RuntimeLease, method: RuntimeRequest['method']): Promise<RuntimeResponse | null> {
  let secret: string;
  try { secret = (await readFile(cognitionRuntimeSecretPath(projectRoot), 'utf8')).trim(); } catch { return null; }
  if (!secret || lease.host !== host || !Number.isInteger(lease.port) || lease.port <= 0) return null;
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: lease.port });
    let buffer = '';
    // Observation can queue Git/filesystem scans and projection synchronization;
    // it needs a longer deadline than a lightweight liveness probe.
    const timeout = setTimeout(() => { socket.destroy(); resolve(null); }, method === 'observe' ? 10_000 : 1_000);
    socket.setEncoding('utf8');
    socket.once('error', () => { clearTimeout(timeout); resolve(null); });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const boundary = buffer.indexOf('\n');
      if (boundary < 0) return;
      clearTimeout(timeout);
      socket.end();
      try { resolve(JSON.parse(buffer.slice(0, boundary)) as RuntimeResponse); } catch { resolve(null); }
    });
    socket.on('connect', () => socket.write(`${JSON.stringify({ token: secret, method } satisfies RuntimeRequest)}\n`));
  });
}

async function liveLease(projectRoot: string, lease?: RuntimeLease | null): Promise<RuntimeLease | null> {
  const candidate = lease === undefined ? await loadLease(projectRoot) : lease;
  if (!candidate) return null;
  const response = await request(projectRoot, candidate, 'ping');
  return response?.ok ? candidate : null;
}

async function writeLease(projectRoot: string, lease: RuntimeLease): Promise<void> {
  await atomicWriteJson(cognitionRuntimeLeasePath(projectRoot), lease);
}

async function publishWithRetry<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { return await withLock(`${locksDirectory(projectRoot)}/cognition-runtime-start.lock`, operation); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'context is busy; try again later' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function appendRuntimeEvent(projectRoot: string, event: AppendEventInput): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { await appendEvent(projectRoot, event); return; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'context is busy; try again later' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function closeServer(projectRoot: string, server: Server, observer: GitObserver, filesystem: FilesystemObserver, heartbeat: NodeJS.Timeout | null, poller: NodeJS.Timeout | null, inactivity: NodeJS.Timeout | null, background: Promise<void>, leaseWrite: Promise<void>, lease: RuntimeLease, reason: string): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  if (poller) clearInterval(poller);
  if (inactivity) clearTimeout(inactivity);
  let failure: unknown;
  try {
    filesystem.stop();
    await filesystem.flush();
    await observer.drain();
    await filesystem.drain();
    await background;
    await rebuildProjections(projectRoot);
    await leaseWrite;
  } catch (error) {
    failure = error;
  } finally {
    await new Promise<void>((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  try {
    await appendRuntimeEvent(projectRoot, {
      type: 'runtime.stopped',
      source: { kind: 'cli', instanceId: lease.instanceId },
      idempotencyKey: `runtime:stopped:${lease.instanceId}`,
      payload: { reason },
    });
  } catch (error) {
    failure ??= error;
  } finally {
    // Removing the lease signals stopRuntime that all writes are complete.
    // Keep it until the final journal write releases its lock, otherwise an
    // immediate upgrade/restart can race the outgoing runtime's last event.
    await removeOwnedRuntimeFiles(projectRoot, lease.instanceId);
  }
  if (failure) throw failure;
}

function attachProtocol(server: Server, secret: string, lease: RuntimeLease, touch: () => void, observe: () => Promise<{ changed: boolean }>, close: (reason: string) => Promise<void>): void {
  server.on('connection', (socket: Socket) => {
    // A timed-out or reset IPC client must not crash the detached runtime.
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxFrameBytes) { socket.destroy(); return; }
      const boundary = buffer.indexOf('\n');
      if (boundary < 0) return;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      let request: RuntimeRequest;
      try { request = JSON.parse(frame) as RuntimeRequest; } catch { socket.end('{"ok":false,"error":"invalid_request"}\n'); return; }
      if (!request || typeof request.token !== 'string' || !sameToken(request.token, secret)) { socket.end('{"ok":false,"error":"unauthorized"}\n'); return; }
      touch();
      if (request.method === 'ping') { socket.end(`${JSON.stringify({ ok: true, result: { instanceId: lease.instanceId } } satisfies RuntimeResponse)}\n`); return; }
      if (request.method === 'observe') {
        try {
          const result = await observe();
          socket.end(`${JSON.stringify({ ok: true, result: { changed: result.changed } } satisfies RuntimeResponse)}\n`);
        } catch { socket.end('{"ok":false,"error":"observe_failed"}\n'); }
        return;
      }
      if (request.method === 'stop') {
        socket.end('{"ok":true}\n');
        void close('ipc').catch(() => undefined);
        return;
      }
      socket.end('{"ok":false,"error":"unknown_method"}\n');
    });
  });
}

export async function serveRuntime(startPath?: string, options: RuntimeServeOptions = {}): Promise<RuntimeServer> {
  const projectRoot = await resolveProjectRoot(startPath);
  await options.onStartupPhase?.('publish-lease');
  const currentPolicy = await loadPolicy(projectRoot);
  if (!currentPolicy.enabled) throw new Error('runtime is disabled; run ctx runtime enable first');
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? currentPolicy.inactivityTimeoutMs;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const runtimePollIntervalMs = options.pollIntervalMs ?? pollIntervalMs;
  const existing = await liveLease(projectRoot);
  if (existing) throw new Error('runtime is already running');
  const manifest = await loadManifest(projectRoot);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('runtime failed to bind loopback endpoint');
  }
  const now = new Date().toISOString();
  const lease: RuntimeLease = { schemaVersion: 2, protocolVersion, projectId: manifest.projectId, instanceId: createInstanceId(), pid: process.pid, host, port: address.port, startedAt: now, heartbeatAt: now };
  const secret = createToken();
  const observer = new GitObserver(projectRoot);
  let filesystem: FilesystemObserver;
  let heartbeat: NodeJS.Timeout | null = null;
  let poller: NodeJS.Timeout | null = null;
  let inactivity: NodeJS.Timeout | null = null;
  let background = Promise.resolve();
  let leaseWrite = Promise.resolve();
  let filesystemEventPending = false;
  let closing: Promise<void> | null = null;
  let finishInitialization!: () => void;
  const initialized = new Promise<void>((resolve) => { finishInitialization = resolve; });
  const enqueueObservation = (operation: () => Promise<{ changed: boolean }>): Promise<{ changed: boolean }> => {
    const next = background.then(operation, operation);
    background = next.then(() => undefined, () => undefined);
    return next;
  };
  const close = async (reason: string): Promise<void> => {
    if (closing) return closing;
    // A caller can see a live endpoint before the first observation finishes.
    // Drain initialization too, so it cannot recreate the lease after shutdown.
    closing = initialized.then(() => closeServer(projectRoot, server, observer, filesystem, heartbeat, poller, inactivity, background, leaseWrite, lease, reason));
    return closing;
  };
  const touch = (): void => {
    // Draining observations during shutdown can still notify activity. Never
    // recreate an inactivity timer after closeServer has cleared the timers.
    if (closing) return;
    if (inactivity) clearTimeout(inactivity);
    inactivity = setTimeout(() => { void close('inactivity').catch(() => undefined); }, inactivityTimeoutMs);
  };
  const observe = (): Promise<{ changed: boolean }> => enqueueObservation(async () => {
    const [gitResult, filesystemResult] = await Promise.all([
      observer.observeNow(),
      filesystem.observeNow(),
    ]);
    const synced = await v1Synced(projectRoot);
    if (!synced) await reconcileV1State(projectRoot);
    if (gitResult.changed || filesystemResult.changed || filesystemEventPending || !synced) {
      await rebuildProjections(projectRoot);
      filesystemEventPending = false;
    }
    const changed = gitResult.changed || filesystemResult.changed || filesystemEventPending || !synced;
    if (changed) touch();
    return { changed };
  });
  filesystem = new FilesystemObserver(projectRoot, {
    anchor: () => ({ worktreeId: observer.current?.worktreeId ?? null, branch: observer.current?.branch ?? null, ref: observer.current?.ref ?? null, head: observer.current?.commit ?? null }),
    onChanged: () => {
      filesystemEventPending = true;
      touch();
    },
  });
  attachProtocol(server, secret, lease, touch, observe, close);
  try {
    await publishWithRetry(projectRoot, async () => {
      const attemptId = process.env.FLUFFY_CONTEXT_RUNTIME_ATTEMPT_ID;
      if (attemptId && (await loadStartupMarker(projectRoot))?.attemptId !== attemptId) throw new Error('runtime startup was cancelled');
      const live = await liveLease(projectRoot);
      if (live) throw new Error('runtime is already running');
      await mkdir(path.dirname(cognitionRuntimeSecretPath(projectRoot)), { recursive: true });
      await writeFile(cognitionRuntimeSecretPath(projectRoot), secret, { encoding: 'utf8', mode: 0o600 });
      await writeLease(projectRoot, lease);
    });
  } catch (error) {
    finishInitialization();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  heartbeat = setInterval(() => {
    lease.heartbeatAt = new Date().toISOString();
    leaseWrite = leaseWrite.then(() => writeLease(projectRoot, lease)).catch(() => undefined);
  }, heartbeatIntervalMs);
  poller = setInterval(() => {
    void observe().catch(() => undefined);
  }, runtimePollIntervalMs);
  // Start the inactivity window as soon as the lease is published. A slow
  // first observation must not keep an otherwise idle runtime alive forever.
  touch();
  try {
    await options.onStartupPhase?.('journal');
    await appendRuntimeEvent(projectRoot, { type: 'runtime.started', source: { kind: 'cli', instanceId: lease.instanceId }, idempotencyKey: `runtime:started:${lease.instanceId}`, payload: {} });
    await options.onStartupPhase?.('observation');
    if (currentPolicy.filesystemEventsEnabled) filesystem.start();
    await observe();
    leaseWrite = leaseWrite.then(() => writeLease(projectRoot, lease));
    await leaseWrite;
    await options.onStartupPhase?.('ready');
    const attemptId = process.env.FLUFFY_CONTEXT_RUNTIME_ATTEMPT_ID;
    if (attemptId) await clearRuntimeStartup(projectRoot, attemptId);
    touch();
  } catch (error) {
    finishInitialization();
    await close('startup-failed').catch(() => undefined);
    throw error;
  } finally {
    finishInitialization();
  }
  return { lease, close };
}

export async function runtimeStatus(startPath?: string): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  const migrated = await exists(cognitionManifestPath(projectRoot));
  if (!migrated) return { projectRoot, v2Present: false, enabled: false, migrated: false, running: false, lease: null };
  const runtimePolicy = await loadPolicy(projectRoot);
  const lease = await loadLease(projectRoot);
  const live = await liveLease(projectRoot, lease);
  const startup = await readRuntimeDiagnostic(projectRoot);
  const marker = await loadStartupMarker(projectRoot);
  const processAlive = runtimeProcessAlive(lease?.pid ?? (marker || startup?.outcome === 'failed' ? startup?.pid : null));
  const state = live ? (marker ? 'starting' : 'ready')
    : lease ? (processAlive === false ? 'exited' : 'unreachable')
    : startup?.outcome === 'failed' ? 'failed' : marker ? 'starting' : 'stopped';
  return { projectRoot, v2Present: true, enabled: runtimePolicy.enabled, migrated: true, running: Boolean(live), lease: lease ? publicLease(lease) : null,
    diagnostics: { state, processAlive, startup } };
}

export async function enableRuntime(startPath?: string): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!await exists(cognitionManifestPath(projectRoot))) throw new Error('v2 migration is required before enabling the runtime');
  const current = await loadPolicy(projectRoot);
  if (!current.enabled || !current.autoStart) {
    await writeRuntimePolicy(projectRoot, { ...current, enabled: true, autoStart: true });
    await appendEvent(projectRoot, { type: 'runtime.enabled', source: { kind: 'cli' }, idempotencyKey: 'runtime:enabled', payload: {} });
  }
  return runtimeStatus(projectRoot);
}

export async function disableRuntime(startPath?: string): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!await exists(cognitionManifestPath(projectRoot))) throw new Error('v2 migration is required before disabling the runtime');
  await stopRuntime(projectRoot);
  const current = await loadPolicy(projectRoot);
  await writeRuntimePolicy(projectRoot, { ...current, enabled: false, autoStart: false });
  return runtimeStatus(projectRoot);
}

export async function setFilesystemEvents(startPath: string | undefined, enabled: boolean): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!await exists(cognitionManifestPath(projectRoot))) throw new Error('v2 migration is required before configuring filesystem events');
  const wasRunning = (await runtimeStatus(projectRoot)).running;
  if (wasRunning) await stopRuntime(projectRoot);
  const current = await loadPolicy(projectRoot);
  await writeRuntimePolicy(projectRoot, { ...current, filesystemEventsEnabled: enabled });
  if (wasRunning) return startRuntime(projectRoot);
  return runtimeStatus(projectRoot);
}

async function waitForRuntime(projectRoot: string, timeoutMs: number, checkChild: () => void = () => undefined): Promise<RuntimeStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkChild();
    const status = await runtimeStatus(projectRoot);
    const marker = await loadStartupMarker(projectRoot);
    // Use readiness from the same status snapshot. The marker may disappear
    // between reads; returning that earlier snapshot would report "starting"
    // even though this caller claims startup has completed.
    if (status.running && status.diagnostics?.state === 'ready') return status;
    if (status.diagnostics?.startup?.outcome === 'failed') {
      throw new Error(`runtime startup failed at ${status.diagnostics.startup.phase} (${status.diagnostics.startup.failure?.code}); run ctx runtime status for diagnostics`);
    }
    if (!status.lease && !marker) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const status = await runtimeStatus(projectRoot);
  checkChild();
  return status.running && status.diagnostics?.state === 'ready' ? status : null;
}

async function startRuntimeCoordinated(projectRoot: string, timeoutMs: number): Promise<RuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  const existing = await liveLease(projectRoot);
  if (existing) {
    // A published lease can answer ping before serveRuntime has finished its
    // first semantic observation and startup event. Do not report completion
    // until the marker is removed. A successful ping alone is not readiness.
    const status = await waitForRuntime(projectRoot, timeoutMs);
    if (status) return status;
    throw new Error('runtime startup is not yet confirmed; run ctx runtime status for the current startup phase.');
  }
  while (Date.now() < deadline) {
    const attemptId = createInstanceId();
    let owner = false;
    let observedLive = false;
    try {
      await withLock(`${locksDirectory(projectRoot)}/cognition-runtime-start.lock`, async () => {
        if (await liveLease(projectRoot)) { observedLive = true; return; }
        const lease = await loadLease(projectRoot);
        if (lease) {
          const age = Date.now() - Date.parse(lease.heartbeatAt);
          if (Number.isFinite(age) && age < 15_000) return;
          await removeOwnedRuntimeFiles(projectRoot, lease.instanceId);
        }
        const marker = await loadStartupMarker(projectRoot);
        if (marker && Date.now() - Date.parse(marker.createdAt) <= startupMarkerTimeoutMs) return;
        await atomicWriteJson(cognitionRuntimeStartupPath(projectRoot), { attemptId, pid: process.pid, createdAt: new Date().toISOString() } satisfies StartupMarker);
        owner = true;
      });
    } catch {
      // A concurrent start or stop owns the coordination lock.
    }
    if (observedLive) {
      const status = await waitForRuntime(projectRoot, Math.max(0, deadline - Date.now()));
      if (status) return status;
      break;
    }
    if (owner) {
      await writeRuntimeDiagnostic(projectRoot, { attemptId, pid: null, phase: 'spawn', outcome: 'starting' });
      const child = spawn(process.execPath, [workerPath, projectRoot, attemptId], {
        cwd: projectRoot, detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, FLUFFY_CONTEXT_RUNTIME_ATTEMPT_ID: attemptId },
      });
      let childFailure: { code: string; exitCode?: number | null; signal?: string | null } | null = null;
      const onError = (error: Error): void => { childFailure = { code: runtimeFailureCode(error) }; };
      const onExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => { childFailure = { code: 'PROCESS_EXIT', exitCode, signal }; };
      child.once('error', onError);
      child.once('exit', onExit);
      child.unref();
      try {
        const status = await waitForRuntime(projectRoot, Math.max(0, deadline - Date.now()), () => {
          if (childFailure) throw new Error(`runtime background process failed (${childFailure.code}, exit ${childFailure.exitCode ?? 'unknown'}); run ctx runtime status for diagnostics`);
        });
        if (status) return status;
      } catch (error) {
        if (childFailure) {
          await publishWithRetry(projectRoot, async () => {
            const diagnostic = await readRuntimeDiagnostic(projectRoot);
            if (diagnostic?.attemptId !== attemptId) return;
            await writeRuntimeDiagnostic(projectRoot, { ...diagnostic, pid: child.pid ?? null, outcome: 'failed', failure: {
              ...childFailure!, code: diagnostic.failure?.code ?? childFailure!.code,
            } });
            if ((await loadStartupMarker(projectRoot))?.attemptId === attemptId) {
              const lease = await loadLease(projectRoot);
              if (lease && lease.pid === child.pid) await removeOwnedRuntimeFiles(projectRoot, lease.instanceId);
              await rm(cognitionRuntimeStartupPath(projectRoot), { force: true });
            }
          });
        }
        throw error;
      } finally {
        child.removeListener('exit', onExit);
        // Keep an error listener even when a very short caller deadline expires
        // before Node delivers a spawn error. Event listeners do not ref a child.
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // A timeout does not cancel the detached child. Preserve its startup marker
  // so another caller cannot launch a competing instance while it initializes.
  throw new Error('runtime startup is not yet confirmed; run ctx runtime status before retrying. The background process may still be starting.');
}

export async function startRuntime(startPath?: string, options: { timeoutMs?: number } = {}): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  const current = await loadPolicy(projectRoot);
  if (!current.enabled) throw new Error('runtime is disabled; run ctx runtime enable first');
  const pending = startupPromises.get(projectRoot);
  if (pending) return pending;
  const operation = startRuntimeCoordinated(projectRoot, options.timeoutMs ?? 10_000).finally(() => startupPromises.delete(projectRoot));
  startupPromises.set(projectRoot, operation);
  return operation;
}

export async function ensureRuntimeForSession(startPath?: string, options: EnsureRuntimeOptions = {}): Promise<EnsureRuntimeResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!await exists(cognitionManifestPath(projectRoot))) return { projectRoot, started: false, running: false, skipped: 'not-migrated' };
  const current = await loadPolicy(projectRoot);
  if (!current.enabled || !current.autoStart || (options.source === 'claude-hook' && !current.allowHookStartup)) return { projectRoot, started: false, running: false, skipped: 'disabled' };
  if (await liveLease(projectRoot)) {
    const status = (await waitForRuntime(projectRoot, options.timeoutMs ?? 1_000)) ?? await runtimeStatus(projectRoot);
    return { projectRoot, started: false, running: status.running, skipped: 'already-running' };
  }
  const pending = startupPromises.get(projectRoot);
  if (pending) {
    try {
      const status = await pending;
      return { projectRoot, started: false, running: status.running, skipped: 'startup-in-progress' };
    } catch {
      return { projectRoot, started: false, running: false, skipped: 'unavailable' };
    }
  }
  const operation = startRuntimeCoordinated(projectRoot, options.timeoutMs ?? 1_000)
    .finally(() => startupPromises.delete(projectRoot));
  startupPromises.set(projectRoot, operation);
  try {
    const status = await operation;
    return { projectRoot, started: true, running: status.running, skipped: null };
  } catch {
    return { projectRoot, started: false, running: false, skipped: 'unavailable' };
  }
}

export async function stopRuntime(startPath?: string): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  const deadline = Date.now() + 20_000;
  let stopRequestedFor: string | null = null;
  while (Date.now() < deadline) {
    const lease = await loadLease(projectRoot);
    const marker = await loadStartupMarker(projectRoot);
    if (marker) {
      try {
        await withLock(`${locksDirectory(projectRoot)}/cognition-runtime-start.lock`, async () => {
          if ((await loadStartupMarker(projectRoot))?.attemptId === marker.attemptId) await rm(cognitionRuntimeStartupPath(projectRoot), { force: true });
        });
      } catch { /* A publishing runtime owns the coordination lock; retry below. */ }
    }
    if (lease && stopRequestedFor !== lease.instanceId && await liveLease(projectRoot, lease)) {
      if ((await request(projectRoot, lease, 'stop'))?.ok) stopRequestedFor = lease.instanceId;
    }
    if (lease) await removeAbandonedRuntimeFiles(projectRoot, lease);
    const status = await runtimeStatus(projectRoot);
    if (!status.lease && !marker && !startupPromises.has(projectRoot)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const status = await runtimeStatus(projectRoot);
  if (!status.lease && !await loadStartupMarker(projectRoot)) return status;
  throw new Error(`runtime shutdown is not yet confirmed (running: ${status.running}); run ctx runtime status before retrying. Startup or pending writes may still be draining.`);
}

export async function observeRuntime(startPath?: string): Promise<boolean> {
  const projectRoot = await resolveProjectRoot(startPath);
  const lease = await liveLease(projectRoot);
  if (!lease) return false;
  return Boolean((await request(projectRoot, lease, 'observe'))?.ok);
}

export async function touchRuntime(startPath?: string): Promise<boolean> {
  try {
    const projectRoot = await resolveProjectRoot(startPath);
    const lease = await loadLease(projectRoot);
    if (!lease) return false;
    return Boolean((await request(projectRoot, lease, 'ping'))?.ok);
  } catch {
    return false;
  }
}
