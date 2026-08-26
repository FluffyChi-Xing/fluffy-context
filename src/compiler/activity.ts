import { filterPaths } from '../capture/context-filter.js';
import { workspaceKey } from '../cognition/projections.js';
import type { BranchWorkspace, CognitionEvent, WorkspacePathChange, WorkspacePathsChangedPayload } from '../cognition/types.js';
import type { ContextActivityRecord, ContextAnchor } from './types.js';

const changeKinds = new Set<WorkspacePathChange['kind']>(['created', 'modified', 'deleted', 'renamed', 'unknown']);

function normalizedPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replaceAll('\\', '/');
  return normalized.length > 0 ? normalized : null;
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parsePayload(event: CognitionEvent): WorkspacePathsChangedPayload | null {
  const payload = event.payload as Partial<WorkspacePathsChangedPayload>;
  return payload.schemaVersion === 1 && typeof payload === 'object' && payload !== null ? payload as WorkspacePathsChangedPayload : null;
}

async function activityForEvent(projectRoot: string, event: CognitionEvent, focus: string[]): Promise<ContextActivityRecord | null> {
  const payload = parsePayload(event);
  if (!payload) return null;
  const rawPaths = Array.isArray(payload.paths) ? payload.paths.map(normalizedPath).filter((value): value is string => value !== null) : [];
  const rawChanges = Array.isArray(payload.changes) ? payload.changes : [];
  const changePaths = rawChanges.map((change) => normalizedPath(change?.path)).filter((value): value is string => value !== null);
  const allowed = await filterPaths(projectRoot, [...new Set([...rawPaths, ...changePaths])]);
  if (allowed.length === 0) return null;
  const allowedSet = new Set(allowed);
  const changes: WorkspacePathChange[] = [];
  for (const change of rawChanges) {
    const path = normalizedPath(change?.path);
    if (!path || !allowedSet.has(path)) continue;
    changes.push({
      path,
      kind: changeKinds.has(change?.kind) ? change.kind : 'unknown',
      fileType: 'file',
      ...(metadataNumber(change?.sizeBytes) !== undefined ? { sizeBytes: metadataNumber(change?.sizeBytes) } : {}),
      ...(metadataNumber(change?.mtimeMs) !== undefined ? { mtimeMs: metadataNumber(change?.mtimeMs) } : {}),
    });
  }
  const fallbackChanges = changes.length > 0 ? changes : allowed.map((path) => ({ path, kind: 'unknown' as const, fileType: 'file' as const }));
  const paths = [...new Set(fallbackChanges.map((change) => change.path))].sort(stableCompare);
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    anchor: {
      projectRoot,
      worktreeId: event.git.worktreeId,
      branch: event.git.branch,
      ref: event.git.ref,
      head: event.git.head,
    },
    paths,
    changes: fallbackChanges.sort((left, right) => stableCompare(left.path, right.path)),
    pathCount: typeof payload.pathCount === 'number' && Number.isSafeInteger(payload.pathCount) && payload.pathCount >= paths.length ? payload.pathCount : paths.length,
    coalesced: payload.coalesced === true,
    truncated: payload.truncated === true,
    focusMatch: paths.some((path) => focus.includes(path)),
  };
}

export async function extractActivity(
  projectRoot: string,
  events: CognitionEvent[],
  anchor: ContextAnchor,
  workspace: BranchWorkspace | null,
  limit: number,
): Promise<ContextActivityRecord[]> {
  if (limit <= 0 || !workspace) return [];
  const currentWorkspace = workspaceKey(anchor);
  const matching = events
    .filter((event) => event.type === 'workspace.paths.changed' && workspaceKey(event.git) === currentWorkspace)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.eventId.localeCompare(left.eventId))
    .slice(0, limit);
  const records: ContextActivityRecord[] = [];
  for (const event of matching) {
    const record = await activityForEvent(projectRoot, event, workspace.pathFocus);
    if (record) records.push(record);
  }
  return records;
}
