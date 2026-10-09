import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { cognitionJournalDirectory } from '../storage/layout.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const JOURNAL_SEGMENT_BYTES = 1024 * 1024;

export async function journalFiles(root: string): Promise<string[]> {
  let files: string[];
  try { files = await readdir(cognitionJournalDirectory(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const segments = new Map<string, string>();
  for (const file of files) {
    if (!file.endsWith('.ndjson') && !file.endsWith('.ndjson.gz')) continue;
    if (!/^\d{8}\.ndjson(?:\.gz)?$/.test(file)) throw new Error(`unrecognized journal segment: ${file}`);
    const base = file.replace(/\.gz$/, '');
    if (!segments.has(base) || file.endsWith('.gz')) segments.set(base, file);
  }
  return [...segments.values()].sort();
}

async function optional(file: string): Promise<Buffer | null> {
  try { return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function readSegment(root: string, name: string): Promise<Buffer> {
  const file = path.join(cognitionJournalDirectory(root), name);
  if (!name.endsWith('.gz')) {
    const raw = await optional(file);
    // An unlocked reader may race a successful archive publication.
    return raw ?? readSegment(root, `${name}.gz`);
  }
  let decoded: Buffer;
  try { decoded = await decompress(await readFile(file)); }
  catch (error) { throw new Error(`invalid journal archive ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  const raw = await optional(file.slice(0, -3));
  if (raw && !raw.equals(decoded)) throw new Error(`journal archive/raw mismatch: ${name}`);
  return decoded;
}

// Caller holds cognition-journal.lock. Publish and validate before removing raw
// bytes; a crash with both representations is safe and validated on every read.
export async function archiveSegment(root: string, name: string): Promise<void> {
  if (name.endsWith('.gz')) {
    await readSegment(root, name);
    await rm(path.join(cognitionJournalDirectory(root), name.slice(0, -3)), { force: true });
    return;
  }
  const source = path.join(cognitionJournalDirectory(root), name);
  const raw = await readFile(source);
  if (!raw.length) return;
  if (raw.at(-1) !== 10) throw new Error(`cannot archive incomplete journal segment: ${name}`);
  const target = `${source}.gz`;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, await compress(raw, { level: 9 }), { flag: 'wx' });
    await rename(temporary, target);
    if (!(await readSegment(root, `${name}.gz`)).equals(raw)) throw new Error(`archive verification failed: ${name}`);
    await rm(source);
  } finally { await rm(temporary, { force: true }); }
}

export async function appendJournalLine(root: string, line: string): Promise<void> {
  const directory = cognitionJournalDirectory(root);
  await mkdir(directory, { recursive: true });
  const latest = (await journalFiles(root)).at(-1);
  let number = latest ? Number(latest.slice(0, 8)) : 1;
  if (latest?.endsWith('.gz')) number += 1;
  else if (latest && (await stat(path.join(directory, latest))).size >= JOURNAL_SEGMENT_BYTES) {
    await archiveSegment(root, latest);
    number += 1;
  }
  if (number > 99_999_999) throw new Error('journal segment limit exceeded');
  await appendFile(path.join(directory, `${String(number).padStart(8, '0')}.ndjson`), line, 'utf8');
}

export async function journalStorage(root: string, expand = false) {
  const files = await journalFiles(root);
  let bytes = 0;
  let expandedBytes: number | null = expand ? 0 : null;
  let archives = 0;
  for (const file of files) {
    let metadata;
    try { metadata = await stat(path.join(cognitionJournalDirectory(root), file)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !file.endsWith('.gz')) {
        metadata = await stat(path.join(cognitionJournalDirectory(root), `${file}.gz`));
      } else throw error;
    }
    bytes += metadata.size;
    if (file.endsWith('.gz')) {
      archives += 1;
      bytes += (await optional(path.join(cognitionJournalDirectory(root), file.slice(0, -3))))?.length ?? 0;
    }
    if (expandedBytes !== null) expandedBytes += (await readSegment(root, file)).length;
  }
  return { bytes, expandedBytes, archives, segments: files.length };
}
