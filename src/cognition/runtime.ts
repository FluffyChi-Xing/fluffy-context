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
import { cognitionManifestPath, cognitionPolicyPath, cognitionRuntimeLeasePath, cognitionRuntimeSecretPath, locksDirectory } from '../storage/layout.js';
import { appendEvent } from './journal.js';
import { GitObserver } from './git-observer.js';
import type { CognitionRuntimePolicy, RuntimeLease, RuntimeStatus } from './types.js';

const host = '127.0.0.1' as const;
const protocolVersion = 1 as const;
const maxFrameBytes = 16 * 1024;
const pollIntervalMs = 2_000;
const cliPath = fileURLToPath(new URL('../cli/main.js', import.meta.url));

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
  return readJson<CognitionRuntimePolicy>(cognitionPolicyPath(projectRoot));
}

async function loadLease(projectRoot: string): Promise<RuntimeLease | null> {
  return readJson<RuntimeLease>(cognitionRuntimeLeasePath(projectRoot)).catch(() => null);
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

async function closeServer(projectRoot: string, server: Server, observer: GitObserver, heartbeat: NodeJS.Timeout, poller: NodeJS.Timeout, inactivity: NodeJS.Timeout, lease: RuntimeLease, reason: string): Promise<void> {
  clearInterval(heartbeat);
  clearInterval(poller);
  clearTimeout(inactivity);
  await observer.drain();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => setImmediate(resolve));
  await rm(cognitionRuntimeLeasePath(projectRoot), { force: true });
  await rm(cognitionRuntimeSecretPath(projectRoot), { force: true });
  await appendEvent(projectRoot, {
    type: 'runtime.stopped',
    source: { kind: 'cli', instanceId: lease.instanceId },
    idempotencyKey: `runtime:stopped:${lease.instanceId}`,
    payload: { reason },
  });
}

function attachProtocol(projectRoot: string, server: Server, observer: GitObserver, secret: string, lease: RuntimeLease, touch: () => void, close: (reason: string) => Promise<void>): void {
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
          const result = await observer.observeNow();
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

export async function serveRuntime(startPath?: string): Promise<RuntimeServer> {
  const projectRoot = await resolveProjectRoot(startPath);
  const currentPolicy = await loadPolicy(projectRoot);
  if (!currentPolicy.enabled) throw new Error('runtime is disabled; run ctx runtime enable first');
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
  let closed = false;
  let heartbeat: NodeJS.Timeout;
  let poller: NodeJS.Timeout;
  let inactivity: NodeJS.Timeout;
  const close = async (reason: string): Promise<void> => {
    if (closed) return;
    closed = true;
    await closeServer(projectRoot, server, observer, heartbeat, poller, inactivity, lease, reason);
  };
  const touch = (): void => {
    clearTimeout(inactivity);
    inactivity = setTimeout(() => { void close('inactivity'); }, currentPolicy.inactivityTimeoutMs);
  };
  attachProtocol(projectRoot, server, observer, secret, lease, touch, close);
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
    void writeLease(projectRoot, lease);
  }, 5_000);
  poller = setInterval(() => { void observer.observeNow(); }, pollIntervalMs);
  touch();
  await appendEvent(projectRoot, { type: 'runtime.started', source: { kind: 'cli', instanceId: lease.instanceId }, idempotencyKey: `runtime:started:${lease.instanceId}`, payload: {} });
  await observer.observeNow();
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
  if (!current.enabled) {
    await atomicWriteJson(cognitionPolicyPath(projectRoot), { ...current, enabled: true });
    await appendEvent(projectRoot, { type: 'runtime.enabled', source: { kind: 'cli' }, idempotencyKey: 'runtime:enabled', payload: {} });
  }
  return runtimeStatus(projectRoot);
}

export async function disableRuntime(startPath?: string): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!await exists(cognitionManifestPath(projectRoot))) throw new Error('v2 migration is required before disabling the runtime');
  await stopRuntime(projectRoot);
  const current = await loadPolicy(projectRoot);
  await atomicWriteJson(cognitionPolicyPath(projectRoot), { ...current, enabled: false });
  return runtimeStatus(projectRoot);
}

export async function startRuntime(startPath?: string): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  const current = await loadPolicy(projectRoot);
  if (!current.enabled) throw new Error('runtime is disabled; run ctx runtime enable first');
  if (await liveLease(projectRoot)) return runtimeStatus(projectRoot);
  const child = spawn(process.execPath, [cliPath, 'runtime', 'serve', '--path', projectRoot], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await runtimeStatus(projectRoot);
    if (status.running) return status;
  }
  throw new Error('runtime failed to start');
}

export async function stopRuntime(startPath?: string): Promise<RuntimeStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  const lease = await liveLease(projectRoot);
  if (!lease) return runtimeStatus(projectRoot);
  await request(projectRoot, lease, 'stop');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await runtimeStatus(projectRoot);
    if (!status.running) return status;
  }
  throw new Error('runtime failed to stop');
}

export async function observeRuntime(startPath?: string): Promise<boolean> {
  const projectRoot = await resolveProjectRoot(startPath);
  const lease = await liveLease(projectRoot);
  if (!lease) return false;
  return Boolean((await request(projectRoot, lease, 'observe'))?.ok);
}
