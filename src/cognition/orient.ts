import { access } from 'node:fs/promises';
import { readGitWorktreeState } from '../git/git-adapter.js';
import { cognitionManifestPath, cognitionPolicyPath } from '../storage/layout.js';
import { readJson } from '../storage/json-store.js';
import { loadManifest } from '../runtime/init.js';
import { readJournal } from './journal.js';
import { projectEvents, workspaceKey } from './projections.js';
import { v1Synced } from './v1-bridge.js';
import type { CognitionEvent, CognitionManifest, CognitionRuntimePolicy } from './types.js';

export interface V2OrientationPlan {
  contextId: string;
  snapshotId: string;
  knowledgeIds: ReadonlySet<string>;
  deadendIds: ReadonlySet<string>;
  noteIds: ReadonlySet<string>;
}

function contextReference(value: string): { contextId: string; snapshotId: string } | null {
  const boundary = value.lastIndexOf(':');
  if (boundary <= 0 || boundary === value.length - 1) return null;
  return { contextId: value.slice(0, boundary), snapshotId: value.slice(boundary + 1) };
}

function record(event: CognitionEvent): Record<string, unknown> | null {
  const payload = event.payload as Record<string, unknown>;
  return payload.record && typeof payload.record === 'object' && !Array.isArray(payload.record) ? payload.record as Record<string, unknown> : null;
}

function applicable(event: CognitionEvent, current: Awaited<ReturnType<typeof readGitWorktreeState>>): boolean {
  if (event.git.ref === null && event.git.branch === null) return true;
  return event.git.ref === current.ref && event.git.branch === current.branch && (event.git.worktreeId === null || event.git.worktreeId === current.worktreeId);
}

function latestRecords(events: CognitionEvent[], current: Awaited<ReturnType<typeof readGitWorktreeState>>, contextId: string) {
  const knowledge = new Map<string, { event: CognitionEvent; record: Record<string, unknown> }>();
  const deadends = new Map<string, { event: CognitionEvent; record: Record<string, unknown> }>();
  const notes = new Map<string, { event: CognitionEvent; record: Record<string, unknown> }>();
  for (const event of events) {
    const item = record(event);
    if (!item) continue;
    if (['knowledge.proposed', 'knowledge.verified'].includes(event.type) && typeof item.knowledgeId === 'string') knowledge.set(item.knowledgeId, { event, record: item });
    if (['deadend.proposed', 'deadend.verified'].includes(event.type) && typeof item.deadendId === 'string') deadends.set(item.deadendId, { event, record: item });
    if (['note.recorded', 'note.resolved', 'note.absorbed'].includes(event.type) && typeof item.noteId === 'string') notes.set(item.noteId, { event, record: item });
  }
  return {
    knowledgeIds: new Set([...knowledge].flatMap(([id, item]) => item.record.status === 'verified' && applicable(item.event, current) ? [id] : [])),
    deadendIds: new Set([...deadends].flatMap(([id, item]) => item.record.status === 'verified' && applicable(item.event, current) ? [id] : [])),
    noteIds: new Set([...notes].flatMap(([id, item]) => item.record.contextId === contextId && item.record.status === 'open' && item.record.absorbedBySnapshotId === null && applicable(item.event, current) ? [id] : [])),
  };
}

export async function selectV2Orientation(projectRoot: string, contextId?: string): Promise<V2OrientationPlan | null> {
  try {
    const [manifest, cognition, policy] = await Promise.all([
      loadManifest(projectRoot),
      readJson<CognitionManifest>(cognitionManifestPath(projectRoot)),
      readJson<CognitionRuntimePolicy>(cognitionPolicyPath(projectRoot)),
    ]);
    if (cognition.schemaVersion !== 2 || cognition.projectId !== manifest.projectId || !policy.enabled || !await v1Synced(projectRoot)) return null;
    const [events, current] = await Promise.all([readJournal(projectRoot), readGitWorktreeState(projectRoot)]);
    if (events.length === 0) return null;
    const projection = projectEvents(events);
    let selected: { contextId: string; snapshotId: string } | null = null;
    if (contextId) {
      const matching = [...Object.keys(projection.contexts)].reverse().find((reference) => contextReference(reference)?.contextId === contextId);
      selected = matching ? contextReference(matching) : null;
    } else {
      const exact = projection.workspaces[workspaceKey(current)];
      const legacy = Object.values(projection.workspaces).find((workspace) => workspace.worktreeId === null && (workspace.ref === current.ref || workspace.branch === current.branch));
      const reference = (exact?.activeContextRef ? exact : legacy)?.activeContextRef;
      selected = reference ? contextReference(reference) : null;
    }
    if (!selected || !projection.contexts[`${selected.contextId}:${selected.snapshotId}`]) return null;
    return { ...selected, ...latestRecords(events, current, selected.contextId) };
  } catch {
    return null;
  }
}

export async function v2Enabled(projectRoot: string): Promise<boolean> {
  try {
    await access(cognitionManifestPath(projectRoot));
    return (await readJson<CognitionRuntimePolicy>(cognitionPolicyPath(projectRoot))).enabled;
  } catch {
    return false;
  }
}
