import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '../storage/json-store.js';
import { atomicWriteJson } from '../storage/atomic-write.js';

export interface MemorySourceReceipt {
  source: string;
  sourceHash: string | null;
  blocks: Array<{ fingerprint: string; knowledgeId: string }>;
  reviewKnowledgeIds: string[];
}
export interface MemoryReceipts { schemaVersion: 1; sources: MemorySourceReceipt[]; }
const hash = /^[a-f0-9]{64}$/;
const id = /^know-[a-z0-9-]+$/;
const MAX_BYTES = 4 * 1024 * 1024;

export function validMemoryReceipts(value: unknown): value is MemoryReceipts {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.sources) || value.sources.length > 2000) return false;
  let count = 0;
  const sources = new Set<string>();
  for (const source of value.sources) {
    if (!isRecord(source) || typeof source.source !== 'string' || !source.source || source.source.length > 1024
      || path.isAbsolute(source.source) || /[\\:\0]/.test(source.source) || source.source.split('/').some((part) => !part || part === '..' || part === '.')
      || sources.has(source.source) || !(source.sourceHash === null || typeof source.sourceHash === 'string' && hash.test(source.sourceHash))
      || !Array.isArray(source.blocks) || !Array.isArray(source.reviewKnowledgeIds)) return false;
    sources.add(source.source);
    count += source.blocks.length + source.reviewKnowledgeIds.length;
    if (count > 10000 || !source.blocks.every((block) => isRecord(block) && typeof block.fingerprint === 'string' && hash.test(block.fingerprint)
      && typeof block.knowledgeId === 'string' && id.test(block.knowledgeId))
      || !source.reviewKnowledgeIds.every((item) => typeof item === 'string' && id.test(item))) return false;
  }
  return true;
}

export async function readMemoryReceipts(root: string): Promise<MemoryReceipts> {
  const file = path.join(root, '.context', 'memory-import.json');
  if ((await lstat(path.dirname(file))).isSymbolicLink()) throw new Error('memory import refuses symlinked storage');
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('unsafe or oversized memory import receipt');
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!validMemoryReceipts(parsed)) throw new Error('invalid memory import receipt; preserve it for inspection');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, sources: [] };
    throw error;
  }
}

export async function writeMemoryReceipts(root: string, receipts: MemoryReceipts): Promise<void> {
  if (!validMemoryReceipts(receipts) || Buffer.byteLength(JSON.stringify(receipts, null, 2)) > MAX_BYTES) throw new Error('memory import receipt budget exceeded');
  await readMemoryReceipts(root); // Do not overwrite a damaged or symlinked receipt.
  await atomicWriteJson(path.join(root, '.context', 'memory-import.json'), receipts);
}
