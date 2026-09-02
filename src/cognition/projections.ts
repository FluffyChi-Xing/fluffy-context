import crypto from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../storage/atomic-write.js';
import {
  cognitionBranchesDirectory,
  cognitionContextsProjectionPath,
  cognitionDeadendsProjectionPath,
  cognitionExperiencesProjectionPath,
  cognitionEvidenceGraphProjectionPath,
  cognitionKnowledgeProjectionPath,
  cognitionNotesProjectionPath,
  cognitionProjectionCursorPath,
  cognitionProposalsProjectionPath,
  cognitionRetrievalProjectionPath,
  cognitionSkillsProjectionPath,
  cognitionRecipesProjectionPath,
} from '../storage/layout.js';
import { readJournal } from './journal.js';
import { buildRetrievalProjection } from './retrieval.js';
import { buildEvidenceGraph } from './evidence-graph.js';
import type { BranchWorkspace, CognitionEvent, CognitionGitAnchor, CognitionProjection, CognitionRecordPayload, CompilerRecipe, CompilerRecipeLifecycleEntry, EvolutionCandidateArtifact, EvolutionLifecycleTransition, EvolutionProposal, EvolutionProposalState, Experience, ProjectionCursor, Skill, SkillInvocation, SkillLifecycleEntry, SkillOutcome, WorkspacePathsChangedPayload } from './types.js';

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

function pathFocusFrom(event: CognitionEvent): string[] {
  const payload = event.payload as Partial<WorkspacePathsChangedPayload>;
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.paths)) return [];
  return [...new Set(payload.paths
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.replaceAll('\\', '/'))
    .filter((value) => value.length > 0 && !value.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..')))]
    .sort()
    .slice(-100);
}

function evolutionRecord<T>(event: CognitionEvent): T | null {
  const payload = event.payload as Record<string, unknown>;
  return isRecord(payload.record) ? payload.record as T : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lifecycleEntry(event: CognitionEvent): EvolutionProposalState['lifecycle'][number] | null {
  const payload = event.payload as Record<string, unknown>;
  const transition = payload.transition;
  if (!isRecord(transition) || transition.entity !== 'proposal' || typeof transition.entityId !== 'string' || typeof transition.from !== 'string' || typeof transition.to !== 'string' || typeof transition.reason !== 'string') return null;
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    from: transition.from as EvolutionLifecycleTransition['from'],
    to: transition.to as EvolutionLifecycleTransition['to'],
    reason: transition.reason,
    ...(isRecord(transition.supersedes) ? { supersedes: transition.supersedes as unknown as EvolutionLifecycleTransition['supersedes'] } : {}),
  };
}

function skillLifecycleEntry(event: CognitionEvent): SkillLifecycleEntry | null {
  const payload = event.payload as Record<string, unknown>;
  const transition = payload.transition;
  if (!isRecord(transition) || transition.entity !== 'skill' || typeof transition.entityId !== 'string' || typeof transition.from !== 'string' || typeof transition.to !== 'string' || typeof transition.reason !== 'string') return null;
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    from: transition.from as EvolutionLifecycleTransition['from'],
    to: transition.to as EvolutionLifecycleTransition['to'],
    reason: transition.reason,
    ...(isRecord(transition.supersedes) ? { supersedes: transition.supersedes as unknown as EvolutionLifecycleTransition['supersedes'] } : {}),
  };
}

function recipeLifecycleEntry(event: CognitionEvent): CompilerRecipeLifecycleEntry | null {
  const payload = event.payload as Record<string, unknown>;
  const transition = payload.transition;
  if (!isRecord(transition) || transition.entity !== 'compiler-recipe' || typeof transition.entityId !== 'string' || typeof transition.from !== 'string' || typeof transition.to !== 'string' || typeof transition.reason !== 'string') return null;
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    from: transition.from as EvolutionLifecycleTransition['from'],
    to: transition.to as EvolutionLifecycleTransition['to'],
    reason: transition.reason,
    ...(isRecord(transition.supersedes) ? { supersedes: transition.supersedes as unknown as EvolutionLifecycleTransition['supersedes'] } : {}),
  };
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
  const projection: CognitionProjection = { schemaVersion: 2, contexts: {}, notes: {}, knowledge: {}, deadends: {}, experiences: {}, proposals: {}, skills: {}, recipes: {}, evidenceGraph: { schemaVersion: 1, derivationVersion: 'evidence-graph-v1', nodes: [], edges: [] }, workspaces: {} };
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
    if (['note.recorded', 'note.resolved', 'note.absorbed'].includes(event.type) && record) {
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
    if (event.type === 'experience.recorded') {
      const experience = evolutionRecord<Experience>(event);
      if (experience && typeof experience.experienceId === 'string') projection.experiences[experience.experienceId] = experience;
    }
    if (event.type === 'evolution.proposed') {
      const proposal = evolutionRecord<EvolutionProposal>(event);
      if (proposal && typeof proposal.proposalId === 'string') {
        projection.proposals[proposal.proposalId] = { proposal, status: proposal.status, lifecycle: [], acceptedArtifact: null };
      }
    }
    if (event.type === 'evolution.candidate.accepted') {
      const artifact = evolutionRecord<EvolutionCandidateArtifact>(event);
      if (artifact && projection.proposals[artifact.proposalId]) projection.proposals[artifact.proposalId].acceptedArtifact = artifact;
    }
    if (['evolution.verified', 'evolution.published', 'evolution.rejected', 'evolution.deprecated', 'evolution.superseded'].includes(event.type)) {
      const entry = lifecycleEntry(event);
      const state = entry ? projection.proposals[(event.payload as { transition: { entityId: string } }).transition.entityId] : null;
      if (entry && state && state.status === entry.from) {
        state.status = entry.to;
        state.lifecycle.push(entry);
      }
    }
    if (event.type === 'skill.materialized') {
      const skill = evolutionRecord<Skill>(event);
      if (skill && typeof skill.skillId === 'string' && !projection.skills[skill.skillId]) {
        projection.skills[skill.skillId] = { skill, status: skill.status, lifecycle: [], invocations: [], outcomes: [] };
      }
    }
    if (['evolution.verified', 'evolution.published', 'evolution.rejected', 'evolution.deprecated', 'evolution.superseded'].includes(event.type)) {
      const skillEntry = skillLifecycleEntry(event);
      const skillState = skillEntry ? projection.skills[(event.payload as { transition: { entityId: string } }).transition.entityId] : null;
      if (skillEntry && skillState && skillState.status === skillEntry.from) {
        skillState.status = skillEntry.to;
        skillState.lifecycle.push(skillEntry);
      }
    }
    if (event.type === 'recipe.materialized') {
      const recipe = evolutionRecord<CompilerRecipe>(event);
      if (recipe && typeof recipe.recipeId === 'string' && !projection.recipes[recipe.recipeId]) {
        projection.recipes[recipe.recipeId] = { recipe, status: recipe.status, lifecycle: [] };
      }
    }
    if (['evolution.verified', 'evolution.published', 'evolution.rejected', 'evolution.deprecated', 'evolution.superseded'].includes(event.type)) {
      const recipeEntry = recipeLifecycleEntry(event);
      const recipeState = recipeEntry ? projection.recipes[(event.payload as { transition: { entityId: string } }).transition.entityId] : null;
      if (recipeEntry && recipeState && recipeState.status === recipeEntry.from) {
        recipeState.status = recipeEntry.to;
        recipeState.lifecycle.push(recipeEntry);
      }
    }
    if (event.type === 'skill.invoked') {
      const invocation = evolutionRecord<SkillInvocation>(event);
      const skillState = invocation ? projection.skills[invocation.skillId] : null;
      if (invocation && skillState && skillState.status === 'published' && !skillState.invocations.some((item) => item.invocationId === invocation.invocationId)) skillState.invocations.push(invocation);
    }
    if (event.type === 'skill.outcome.recorded') {
      const outcome = evolutionRecord<SkillOutcome>(event);
      if (outcome) {
        const skillState = Object.values(projection.skills).find((state) => state.invocations.some((invocation) => invocation.invocationId === outcome.invocationId));
        if (skillState && !skillState.outcomes.some((item) => item.invocationId === outcome.invocationId)) skillState.outcomes.push(outcome);
      }
    }
    if (event.type === 'note.recorded' && openObservationIds.has(event.eventId)) {
      workspace.openObservationEventIds = [...workspace.openObservationEventIds, event.eventId].slice(-50);
    }
    if (event.type === 'workspace.paths.changed') {
      workspace.pathFocus = [...new Set([...workspace.pathFocus, ...pathFocusFrom(event)])].sort().slice(-100);
    }
    projection.workspaces[key] = workspace;
  }
  projection.evidenceGraph = buildEvidenceGraph(events);
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
    atomicWriteJson(cognitionExperiencesProjectionPath(projectRoot), projection.experiences),
    atomicWriteJson(cognitionProposalsProjectionPath(projectRoot), projection.proposals),
    atomicWriteJson(cognitionSkillsProjectionPath(projectRoot), projection.skills),
    atomicWriteJson(cognitionRecipesProjectionPath(projectRoot), projection.recipes),
    atomicWriteJson(cognitionEvidenceGraphProjectionPath(projectRoot), projection.evidenceGraph),
    atomicWriteJson(cognitionRetrievalProjectionPath(projectRoot), retrieval),
    ...Object.values(projection.workspaces).map((workspace) => atomicWriteJson(`${cognitionBranchesDirectory(projectRoot)}/${workspace.workspaceKey}.json`, workspace)),
  ]);
  await atomicWriteJson(cognitionProjectionCursorPath(projectRoot), cursor);
  return { projection, cursor };
}
