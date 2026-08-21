import crypto from 'node:crypto';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { isRecord, readJson } from '../storage/json-store.js';
import { withLock } from '../storage/lock.js';
import { contextMetadataPath, deadendsPath, knowledgePath, locksDirectory, snapshotPath } from '../storage/layout.js';
import { rebuildSnapshot } from './runtime.js';
import type { Deadend, DeadendDiscoverOptions, DeadendDiscoveryResult, DeadendFile, DeadendInput, Knowledge, KnowledgeDiscoverOptions, KnowledgeDiscoveryResult, KnowledgeFile, KnowledgeInput, KnowledgeStatus } from './types.js';

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isKnowledge(value: unknown): value is Knowledge {
  return isRecord(value)
    && typeof value.knowledgeId === 'string'
    && typeof value.kind === 'string' && value.kind.trim().length > 0
    && typeof value.statement === 'string' && value.statement.trim().length > 0
    && typeof value.scope === 'string' && value.scope.trim().length > 0
    && typeof value.confidence === 'number' && value.confidence >= 0 && value.confidence <= 1
    && ['candidate', 'verified', 'deprecated', 'rejected'].includes(value.status as string)
    && Array.isArray(value.sourceContextIds) && value.sourceContextIds.every((item) => typeof item === 'string')
    && Array.isArray(value.sourceSnapshotIds) && value.sourceSnapshotIds.every((item) => typeof item === 'string')
    && Array.isArray(value.supportingEvidence) && value.supportingEvidence.every((item) => typeof item === 'string')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isKnowledgeFile(value: unknown): value is KnowledgeFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.items) || !value.items.every(isKnowledge)) return false;
  const ids = value.items.map((item) => item.knowledgeId);
  return new Set(ids).size === ids.length;
}

function cleanList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isDeadend(value: unknown): value is Deadend {
  return isRecord(value)
    && typeof value.deadendId === 'string'
    && typeof value.attempt === 'string'
    && typeof value.reason === 'string'
    && Array.isArray(value.observedEvidence) && value.observedEvidence.every((item) => typeof item === 'string')
    && typeof value.scope === 'string'
    && ['candidate', 'verified', 'obsolete', 'rejected'].includes(value.status as string)
    && (typeof value.sourceContextId === 'string' || value.sourceContextId === null)
    && (typeof value.sourceSnapshotId === 'string' || value.sourceSnapshotId === null)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isDeadendFile(value: unknown): value is DeadendFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.items) || !value.items.every(isDeadend)) return false;
  const ids = value.items.map((item) => item.deadendId);
  return new Set(ids).size === ids.length;
}

async function validateSource(projectRoot: string, contextId?: string, snapshotId?: string): Promise<void> {
  if (!contextId && snapshotId) throw new Error('source snapshot requires source context');
  if (!contextId) return;
  const context = await readJson<Record<string, unknown>>(contextMetadataPath(projectRoot, contextId), (value): value is Record<string, unknown> => isRecord(value) && value.id === contextId && value.schemaVersion === 1);
  if (snapshotId) {
    const snapshot = await readJson<Record<string, unknown>>(snapshotPath(projectRoot, contextId, snapshotId), (value): value is Record<string, unknown> => isRecord(value) && value.snapshotId === snapshotId && value.contextId === contextId && value.schemaVersion === 1);
    await rebuildSnapshot(projectRoot, contextId, snapshot.snapshotId as string);
  }
  if (context.projectRoot !== projectRoot) throw new Error(`source context belongs to another project: ${contextId}`);
}

async function loadKnowledge(projectRoot: string): Promise<KnowledgeFile> {
  try { return await readJson<KnowledgeFile>(knowledgePath(projectRoot), isKnowledgeFile); }
  catch (error) { if (isNotFound(error)) return { schemaVersion: 1, items: [] }; throw error; }
}

async function loadDeadends(projectRoot: string): Promise<DeadendFile> {
  try { return await readJson<DeadendFile>(deadendsPath(projectRoot), isDeadendFile); }
  catch (error) { if (isNotFound(error)) return { schemaVersion: 1, items: [] }; throw error; }
}

export async function learnKnowledge(startPath: string | undefined, statement: string, scopeOrInput: string | KnowledgeInput = 'project'): Promise<Knowledge> {
  const projectRoot = await resolveProjectRoot(startPath);
  const input: KnowledgeInput = typeof scopeOrInput === 'string' ? { scope: scopeOrInput } : scopeOrInput;
  const cleanStatement = statement.trim();
  const cleanScope = (input.scope ?? 'project').trim();
  const cleanKind = (input.kind ?? 'fact').trim();
  if (!cleanStatement) throw new Error('knowledge statement must not be empty');
  if (!cleanScope) throw new Error('knowledge scope must not be empty');
  if (!cleanKind) throw new Error('knowledge kind must not be empty');
  await validateSource(projectRoot, input.sourceContextId, input.sourceSnapshotId);
  return withLock(`${locksDirectory(projectRoot)}/knowledge.lock`, async () => {
    const file = await loadKnowledge(projectRoot);
    const now = new Date().toISOString();
    const item: Knowledge = {
      knowledgeId: id('know'),
      kind: cleanKind,
      statement: cleanStatement,
      scope: cleanScope,
      confidence: 0.5,
      status: 'candidate',
      sourceContextIds: cleanList(input.sourceContextId ? [input.sourceContextId] : []),
      sourceSnapshotIds: cleanList(input.sourceSnapshotId ? [input.sourceSnapshotId] : []),
      supportingEvidence: cleanList(input.evidence),
      createdAt: now,
      updatedAt: now,
    };
    await atomicWriteJson(knowledgePath(projectRoot), { schemaVersion: 1, items: [...file.items, item] });
    return item;
  });
}

export async function listKnowledge(startPath?: string, includeUnverified = false): Promise<Knowledge[]> {
  const projectRoot = await resolveProjectRoot(startPath);
  const file = await loadKnowledge(projectRoot);
  return includeUnverified ? file.items : file.items.filter((item) => item.status === 'verified');
}

const aliasGroups = [
  ['投保人认证', '投保人身份认证', '身份核验', '实名认证', 'applicant authentication', 'identity verification'],
  ['短信验证码', '验证码', 'sms verification', 'otp'],
  ['证件ocr', '证件识别', 'identity ocr', 'document ocr'],
  ['人脸识别', '人脸认证', 'face recognition', 'facial verification'],
];

function queryTerms(query: string): string[] {
  const normalizedQuery = normalized(query);
  const terms = new Set(normalizedQuery.split(/\s+/).filter(Boolean));
  for (const group of aliasGroups) {
    if (group.some((alias) => normalizedQuery.includes(normalized(alias)))) {
      for (const alias of group) terms.add(normalized(alias));
    }
  }
  return [...terms];
}

function matchedFields(knowledge: Knowledge, terms: string[]): { fields: string[]; matchedTerms: string[]; score: number } {
  const values = { statement: normalized(knowledge.statement), kind: normalized(knowledge.kind), scope: normalized(knowledge.scope) };
  const fields = new Set<string>();
  const matched = new Set<string>();
  let score = 0;
  const normalizedQuery = terms.join(' ');
  if (values.statement.includes(normalizedQuery)) score += 20;
  for (const term of terms) {
    let matchedTerm = false;
    for (const [field, value] of Object.entries(values)) {
      if (value.includes(term)) {
        fields.add(field);
        matchedTerm = true;
        score += field === 'statement' ? 5 : field === 'scope' ? 4 : 3;
      }
    }
    if (matchedTerm) matched.add(term);
  }
  if (values.scope === normalizedQuery) score += 10;
  return { fields: [...fields], matchedTerms: [...matched], score };
}

function limitedKnowledge(knowledge: Knowledge, maxChars: number): Knowledge {
  const statement = knowledge.statement.length <= maxChars ? knowledge.statement : `${knowledge.statement.slice(0, Math.max(0, maxChars - 1))}…`;
  return { ...knowledge, statement, supportingEvidence: knowledge.supportingEvidence.map((item) => item.length <= maxChars ? item : `${item.slice(0, Math.max(0, maxChars - 1))}…`) };
}

export async function discoverKnowledge(startPath: string | undefined, query: string, options: KnowledgeDiscoverOptions = {}): Promise<KnowledgeDiscoveryResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  const cleanQuery = query.trim();
  if (!cleanQuery) throw new Error('knowledge discovery query must not be empty');
  const file = await loadKnowledge(projectRoot);
  const statuses = options.statuses ?? ['verified'];
  const terms = queryTerms(cleanQuery);
  const matches = file.items
    .filter((item) => statuses.includes(item.status))
    .filter((item) => !options.scope || normalized(item.scope) === normalized(options.scope))
    .map((knowledge) => ({ knowledge, ...matchedFields(knowledge, terms) }))
    .filter((item) => item.matchedTerms.length > 0)
    .sort((left, right) => right.score - left.score || Number(right.knowledge.status === 'verified') - Number(left.knowledge.status === 'verified') || right.knowledge.confidence - left.knowledge.confidence || right.knowledge.updatedAt.localeCompare(left.knowledge.updatedAt) || left.knowledge.knowledgeId.localeCompare(right.knowledge.knowledgeId));
  const duplicateMap = new Map<string, string[]>();
  for (const item of file.items) {
    const key = `${normalized(item.kind)}|${normalized(item.scope)}|${normalized(item.statement)}`;
    duplicateMap.set(key, [...(duplicateMap.get(key) ?? []), item.knowledgeId]);
  }
  const duplicateIds = [...duplicateMap.values()].filter((ids) => ids.length > 1);
  const possibleConflicts = file.items.flatMap((left, index) => file.items.slice(index + 1).filter((right) => normalized(left.scope) === normalized(right.scope) && normalized(left.statement) !== normalized(right.statement) && queryTerms(left.statement).some((term) => normalized(right.statement).includes(term))).map((right) => ({ scope: left.scope, knowledgeIds: [left.knowledgeId, right.knowledgeId], statements: [left.statement, right.statement] })));
  const limit = options.limit ?? 10;
  const selected = matches.slice(0, limit);
  const maxChars = options.maxChars ?? 4000;
  const hits = selected.map((item) => ({ knowledge: limitedKnowledge(item.knowledge, maxChars), score: item.score, matchedTerms: item.matchedTerms, matchedFields: item.fields, why: item.fields.map((field) => `matched ${field}`) }));
  return { query: cleanQuery, total: matches.length, truncated: matches.length > selected.length, hits, duplicateIds, possibleConflicts };
}

export async function verifyKnowledge(startPath: string | undefined, knowledgeId: string): Promise<Knowledge> {
  const projectRoot = await resolveProjectRoot(startPath);
  return withLock(`${locksDirectory(projectRoot)}/knowledge.lock`, async () => {
    const file = await loadKnowledge(projectRoot);
    const item = file.items.find((candidate) => candidate.knowledgeId === knowledgeId);
    if (!item) throw new Error(`knowledge not found: ${knowledgeId}`);
    item.status = 'verified';
    item.confidence = Math.max(item.confidence, 0.8);
    item.updatedAt = new Date().toISOString();
    await atomicWriteJson(knowledgePath(projectRoot), file);
    return item;
  });
}

export async function recordDeadend(startPath: string | undefined, attempt: string, reason: string, scopeOrInput: string | DeadendInput = 'project'): Promise<Deadend> {
  const projectRoot = await resolveProjectRoot(startPath);
  const input: DeadendInput = typeof scopeOrInput === 'string' ? { scope: scopeOrInput } : scopeOrInput;
  await validateSource(projectRoot, input.sourceContextId, input.sourceSnapshotId);
  return withLock(`${locksDirectory(projectRoot)}/deadends.lock`, async () => {
    const file = await loadDeadends(projectRoot);
    const now = new Date().toISOString();
    const item: Deadend = {
      deadendId: id('dead'),
      attempt,
      reason,
      observedEvidence: input.evidence ?? [],
      scope: input.scope ?? 'project',
      status: 'candidate',
      sourceContextId: input.sourceContextId ?? null,
      sourceSnapshotId: input.sourceSnapshotId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await atomicWriteJson(deadendsPath(projectRoot), { schemaVersion: 1, items: [...file.items, item] });
    return item;
  });
}

export async function listDeadends(startPath?: string, includeUnverified = false): Promise<Deadend[]> {
  const projectRoot = await resolveProjectRoot(startPath);
  const file = await loadDeadends(projectRoot);
  return includeUnverified ? file.items : file.items.filter((item) => item.status === 'verified');
}

function limitedDeadend(deadend: Deadend, maxChars: number): Deadend {
  const limit = (value: string): string => value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
  return { ...deadend, attempt: limit(deadend.attempt), reason: limit(deadend.reason), observedEvidence: deadend.observedEvidence.map(limit) };
}

export async function discoverDeadends(startPath: string | undefined, query: string, options: DeadendDiscoverOptions = {}): Promise<DeadendDiscoveryResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  const cleanQuery = query.trim();
  if (!cleanQuery) throw new Error('deadend discovery query must not be empty');
  const terms = normalized(cleanQuery).split(/\s+/).filter(Boolean);
  const statuses = options.statuses ?? ['verified'];
  const file = await loadDeadends(projectRoot);
  const matches = file.items
    .filter((item) => statuses.includes(item.status))
    .filter((item) => !options.scope || normalized(item.scope) === normalized(options.scope))
    .map((deadend) => {
      const values = { attempt: normalized(deadend.attempt), reason: normalized(deadend.reason), scope: normalized(deadend.scope) };
      const fields = new Set<string>();
      const matchedTerms = new Set<string>();
      let score = 0;
      for (const term of terms) {
        for (const [field, value] of Object.entries(values)) {
          if (value.includes(term)) {
            fields.add(field);
            matchedTerms.add(term);
            score += field === 'attempt' ? 5 : field === 'reason' ? 4 : 3;
          }
        }
      }
      return { deadend, score, matchedTerms: [...matchedTerms], matchedFields: [...fields] };
    })
    .filter((item) => item.matchedTerms.length > 0)
    .sort((left, right) => right.score - left.score || right.deadend.updatedAt.localeCompare(left.deadend.updatedAt) || left.deadend.deadendId.localeCompare(right.deadend.deadendId));
  const limit = options.limit ?? 10;
  const selected = matches.slice(0, limit);
  const maxChars = options.maxChars ?? 4000;
  return {
    query: cleanQuery,
    total: matches.length,
    truncated: matches.length > selected.length,
    hits: selected.map((item) => ({ ...item, deadend: limitedDeadend(item.deadend, maxChars) })),
  };
}

export async function verifyDeadend(startPath: string | undefined, deadendId: string): Promise<Deadend> {
  const projectRoot = await resolveProjectRoot(startPath);
  return withLock(`${locksDirectory(projectRoot)}/deadends.lock`, async () => {
    const file = await loadDeadends(projectRoot);
    const item = file.items.find((candidate) => candidate.deadendId === deadendId);
    if (!item) throw new Error(`deadend not found: ${deadendId}`);
    item.status = 'verified';
    item.updatedAt = new Date().toISOString();
    await atomicWriteJson(deadendsPath(projectRoot), file);
    return item;
  });
}
