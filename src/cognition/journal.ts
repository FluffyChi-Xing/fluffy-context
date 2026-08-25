import crypto from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, truncate } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { loadManifest } from '../runtime/init.js';
import { withLock } from '../storage/lock.js';
import { cognitionJournalDirectory, locksDirectory } from '../storage/layout.js';
import type { CognitionEvent, CognitionEventSource, CognitionEventType, CognitionGitAnchor } from './types.js';

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
  } catch {
    await truncate(filePath, boundary < 0 ? 0 : boundary + 1);
  }
}

export async function readJournal(startPath?: string): Promise<CognitionEvent[]> {
  const projectRoot = await resolveProjectRoot(startPath);
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
        if (index === lines.length - 1 && !content.endsWith('\n')) break;
        throw new Error(`invalid journal record ${file}:${index + 1}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
      }
      const { hash, ...withoutHash } = event;
      if (event.schemaVersion !== 2 || !event.eventId || event.previousHash !== previousHash || hash !== eventHash(withoutHash)) {
        throw new Error(`invalid journal hash chain at ${file}:${index + 1}`);
      }
      previousHash = event.hash;
      events.push(event);
    }
  }
  return events;
}

export async function appendEvent<T>(startPath: string | undefined, input: AppendEventInput<T>): Promise<{ event: CognitionEvent<T>; appended: boolean }> {
  const projectRoot = await resolveProjectRoot(startPath);
  return withLock(`${locksDirectory(projectRoot)}/cognition-journal.lock`, async () => {
    await recoverPartialTail(projectRoot);
    const existing = await readJournal(projectRoot);
    const duplicate = existing.find((event) => event.idempotencyKey === input.idempotencyKey);
    if (duplicate) return { event: duplicate as CognitionEvent<T>, appended: false };
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
