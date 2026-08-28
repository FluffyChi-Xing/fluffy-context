import crypto from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, truncate } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { loadManifest } from '../runtime/init.js';
import { withLock } from '../storage/lock.js';
import { cognitionJournalDirectory, locksDirectory } from '../storage/layout.js';
import type { CognitionEvent, CognitionEventSource, CognitionEventType, CognitionGitAnchor } from './types.js';

const eventTypes: ReadonlySet<string> = new Set([
  'runtime.enabled', 'runtime.started', 'runtime.stopped', 'host.session.started', 'host.prompt.submitted',
  'git.state.observed', 'git.branch.changed', 'git.head.changed', 'workspace.paths.changed',
  'context.checkpoint.imported', 'context.state.recorded', 'note.recorded', 'note.resolved', 'note.absorbed',
  'knowledge.proposed', 'knowledge.verified', 'knowledge.deprecated', 'knowledge.rejected',
  'deadend.proposed', 'deadend.verified', 'deadend.obsoleted', 'deadend.rejected', 'record.used',
  'usage.operation.completed',
  'projection.advanced', 'projection.failed',
]);
const sourceKinds: ReadonlySet<string> = new Set(['cli', 'claude-hook', 'mcp', 'agent', 'git-observer', 'fs-observer', 'migration']);

const segmentName = '00000001.ndjson';

export interface AppendEventInput<T = Record<string, unknown>> {
  eventId?: string;
  type: CognitionEventType;
  occurredAt?: string;
  source?: { kind: CognitionEventSource; instanceId?: string };
  correlationId?: string;
  idempotencyKey: string;
  git?: CognitionGitAnchor;
  privacy?: { classification: 'metadata' | 'redacted-text'; redactionCount: number };
  payload: T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function eventId(): string {
  return `evt-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

export function eventHash<T>(event: Omit<CognitionEvent<T>, 'hash'>): string {
  return digest(event);
}

async function journalFiles(projectRoot: string): Promise<string[]> {
  try {
    return (await readdir(cognitionJournalDirectory(projectRoot))).filter((file) => file.endsWith('.ndjson')).sort();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validGitAnchor(value: unknown): value is CognitionGitAnchor {
  return isRecord(value)
    && (typeof value.worktreeId === 'string' || value.worktreeId === null)
    && (typeof value.branch === 'string' || value.branch === null)
    && (typeof value.ref === 'string' || value.ref === null)
    && (typeof value.head === 'string' || value.head === null);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validatePayloadBoundary(input: AppendEventInput): void {
  const payload = input.payload as Record<string, unknown>;
  if (input.type === 'host.prompt.submitted' && (typeof payload.intent !== 'string' || payload.intent.trim().length === 0)) {
    throw new Error('host prompt intent must not be empty');
  }
  if (['note.recorded', 'note.resolved', 'note.absorbed'].includes(input.type)) {
    const record = payload.record;
    if (!isRecord(record) || typeof record.message !== 'string' || record.message.trim().length === 0) throw new Error('note message must not be empty');
  }
  if (input.type === 'usage.operation.completed') {
    const requiredNumbers = ['durationMs', 'inputChars', 'outputChars', 'inputBytes', 'outputBytes', 'estimatedInputTokens', 'estimatedOutputTokens'];
    if (payload.operation !== 'orient' && payload.operation !== 'compile' && payload.operation !== 'expand' && payload.operation !== 'resume') throw new Error('invalid usage operation');
    if (payload.interface !== 'cli' && payload.interface !== 'mcp' && payload.interface !== 'agent' && payload.interface !== 'hook') throw new Error('invalid usage interface');
    if (typeof payload.success !== 'boolean' || payload.estimatedMethod !== 'chars-div-four' || requiredNumbers.some((key) => typeof payload[key] !== 'number' || !Number.isFinite(payload[key]) || payload[key] < 0)) throw new Error('invalid usage telemetry payload');
    if (!payload.success && typeof payload.errorClass !== 'string') throw new Error('usage errors require an error class');
  }
  if (input.type === 'workspace.paths.changed') {
    const changes = payload.changes;
    if (!Array.isArray(changes) || changes.length === 0) throw new Error('workspace activity must contain changes');
  }
}

function validateEventShape(event: unknown, projectId: string, file: string, line: number): asserts event is CognitionEvent {
  if (!isRecord(event)
    || event.schemaVersion !== 2
    || typeof event.eventId !== 'string'
    || event.eventId.length === 0
    || typeof event.type !== 'string'
    || !eventTypes.has(event.type)
    || !validIsoDate(event.occurredAt)
    || !validIsoDate(event.observedAt)
    || event.projectId !== projectId
    || !isRecord(event.source)
    || typeof event.source.kind !== 'string'
    || !sourceKinds.has(event.source.kind)
    || (event.source.instanceId !== undefined && typeof event.source.instanceId !== 'string')
    || (event.correlationId !== undefined && typeof event.correlationId !== 'string')
    || typeof event.idempotencyKey !== 'string'
    || event.idempotencyKey.length === 0
    || !validGitAnchor(event.git)
    || !isRecord(event.privacy)
    || (event.privacy.classification !== 'metadata' && event.privacy.classification !== 'redacted-text')
    || typeof event.privacy.redactionCount !== 'number'
    || !Number.isSafeInteger(event.privacy.redactionCount)
    || event.privacy.redactionCount < 0
    || !isRecord(event.payload)
    || (event.previousHash !== null && typeof event.previousHash !== 'string')
    || typeof event.hash !== 'string'
    || event.hash.length === 0) {
    throw new Error(`invalid journal record schema at ${file}:${line}`);
  }
}

async function recoverPartialTail(projectRoot: string): Promise<void> {
  const files = await journalFiles(projectRoot);
  const file = files.at(-1);
  if (!file) return;
  const filePath = path.join(cognitionJournalDirectory(projectRoot), file);
  const content = await readFile(filePath, 'utf8');
  if (content.endsWith('\n')) return;
  const boundary = content.lastIndexOf('\n');
  const tail = content.slice(boundary + 1);
  try {
    JSON.parse(tail);
    await appendFile(filePath, '\n', 'utf8');
  } catch {
    await truncate(filePath, boundary < 0 ? 0 : boundary + 1);
  }
}

export async function readJournal(startPath?: string, options: { allowPartialTail?: boolean } = {}): Promise<CognitionEvent[]> {
  const projectRoot = await resolveProjectRoot(startPath);
  const projectId = (await loadManifest(projectRoot)).projectId;
  const events: CognitionEvent[] = [];
  let previousHash: string | null = null;
  for (const file of await journalFiles(projectRoot)) {
    const content = await readFile(path.join(cognitionJournalDirectory(projectRoot), file), 'utf8');
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      let event: CognitionEvent;
      try {
        event = JSON.parse(line) as CognitionEvent;
      } catch (error) {
        if (options.allowPartialTail !== false && index === lines.length - 1 && !content.endsWith('\n')) break;
        throw new Error(`invalid journal record ${file}:${index + 1}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
      }
      validateEventShape(event, projectId, file, index + 1);
      const { hash, ...withoutHash } = event;
      if (event.previousHash !== previousHash || hash !== eventHash(withoutHash)) {
        throw new Error(`invalid journal hash chain at ${file}:${index + 1}`);
      }
      previousHash = event.hash;
      events.push(event);
    }
  }
  return events;
}

export async function verifyJournal(startPath?: string): Promise<CognitionEvent[]> {
  return readJournal(startPath, { allowPartialTail: false });
}

export async function appendEvent<T>(startPath: string | undefined, input: AppendEventInput<T>): Promise<{ event: CognitionEvent<T>; appended: boolean }> {
  validatePayloadBoundary(input as AppendEventInput);
  const projectRoot = await resolveProjectRoot(startPath);
  return withLock(`${locksDirectory(projectRoot)}/cognition-journal.lock`, async () => {
    await recoverPartialTail(projectRoot);
    const existing = await readJournal(projectRoot);
    const duplicate = existing.find((event) => event.idempotencyKey === input.idempotencyKey);
    if (duplicate) {
      const candidate = {
        type: input.type,
        source: input.source ?? { kind: 'cli' },
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        git: input.git ?? { worktreeId: null, branch: null, ref: null, head: null },
        privacy: input.privacy ?? { classification: 'metadata', redactionCount: 0 },
        payload: input.payload,
      };
      const existingSemantic = {
        type: duplicate.type,
        source: duplicate.source,
        correlationId: duplicate.correlationId,
        idempotencyKey: duplicate.idempotencyKey,
        git: duplicate.git,
        privacy: duplicate.privacy,
        payload: duplicate.payload,
      };
      if (canonical(candidate) !== canonical(existingSemantic)) throw new Error(`idempotency key conflict: ${input.idempotencyKey}`);
      return { event: duplicate as CognitionEvent<T>, appended: false };
    }
    const now = new Date().toISOString();
    const eventWithoutHash: Omit<CognitionEvent<T>, 'hash'> = {
      eventId: input.eventId ?? eventId(),
      schemaVersion: 2,
      type: input.type,
      occurredAt: input.occurredAt ?? now,
      observedAt: now,
      projectId: (await loadManifest(projectRoot)).projectId,
      source: input.source ?? { kind: 'cli' },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      idempotencyKey: input.idempotencyKey,
      git: input.git ?? { worktreeId: null, branch: null, ref: null, head: null },
      privacy: input.privacy ?? { classification: 'metadata', redactionCount: 0 },
      payload: input.payload,
      previousHash: existing.at(-1)?.hash ?? null,
    };
    const event = { ...eventWithoutHash, hash: eventHash(eventWithoutHash) };
    await mkdir(cognitionJournalDirectory(projectRoot), { recursive: true });
    await appendFile(path.join(cognitionJournalDirectory(projectRoot), segmentName), `${JSON.stringify(event)}\n`, 'utf8');
    return { event, appended: true };
  });
}
