import { filterPaths } from '../capture/context-filter.js';
import { contentHash, estimateTokens, rebuildManifestHash } from './identity.js';
import { queryTerms } from '../cognition/retrieval.js';
import { listDeadends, listKnowledge } from '../runtime/knowledge.js';
import { listNotes } from '../runtime/notes.js';
import type { Deadend, Knowledge, Note } from '../runtime/types.js';
import { extractActivity } from './activity.js';
import { graphOrdering } from './graph.js';
import { latestHostIntent, loadCompilerSources, sourceDescriptor, type CompilerSources } from './sources.js';
import type { ContextActivityRecord } from './types.js';
import type {
  ContextAnchor,
  ContextCandidate,
  ContextCandidateSection,
  ContextCompileOptions,
  ContextExclusion,
  ContextExclusionReason,
  ContextIntent,
  ContextIntentSignal,
  ContextManifest,
  ContextRecipeParticipation,
  ContextScenario,
  ContextSourceDescriptor,
  ContextTruncation,
} from './types.js';

const scenarioKeywords: Array<{ scenario: ContextScenario; words: string[] }> = [
  { scenario: 'debugging', words: ['bug', 'error', 'fail', 'failure', 'exception', 'regression', 'debug', '失败', '报错', '异常', '修复'] },
  { scenario: 'verification', words: ['test', 'verify', 'check', 'build', '测试', '验证', '检查', '构建'] },
  { scenario: 'handoff', words: ['handoff', 'summary', '交接', '总结', '移交'] },
  { scenario: 'implementation', words: ['implement', 'add', 'change', 'feature', '实现', '新增', '修改', '功能'] },
  { scenario: 'exploration', words: ['search', 'investigate', 'find', 'explore', '查找', '调查', '分析', '探索'] },
  { scenario: 'resume', words: ['resume', 'continue', 'restore', '继续', '恢复'] },
];

const priorities: Record<ContextCandidateSection, number> = {
  summary: 100,
  pending: 95,
  risk: 94,
  decision: 92,
  note: 85,
  knowledge: 75,
  deadend: 73,
  activity: 70,
};

function clean(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function anchorFromSources(sources: CompilerSources): ContextAnchor {
  return sources.anchor;
}

function signal(source: ContextIntentSignal['source'], value: string, origin: ContextIntentSignal['origin'], confidence: ContextIntentSignal['confidence']): ContextIntentSignal {
  return { source, value, origin, confidence };
}

function inferScenario(query: string | null, explicit: ContextScenario | undefined): { scenario: ContextScenario; signals: ContextIntentSignal[] } {
  if (explicit) return { scenario: explicit, signals: [signal('explicit-scenario', explicit, 'explicit', 'high')] };
  if (!query) return { scenario: 'resume', signals: [] };
  const normalized = clean(query);
  const matches = scenarioKeywords.flatMap(({ scenario, words }) => words.filter((word) => normalized.includes(clean(word))).map((word) => ({ scenario, word })));
  if (matches.length === 0) return { scenario: 'unknown', signals: [] };
  const selected = matches[0].scenario;
  return {
    scenario: selected,
    signals: matches.map(({ scenario, word }) => signal('context-state', `${scenario}:${word}`, 'deterministic', 'medium')),
  };
}

function sourcePaths(record: Record<string, unknown>): string[] {
  const applicability = record.applicability;
  if (!applicability || typeof applicability !== 'object' || Array.isArray(applicability)) return [];
  const paths = (applicability as Record<string, unknown>).paths;
  return Array.isArray(paths) ? paths.filter((value): value is string => typeof value === 'string') : [];
}

function sourceApplicability(record: Record<string, unknown>, descriptor: ContextSourceDescriptor): ContextSourceDescriptor {
  const applicability = record.applicability;
  if (!applicability || typeof applicability !== 'object' || Array.isArray(applicability)) return descriptor;
  const value = applicability as Record<string, unknown>;
  const branchMode = value.branchMode === 'global' || value.branchMode === 'exact' ? value.branchMode : descriptor.applicability.branchMode;
  const branches = Array.isArray(value.branches) ? value.branches.filter((item): item is string => typeof item === 'string').map(clean).sort(stableCompare) : descriptor.applicability.branches;
  const paths = sourcePaths(record).map((item) => item.replaceAll('\\', '/')).sort(stableCompare);
  return {
    ...descriptor,
    scope: typeof record.scope === 'string' ? record.scope : descriptor.scope,
    paths,
    applicability: {
      ...descriptor.applicability,
      branchMode,
      branches,
      paths,
      ref: descriptor.applicability.ref,
    },
  };
}

function matched(text: string, terms: string[]): { score: number; matchedTerms: string[] } {
  const normalized = clean(text);
  const matchedTerms = terms.filter((term) => normalized.includes(term));
  return { score: matchedTerms.length, matchedTerms };
}

function makeCandidate<T>(
  section: ContextCandidateSection,
  source: ContextSourceDescriptor,
  content: T,
  text: string,
  terms: string[],
  matchedFields: string[],
  discriminator: string,
): ContextCandidate<T> {
  const hit = matched(text, terms);
  const candidateId = `${section}:${source.sourceId}:${matchedFields.join('.')}:${discriminator}`;
  return {
    candidateId,
    section,
    source,
    content,
    text,
    priority: priorities[section],
    score: hit.score,
    matchedTerms: hit.matchedTerms,
    matchedFields,
    originalChars: text.length,
    selectedChars: 0,
    selected: false,
    truncated: false,
    level: 'summary',
    itemHash: contentHash({ candidateId, source, content, text }),
    tokenEstimate: estimateTokens(text),
    expandable: true,
  };
}

function applicable(candidate: ContextCandidate, intent: ContextIntent): { ok: boolean; reason?: ContextExclusionReason } {
  const source = candidate.source;
  if (source.privacy.classification === 'unknown') return { ok: false, reason: 'v2_unavailable' };
  if (source.status && ['candidate', 'deprecated', 'rejected', 'obsolete'].includes(source.status)) return { ok: false, reason: 'status_not_verified' };
  if (source.applicability.branchMode === 'unsupported') return { ok: false, reason: 'unsupported_applicability' };
  if (source.applicability.branchMode === 'exact') {
    const branch = intent.anchor.ref ?? intent.anchor.branch ?? 'detached';
    if (source.applicability.branches.length > 0 && !source.applicability.branches.includes(branch) && !source.applicability.branches.includes(intent.anchor.branch ?? '')) return { ok: false, reason: 'applicability_mismatch' };
    if (source.applicability.worktreeId && source.applicability.worktreeId !== intent.anchor.worktreeId) return { ok: false, reason: 'applicability_mismatch' };
    if (source.applicability.ref && source.applicability.ref !== intent.anchor.ref) return { ok: false, reason: 'applicability_mismatch' };
  }
  if (intent.scope && source.scope && clean(intent.scope) !== clean(source.scope)) return { ok: false, reason: 'scope_mismatch' };
  if (intent.paths.length > 0 && source.paths.length > 0 && !source.paths.some((path) => intent.paths.includes(path))) return { ok: false, reason: 'path_mismatch' };
  if (intent.query && ['knowledge', 'deadend'].includes(candidate.section) && candidate.matchedTerms.length === 0) return { ok: false, reason: 'query_no_match' };
  return { ok: true };
}

function sortCandidates(left: ContextCandidate, right: ContextCandidate): number {
  return right.score - left.score
    || right.priority - left.priority
    || right.matchedTerms.length - left.matchedTerms.length
    || stableCompare(left.candidateId, right.candidateId);
}

function recipeParticipation(sources: CompilerSources): ContextRecipeParticipation | undefined {
  const recipe = sources.recipe?.recipe;
  if (!recipe) return undefined;
  return {
    recipeId: recipe.recipeId,
    contentHash: recipe.contentHash,
    interpreterVersion: 'recipe-interpreter-v1',
    preferredSources: [...(recipe.preferredSources ?? [])],
    preferredSections: [...(recipe.preferredSections ?? [])],
    sectionBudgets: { ...(recipe.sectionBudgets ?? {}) },
  };
}

function sourcePreference(candidate: ContextCandidate, recipe: ContextRecipeParticipation): number {
  const source = candidate.source.kind === 'current-context' ? 'context' : candidate.source.kind;
  const index = recipe.preferredSources.indexOf(source as ContextRecipeParticipation['preferredSources'][number]);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sectionPreference(candidate: ContextCandidate, recipe: ContextRecipeParticipation): number {
  const index = recipe.preferredSections.indexOf(candidate.section);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function recipeApplicable(recipe: ContextRecipeParticipation, sources: CompilerSources, paths: string[]): boolean {
  const applicability = sources.recipe!.recipe.applicability;
  if (applicability.branchMode === 'global') return true;
  if (applicability.branchMode !== 'exact') return false;
  const branch = sources.anchor.ref ?? sources.anchor.branch ?? 'detached';
  if (applicability.branches?.length && !applicability.branches.includes(branch) && !applicability.branches.includes(sources.anchor.branch ?? '')) return false;
  if (applicability.sourceCommit && applicability.sourceCommit !== sources.anchor.head) return false;
  if (paths.length > 0 && applicability.paths?.length && !applicability.paths.some((path) => paths.includes(path.replaceAll('\\', '/')))) return false;
  return recipe.recipeId === sources.recipe!.recipe.recipeId;
}

function sortWithRecipe(recipe: ContextRecipeParticipation | undefined, scenario: ContextScenario): (left: ContextCandidate, right: ContextCandidate) => number {
  const compare = scenario === 'resume' || scenario === 'handoff'
    ? (left: ContextCandidate, right: ContextCandidate) => right.priority - left.priority || sortCandidates(left, right)
    : sortCandidates;
  if (!recipe) return compare;
  return (left, right) => sourcePreference(left, recipe) - sourcePreference(right, recipe)
    || sectionPreference(left, recipe) - sectionPreference(right, recipe)
    || compare(left, right);
}

function budgetGroup(candidate: ContextCandidate): 'task' | 'evidence' {
  return candidate.section === 'knowledge' || candidate.section === 'deadend' ? 'evidence' : 'task';
}

function groupBudgets(candidates: ContextCandidate[], total: number, scenario: ContextScenario) {
  const demand = { task: 0, evidence: 0 };
  for (const candidate of candidates) demand[budgetGroup(candidate)] += candidate.text.length + 1;
  // Reserve progress for resume/handoff, and evidence for other tasks. Unused
  // reservations are lent to the other group instead of wasting the budget.
  const taskShare = scenario === 'resume' || scenario === 'handoff' ? 0.7 : 0.4;
  let task = Math.min(demand.task, Math.floor(total * taskShare));
  const evidence = Math.min(demand.evidence, total - task);
  task = Math.min(demand.task, total - evidence);
  return { task, evidence };
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  if (maxChars <= 0) return { text: '', truncated: true };
  return { text: `${value.slice(0, maxChars - 1)}…`, truncated: true };
}

function textForSummary(label: string, value: string | null): string {
  return value ? `${label}: ${value}` : '';
}

function activityText(record: ContextActivityRecord): string {
  const changes = record.changes.map((change) => `${change.path} (${change.kind})`).join(', ');
  return `activity: ${changes}`;
}

function createCandidates(sources: CompilerSources, intent: ContextIntent, notes: Note[], knowledge: Knowledge[], deadends: Deadend[], activities: ContextActivityRecord[]): ContextCandidate[] {
  const terms = intent.normalizedTerms;
  const candidates: ContextCandidate[] = [];
  if (sources.orientation.status === 'ready') {
    const { context, snapshot, resumeSummary } = sources.orientation;
    const contextSource = sourceDescriptor(sources.anchor.projectRoot, sources.anchor, sources.events, 'current-context', context.id, context.id, snapshot.snapshotId, context.status, null, resumeSummary.relatedFiles);
    const summaryFields: Array<[string, string | null, ContextCandidateSection]> = [
      ['title', context.title, 'summary'],
      ['progressSummary', resumeSummary.progressSummary, 'summary'],
      ['lastError', resumeSummary.lastError, 'risk'],
    ];
    for (const [field, value, section] of summaryFields) {
      const text = textForSummary(`context.${field}`, value);
      if (text) {
        const candidate = makeCandidate(section, contextSource, { field, value }, text, terms, [field], field);
        candidate.priority = field === 'progressSummary' ? 104 : field === 'title' ? 102 : candidate.priority;
        candidates.push(candidate);
      }
    }
    const listFields: Array<[string, string[], ContextCandidateSection]> = [
      ['pendingTasks', resumeSummary.pendingTasks, 'pending'],
      ['completed', resumeSummary.completed, 'summary'],
      ['decisions', resumeSummary.decisions, 'decision'],
      ['risks', resumeSummary.risks, 'risk'],
      ['relatedFiles', resumeSummary.relatedFiles, 'summary'],
    ];
    for (const [field, values, section] of listFields) {
      for (const [index, value] of values.entries()) {
        const candidate = makeCandidate(section, contextSource, { field, value }, `context.${field}: ${value}`, terms, [field], `${field}:${index}`);
        if (field === 'pendingTasks') candidate.priority = 103;
        candidates.push(candidate);
      }
    }
  }
  for (const note of notes) {
    const source = sourceDescriptor(sources.anchor.projectRoot, sources.anchor, sources.events, 'note', note.noteId, note.contextId, note.snapshotId, note.status, null, note.relatedFiles);
    candidates.push(makeCandidate('note', source, note, `${note.kind}: ${note.message}`, terms, ['kind', 'message'], note.noteId));
  }
  for (const item of knowledge) {
    const source = sourceApplicability(item as unknown as Record<string, unknown>, sourceDescriptor(sources.anchor.projectRoot, sources.anchor, sources.events, 'knowledge', item.knowledgeId, item.sourceContextIds[0] ?? null, item.sourceSnapshotIds[0] ?? null, item.status, item.scope, sourcePaths(item as unknown as Record<string, unknown>)));
    candidates.push(makeCandidate('knowledge', source, item, item.statement, terms, ['statement', 'kind', 'scope'], item.knowledgeId));
  }
  for (const item of deadends) {
    const source = sourceApplicability(item as unknown as Record<string, unknown>, sourceDescriptor(sources.anchor.projectRoot, sources.anchor, sources.events, 'deadend', item.deadendId, item.sourceContextId, item.sourceSnapshotId, item.status, item.scope, sourcePaths(item as unknown as Record<string, unknown>)));
    candidates.push(makeCandidate('deadend', source, item, `${item.attempt}: ${item.reason}`, terms, ['attempt', 'reason', 'scope'], item.deadendId));
  }
  for (const item of activities) {
    const source = sourceDescriptor(sources.anchor.projectRoot, sources.anchor, sources.events, 'journal', item.eventId, null, null, null, null, item.paths);
    candidates.push(makeCandidate('activity', source, item, activityText(item), terms, ['paths'], item.eventId));
  }
  return candidates;
}

function emptyTruncation(): ContextTruncation {
  return { truncated: false, summary: false, pending: false, decisions: false, risks: false, notes: false, knowledge: false, deadends: false, activity: false, candidatesOmittedByBudget: 0, candidatesPartiallyTruncated: 0 };
}

function manifestText(selected: ContextCandidate[]): string {
  return selected.map((candidate) => candidate.text).join('\n');
}

function intentFor(sources: CompilerSources, options: ContextCompileOptions, normalizedPaths: string[]): ContextIntent {
  const orientation = sources.orientation;
  const host = latestHostIntent(sources.events, sources.anchor);
  const query = options.query?.trim() || host?.value.trim() || (orientation.status === 'ready' ? orientation.context.title : null);
  const inferred = inferScenario(query, options.scenario);
  const signals = [
    ...(options.query ? [signal('explicit-query', options.query.trim(), 'explicit', 'high')] : []),
    ...(host && !options.query ? [signal('host-prompt', host.value, 'deterministic', 'medium')] : []),
    ...(normalizedPaths.map((value) => signal('path', value, 'explicit', 'high'))),
    ...(inferred.signals),
  ];
  return {
    schemaVersion: 1,
    trigger: options.trigger ?? 'manual',
    query,
    normalizedTerms: query ? queryTerms(query).map(clean).sort(stableCompare) : [],
    scenario: inferred.scenario,
    scope: options.scope ?? null,
    paths: normalizedPaths,
    contextId: options.contextId ?? (orientation.status === 'ready' ? orientation.context.id : null),
    anchor: anchorFromSources(sources),
    signals,
    requestedSections: ['summary', 'pending', 'decision', 'risk', 'note', 'knowledge', 'deadend', 'activity'],
    budget: { unit: 'chars', total: Math.max(0, options.maxChars ?? 4000), reservedForRenderer: 0 },
    adapter: options.adapter ?? 'generic',
    sessionId: options.sessionId ?? null,
    eventId: options.eventId ?? null,
  };
}

export async function compileContext(startPath?: string, options: ContextCompileOptions = {}): Promise<ContextManifest> {
  const sources = await loadCompilerSources(startPath, options);
  const normalizedPaths = options.paths ? await filterPaths(sources.anchor.projectRoot, options.paths) : [];
  const intent = intentFor(sources, options, normalizedPaths);
  const recipe = recipeParticipation(sources);
  if (recipe && !recipeApplicable(recipe, sources, normalizedPaths)) throw new Error(`compiler recipe is not applicable: ${recipe.recipeId}`);
  const orientation = sources.orientation;
  const maxChars = intent.budget.total;
  const notes = orientation.status === 'ready' ? (await listNotes(sources.anchor.projectRoot, { contextId: orientation.context.id, openOnly: true, limit: options.noteLimit ?? 50, maxChars: Number.MAX_SAFE_INTEGER })).filter((note) => orientation.notes.some((selected) => selected.noteId === note.noteId)) : [];
  const knowledge = intent.query ? await listKnowledge(sources.anchor.projectRoot, true) : [];
  const deadends = intent.query ? await listDeadends(sources.anchor.projectRoot, true) : [];
  const activities = await extractActivity(sources.anchor.projectRoot, sources.events, sources.anchor, sources.workspace, options.activityLimit ?? 20);
  const all = createCandidates(sources, intent, notes, knowledge, deadends, activities);
  const contextRelevant = !options.query || Boolean(options.contextId) || ['resume', 'handoff'].includes(intent.scenario)
    || all.some((candidate) => candidate.source.kind === 'current-context' && candidate.matchedTerms.length > 0);
  const excluded: ContextExclusion[] = [];
  const eligible = all.filter((candidate) => {
    if (candidate.source.kind === 'current-context' && !contextRelevant) {
      excluded.push({ candidateId: candidate.candidateId, source: candidate.source, reason: 'query_no_match' });
      return false;
    }
    const check = applicable(candidate, intent);
    if (!check.ok) excluded.push({ candidateId: candidate.candidateId, source: candidate.source, reason: check.reason ?? 'query_no_match' });
    return check.ok;
  }).sort(sortWithRecipe(recipe, intent.scenario));
  const graph = options.graphHops === undefined ? undefined : graphOrdering(sources.evidenceGraph, options.graphHops, sources.anchor, eligible);
  if (graph) {
    eligible.sort((left, right) => {
      if (recipe) {
        const sourceOrder = sourcePreference(left, recipe) - sourcePreference(right, recipe);
        if (sourceOrder) return sourceOrder;
        const sectionOrder = sectionPreference(left, recipe) - sectionPreference(right, recipe);
        if (sectionOrder) return sectionOrder;
      }
      return (graph.distanceFor(left) ?? Number.MAX_SAFE_INTEGER) - (graph.distanceFor(right) ?? Number.MAX_SAFE_INTEGER)
        || sortCandidates(left, right);
    });
  }
  const selected: ContextCandidate[] = [];
  const truncation = emptyTruncation();
  const sectionStats: ContextManifest['budget']['sections'] = {};
  const groups = recipe ? null : groupBudgets(eligible, maxChars, intent.scenario);
  const groupUsed = { task: 0, evidence: 0 };
  const taskDemand = eligible.filter((item) => budgetGroup(item) === 'task').reduce((sum, item) => sum + item.text.length + 1, 0);
  const reservePending = groups && taskDemand > groups.task && eligible.some((item) => item.section === 'pending');
  let usedChars = 0;
  for (const candidate of eligible) {
    const separator = selected.length > 0 ? 1 : 0;
    const sectionBudget = recipe?.sectionBudgets[candidate.section] ?? maxChars;
    const consumedInSection = sectionStats[candidate.section]?.consumed ?? 0;
    const group = budgetGroup(candidate);
    const groupAvailable = groups ? groups[group] - groupUsed[group] - separator : maxChars;
    const itemLimit = reservePending && candidate.matchedFields.includes('progressSummary') ? Math.ceil(groups!.task * 0.6) : maxChars;
    const available = Math.min(maxChars - usedChars - separator, sectionBudget - consumedInSection - separator, groupAvailable, itemLimit);
    if (available <= 0) {
      excluded.push({ candidateId: candidate.candidateId, source: candidate.source, reason: 'budget' });
      truncation.candidatesOmittedByBudget += 1;
      truncation.truncated = true;
      continue;
    }
    const limited = truncateText(candidate.text, available);
    if (!limited.text) {
      excluded.push({ candidateId: candidate.candidateId, source: candidate.source, reason: 'budget' });
      truncation.candidatesOmittedByBudget += 1;
      truncation.truncated = true;
      continue;
    }
    const item = { ...candidate, text: limited.text, selectedChars: limited.text.length, selected: true, truncated: limited.truncated };
    selected.push(item);
    usedChars += separator + item.selectedChars;
    groupUsed[group] += separator + item.selectedChars;
    const prior = sectionStats[item.section] ?? { allocated: recipe?.sectionBudgets[item.section] ?? maxChars, consumed: 0, truncated: false };
    sectionStats[item.section] = { ...prior, consumed: prior.consumed + item.selectedChars + separator, truncated: prior.truncated || limited.truncated };
    if (limited.truncated) {
      truncation.candidatesPartiallyTruncated += 1;
      truncation.truncated = true;
      if (item.section === 'summary') truncation.summary = true;
      if (item.section === 'pending') truncation.pending = true;
      if (item.section === 'decision') truncation.decisions = true;
      if (item.section === 'risk') truncation.risks = true;
      if (item.section === 'note') truncation.notes = true;
      if (item.section === 'knowledge') truncation.knowledge = true;
      if (item.section === 'deadend') truncation.deadends = true;
      if (item.section === 'activity') truncation.activity = true;
    }
  }
  const sections = {
    summary: selected.filter((item) => item.section === 'summary'),
    pending: selected.filter((item) => item.section === 'pending'),
    decision: selected.filter((item) => item.section === 'decision'),
    risk: selected.filter((item) => item.section === 'risk'),
    notes: selected.filter((item) => item.section === 'note'),
    knowledge: selected.filter((item) => item.section === 'knowledge'),
    deadends: selected.filter((item) => item.section === 'deadend'),
    activity: selected.filter((item) => item.section === 'activity') as ContextCandidate<ContextActivityRecord>[],
  };
  const tokenEstimate = estimateTokens(manifestText(selected));
  const selectedItemHashes = selected.map((item) => item.itemHash);
  const status = orientation.status === 'ready' || selected.length > 0 ? 'ready' : 'no_context';
  const budget = {
    requested: intent.budget, usedChars, remainingChars: Math.max(0, maxChars - usedChars), sections: sectionStats,
    ...(groups ? { groups: {
      task: { allocated: groups.task, consumed: groupUsed.task },
      evidence: { allocated: groups.evidence, consumed: groupUsed.evidence },
    } } : {}),
  };
  const manifestHash = rebuildManifestHash({
    status,
    projectRoot: sources.anchor.projectRoot,
    mode: orientation.explanation.mode,
    anchor: sources.anchor,
    intent,
    selected,
    budget,
    truncation,
    diagnostics: {
      knowledge: {
        duplicateIds: orientation.knowledge.duplicateIds,
        possibleConflicts: orientation.knowledge.possibleConflicts,
        freshness: orientation.knowledge.hits.map((hit) => ({ knowledgeId: hit.knowledge.knowledgeId, score: hit.freshnessScore })),
      },
    },
    ...(recipe ? { recipe } : {}),
    ...(graph ? { graph: graph.participation } : {}),
  });
  return {
    schemaVersion: 1,
    compilerVersion: '0.7.7',
    rankingVersion: 'compiler-ranking-v3',
    status,
    projectRoot: sources.anchor.projectRoot,
    mode: orientation.explanation.mode,
    anchor: sources.anchor,
    intent,
    context: orientation.context,
    snapshot: orientation.snapshot,
    resumeSummary: orientation.resumeSummary,
    sections,
    selected,
    excluded,
    identity: {
      manifestHash,
      selectedItemHashes,
      tokenEstimate: { input: tokenEstimate, output: tokenEstimate, unit: 'estimated-tokens', method: 'chars-div-four' },
    },
    budget,
    truncation,
    diagnostics: {
      knowledge: {
        duplicateIds: orientation.knowledge.duplicateIds,
        possibleConflicts: orientation.knowledge.possibleConflicts,
        freshness: orientation.knowledge.hits.map((hit) => ({ knowledgeId: hit.knowledge.knowledgeId, score: hit.freshnessScore })),
      },
    },
    provenance: {
      journalRead: sources.events.length > 0,
      journalEventCount: sources.events.length,
      selectedSourceIds: [...new Set(selected.map((item) => item.source.sourceId))].sort(stableCompare),
      selectedEventIds: [...new Set(selected.flatMap((item) => item.source.provenance.eventId ? [item.source.provenance.eventId] : []))].sort(stableCompare),
      fallbackReason: sources.fallbackReason,
    },
    ...(recipe ? { recipe } : {}),
    ...(graph ? { graph: graph.participation } : {}),
    text: manifestText(selected),
  };
}
