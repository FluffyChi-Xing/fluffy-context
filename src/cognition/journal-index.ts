import { createHash } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readJournal, readJournalSegments } from './journal.js';
import { journalFiles, readSegment } from './journal-segments.js';
import { cognitionJournalDirectory, cognitionRoot } from '../storage/layout.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { loadManifest } from '../runtime/init.js';
import { resolveProjectRoot } from '../project/project-resolver.js';
import type { CognitionEvent } from './types.js';

const MAX_INDEX_BYTES = 32 * 1024 * 1024;

interface IndexedSegment {
  name: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  cacheSha256: string;
  byteOffsets: number[];
  events: CognitionEvent[];
}

interface JournalIndex {
  schemaVersion: 1;
  projectId: string;
  headHash: string | null;
  segments: IndexedSegment[];
}

function indexPath(root: string): string {
  return path.join(cognitionRoot(root), 'cache', 'journal-index.json');
}

async function assertCachePathSafe(root: string): Promise<void> {
  for (const location of [cognitionRoot(root), path.dirname(indexPath(root)), indexPath(root)]) {
    try { if ((await lstat(location)).isSymbolicLink()) throw new Error('journal index refuses symlinked cache paths'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

function sealed(files: string[]): string[] {
  const latest = files.at(-1);
  return latest?.endsWith('.gz') ? files : files.slice(0, -1);
}

function offsets(raw: Buffer): number[] {
  const result: number[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 10) continue;
    if (index > start) result.push(start);
    start = index + 1;
  }
  return result;
}

export async function rebuildJournalIndex(startPath?: string): Promise<{ segments: number; events: number; headHash: string | null }> {
  const root = await resolveProjectRoot(startPath);
  const file = indexPath(root);
  await assertCachePathSafe(root);
  try {
    const projectId = (await loadManifest(root)).projectId;
    const events = await readJournal(root, { allowPartialTail: false });
    const segments: IndexedSegment[] = [];
    let cursor = 0;
    for (const name of sealed(await journalFiles(root))) {
      const raw = await readSegment(root, name);
      const byteOffsets = offsets(raw);
      const metadata = await stat(path.join(cognitionJournalDirectory(root), name));
      segments.push({ name, size: metadata.size, mtimeMs: metadata.mtimeMs,
        sha256: createHash('sha256').update(raw).digest('hex'), byteOffsets,
        events: events.slice(cursor, cursor + byteOffsets.length),
        cacheSha256: createHash('sha256').update(JSON.stringify(events.slice(cursor, cursor + byteOffsets.length))).digest('hex') });
      cursor += byteOffsets.length;
    }
    const cached = segments.flatMap((segment) => segment.events);
    const index: JournalIndex = { schemaVersion: 1, projectId, headHash: cached.at(-1)?.hash ?? null, segments };
    if (Buffer.byteLength(JSON.stringify(index)) > MAX_INDEX_BYTES) throw new Error('journal index exceeds 32 MiB; original journal remains authoritative');
    await atomicWriteJson(file, index);
    return { segments: segments.length, events: cached.length, headHash: index.headHash };
  } catch (error) { throw error; }
}

export async function readJournalIndexed(startPath?: string): Promise<{ events: CognitionEvent[]; mode: 'indexed' | 'full'; reason: string | null }> {
  const root = await resolveProjectRoot(startPath);
  const allFiles = await journalFiles(root);
  const sealedFiles = sealed(allFiles);
  if (sealedFiles.length === 0) return { events: await readJournal(root), mode: 'full', reason: 'no sealed segments' };
  let index: JournalIndex | null = null;
  try {
    await assertCachePathSafe(root);
    const file = indexPath(root);
    if ((await stat(file)).size > MAX_INDEX_BYTES) throw new Error('oversized index');
    index = JSON.parse(await readFile(file, 'utf8')) as JournalIndex;
    if (index.schemaVersion !== 1 || index.projectId !== (await loadManifest(root)).projectId || !Array.isArray(index.segments)
      || index.segments.length !== sealedFiles.length) throw new Error('stale index');
    for (const [position, name] of sealedFiles.entries()) {
      const cached = index.segments[position];
      const metadata = await stat(path.join(cognitionJournalDirectory(root), name));
      if (name.endsWith('.gz')) {
        try { await stat(path.join(cognitionJournalDirectory(root), name.slice(0, -3))); throw new Error('archive/raw pair requires full verification'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!cached || cached.name !== name || cached.size !== metadata.size || cached.mtimeMs !== metadata.mtimeMs
        || !Array.isArray(cached.events) || !Array.isArray(cached.byteOffsets) || cached.events.length !== cached.byteOffsets.length
        || typeof cached.sha256 !== 'string' || cached.sha256.length !== 64
        || cached.cacheSha256 !== createHash('sha256').update(JSON.stringify(cached.events)).digest('hex')) throw new Error('stale index');
    }
    const cachedEvents = index.segments.flatMap((segment) => segment.events);
    if ((cachedEvents.at(-1)?.hash ?? null) !== index.headHash) throw new Error('corrupt index');
    const tail = allFiles.slice(sealedFiles.length);
    const newEvents = await readJournalSegments(root, index.projectId, tail, index.headHash);
    return { events: [...cachedEvents, ...newEvents], mode: 'indexed', reason: null };
  } catch (error) {
    return { events: await readJournal(root), mode: 'full', reason: error instanceof Error ? error.message : 'index unavailable' };
  }
}
