import crypto from 'node:crypto';
import { atomicWriteJson } from '../storage/atomic-write.js';
import {
  cognitionBranchesDirectory,
  cognitionContextsProjectionPath,
  cognitionDeadendsProjectionPath,
  cognitionKnowledgeProjectionPath,
  cognitionNotesProjectionPath,
  cognitionProjectionCursorPath,
} from '../storage/layout.js';
import { readJournal } from './journal.js';
import type { BranchWorkspace, CognitionEvent, CognitionProjection, ProjectionCursor } from './types.js';

function workspaceKey(event: CognitionEvent): string {
  return crypto.createHash('sha256')
    .update(`${event.git.worktreeId ?? 'default'}\0${event.git.ref ?? event.git.branch ?? 'detached'}`)
    .digest('hex')
    .slice(0, 16);
}

function workspaceFor(event: CognitionEvent, existing?: BranchWorkspace): BranchWorkspace {
  const key = workspaceKey(event);
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

function importedRecord(event: CognitionEvent): Record<string, unknown> | null {
  const record = event.payload as Record<string, unknown>;
  return record.record && typeof record.record === 'object' && !Array.isArray(record.record) ? record.record as Record<string, unknown> : null;
}

export function projectEvents(events: CognitionEvent[]): CognitionProjection {
  const projection: CognitionProjection = { schemaVersion: 2, contexts: {}, notes: {}, knowledge: {}, deadends: {}, workspaces: {} };
  for (const event of events) {
    const key = workspaceKey(event);
    const workspace = workspaceFor(event, projection.workspaces[key]);
    const record = importedRecord(event);
    if (event.type === 'context.checkpoint.imported' && record) {
      const snapshot = record.snapshot as Record<string, unknown> | undefined;
      if (snapshot && typeof snapshot.contextId === 'string' && typeof snapshot.snapshotId === 'string') {
        projection.contexts[`${snapshot.contextId}:${snapshot.snapshotId}`] = record;
        workspace.activeContextRef = `${snapshot.contextId}:${snapshot.snapshotId}`;
      }
    }
    if (event.type === 'note.recorded' && record && typeof record.noteId === 'string') {
      projection.notes[record.noteId] = record;
      if (record.status === 'open' && record.absorbedBySnapshotId === null) workspace.openObservationEventIds = [...workspace.openObservationEventIds, event.eventId];
    }
    if ((event.type === 'knowledge.proposed' || event.type === 'knowledge.verified') && record && typeof record.knowledgeId === 'string') projection.knowledge[record.knowledgeId] = record;
    if ((event.type === 'deadend.proposed' || event.type === 'deadend.verified') && record && typeof record.deadendId === 'string') projection.deadends[record.deadendId] = record;
    projection.workspaces[key] = workspace;
  }
  return projection;
}

export async function rebuildProjections(projectRoot: string): Promise<{ projection: CognitionProjection; cursor: ProjectionCursor }> {
  const events = await readJournal(projectRoot);
  const projection = projectEvents(events);
  const last = events.at(-1);
  const cursor: ProjectionCursor = {
    schemaVersion: 2,
    lastEventId: last?.eventId ?? null,
    lastEventHash: last?.hash ?? null,
    updatedAt: last?.observedAt ?? null,
  };
  await Promise.all([
    atomicWriteJson(cognitionContextsProjectionPath(projectRoot), projection.contexts),
    atomicWriteJson(cognitionNotesProjectionPath(projectRoot), projection.notes),
    atomicWriteJson(cognitionKnowledgeProjectionPath(projectRoot), projection.knowledge),
    atomicWriteJson(cognitionDeadendsProjectionPath(projectRoot), projection.deadends),
    ...Object.values(projection.workspaces).map((workspace) => atomicWriteJson(`${cognitionBranchesDirectory(projectRoot)}/${workspace.workspaceKey}.json`, workspace)),
  ]);
  await atomicWriteJson(cognitionProjectionCursorPath(projectRoot), cursor);
  return { projection, cursor };
}
