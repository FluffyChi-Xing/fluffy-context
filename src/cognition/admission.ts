import path from 'node:path';
import { cognitionRuntimeDirectory } from '../storage/layout.js';
import { readJson, isRecord } from '../storage/json-store.js';
import { atomicWriteJson } from '../storage/atomic-write.js';

interface AdmissionStats { schemaVersion: 1; dropped: Record<string, number>; updatedAt: string; }
const statsPath = (root: string) => path.join(cognitionRuntimeDirectory(root), 'admission.json');

export async function readAdmissionStats(root: string): Promise<AdmissionStats> {
  try {
    return await readJson<AdmissionStats>(statsPath(root), (value): value is AdmissionStats => isRecord(value)
      && value.schemaVersion === 1 && typeof value.updatedAt === 'string' && isRecord(value.dropped)
      && Object.values(value.dropped).every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, dropped: {}, updatedAt: '' };
    throw error;
  }
}

// The journal writer lock serializes these counters too. Never store content.
export async function recordAdmissionDrop(root: string, type: string): Promise<void> {
  const stats = await readAdmissionStats(root);
  stats.dropped[type] = Math.min(Number.MAX_SAFE_INTEGER, (stats.dropped[type] ?? 0) + 1);
  stats.updatedAt = new Date().toISOString();
  await atomicWriteJson(statsPath(root), stats);
}
