import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { filterPaths } from '../capture/context-filter.js';
import type { Knowledge } from '../runtime/types.js';
import { readMemoryReceipts } from './memory-receipts.js';

export interface KnowledgeSourceState {
  state: 'unchanged' | 'changed' | 'missing' | 'unknown';
  reviewRequired: boolean;
  fingerprint: string;
  reason?: 'receipt-unavailable';
}
export interface SourceObservation {
  source: string;
  status: KnowledgeSourceState['state'];
  currentHash: string | null;
  previousHash: string | null;
  reviewKnowledgeIds: string[];
}
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** Check only previously tracked sources. No discovery scan or journal mutation. */
export async function inspectKnowledgeSources(root: string, records: Knowledge[]) {
  const byId = new Map(records.map((item) => [item.knowledgeId, item]));
  const states = new Map<string, KnowledgeSourceState>();
  const observations: SourceObservation[] = [];
  if (!records.length) return { states, observations, checkedFiles: 0, readBytes: 0 };
  let receipts;
  try { receipts = await readMemoryReceipts(root); }
  catch {
    // Optional source metadata must not prevent task recovery. Imported evidence
    // remains withheld until its damaged/unavailable provenance can be inspected.
    for (const item of records) states.set(item.knowledgeId, { state: 'unknown', reason: 'receipt-unavailable',
      reviewRequired: item.kind === 'imported-memory' || item.supportingEvidence.some((value) => value.startsWith('source-sha256:')),
      fingerprint: hash('receipt-unavailable') });
    return { states, observations, checkedFiles: 0, readBytes: 0 };
  }
  const evidence = new Map<string, Array<{ state: KnowledgeSourceState['state']; pending: boolean; source: string; hash: string | null }>>();
  let bytes = 0;
  let checks = 0;
  let files = 0;
  async function observe(source: string): Promise<{ state: 'known' | 'missing' | 'unknown'; hash: string | null }> {
    if (++files > 128 || /^\.claude\/worktrees(?:\/|$)/i.test(source) || !(await filterPaths(root, [source])).length) return { state: 'unknown', hash: null };
    const parts = source.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (++checks > 2000) return { state: 'unknown', hash: null };
      const location = path.join(root, ...parts.slice(0, i + 1));
      try {
        const info = await lstat(location);
        if (info.isSymbolicLink()) return { state: 'unknown', hash: null };
        if (i < parts.length - 1) {
          if (!info.isDirectory()) return { state: 'unknown', hash: null };
          try { await lstat(path.join(location, '.git')); return { state: 'unknown', hash: null }; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'unknown', hash: null }; }
        } else {
          if (!info.isFile() || info.size > 65536 || bytes + info.size > 2 * 1024 * 1024) return { state: 'unknown', hash: null };
          const handle = await open(location, 'r');
          try {
            const buffer = Buffer.alloc(65537);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            bytes += bytesRead;
            if (bytesRead !== info.size || (await handle.stat()).size !== info.size || bytesRead > 65536 || bytes > 2 * 1024 * 1024) return { state: 'unknown', hash: null };
            return { state: 'known', hash: hash(buffer.subarray(0, bytesRead).toString('utf8')) };
          } finally { await handle.close(); }
        }
      } catch (error) {
        return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown', hash: null };
      }
    }
    return { state: 'unknown', hash: null };
  }
  for (const receipt of receipts.sources) {
    const ids = [...new Set([...receipt.blocks.map((block) => block.knowledgeId), ...receipt.reviewKnowledgeIds])].filter((id) => byId.has(id));
    if (!ids.length) continue;
    const current = await observe(receipt.source);
    const status = current.state === 'unknown' ? 'unknown' : current.state === 'missing' ? 'missing' : current.hash === receipt.sourceHash ? 'unchanged' : 'changed';
    const pendingIds: string[] = [];
    for (const id of ids) {
      const review = byId.get(id)!.memoryReview?.sources.find((item) => item.source === receipt.source);
      const acknowledged = current.state !== 'unknown' && review !== undefined && review.sourceHash === current.hash;
      const pending = !acknowledged && (status === 'changed' || status === 'missing' || receipt.reviewKnowledgeIds.includes(id));
      if (pending) pendingIds.push(id);
      const entries = evidence.get(id) ?? [];
      entries.push({ state: acknowledged && status === 'changed' ? 'unchanged' : status, pending, source: receipt.source, hash: current.hash });
      evidence.set(id, entries);
    }
    observations.push({ source: receipt.source, status, previousHash: receipt.sourceHash, currentHash: current.hash, reviewKnowledgeIds: pendingIds });
  }
  for (const item of records) {
    const entries = evidence.get(item.knowledgeId) ?? [];
    const state = entries.some((entry) => entry.state === 'changed') ? 'changed' : entries.some((entry) => entry.state === 'missing') ? 'missing'
      : !entries.length || entries.some((entry) => entry.state === 'unknown') ? 'unknown' : 'unchanged';
    states.set(item.knowledgeId, { state, reviewRequired: entries.some((entry) => entry.pending), fingerprint: hash(JSON.stringify(entries)) });
  }
  return { states, observations, checkedFiles: Math.min(files, 128), readBytes: bytes };
}
