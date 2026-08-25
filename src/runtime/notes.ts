import crypto from 'node:crypto';
import { access, readdir } from 'node:fs/promises';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { filterPaths } from '../capture/context-filter.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { isRecord, readJson } from '../storage/json-store.js';
import { contextMetadataPath, contextsRoot, locksDirectory, notesPath, snapshotPath, snapshotsDirectory } from '../storage/layout.js';
import { withLock } from '../storage/lock.js';
import type { ActivityItem, ActivityQuery, ActivityResult, Note, NoteFile, NoteInput, NoteQuery, Snapshot } from './types.js';
import { mirrorNote } from '../cognition/v1-bridge.js';

function id(): string {
  return `note-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isNote(value: unknown): value is Note {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.noteId === 'string'
    && ['problem', 'action', 'observation', 'decision'].includes(value.kind as string)
    && typeof value.message === 'string'
    && value.message.trim().length > 0
    && ['agent', 'human'].includes(value.actor as string)
    && (typeof value.contextId === 'string' || value.contextId === null)
    && (typeof value.snapshotId === 'string' || value.snapshotId === null)
    && Array.isArray(value.relatedFiles) && value.relatedFiles.every((item) => typeof item === 'string')
    && ['open', 'resolved'].includes(value.status as string)
    && (typeof value.absorbedBySnapshotId === 'string' || value.absorbedBySnapshotId === null)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isNoteFile(value: unknown): value is NoteFile {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.items) && value.items.every(isNote);
}

async function loadNotes(projectRoot: string): Promise<NoteFile> {
  try {
    return await readJson<NoteFile>(notesPath(projectRoot), isNoteFile);
  } catch (error) {
    if (isNotFound(error)) return { schemaVersion: 1, items: [] };
    throw error;
  }
}

async function validateSource(projectRoot: string, contextId?: string, snapshotId?: string): Promise<void> {
  if (!contextId && snapshotId) throw new Error('source snapshot requires source context');
  if (!contextId) return;
  await access(contextMetadataPath(projectRoot, contextId));
  if (snapshotId) await access(snapshotPath(projectRoot, contextId, snapshotId));
}

function limited(value: string, budget: number): string {
  return value.length <= budget ? value : value.slice(0, Math.max(0, budget - 1)) + '…';
}

export async function addNote(startPath: string | undefined, message: string, input: NoteInput = {}): Promise<Note> {
  const projectRoot = await resolveProjectRoot(startPath);
  const normalizedMessage = message.trim();
  if (!normalizedMessage) throw new Error('note message must not be empty');
  await validateSource(projectRoot, input.contextId, input.snapshotId);
  const relatedFiles = await filterPaths(projectRoot, (input.relatedFiles ?? []).map((item) => item.trim()).filter(Boolean));
  return withLock(`${locksDirectory(projectRoot)}/notes.lock`, async () => {
    const file = await loadNotes(projectRoot);
    const now = new Date().toISOString();
    const note: Note = {
      noteId: id(),
      schemaVersion: 1,
      kind: input.kind ?? 'observation',
      message: normalizedMessage,
      actor: input.actor ?? 'agent',
      contextId: input.contextId ?? null,
      snapshotId: input.snapshotId ?? null,
      relatedFiles,
      status: input.status ?? 'open',
      absorbedBySnapshotId: null,
      createdAt: now,
      updatedAt: now,
    };
    await atomicWriteJson(notesPath(projectRoot), { schemaVersion: 1, items: [...file.items, note] });
    await mirrorNote(projectRoot, note);
    return note;
  });
}

export async function listNotes(startPath: string | undefined, query: NoteQuery = {}): Promise<Note[]> {
  const projectRoot = await resolveProjectRoot(startPath);
  const file = await loadNotes(projectRoot);
  const limit = query.limit ?? 50;
  const maxChars = query.maxChars ?? 500;
  return file.items
    .filter((note) => !query.contextId || note.contextId === query.contextId)
    .filter((note) => !query.openOnly || (note.status === 'open' && note.absorbedBySnapshotId === null))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
    .map((note) => ({ ...note, message: limited(note.message, maxChars) }));
}

function noteActivity(note: Note): ActivityItem | null {
  if (!note.contextId) return null;
  return {
    type: 'note',
    occurredAt: note.createdAt,
    contextId: note.contextId,
    snapshotId: note.snapshotId ?? undefined,
    noteId: note.noteId,
    kind: note.kind,
    message: note.message,
    actor: note.actor,
    status: note.status,
    absorbedBySnapshotId: note.absorbedBySnapshotId,
  };
}

async function checkpointActivities(projectRoot: string, contextId?: string): Promise<ActivityItem[]> {
  const items: ActivityItem[] = [];
  let contextIds: string[];
  try { contextIds = await readdir(contextsRoot(projectRoot)); } catch { contextIds = []; }
  for (const id of contextIds) {
    if (contextId && id !== contextId) continue;
    try {
      const context = await readJson<{ id: string; title: string; currentSnapshotId: string | null }>(contextMetadataPath(projectRoot, id), (value): value is { id: string; title: string; currentSnapshotId: string | null } => isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string' && (typeof value.currentSnapshotId === 'string' || value.currentSnapshotId === null));
      if (!context.currentSnapshotId) continue;
      const snapshots = await readdir(snapshotsDirectory(projectRoot, id));
      for (const fileName of snapshots.filter((name) => name.endsWith('.json'))) {
        const snapshot = await readJson<Snapshot>(snapshotPath(projectRoot, id, fileName.slice(0, -5)), (value): value is Snapshot => isRecord(value) && value.schemaVersion === 1 && typeof value.snapshotId === 'string' && typeof value.createdAt === 'string' && (value.mode === 'baseline' || value.mode === 'patch'));
        items.push({ type: 'checkpoint', occurredAt: snapshot.createdAt, contextId: id, snapshotId: snapshot.snapshotId, title: context.title });
      }
    } catch {
      // Doctor reports malformed activity sources.
    }
  }
  return items;
}

export async function listActivity(startPath: string | undefined, query: ActivityQuery = {}): Promise<ActivityResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  const notes = await loadNotes(projectRoot);
  const noteItems = notes.items.map(noteActivity).filter((item): item is ActivityItem => item !== null);
  const checkpointItems = await checkpointActivities(projectRoot, query.contextId);
  const maxChars = query.maxChars ?? 500;
  const items = [...noteItems, ...checkpointItems]
    .filter((item) => !query.contextId || item.contextId === query.contextId)
    .filter((item) => !query.since || item.occurredAt >= query.since)
    .filter((item) => !query.openOnly || (item.type === 'note' && item.status === 'open' && item.absorbedBySnapshotId === null))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, query.limit ?? 50)
    .map((item) => item.message ? { ...item, message: limited(item.message, maxChars) } : item);
  return { projectRoot, items };
}

export async function absorbNotes(startPath: string | undefined, contextId: string, snapshotId: string): Promise<number> {
  const projectRoot = await resolveProjectRoot(startPath);
  return withLock(`${locksDirectory(projectRoot)}/notes.lock`, async () => {
    const file = await loadNotes(projectRoot);
    let absorbed = 0;
    const items = file.items.map((note) => {
      if (note.contextId !== contextId || note.absorbedBySnapshotId !== null) return note;
      absorbed += 1;
      return { ...note, absorbedBySnapshotId: snapshotId, updatedAt: new Date().toISOString() };
    });
    if (absorbed > 0) {
      await atomicWriteJson(notesPath(projectRoot), { schemaVersion: 1, items });
      for (const note of items) {
        if (note.contextId === contextId && note.absorbedBySnapshotId === snapshotId) await mirrorNote(projectRoot, note, true);
      }
    }
    return absorbed;
  });
}

export function isValidNote(value: unknown): value is Note {
  return isNote(value);
}
