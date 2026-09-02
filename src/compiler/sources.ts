import { readGitWorktreeState } from '../git/git-adapter.js';
import { contextOrient } from '../agent/api.js';
import { readJournal } from '../cognition/journal.js';
import { projectEvents, workspaceKey } from '../cognition/projections.js';
import type { BranchWorkspace, CognitionEvent, CompilerRecipeState } from '../cognition/types.js';
import type { ContextOrientResult } from '../agent/types.js';
import type { ContextAnchor, ContextProvenance, ContextSourceDescriptor, ContextSourceApplicability } from './types.js';
import type { ContextCompileOptions } from './types.js';

export interface CompilerSources {
  orientation: ContextOrientResult;
  anchor: ContextAnchor;
  events: CognitionEvent[];
  workspace: BranchWorkspace | null;
  recipe: CompilerRecipeState | null;
  fallbackReason: string | null;
}

function anchorFromGit(git: Awaited<ReturnType<typeof readGitWorktreeState>>, projectRoot: string): ContextAnchor {
  return {
    projectRoot,
    worktreeId: git.worktreeId,
    branch: git.branch,
    ref: git.ref,
    head: git.commit,
  };
}

function payloadRecord(event: CognitionEvent): Record<string, unknown> | null {
  const payload = event.payload as Record<string, unknown>;
  return payload.record && typeof payload.record === 'object' && !Array.isArray(payload.record)
    ? payload.record as Record<string, unknown>
    : null;
}

function matchesRecord(event: CognitionEvent, entityId: string): boolean {
  if (event.eventId === entityId) return true;
  const record = payloadRecord(event);
  return record?.contextId === entityId
    || record?.knowledgeId === entityId
    || record?.deadendId === entityId
    || record?.noteId === entityId
    || record?.snapshotId === entityId;
}

export function sourceApplicability(event: CognitionEvent | null, anchor: ContextAnchor): ContextSourceApplicability {
  if (!event || (event.git.branch === null && event.git.ref === null)) {
    return { project: true, branchMode: 'global', branches: [], paths: [], worktreeId: null, ref: null };
  }
  return {
    project: true,
    branchMode: 'exact',
    branches: [event.git.ref ?? event.git.branch ?? 'detached'],
    paths: [],
    worktreeId: event.git.worktreeId,
    ref: event.git.ref,
  };
}

export function provenanceFor(events: CognitionEvent[], entityId: string, anchor: ContextAnchor): ContextProvenance {
  const event = [...events].reverse().find((item) => matchesRecord(item, entityId));
  if (!event) {
    return {
      origin: 'v1-file',
      eventId: null,
      eventType: null,
      occurredAt: null,
      sourcePath: null,
      sourceHash: null,
      anchorProvenance: null,
    };
  }
  const payload = event.payload as Record<string, unknown>;
  return {
    origin: 'v2-journal',
    eventId: event.eventId,
    eventType: event.type,
    occurredAt: event.occurredAt,
    sourcePath: typeof payload.sourcePath === 'string' ? payload.sourcePath : null,
    sourceHash: typeof payload.sourceHash === 'string' ? payload.sourceHash : null,
    anchorProvenance: payload.anchorProvenance === 'snapshot' || payload.anchorProvenance === 'live' || payload.anchorProvenance === 'global'
      ? payload.anchorProvenance
      : null,
  };
}

export function sourceDescriptor(
  projectRoot: string,
  anchor: ContextAnchor,
  events: CognitionEvent[],
  kind: ContextSourceDescriptor['kind'],
  entityId: string,
  contextId: string | null,
  snapshotId: string | null,
  status: string | null,
  scope: string | null,
  paths: string[],
): ContextSourceDescriptor {
  const provenance = provenanceFor(events, entityId, anchor);
  const event = provenance.eventId ? events.find((item) => item.eventId === provenance.eventId) ?? null : null;
  return {
    sourceId: `${kind}:${entityId}`,
    kind,
    entityId,
    contextId,
    snapshotId,
    status,
    scope,
    paths: [...new Set(paths)].sort(),
    anchor,
    applicability: sourceApplicability(event, anchor),
    privacy: { classification: provenance.origin === 'v2-journal' ? (event?.privacy.classification ?? 'metadata') : 'metadata', redactionCount: event?.privacy.redactionCount ?? 0 },
    provenance,
  };
}

export async function loadCompilerSources(startPath: string | undefined, options: ContextCompileOptions): Promise<CompilerSources> {
  const orientation = await contextOrient(startPath, {
    contextId: options.contextId,
    query: options.query,
    scope: options.scope,
    maxChars: Number.MAX_SAFE_INTEGER,
    knowledgeLimit: options.knowledgeLimit ?? 10,
    deadendLimit: options.deadendLimit ?? 10,
    noteLimit: options.noteLimit ?? 20,
  }, null);
  const projectRoot = orientation.projectRoot;
  const git = await readGitWorktreeState(projectRoot);
  let events: CognitionEvent[] = [];
  let fallbackReason: string | null = null;
  try {
    events = await readJournal(projectRoot);
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : 'journal-unavailable';
  }
  const anchor = anchorFromGit(git, projectRoot);
  const projection = events.length > 0 ? projectEvents(events) : null;
  const workspace = projection?.workspaces[workspaceKey(anchor)] ?? null;
  const recipeId = options.recipeId?.trim();
  if (options.recipeId !== undefined && !recipeId) throw new Error('compiler recipe ID must not be empty');
  const recipe = recipeId ? projection?.recipes[recipeId] ?? null : null;
  if (recipeId && !recipe) throw new Error(`compiler recipe not found: ${recipeId}`);
  if (recipe && !['verified', 'published'].includes(recipe.status)) throw new Error(`compiler recipe is not active: ${recipe.recipe.recipeId}`);
  return { orientation, anchor, events, workspace, recipe, fallbackReason };
}

export function latestHostIntent(events: CognitionEvent[], anchor: ContextAnchor): { value: string; eventId: string } | null {
  const event = [...events].reverse().find((candidate) => {
    if (candidate.type !== 'host.prompt.submitted') return false;
    if (candidate.git.worktreeId !== null && candidate.git.worktreeId !== anchor.worktreeId) return false;
    if (candidate.git.ref !== null && candidate.git.ref !== anchor.ref) return false;
    const payload = candidate.payload as Record<string, unknown>;
    return typeof payload.intent === 'string' && payload.intent.trim().length > 0;
  });
  if (!event) return null;
  return { value: (event.payload as Record<string, unknown>).intent as string, eventId: event.eventId };
}
