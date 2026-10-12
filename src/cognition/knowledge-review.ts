import crypto from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { loadKnowledge } from '../runtime/knowledge.js';
import type { KnowledgeStatus } from '../runtime/types.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { cognitionManifestPath, knowledgePath, locksDirectory } from '../storage/layout.js';
import { withLock } from '../storage/lock.js';
import { importMemory } from './import-memory.js';
import { readMemoryReceipts } from './memory-receipts.js';
import { mirrorKnowledgeBatch } from './v1-bridge.js';
import { reconcileV1State } from './migration-v1.js';
import { loadRuntimePolicy } from './policy.js';

export interface KnowledgeReviewOptions {
  statuses?: KnowledgeStatus[];
  source?: string;
  reviewRequired?: boolean;
  offset?: number;
  limit?: number;
  maxChars?: number;
}
export interface KnowledgeBatchOptions {
  ids: string[];
  action: 'verify' | 'reject' | 'deprecate' | 'keep';
  reason: string;
  evidence?: string[];
  apply?: boolean;
  expectedToken?: string;
}
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function bounded(value: number | undefined, fallback: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > max) throw new Error(`${name} must be an integer from 0 to ${max}`);
  return result;
}

export async function reviewKnowledge(startPath?: string, options: KnowledgeReviewOptions = {}) {
  const root = await resolveProjectRoot(startPath);
  const limit = bounded(options.limit, 20, 100, 'limit');
  const offset = bounded(options.offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const maxChars = bounded(options.maxChars, 6000, 50000, 'maxChars');
  const statuses = options.statuses ?? ['candidate', 'verified'];
  if (!statuses.length || statuses.some((status) => !['candidate', 'verified', 'deprecated', 'rejected'].includes(status))) throw new Error('invalid review statuses');
  const memory = await importMemory(root);
  const receipts = await readMemoryReceipts(root);
  const records = (await loadKnowledge(root)).items;
  const matches = records.map((item) => {
    const sources = [...new Set([
      ...receipts.sources.filter((source) => source.blocks.some((block) => block.knowledgeId === item.knowledgeId) || source.reviewKnowledgeIds.includes(item.knowledgeId)).map((source) => source.source),
      ...memory.results.filter((result) => result.knowledgeId === item.knowledgeId).map((result) => result.source),
    ])].sort();
    const changes = memory.changes.filter((change) => change.reviewKnowledgeIds.includes(item.knowledgeId));
    return { item, sources, changes };
  }).filter(({ item, sources, changes }) => statuses.includes(item.status)
    && (options.source === undefined || sources.includes(options.source))
    && (!options.reviewRequired || changes.length > 0))
    .sort((a, b) => Number(b.changes.length > 0) - Number(a.changes.length > 0) || a.item.knowledgeId.localeCompare(b.item.knowledgeId));
  let usedChars = 0;
  let textTruncated = false;
  const items = [];
  for (const { item, sources, changes } of matches.slice(offset, offset + limit)) {
    const entry = { knowledgeId: item.knowledgeId, status: item.status, scope: item.scope,
      statement: item.statement, supportingEvidence: item.supportingEvidence, sources,
      reviewRequired: changes.length > 0,
      changes: changes.map(({ source, status }) => ({ source, status })), truncated: false };
    // Budget the entire serialized entry, including evidence and source metadata.
    if (usedChars + JSON.stringify(entry).length > maxChars) {
      entry.supportingEvidence = [];
      entry.truncated = true;
      entry.statement = '';
      if (usedChars + JSON.stringify(entry).length >= maxChars) {
        entry.sources = [];
        entry.changes = [];
        entry.scope = '';
      }
      if (usedChars + JSON.stringify(entry).length >= maxChars) break;
      // JSON escaping can cost more than one character per input character.
      // Binary search avoids quadratic slicing for long escaped statements.
      let low = 0;
      let high = Math.min(item.statement.length, maxChars - usedChars);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        entry.statement = item.statement.slice(0, mid);
        if (usedChars + JSON.stringify(entry).length <= maxChars) low = mid;
        else high = mid - 1;
      }
      entry.statement = item.statement.slice(0, low);
      textTruncated = true;
    }
    usedChars += JSON.stringify(entry).length;
    items.push(entry);
  }
  const nextOffset = offset + items.length < matches.length ? offset + items.length : null;
  return { projectRoot: root, total: matches.length, items, nextOffset,
    truncated: textTruncated || nextOffset !== null,
    budget: { maxChars, usedChars, includes: 'serialized items; response envelope excluded' },
    hint: nextOffset === offset ? 'Increase maxChars or limit to make progress.' : null };
}

export async function batchKnowledge(startPath: string | undefined, options: KnowledgeBatchOptions) {
  const root = await resolveProjectRoot(startPath);
  if (!Array.isArray(options.ids) || !options.ids.length || options.ids.length > 50 || options.ids.some((id) => !/^know-[a-z0-9-]+$/.test(id))) throw new Error('batch requires 1 to 50 explicit knowledge IDs');
  const ids = [...new Set(options.ids)].sort();
  if (ids.length !== options.ids.length) throw new Error('duplicate batch IDs');
  if (!['verify', 'reject', 'deprecate', 'keep'].includes(options.action)) throw new Error('invalid batch action');
  const reason = options.reason.trim();
  const evidence = [...new Set((options.evidence ?? []).map((value) => value.trim()).filter(Boolean))];
  if (!reason || reason.length > 2000) throw new Error('batch reason requires 1 to 2000 characters');
  if (evidence.length > 20 || evidence.some((value) => value.length > 2000)) throw new Error('batch evidence budget exceeded');
  if (['verify', 'keep'].includes(options.action) && !evidence.length) throw new Error('verify and keep require explicit evidence');
  if (options.apply && !/^[a-f0-9]{64}$/.test(options.expectedToken ?? '')) throw new Error('apply requires the expectedToken from a preview');
  const run = async () => {
    const file = await loadKnowledge(root);
    const selected = ids.map((id) => {
      const item = file.items.find((record) => record.knowledgeId === id);
      if (!item) throw new Error(`knowledge not found: ${id}`);
      return item;
    });
    const synchronize = async () => {
      const errors: Array<{ knowledgeId: string; error: string }> = [];
      try { await access(cognitionManifestPath(root)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'not-enabled', errors };
        return { status: 'pending', errors: [{ knowledgeId: '*', error: String(error).slice(0, 300) }] };
      }
      try {
        if (!(await loadRuntimePolicy(root)).enabled) return { status: 'not-enabled', errors };
      } catch (error) { return { status: 'pending', errors: [{ knowledgeId: '*', error: String(error).slice(0, 300) }] }; }
      try { await mirrorKnowledgeBatch(root, selected); }
      catch (error) { errors.push({ knowledgeId: '*', error: String(error).slice(0, 300) }); }
      if (!errors.length) {
        try { await reconcileV1State(root); }
        catch (error) { errors.push({ knowledgeId: '*', error: String(error).slice(0, 300) }); }
      }
      return { status: errors.length ? 'pending' : 'complete', errors };
    };
    const requestHash = digest({ root, ids, action: options.action, reason, evidence });
    // The stored token also binds the request, so retries cannot change intent.
    if (options.apply && selected.every((item) => item.governance?.batchToken === `${requestHash}:${options.expectedToken}`)) {
      return { applied: true, alreadyApplied: true, token: options.expectedToken!, ids, synchronization: await synchronize() };
    }
    const memory = await importMemory(root);
    const receipts = await readMemoryReceipts(root);
    const relatedSources = new Set(receipts.sources.filter((source) => source.blocks.some((block) => ids.includes(block.knowledgeId))
      || source.reviewKnowledgeIds.some((id) => ids.includes(id))).map((source) => source.source));
    for (const result of memory.results) if (result.knowledgeId && ids.includes(result.knowledgeId)) relatedSources.add(result.source);
    const changes = memory.changes.filter((change) => relatedSources.has(change.source));
    for (const item of selected) {
      const expected = options.action === 'verify' || options.action === 'reject' ? 'candidate' : 'verified';
      if (item.status !== expected) throw new Error(`invalid ${options.action} transition for ${item.knowledgeId}: ${item.status}`);
      if (options.action === 'keep') {
        const affected = changes.filter((change) => change.reviewKnowledgeIds.includes(item.knowledgeId));
        if (!affected.length) throw new Error(`no pending source review: ${item.knowledgeId}`);
        if (affected.some((change) => ['partial', 'unavailable'].includes(change.status))) throw new Error('cannot close an incomplete source review');
      }
    }
    const token = digest({ requestHash, selected, changes });
    const transitions = selected.map((item) => ({ knowledgeId: item.knowledgeId, from: item.status,
      to: options.action === 'verify' ? 'verified' : options.action === 'reject' ? 'rejected' : options.action === 'deprecate' ? 'deprecated' : item.status }));
    if (!options.apply) return { applied: false, token, transitions, reason, evidence };
    if (token !== options.expectedToken) throw new Error('batch preview is stale; preview again before applying');
    const now = new Date().toISOString();
    for (const item of selected) {
      if (options.action === 'keep') {
        const sources = new Map(item.memoryReview?.sources.map((source) => [source.source, source]) ?? []);
        for (const change of changes.filter((change) => change.reviewKnowledgeIds.includes(item.knowledgeId))) sources.set(change.source, { source: change.source, sourceHash: change.currentHash });
        if (sources.size > 2000) throw new Error('source review history budget exceeded');
        item.memoryReview = { sources: [...sources.values()], reason, evidence, reviewedAt: now };
      } else item.status = options.action === 'verify' ? 'verified' : options.action === 'reject' ? 'rejected' : 'deprecated';
      if (options.action === 'verify') item.confidence = Math.max(item.confidence, 0.8);
      if (options.action === 'verify' || options.action === 'keep') item.supportingEvidence = [...new Set([...item.supportingEvidence, ...evidence])];
      item.updatedAt = now;
      item.governance = { reason, transitionedAt: now, action: options.action, batchToken: `${requestHash}:${token}` };
    }
    // All states commit in one atomic file replacement. Journal mirroring can be
    // retried with the same token if a later append fails; never roll back history.
    await atomicWriteJson(knowledgePath(root), file);
    return { applied: true, alreadyApplied: false, token, transitions, synchronization: await synchronize() };
  };
  return options.apply
    ? withLock(path.join(locksDirectory(root), 'memory-import.lock'), () => withLock(path.join(locksDirectory(root), 'knowledge.lock'), run))
    : run();
}
