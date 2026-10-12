import type { Deadend, DeadendDiscoveryResult, Knowledge, KnowledgeDiscoveryResult } from '../runtime/types.js';
import type { CognitionEvent, CognitionRetrievalEntry, CognitionRetrievalProjection, Applicability } from './types.js';

const aliasGroups = [
  ['投保人认证', '投保人身份认证', '身份核验', '实名认证', 'applicant authentication', 'identity verification'],
  ['短信验证码', '验证码', 'sms verification', 'otp'],
  ['证件ocr', '证件识别', 'identity ocr', 'document ocr'],
  ['人脸识别', '人脸认证', 'face recognition', 'facial verification'],
];

export function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function queryTerms(query: string): string[] {
  const clean = normalized(query);
  const terms = new Set(clean.split(/\s+/).filter(Boolean));
  for (const group of aliasGroups) {
    if (group.some((alias) => clean.includes(normalized(alias)))) {
      for (const alias of group) terms.add(normalized(alias));
    }
  }
  return [...terms].sort();
}

function strings(record: Record<string, unknown>, entity: 'knowledge' | 'deadend'): Record<string, string> {
  return entity === 'knowledge'
    ? {
      statement: typeof record.statement === 'string' ? record.statement : '',
      kind: typeof record.kind === 'string' ? record.kind : '',
      scope: typeof record.scope === 'string' ? record.scope : '',
    }
    : {
      attempt: typeof record.attempt === 'string' ? record.attempt : '',
      reason: typeof record.reason === 'string' ? record.reason : '',
      scope: typeof record.scope === 'string' ? record.scope : '',
    };
}

function defaultApplicability(event: CognitionEvent): Applicability {
  if (event.git.ref === null && event.git.branch === null) return { project: true, branchMode: 'global' };
  return {
    project: true,
    branchMode: 'exact',
    branches: [event.git.ref ?? event.git.branch ?? 'detached'],
    sourceCommit: event.git.head,
  };
}

function applicability(record: Record<string, unknown>, event: CognitionEvent): Applicability {
  const value = record.applicability;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (candidate.project === true && (candidate.branchMode === 'global' || candidate.branchMode === 'exact')) {
      return {
        project: true,
        branchMode: candidate.branchMode,
        ...(Array.isArray(candidate.branches) ? { branches: candidate.branches.filter((item): item is string => typeof item === 'string').sort() } : {}),
        ...(Array.isArray(candidate.paths) ? { paths: candidate.paths.filter((item): item is string => typeof item === 'string').sort() } : {}),
        ...(typeof candidate.sourceCommit === 'string' || candidate.sourceCommit === null ? { sourceCommit: candidate.sourceCommit } : {}),
      };
    }
  }
  return defaultApplicability(event);
}

function recordPayload(event: CognitionEvent): Record<string, unknown> | null {
  const payload = event.payload as Record<string, unknown>;
  return payload.record && typeof payload.record === 'object' && !Array.isArray(payload.record)
    ? payload.record as Record<string, unknown>
    : null;
}

function lifecycleEntity(event: CognitionEvent, record: Record<string, unknown>): { entity: 'knowledge' | 'deadend'; entityId: string } | null {
  if (event.type.startsWith('knowledge.') && typeof record.knowledgeId === 'string') return { entity: 'knowledge', entityId: record.knowledgeId };
  if (event.type.startsWith('deadend.') && typeof record.deadendId === 'string') return { entity: 'deadend', entityId: record.deadendId };
  return null;
}

function lifecycleEvent(event: CognitionEvent): boolean {
  return [
    'knowledge.proposed', 'knowledge.verified', 'knowledge.deprecated', 'knowledge.rejected',
    'deadend.proposed', 'deadend.verified', 'deadend.obsoleted', 'deadend.rejected',
  ].includes(event.type);
}

export function buildRetrievalProjection(events: CognitionEvent[]): CognitionRetrievalProjection {
  const entries = new Map<string, CognitionRetrievalEntry>();
  const feedback = new Map<string, { usedCount: number; latestUsedAt: string }>();
  for (const event of events) {
    if (event.type === 'record.used') {
      const payload = event.payload as Record<string, unknown>;
      const entity = payload.entity === 'knowledge' || payload.entity === 'deadend' ? payload.entity : null;
      const entityId = typeof payload.entityId === 'string' ? payload.entityId : null;
      if (!entity || !entityId) continue;
      const key = `${entity}:${entityId}`;
      const prior = feedback.get(key) ?? { usedCount: 0, latestUsedAt: event.occurredAt };
      feedback.set(key, { usedCount: prior.usedCount + 1, latestUsedAt: event.occurredAt });
      continue;
    }
    if (!lifecycleEvent(event)) continue;
    const record = recordPayload(event);
    if (!record) continue;
    const identity = lifecycleEntity(event, record);
    if (!identity) continue;
    const fields = strings(record, identity.entity);
    const normalizedTerms = [...new Set(Object.values(fields).flatMap((value) => {
      const normalizedValue = normalized(value);
      return normalizedValue ? [normalizedValue, ...normalizedValue.split(/\s+/).filter(Boolean)] : [];
    }))].sort();
    const key = `${identity.entity}:${identity.entityId}`;
    entries.set(key, {
      entity: identity.entity,
      entityId: identity.entityId,
      status: typeof record.status === 'string' ? record.status : 'candidate',
      record,
      applicability: applicability(record, event),
      searchable: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, normalized(value)])),
      normalizedTerms,
      provenance: {
        eventId: event.eventId,
        eventType: event.type,
        occurredAt: event.occurredAt,
        git: event.git,
        ...(typeof (event.payload as Record<string, unknown>).anchorProvenance === 'string' ? { anchorProvenance: (event.payload as Record<string, unknown>).anchorProvenance as CognitionRetrievalEntry['provenance']['anchorProvenance'] } : {}),
      },
      feedback: { usedCount: 0, latestUsedAt: null },
    });
  }
  for (const [key, entry] of entries) {
    const value = feedback.get(key);
    if (value) entry.feedback = value;
  }
  const ordered = Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const terms = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(ordered)) {
    for (const term of entry.normalizedTerms) terms.set(term, [...(terms.get(term) ?? []), key]);
  }
  return {
    schemaVersion: 2,
    entries: ordered,
    terms: Object.fromEntries([...terms.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([term, ids]) => [term, ids.sort()])),
  };
}

export interface RetrievalExclusions {
  status_not_verified: number;
  applicability_mismatch: number;
  scope_mismatch: number;
  query_no_match: number;
  result_limit: number;
}

export interface V2Discovery<T> {
  result: T;
  exclusions: RetrievalExclusions;
}

function emptyExclusions(): RetrievalExclusions {
  return { status_not_verified: 0, applicability_mismatch: 0, scope_mismatch: 0, query_no_match: 0, result_limit: 0 };
}

function applicable(entry: CognitionRetrievalEntry, current: CognitionEvent['git']): boolean {
  if (entry.applicability.branchMode === 'global') return true;
  const anchor = entry.provenance.git;
  return anchor.ref === current.ref
    && anchor.branch === current.branch
    && (anchor.worktreeId === null || anchor.worktreeId === current.worktreeId);
}

function match(entry: CognitionRetrievalEntry, terms: string[], entity: 'knowledge' | 'deadend'): { score: number; matchedTerms: string[]; matchedFields: string[] } {
  const fields = new Set<string>();
  const matched = new Set<string>();
  let score = 0;
  const phrase = terms.join(' ');
  const statementField = entity === 'knowledge' ? 'statement' : 'attempt';
  if (entry.searchable[statementField]?.includes(phrase)) score += entity === 'knowledge' ? 20 : 0;
  for (const term of terms) {
    for (const [field, value] of Object.entries(entry.searchable)) {
      if (!value.includes(term)) continue;
      fields.add(field);
      matched.add(term);
      score += field === statementField ? 5 : field === 'scope' ? 4 : 3;
    }
  }
  if (entry.searchable.scope === phrase) score += 10;
  return { score, matchedTerms: [...matched].sort(), matchedFields: [...fields].sort() };
}

function limitText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function contradiction(left: string, right: string): boolean {
  const a = normalized(left).replace(/[.!。！]+$/, '');
  const b = normalized(right).replace(/[.!。！]+$/, '');
  const negative = (text: string) => /\b(?:not|never|no)\b|不能|不应|禁止|不要|无需/.test(text);
  const proposition = (text: string) => text
    .replace(/\b(?:must|should|does|do|is|are|be|not|never|no|always|the|a|an)\b/g, '')
    .replace(/不能|不应|禁止|不要|无需|必须|应该|应当/g, '').replace(/\s+/g, ' ').trim();
  if (negative(a) !== negative(b) && proposition(a).length > 3 && proposition(a) === proposition(b)) return true;
  const existing = /^(?:use|reuse) (?:the )?existing (.+)$/;
  const replacement = /^(?:build|create) (?:a )?new (.+)$/;
  return Boolean(existing.exec(a)?.[1] && existing.exec(a)?.[1] === replacement.exec(b)?.[1])
    || Boolean(existing.exec(b)?.[1] && existing.exec(b)?.[1] === replacement.exec(a)?.[1]);
}

function knowledgeDiagnostics(hits: Array<{ knowledge: Knowledge }>, maxChars: number, limit: number): Pick<KnowledgeDiscoveryResult, 'duplicateIds' | 'possibleConflicts'> {
  const duplicateMap = new Map<string, string[]>();
  for (const { knowledge } of hits.slice(0, 100)) {
    const key = `${normalized(knowledge.kind)}|${normalized(knowledge.scope)}|${normalized(knowledge.statement)}`;
    duplicateMap.set(key, [...(duplicateMap.get(key) ?? []), knowledge.knowledgeId]);
  }
  const duplicateIds = [...duplicateMap.values()].filter((ids) => ids.length > 1).slice(0, Math.min(limit, 10)).map((ids) => ids.slice(0, 10));
  const possibleConflicts: KnowledgeDiscoveryResult['possibleConflicts'] = [];
  const budget = { remaining: maxChars };
  outer: for (let index = 0; index < hits.length && index < 100; index += 1) {
    const left = hits[index].knowledge;
    for (const { knowledge: right } of hits.slice(index + 1, 100)) {
      if (normalized(left.scope) !== normalized(right.scope) || normalized(left.kind) !== normalized(right.kind) || !contradiction(left.statement, right.statement)) continue;
      if (possibleConflicts.length >= Math.min(limit, 10)) break outer;
      const statements = [left.statement, right.statement].map((value) => limitText(value, Math.max(0, budget.remaining)));
      budget.remaining -= statements.reduce((sum, value) => sum + value.length, 0);
      possibleConflicts.push({ scope: left.scope, knowledgeIds: [left.knowledgeId, right.knowledgeId], statements });
    }
  }
  return { duplicateIds, possibleConflicts };
}

/**
 * Deterministic source freshness relative to the newest event in this
 * projection.  The reference is deliberately projection-local so replaying
 * the same journal produces the same ranking regardless of wall-clock time.
 */
function freshnessScore(occurredAt: string, referenceAt: string): number {
  const source = Date.parse(occurredAt);
  const reference = Date.parse(referenceAt);
  if (!Number.isFinite(source) || !Number.isFinite(reference)) return 0;
  const ageDays = Math.max(0, reference - source) / 86_400_000;
  return Math.max(0, Math.round(100 * (1 - Math.min(ageDays, 180) / 180)));
}

export function discoverV2Knowledge(index: CognitionRetrievalProjection, query: string, current: CognitionEvent['git'], options: { scope?: string; limit: number; maxChars: number }): V2Discovery<KnowledgeDiscoveryResult> {
  const exclusions = emptyExclusions();
  const terms = queryTerms(query);
  const referenceAt = Object.values(index.entries).reduce((latest, entry) => entry.provenance.occurredAt > latest ? entry.provenance.occurredAt : latest, '');
  const hits = Object.values(index.entries).flatMap((entry) => {
    if (entry.entity !== 'knowledge') return [];
    if (entry.status !== 'verified') { exclusions.status_not_verified += 1; return []; }
    if (!applicable(entry, current)) { exclusions.applicability_mismatch += 1; return []; }
    const knowledge = entry.record as unknown as Knowledge;
    if (options.scope && normalized(knowledge.scope) !== normalized(options.scope)) { exclusions.scope_mismatch += 1; return []; }
    const matched = match(entry, terms, 'knowledge');
    if (matched.matchedTerms.length === 0) { exclusions.query_no_match += 1; return []; }
    return [{ entry, knowledge, freshnessScore: freshnessScore(entry.provenance.occurredAt, referenceAt), ...matched }];
  }).sort((left, right) => right.score - left.score
    || Math.min(right.entry.feedback.usedCount, 5) - Math.min(left.entry.feedback.usedCount, 5)
    || right.knowledge.confidence - left.knowledge.confidence
    || right.freshnessScore - left.freshnessScore
    || right.entry.provenance.occurredAt.localeCompare(left.entry.provenance.occurredAt)
    || left.knowledge.knowledgeId.localeCompare(right.knowledge.knowledgeId));
  const diagnostics = knowledgeDiagnostics(hits, options.maxChars, options.limit);
  const selected = hits.slice(0, options.limit);
  exclusions.result_limit = hits.length - selected.length;
  return {
    result: {
      query,
      total: hits.length,
      truncated: hits.length > selected.length,
      hits: selected.map(({ knowledge, score, freshnessScore: sourceFreshness, matchedTerms, matchedFields, entry }) => ({
        knowledge: { ...knowledge, statement: limitText(knowledge.statement, options.maxChars), supportingEvidence: knowledge.supportingEvidence.map((value) => limitText(value, options.maxChars)) },
        score,
        freshnessScore: sourceFreshness,
        matchedTerms,
        matchedFields,
        why: [...matchedFields.map((field) => `matched ${field}`), `source freshness ${sourceFreshness}/100`, ...(entry.feedback.usedCount > 0 ? ['prior recorded use'] : [])],
      })),
      ...diagnostics,
    },
    exclusions,
  };
}

export function discoverV2Deadends(index: CognitionRetrievalProjection, query: string, current: CognitionEvent['git'], options: { scope?: string; limit: number; maxChars: number }): V2Discovery<DeadendDiscoveryResult> {
  const exclusions = emptyExclusions();
  const terms = queryTerms(query);
  const hits = Object.values(index.entries).flatMap((entry) => {
    if (entry.entity !== 'deadend') return [];
    if (entry.status !== 'verified') { exclusions.status_not_verified += 1; return []; }
    if (!applicable(entry, current)) { exclusions.applicability_mismatch += 1; return []; }
    const deadend = entry.record as unknown as Deadend;
    if (options.scope && normalized(deadend.scope) !== normalized(options.scope)) { exclusions.scope_mismatch += 1; return []; }
    const matched = match(entry, terms, 'deadend');
    if (matched.matchedTerms.length === 0) { exclusions.query_no_match += 1; return []; }
    return [{ entry, deadend, ...matched }];
  }).sort((left, right) => right.score - left.score
    || Math.min(right.entry.feedback.usedCount, 5) - Math.min(left.entry.feedback.usedCount, 5)
    || right.entry.provenance.occurredAt.localeCompare(left.entry.provenance.occurredAt)
    || left.deadend.deadendId.localeCompare(right.deadend.deadendId));
  const selected = hits.slice(0, options.limit);
  exclusions.result_limit = hits.length - selected.length;
  return {
    result: {
      query,
      total: hits.length,
      truncated: hits.length > selected.length,
      hits: selected.map(({ deadend, score, matchedTerms, matchedFields }) => ({
        deadend: { ...deadend, attempt: limitText(deadend.attempt, options.maxChars), reason: limitText(deadend.reason, options.maxChars), observedEvidence: deadend.observedEvidence.map((value) => limitText(value, options.maxChars)) },
        score,
        matchedTerms,
        matchedFields,
      })),
    },
    exclusions,
  };
}
