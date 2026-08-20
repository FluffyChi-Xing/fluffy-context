import crypto from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { isRecord, readJson } from '../storage/json-store.js';
import { withLock } from '../storage/lock.js';
import { contextMetadataPath, deadendsPath, knowledgePath, locksDirectory, snapshotPath } from '../storage/layout.js';
import type { Deadend, DeadendFile, DeadendInput, Knowledge, KnowledgeFile, KnowledgeInput } from './types.js';

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isKnowledgeFile(value: unknown): value is KnowledgeFile {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.items);
}

function isDeadendFile(value: unknown): value is DeadendFile {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.items);
}

async function validateSource(projectRoot: string, contextId?: string, snapshotId?: string): Promise<void> {
  if (!contextId && snapshotId) throw new Error('source snapshot requires source context');
  if (!contextId) return;
  await access(contextMetadataPath(projectRoot, contextId));
  if (snapshotId) await access(snapshotPath(projectRoot, contextId, snapshotId));
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
  await validateSource(projectRoot, input.sourceContextId, input.sourceSnapshotId);
  return withLock(`${locksDirectory(projectRoot)}/knowledge.lock`, async () => {
    const file = await loadKnowledge(projectRoot);
    const now = new Date().toISOString();
    const item: Knowledge = {
      knowledgeId: id('know'),
      kind: 'fact',
      statement,
      scope: input.scope ?? 'project',
      confidence: 0.5,
      status: 'candidate',
      sourceContextIds: input.sourceContextId ? [input.sourceContextId] : [],
      sourceSnapshotIds: input.sourceSnapshotId ? [input.sourceSnapshotId] : [],
      supportingEvidence: input.evidence ?? [],
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
