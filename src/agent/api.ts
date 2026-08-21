import { readdir } from 'node:fs/promises';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { contextsRoot, contextMetadataPath } from '../storage/layout.js';
import { isRecord, readJson } from '../storage/json-store.js';
import { checkpoint, rebuildSnapshot, resume } from '../runtime/runtime.js';
import { discoverDeadends, discoverKnowledge, listDeadends } from '../runtime/knowledge.js';
import type {
  AgentLoadOptions,
  AgentLoadResult,
  AgentSaveResult,
  CheckpointInput,
  ContextMetadata,
  ContextSearchHit,
  ContextSearchOptions,
  ContextSearchResult,
  KnowledgeDiscoveryResult,
  ResumeSummary,
  StructuredContext,
} from '../runtime/types.js';

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

export async function loadContext(startPath: string | undefined, options: AgentLoadOptions = {}): Promise<AgentLoadResult> {
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
