import { readdir } from 'node:fs/promises';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { contextsRoot, contextMetadataPath } from '../storage/layout.js';
import { isRecord, readJson } from '../storage/json-store.js';
import { checkpoint, rebuildSnapshot, resume, resumeSnapshot } from '../runtime/runtime.js';
import { recordUse } from '../cognition/feedback.js';
import { inspectRecipe, listRecipes, materializeRecipe, transitionRecipe, type MaterializeRecipeInput, type TransitionRecipeInput } from '../cognition/recipes.js';
import { inspectSkill, listSkills, materializeSkill, recordSkillInvocation, recordSkillOutcome, transitionSkill, type MaterializeSkillInput, type RecordSkillInvocationInput, type RecordSkillOutcomeInput, type TransitionSkillInput } from '../cognition/skills.js';
import { selectV2Orientation } from '../cognition/orient.js';
import { discoverV2Deadends, discoverV2Knowledge } from '../cognition/retrieval.js';
import { discoverDeadends, discoverKnowledge, listDeadends } from '../runtime/knowledge.js';
import { listNotes } from '../runtime/notes.js';
import { expandContext } from '../compiler/expand.js';
import { compileContext } from '../compiler/compile.js';
import { withUsageTelemetry, type UsageInterface } from '../cognition/usage.js';
import { buildUsageReport, type UsageReport, type UsageReportOptions } from '../cognition/usage-report.js';
import type {
  AgentLoadOptions,
  AgentLoadResult,
  AgentSaveResult,
  CheckpointInput,
  ContextMetadata,
  ContextSearchHit,
  ContextSearchOptions,
  ContextSearchResult,
  DeadendDiscoveryResult,
  KnowledgeDiscoveryResult,
  Note,
  ResumeSummary,
  StructuredContext,
} from '../runtime/types.js';
import type { ContextOrientOptions, ContextOrientResult, ContextUseInput } from './types.js';
import type { ContextExpandInput, ContextExpandResult, ContextCompileOptions, ContextManifest } from '../compiler/types.js';

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function terms(query: string): string[] {
  return [...new Set(normalized(query).split(/\s+/).filter(Boolean))];
}

function limited(value: string, budget: { remaining: number }): string {
  if (budget.remaining <= 0) return '';
  const result = value.length <= budget.remaining ? value : `${value.slice(0, Math.max(0, budget.remaining - 1))}…`;
  budget.remaining -= result.length;
  return result;
}

function limitedList(values: string[], budget: { remaining: number }): string[] {
  return values.flatMap((value) => {
    if (budget.remaining <= 0) return [];
    const result = limited(value, budget);
    return result ? [result] : [];
  });
}

function textLength(value: string | null | string[]): number {
  return Array.isArray(value) ? value.reduce((total, item) => total + item.length, 0) : value?.length ?? 0;
}

function emptyKnowledge(query: string): KnowledgeDiscoveryResult {
  return { query, total: 0, truncated: false, hits: [], duplicateIds: [], possibleConflicts: [] };
}

function emptyDeadends(query: string): DeadendDiscoveryResult {
  return { query, total: 0, truncated: false, hits: [] };
}

function limitKnowledge(result: KnowledgeDiscoveryResult, budget: { remaining: number }): { result: KnowledgeDiscoveryResult; truncated: boolean } {
  let truncated = false;
  const hits = [];
  for (const hit of result.hits) {
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    const statement = limited(hit.knowledge.statement, budget);
    const supportingEvidence = limitedList(hit.knowledge.supportingEvidence, budget);
    if (statement.length < hit.knowledge.statement.length || supportingEvidence.length < hit.knowledge.supportingEvidence.length) truncated = true;
    hits.push({ ...hit, knowledge: { ...hit.knowledge, statement, supportingEvidence } });
  }
  if (hits.length < result.hits.length) truncated = true;
  return { result: { ...result, hits, truncated: result.truncated || truncated }, truncated };
}

function limitDeadends(result: DeadendDiscoveryResult, budget: { remaining: number }): { result: DeadendDiscoveryResult; truncated: boolean } {
  let truncated = false;
  const hits = [];
  for (const hit of result.hits) {
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    const attempt = limited(hit.deadend.attempt, budget);
    const reason = limited(hit.deadend.reason, budget);
    const observedEvidence = limitedList(hit.deadend.observedEvidence, budget);
    if (attempt.length < hit.deadend.attempt.length || reason.length < hit.deadend.reason.length || observedEvidence.length < hit.deadend.observedEvidence.length) truncated = true;
    hits.push({ ...hit, deadend: { ...hit.deadend, attempt, reason, observedEvidence } });
  }
  if (hits.length < result.hits.length) truncated = true;
  return { result: { ...result, hits, truncated: result.truncated || truncated }, truncated };
}

function limitNotes(notes: Note[], budget: { remaining: number }): { notes: Note[]; truncated: boolean } {
  const result: Note[] = [];
  for (const note of notes) {
    if (budget.remaining <= 0) return { notes: result, truncated: true };
    const message = limited(note.message, budget);
    result.push({ ...note, message });
    if (message.length < note.message.length) return { notes: result, truncated: true };
  }
  return { notes: result, truncated: false };
}

function summary(content: StructuredContext, maxChars: number, branchOrCommitDrift = false): ResumeSummary {
  const budget = { remaining: Math.max(0, maxChars) };
  return {
    progressSummary: limited(content.progressSummary, budget),
    lastError: content.lastError === null ? null : limited(content.lastError, budget),
    completed: limitedList(content.completed, budget),
    pendingTasks: limitedList(content.pendingTasks, budget),
    decisions: limitedList(content.decisions, budget),
    risks: limitedList(content.risks, budget),
    relatedFiles: limitedList(content.relatedFiles, budget),
    branchOrCommitDrift,
  };
}

function isContextMetadata(value: unknown): value is ContextMetadata {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.projectRoot === 'string'
    && (typeof value.currentSnapshotId === 'string' || value.currentSnapshotId === null)
    && ['draft', 'active', 'stable', 'archived', 'deleted'].includes(value.status as string);
}

function matchedContext(context: ContextMetadata, content: StructuredContext, queryTerms: string[]): { matchedFields: string[]; matchedTerms: string[]; score: number } {
  const values: Record<string, string> = {
    title: context.title,
    progressSummary: content.progressSummary,
    lastError: content.lastError ?? '',
    completed: content.completed.join(' '),
    pendingTasks: content.pendingTasks.join(' '),
    decisions: content.decisions.join(' '),
    risks: content.risks.join(' '),
    relatedFiles: content.relatedFiles.join(' '),
  };
  const matchedFields = new Set<string>();
  const matchedTerms = new Set<string>();
  let score = 0;
  for (const term of queryTerms) {
    for (const [field, value] of Object.entries(values)) {
      if (normalized(value).includes(term)) {
        matchedFields.add(field);
        matchedTerms.add(term);
        score += field === 'title' ? 5 : 3;
      }
    }
  }
  return { matchedFields: [...matchedFields], matchedTerms: [...matchedTerms], score };
}

export async function saveContext(startPath: string | undefined, input: CheckpointInput, options: { minSaveIntervalMs?: number } = {}): Promise<AgentSaveResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  return { projectRoot, result: await checkpoint(projectRoot, input, options) };
}

export async function contextExpand(startPath: string | undefined, input: ContextExpandInput, interfaceName: UsageInterface = 'agent'): Promise<ContextExpandResult> {
  return withUsageTelemetry(startPath, 'expand', 'agent', input, () => resolveProjectRoot(startPath).then((projectRoot) => expandContext(projectRoot, input)), interfaceName);
}

export async function contextCompile(startPath: string | undefined, options: ContextCompileOptions = {}, interfaceName: UsageInterface = 'agent'): Promise<ContextManifest> {
  return withUsageTelemetry(startPath, 'compile', 'agent', options, () => compileContext(startPath, options), interfaceName);
}

export async function loadContext(startPath: string | undefined, options: AgentLoadOptions = {}, interfaceName: UsageInterface = 'agent'): Promise<AgentLoadResult> {
  return withUsageTelemetry(startPath, 'resume', 'agent', options, async () => {
    const projectRoot = await resolveProjectRoot(startPath);
    const result = await resume(projectRoot, options.contextId, options.maxChars ?? 4000);
    const knowledge = options.query === undefined ? null : await discoverKnowledge(projectRoot, options.query, { scope: options.scope, maxChars: options.maxChars ?? 4000 });
    const verifiedDeadends = await listDeadends(projectRoot);
    return {
      projectRoot,
      context: result.context,
      snapshot: result.snapshot,
      resumeSummary: result.resumeSummary,
      ...(options.includeDetails ? { details: result.details } : {}),
      knowledge,
      verifiedDeadendIds: verifiedDeadends.map((item) => item.deadendId),
    };
  }, interfaceName);
}

export async function contextOrient(startPath: string | undefined, options: ContextOrientOptions = {}, interfaceName: UsageInterface | null = 'agent'): Promise<ContextOrientResult> {
  const action: () => Promise<ContextOrientResult> = async () => {
    const projectRoot = await resolveProjectRoot(startPath);
    const query = options.query === undefined ? null : options.query.trim();
    if (query === '') throw new Error('context orient query must not be empty');

  let loaded;
  try {
    const v2 = await selectV2Orientation(projectRoot, options.contextId);
    loaded = v2
      ? await resumeSnapshot(projectRoot, v2.contextId, v2.snapshotId, options.maxChars ?? 4000)
      : await resume(projectRoot, options.contextId, options.maxChars ?? 4000, { touchLastUsedAt: false });
  } catch (error) {
    if (error instanceof Error && error.message === 'no active context found') {
      return {
        status: 'no_context',
        projectRoot,
        query,
        context: null,
        snapshot: null,
        resumeSummary: null,
        knowledge: emptyKnowledge(query ?? ''),
        deadends: emptyDeadends(query ?? ''),
        notes: [],
        truncated: false,
        explanation: {
          mode: 'v1-fallback',
          selection: 'v1',
          retrieval: { knowledge: {}, deadends: {} },
          truncation: { summary: false, knowledge: false, deadends: false, notes: false },
        },
      };
    }
    throw error;
  }

  const v2 = await selectV2Orientation(projectRoot, options.contextId);
  const notes = (await listNotes(projectRoot, {
    contextId: loaded.context.id,
    openOnly: true,
    limit: v2 ? Number.MAX_SAFE_INTEGER : options.noteLimit ?? 20,
    maxChars: options.maxChars ?? 4000,
  })).filter((note) => !v2 || v2.noteIds.has(note.noteId)).slice(0, options.noteLimit ?? 20);
  const v2Knowledge = query === null || !v2 ? null : discoverV2Knowledge(v2.retrieval, query, v2.currentGit, {
    scope: options.scope,
    limit: options.knowledgeLimit ?? 10,
    maxChars: options.maxChars ?? 4000,
  });
  const v2Deadends = query === null || !v2 ? null : discoverV2Deadends(v2.retrieval, query, v2.currentGit, {
    scope: options.scope,
    limit: options.deadendLimit ?? 10,
    maxChars: options.maxChars ?? 4000,
  });
  const applicableKnowledge = query === null
    ? emptyKnowledge('')
    : v2Knowledge?.result ?? await discoverKnowledge(projectRoot, query, {
      scope: options.scope,
      limit: options.knowledgeLimit ?? 10,
      maxChars: options.maxChars ?? 4000,
    });
  const applicableDeadends = query === null
    ? emptyDeadends('')
    : v2Deadends?.result ?? await discoverDeadends(projectRoot, query, {
      scope: options.scope,
      limit: options.deadendLimit ?? 10,
      maxChars: options.maxChars ?? 4000,
    });

  const budget = { remaining: Math.max(0, options.maxChars ?? 4000) };
  const resumeSummary: ResumeSummary = {
    progressSummary: limited(loaded.resumeSummary.progressSummary, budget),
    lastError: loaded.resumeSummary.lastError === null ? null : limited(loaded.resumeSummary.lastError, budget),
    completed: limitedList(loaded.resumeSummary.completed, budget),
    pendingTasks: limitedList(loaded.resumeSummary.pendingTasks, budget),
    decisions: limitedList(loaded.resumeSummary.decisions, budget),
    risks: limitedList(loaded.resumeSummary.risks, budget),
    relatedFiles: limitedList(loaded.resumeSummary.relatedFiles, budget),
    branchOrCommitDrift: loaded.resumeSummary.branchOrCommitDrift,
  };
  const resumeTruncated = textLength(resumeSummary.progressSummary) < textLength(loaded.resumeSummary.progressSummary)
    || textLength(resumeSummary.lastError) < textLength(loaded.resumeSummary.lastError)
    || textLength(resumeSummary.completed) < textLength(loaded.resumeSummary.completed)
    || textLength(resumeSummary.pendingTasks) < textLength(loaded.resumeSummary.pendingTasks)
    || textLength(resumeSummary.decisions) < textLength(loaded.resumeSummary.decisions)
    || textLength(resumeSummary.risks) < textLength(loaded.resumeSummary.risks)
    || textLength(resumeSummary.relatedFiles) < textLength(loaded.resumeSummary.relatedFiles);
  const limitedKnowledgeResult = limitKnowledge(applicableKnowledge, budget);
  const limitedDeadendResult = limitDeadends(applicableDeadends, budget);
  const limitedNotesResult = limitNotes(notes, budget);

  return {
    status: 'ready',
    projectRoot,
    query,
    context: {
      id: loaded.context.id,
      title: loaded.context.title,
      status: loaded.context.status,
      branch: loaded.context.branch,
      commit: loaded.context.commit,
      updatedAt: loaded.context.updatedAt,
    },
    snapshot: {
      snapshotId: loaded.snapshot.snapshotId,
      mode: loaded.snapshot.mode,
      createdAt: loaded.snapshot.createdAt,
      branch: loaded.snapshot.branch,
      commit: loaded.snapshot.commit,
    },
    resumeSummary,
    knowledge: limitedKnowledgeResult.result,
    deadends: limitedDeadendResult.result,
    notes: limitedNotesResult.notes,
    truncated: resumeTruncated || limitedKnowledgeResult.truncated || limitedDeadendResult.truncated || limitedNotesResult.truncated,
    explanation: {
      mode: v2 ? 'v2' : 'v1-fallback',
      selection: v2?.selection ?? 'v1',
      retrieval: {
        knowledge: v2Knowledge?.exclusions ?? {},
        deadends: v2Deadends?.exclusions ?? {},
      },
      truncation: {
        summary: resumeTruncated,
        knowledge: limitedKnowledgeResult.truncated,
        deadends: limitedDeadendResult.truncated,
        notes: limitedNotesResult.truncated,
      },
    },
  };
  };
  return interfaceName === null
    ? action()
    : withUsageTelemetry(startPath, 'orient', 'agent', options, action, interfaceName);
}

export async function contextUsageReport(startPath: string | undefined, options: UsageReportOptions = {}): Promise<UsageReport> {
  return buildUsageReport(startPath, options);
}

export async function recordContextUse(startPath: string | undefined, input: ContextUseInput): Promise<{ recorded: boolean; eventId: string }> {
  return recordUse(startPath, input);
}

export { inspectRecipe, inspectSkill, listRecipes, listSkills };

export async function materializeContextRecipe(startPath: string | undefined, input: MaterializeRecipeInput): Promise<{ materialized: boolean; recipeId: string; eventId: string }> {
  return materializeRecipe(startPath, input);
}

export async function transitionContextRecipe(startPath: string | undefined, input: TransitionRecipeInput): Promise<{ transitioned: boolean; eventId: string }> {
  return transitionRecipe(startPath, input);
}

export async function materializeContextSkill(startPath: string | undefined, input: MaterializeSkillInput): Promise<{ materialized: boolean; skillId: string; eventId: string }> {
  return materializeSkill(startPath, input);
}

export async function transitionContextSkill(startPath: string | undefined, input: TransitionSkillInput): Promise<{ transitioned: boolean; eventId: string }> {
  return transitionSkill(startPath, input);
}

export async function recordContextSkillInvocation(startPath: string | undefined, input: RecordSkillInvocationInput): Promise<{ recorded: boolean; eventId: string }> {
  return recordSkillInvocation(startPath, input);
}

export async function recordContextSkillOutcome(startPath: string | undefined, input: RecordSkillOutcomeInput): Promise<{ recorded: boolean; eventId: string }> {
  return recordSkillOutcome(startPath, input);
}

export async function searchContext(startPath: string | undefined, query: string, options: ContextSearchOptions = {}): Promise<ContextSearchResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  const cleanQuery = query.trim();
  if (!cleanQuery) throw new Error('context search query must not be empty');
  const queryTerms = terms(cleanQuery);
  const contextIds = options.contextId ? [options.contextId] : await readdir(contextsRoot(projectRoot));
  const matches: ContextSearchHit[] = [];
  for (const contextId of contextIds) {
    const context = await readJson<ContextMetadata>(contextMetadataPath(projectRoot, contextId), isContextMetadata);
    if (!['active', 'stable'].includes(context.status) || !context.currentSnapshotId) continue;
    const content = await rebuildSnapshot(projectRoot, context.id, context.currentSnapshotId);
    const match = matchedContext(context, content, queryTerms);
    if (match.matchedTerms.length === 0) continue;
    matches.push({
      context,
      snapshotId: context.currentSnapshotId,
      score: match.score,
      matchedTerms: match.matchedTerms,
      matchedFields: match.matchedFields,
      summary: summary(content, options.maxChars ?? 4000),
    });
  }
  matches.sort((left, right) => right.score - left.score || right.context.updatedAt.localeCompare(left.context.updatedAt) || left.context.id.localeCompare(right.context.id));
  const limit = options.limit ?? 10;
  const selected = matches.slice(0, limit);
  const knowledge: KnowledgeDiscoveryResult = await discoverKnowledge(projectRoot, cleanQuery, { scope: options.scope, maxChars: options.maxChars ?? 4000 });
  const deadends = await discoverDeadends(projectRoot, cleanQuery, { scope: options.scope, maxChars: options.maxChars ?? 4000 });
  return {
    projectRoot,
    query: cleanQuery,
    total: matches.length,
    truncated: matches.length > selected.length,
    hits: selected,
    knowledge,
    verifiedDeadendIds: deadends.hits.map((hit) => hit.deadend.deadendId),
  };
}
