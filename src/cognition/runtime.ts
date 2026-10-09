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
import { rebuildProjections } from './projections.js';
import { loadRuntimePolicy, writeRuntimePolicy } from './policy.js';
import { FilesystemObserver } from './filesystem-observer.js';
import { GitObserver } from './git-observer.js';
import { reconcileV1State } from './migration-v1.js';
import { v1Synced } from './v1-bridge.js';
import type { CognitionRuntimePolicy, RuntimeLease, RuntimeStatus } from './types.js';

const host = '127.0.0.1' as const;
const protocolVersion = 1 as const;
const maxFrameBytes = 16 * 1024;
const pollIntervalMs = 2_000;
const cliPath = fileURLToPath(new URL('../cli/main.js', import.meta.url));
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

async function removeOwnedRuntimeFiles(projectRoot: string, instanceId: string): Promise<void> {
  const current = await loadLease(projectRoot);
  if (current?.instanceId !== instanceId) return;
  await rm(cognitionRuntimeLeasePath(projectRoot), { force: true });
  await rm(cognitionRuntimeSecretPath(projectRoot), { force: true });
}

async function request(projectRoot: string, lease: RuntimeLease, method: RuntimeRequest['method']): Promise<RuntimeResponse | null> {
  let secret: string;
  try { secret = (await readFile(cognitionRuntimeSecretPath(projectRoot), 'utf8')).trim(); } catch { return null; }
  if (!secret || lease.host !== host || !Number.isInteger(lease.port) || lease.port <= 0) return null;
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: lease.port });
    let buffer = '';
    const timeout = setTimeout(() => { socket.destroy(); resolve(null); }, 1_000);
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
    await removeOwnedRuntimeFiles(projectRoot, lease.instanceId);
  }
  try {
    await appendEvent(projectRoot, {
      type: 'runtime.stopped',
      source: { kind: 'cli', instanceId: lease.instanceId },
      idempotencyKey: `runtime:stopped:${lease.instanceId}`,
      payload: { reason },
    });
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

function attachProtocol(server: Server, secret: string, lease: RuntimeLease, touch: () => void, observe: () => Promise<{ changed: boolean }>, close: (reason: string) => Promise<void>): void {
  server.on('connection', (socket: Socket) => {
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
      if (!request.token || !sameToken(request.token, secret)) { socket.end('{"ok":false,"error":"unauthorized"}\n'); return; }
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
        void close('ipc');
        return;
      }
      socket.end('{"ok":false,"error":"unknown_method"}\n');
    });
  });
}

export async function serveRuntime(startPath?: string, options: RuntimeServeOptions = {}): Promise<RuntimeServer> {
  const projectRoot = await resolveProjectRoot(startPath);
  const currentPolicy = await loadPolicy(projectRoot);
  if (!currentPolicy.enabled) throw new Error('runtime is disabled; run ctx runtime enable first');
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? currentPolicy.inactivityTimeoutMs;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const runtimePollIntervalMs = options.pollIntervalMs ?? pollIntervalMs;
  const existing = await liveLease(projectRoot);
  if (existing) throw new Error('runtime is already running');
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
  const manifest = await loadManifest(projectRoot);
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
  const enqueueObservation = (operation: () => Promise<{ changed: boolean }>): Promise<{ changed: boolean }> => {
    const next = background.then(operation, operation);
    background = next.then(() => undefined, () => undefined);
    return next;
  };
  const close = async (reason: string): Promise<void> => {
    if (closing) return closing;
    closing = closeServer(projectRoot, server, observer, filesystem, heartbeat, poller, inactivity, background, leaseWrite, lease, reason);
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
    await withLock(`${locksDirectory(projectRoot)}/cognition-runtime-start.lock`, async () => {
      const live = await liveLease(projectRoot);
      if (live) throw new Error('runtime is already running');
      await mkdir(path.dirname(cognitionRuntimeSecretPath(projectRoot)), { recursive: true });
      await writeFile(cognitionRuntimeSecretPath(projectRoot), secret, { encoding: 'utf8', mode: 0o600 });
      await writeLease(projectRoot, lease);
    });
  } catch (error) {
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
  await appendEvent(projectRoot, { type: 'runtime.started', source: { kind: 'cli', instanceId: lease.instanceId }, idempotencyKey: `runtime:started:${lease.instanceId}`, payload: {} });
  if (currentPolicy.filesystemEventsEnabled) filesystem.start();
  await observe();
  await writeLease(projectRoot, lease);
  await rm(cognitionRuntimeStartupPath(projectRoot), { force: true });
  touch();
  return { lease, close };
}

export async function runtimeStatus(startPath?: string): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  const migrated = await exists(cognitionManifestPath(projectRoot));
  if (!migrated) return { projectRoot, v2Present: false, enabled: false, migrated: false, running: false, lease: null };
  const runtimePolicy = await loadPolicy(projectRoot);
  const lease = await loadLease(projectRoot);
  const live = await liveLease(projectRoot, lease);
  return { projectRoot, v2Present: true, enabled: runtimePolicy.enabled, migrated: true, running: Boolean(live), lease: lease ? publicLease(lease) : null };
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

async function waitForRuntime(projectRoot: string, timeoutMs: number): Promise<RuntimeStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await runtimeStatus(projectRoot);
    if (status.running && !await loadStartupMarker(projectRoot)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function startRuntimeCoordinated(projectRoot: string, timeoutMs: number): Promise<RuntimeStatus> {
  const existing = await liveLease(projectRoot);
  if (existing) return runtimeStatus(projectRoot);
  const attemptId = createInstanceId();
  let owner = false;
  try {
    await withLock(`${locksDirectory(projectRoot)}/cognition-runtime-start.lock`, async () => {
      const live = await liveLease(projectRoot);
      if (live) return;
      const marker = await loadStartupMarker(projectRoot);
      if (marker && Date.now() - Date.parse(marker.createdAt) <= startupMarkerTimeoutMs) return;
      await atomicWriteJson(cognitionRuntimeStartupPath(projectRoot), { attemptId, pid: process.pid, createdAt: new Date().toISOString() } satisfies StartupMarker);
      owner = true;
    });
  } catch {
    // Another process owns the startup lock; it will publish the lease or the marker will expire.
  }
  if (owner) {
    const child = spawn(process.execPath, [cliPath, 'runtime', 'serve', '--path', projectRoot], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  const status = await waitForRuntime(projectRoot, timeoutMs);
  const marker = await loadStartupMarker(projectRoot);
  if (marker?.attemptId === attemptId) await rm(cognitionRuntimeStartupPath(projectRoot), { force: true });
  if (status) return status;
  throw new Error('runtime failed to start');
}

export async function startRuntime(startPath?: string): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  const current = await loadPolicy(projectRoot);
  if (!current.enabled) throw new Error('runtime is disabled; run ctx runtime enable first');
  const pending = startupPromises.get(projectRoot);
  if (pending) return pending;
  const operation = startRuntimeCoordinated(projectRoot, 1_500).finally(() => startupPromises.delete(projectRoot));
  startupPromises.set(projectRoot, operation);
  return operation;
}

export async function ensureRuntimeForSession(startPath?: string, options: EnsureRuntimeOptions = {}): Promise<EnsureRuntimeResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!await exists(cognitionManifestPath(projectRoot))) return { projectRoot, started: false, running: false, skipped: 'not-migrated' };
  const current = await loadPolicy(projectRoot);
  if (!current.enabled || !current.autoStart || (options.source === 'claude-hook' && !current.allowHookStartup)) return { projectRoot, started: false, running: false, skipped: 'disabled' };
  if (await liveLease(projectRoot)) return { projectRoot, started: false, running: true, skipped: 'already-running' };
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
  const lease = await liveLease(projectRoot);
  if (!lease) return runtimeStatus(projectRoot);
  await request(projectRoot, lease, 'stop');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await runtimeStatus(projectRoot);
    if (!status.running && !status.lease) return status;
  }
  throw new Error('runtime failed to stop');
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
