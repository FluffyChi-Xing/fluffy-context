import crypto from 'node:crypto';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { readJson } from '../storage/json-store.js';
import { withLock } from '../storage/lock.js';
import { deadendsPath, knowledgePath, locksDirectory } from '../storage/layout.js';
import type { Deadend, DeadendFile, Knowledge, KnowledgeFile } from './types.js';

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

async function loadKnowledge(projectRoot: string): Promise<KnowledgeFile> {
  try { return await readJson<KnowledgeFile>(knowledgePath(projectRoot)); } catch { return { schemaVersion: 1, items: [] }; }
}

async function loadDeadends(projectRoot: string): Promise<DeadendFile> {
  try { return await readJson<DeadendFile>(deadendsPath(projectRoot)); } catch { return { schemaVersion: 1, items: [] }; }
}

export async function learnKnowledge(startPath: string | undefined, statement: string, scope = 'project'): Promise<Knowledge> {
  const projectRoot = await resolveProjectRoot(startPath);
  return withLock(`${locksDirectory(projectRoot)}/knowledge.lock`, async () => {
    const file = await loadKnowledge(projectRoot);
    const now = new Date().toISOString();
    const item: Knowledge = {
      knowledgeId: id('know'),
      kind: 'fact',
      statement,
      scope,
      confidence: 0.5,
      status: 'candidate',
      sourceContextIds: [],
      sourceSnapshotIds: [],
      supportingEvidence: [],
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

export async function recordDeadend(startPath: string | undefined, attempt: string, reason: string, scope = 'project'): Promise<Deadend> {
  const projectRoot = await resolveProjectRoot(startPath);
  return withLock(`${locksDirectory(projectRoot)}/deadends.lock`, async () => {
    const file = await loadDeadends(projectRoot);
    const now = new Date().toISOString();
    const item: Deadend = {
      deadendId: id('dead'),
      attempt,
      reason,
      observedEvidence: [],
      scope,
      status: 'candidate',
      sourceContextId: null,
      sourceSnapshotId: null,
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
