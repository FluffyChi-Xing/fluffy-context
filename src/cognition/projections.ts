import crypto from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../storage/atomic-write.js';
import {
  cognitionBranchesDirectory,
  cognitionContextsProjectionPath,
  cognitionDeadendsProjectionPath,
  cognitionKnowledgeProjectionPath,
  cognitionNotesProjectionPath,
  cognitionProjectionCursorPath,
  cognitionRetrievalProjectionPath,
} from '../storage/layout.js';
import { readJournal } from './journal.js';
import { buildRetrievalProjection } from './retrieval.js';
import type { BranchWorkspace, CognitionEvent, CognitionGitAnchor, CognitionProjection, CognitionRecordPayload, ProjectionCursor } from './types.js';

export function workspaceKey(anchor: Pick<CognitionGitAnchor, 'worktreeId' | 'branch' | 'ref'>): string {
  return crypto.createHash('sha256')
    .update(`${anchor.worktreeId ?? 'default'}\0${anchor.ref ?? anchor.branch ?? 'detached'}`)
    .digest('hex')
    .slice(0, 16);
}

function workspaceFor(event: CognitionEvent, existing?: BranchWorkspace): BranchWorkspace {
  const key = workspaceKey(event.git);
  return {
    schemaVersion: 2,
    workspaceKey: key,
    worktreeId: event.git.worktreeId,
    branch: event.git.branch,
    ref: event.git.ref,
    head: event.git.head,
    activeContextRef: existing?.activeContextRef ?? null,
    openObservationEventIds: existing?.openObservationEventIds ?? [],
    pathFocus: existing?.pathFocus ?? [],
    recentEventIds: [...(existing?.recentEventIds ?? []), event.eventId].slice(-50),
    lastActivatedAt: event.occurredAt,
  };
}

function recordPayload(event: CognitionEvent): CognitionRecordPayload | null {
  const payload = event.payload as Record<string, unknown>;
  if (!payload.record || typeof payload.record !== 'object' || Array.isArray(payload.record)) return null;
  return payload as unknown as CognitionRecordPayload;
}

function recordId(record: Record<string, unknown>, kind: 'note' | 'knowledge' | 'deadend'): string | null {
  const field = kind === 'note' ? 'noteId' : kind === 'knowledge' ? 'knowledgeId' : 'deadendId';
  return typeof record[field] === 'string' ? record[field] : null;
}

function latestOpenObservationIds(events: CognitionEvent[], notes: Record<string, CognitionRecordPayload>): Set<string> {
  const latest = new Map<string, { eventId: string; record: Record<string, unknown> }>();
  for (const event of events) {
    if (!['note.recorded', 'note.resolved', 'note.absorbed'].includes(event.type)) continue;
    const payload = recordPayload(event);
    const note = payload?.record;
    if (!note) continue;
    const noteId = recordId(note, 'note');
    if (!noteId) continue;
    notes[noteId] = payload;
    latest.set(noteId, { eventId: event.eventId, record: note });
  }
  return new Set([...latest.values()].flatMap(({ eventId, record }) => record.status === 'open' && record.absorbedBySnapshotId === null ? [eventId] : []));
}

export function projectEvents(events: CognitionEvent[]): CognitionProjection {
  const projection: CognitionProjection = { schemaVersion: 2, contexts: {}, notes: {}, knowledge: {}, deadends: {}, workspaces: {} };
  const openObservationIds = latestOpenObservationIds(events, projection.notes);
  for (const event of events) {
    const key = workspaceKey(event.git);
    const workspace = workspaceFor(event, projection.workspaces[key]);
    const payload = recordPayload(event);
    const record = payload?.record;
    if ((event.type === 'context.checkpoint.imported' || event.type === 'context.state.recorded') && record) {
      const snapshot = record.snapshot as Record<string, unknown> | undefined;
      if (snapshot && typeof snapshot.contextId === 'string' && typeof snapshot.snapshotId === 'string') {
        const contextRef = `${snapshot.contextId}:${snapshot.snapshotId}`;
        projection.contexts[contextRef] = payload;
        workspace.activeContextRef = contextRef;
      }
    }
    if (event.type === 'note.recorded' && record) {
      const noteId = recordId(record, 'note');
      if (noteId) projection.notes[noteId] = payload!;
    }
    if (['knowledge.proposed', 'knowledge.verified', 'knowledge.deprecated', 'knowledge.rejected'].includes(event.type) && record) {
      const knowledgeId = recordId(record, 'knowledge');
      if (knowledgeId) projection.knowledge[knowledgeId] = payload!;
    }
    if (['deadend.proposed', 'deadend.verified', 'deadend.obsoleted', 'deadend.rejected'].includes(event.type) && record) {
      const deadendId = recordId(record, 'deadend');
      if (deadendId) projection.deadends[deadendId] = payload!;
    }
    if (event.type === 'note.recorded' && openObservationIds.has(event.eventId)) {
      workspace.openObservationEventIds = [...workspace.openObservationEventIds, event.eventId].slice(-50);
    }
    projection.workspaces[key] = workspace;
  }
  return projection;
}

async function removeObsoleteWorkspaceFiles(projectRoot: string, workspaceKeys: Set<string>): Promise<void> {
  try {
    const files = await readdir(cognitionBranchesDirectory(projectRoot));
    await Promise.all(files
      .filter((file) => file.endsWith('.json') && !workspaceKeys.has(file.slice(0, -'.json'.length)))
      .map((file) => rm(path.join(cognitionBranchesDirectory(projectRoot), file), { force: true })));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

export async function rebuildProjections(projectRoot: string): Promise<{ projection: CognitionProjection; cursor: ProjectionCursor }> {
  const events = await readJournal(projectRoot);
  const projection = projectEvents(events);
  const retrieval = buildRetrievalProjection(events);
  const last = events.at(-1);
  const cursor: ProjectionCursor = {
    schemaVersion: 2,
    lastEventId: last?.eventId ?? null,
    lastEventHash: last?.hash ?? null,
    updatedAt: last?.observedAt ?? null,
  };
  await removeObsoleteWorkspaceFiles(projectRoot, new Set(Object.keys(projection.workspaces)));
  await Promise.all([
    atomicWriteJson(cognitionContextsProjectionPath(projectRoot), projection.contexts),
    atomicWriteJson(cognitionNotesProjectionPath(projectRoot), projection.notes),
    atomicWriteJson(cognitionKnowledgeProjectionPath(projectRoot), projection.knowledge),
    atomicWriteJson(cognitionDeadendsProjectionPath(projectRoot), projection.deadends),
    atomicWriteJson(cognitionRetrievalProjectionPath(projectRoot), retrieval),
    ...Object.values(projection.workspaces).map((workspace) => atomicWriteJson(`${cognitionBranchesDirectory(projectRoot)}/${workspace.workspaceKey}.json`, workspace)),
  ]);
  await atomicWriteJson(cognitionProjectionCursorPath(projectRoot), cursor);
  return { projection, cursor };
}
