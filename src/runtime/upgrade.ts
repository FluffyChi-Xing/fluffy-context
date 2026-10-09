import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { cognitionManifestPath, cognitionV1ImportPath, contextRoot, locksDirectory } from '../storage/layout.js';
import { withLock } from '../storage/lock.js';
import { loadManifest } from './init.js';
import { migrationReadiness } from '../cognition/readiness.js';
import { importV1, reconcileV1State, verifyV1Import } from '../cognition/migration-v1.js';
import { compactJournal, readJournal } from '../cognition/journal.js';
import { journalStorage } from '../cognition/journal-segments.js';
import { loadRuntimePolicy } from '../cognition/policy.js';
import { runtimeStatus, startRuntime, stopRuntime } from '../cognition/runtime.js';
import { rebuildProjections } from '../cognition/projections.js';
import { v1Synced } from '../cognition/v1-bridge.js';
import { COGNITION_LAYOUT_VERSION } from '../cognition/types.js';
import type { ProgressReporter } from '../cognition/progress.js';
import { VERSION } from '../version.js';

const excluded = new Set(['backups', 'builds', 'locks', 'cognition/runtime/lease.json', 'cognition/runtime/secret', 'cognition/runtime/startup.json']);

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function inventory(root: string) {
  const files: Array<{ relative: string; bytes: number }> = [];
  async function visit(relative: string) {
    if (excluded.has(relative)) return;
    const file = path.join(root, relative);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`upgrade refuses symlink: ${relative || '.context'}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) files.push({ relative, bytes: stat.size });
    else throw new Error(`upgrade refuses unsupported file: ${relative}`);
  }
  await visit('');
  return files;
}

async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function backup(root: string, destination: string, progress?: ProgressReporter) {
  const files = await inventory(root);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const manifest = [];
  let completed = 0;
  progress?.({ phase: 'backup', completed, total, unit: 'bytes' });
  for (const file of files) {
    const source = path.join(root, file.relative);
    const target = path.join(destination, 'data', file.relative);
    await mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(createReadStream(source), new Transform({ transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk); bytes += chunk.length; completed += chunk.length;
      progress?.({ phase: 'backup', completed, total, unit: 'bytes' });
      callback(null, chunk);
    } }), createWriteStream(target, { flags: 'wx' }));
    const sha256 = hash.digest('hex');
    if (bytes !== file.bytes || await hashFile(target) !== sha256 || await hashFile(source) !== sha256) throw new Error(`backup changed during copy: ${file.relative}`);
    manifest.push({ ...file, sha256 });
  }
  if (JSON.stringify(await inventory(root)) !== JSON.stringify(files)) throw new Error('project data changed during backup; close other agents and retry');
  await atomicWriteJson(path.join(destination, 'backup.json'), { version: VERSION, completedAt: new Date().toISOString(), excluded: [...excluded], files: manifest });
  return { directory: destination, files: files.length, bytes: total };
}

async function locked<T>(root: string, names: string[], action: () => Promise<T>): Promise<T> {
  if (!names.length) return action();
  return withLock(path.join(locksDirectory(root), `${names[0]}.lock`), () => locked(root, names.slice(1), action));
}

export async function upgradeProject(startPath?: string, options: { dryRun?: boolean; onProgress?: ProgressReporter } = {}) {
  const root = await resolveProjectRoot(startPath);
  const progress = options.onProgress;
  progress?.({ phase: 'inspect', completed: 0, total: null });
  // Read-only preflight; never initialize a missing or invalid legacy store.
  const files = await inventory(contextRoot(root));
  const manifest = await loadManifest(root);
  const readiness = await migrationReadiness(root, progress);
  if (!readiness.eligible) throw new Error(`upgrade preflight failed: ${readiness.issues.join('; ')}`);
  if (readiness.v2Present) {
    const cognition = JSON.parse(await readFile(cognitionManifestPath(root), 'utf8'));
    if (cognition.schemaVersion !== 2 || cognition.layoutVersion !== COGNITION_LAYOUT_VERSION || cognition.projectId !== manifest.projectId) throw new Error('unsupported cognition manifest; upgrade refused');
    await loadRuntimePolicy(root);
  }
  const initial = await readJournal(root, { allowPartialTail: false, onProgress: progress });
  const storage = await journalStorage(root);
  const receiptPresent = await exists(cognitionV1ImportPath(root));
  if (receiptPresent) {
    const receipt = JSON.parse(await readFile(cognitionV1ImportPath(root), 'utf8'));
    if (!readiness.v2Present || receipt.schemaVersion !== 2 || typeof receipt.sourceHash !== 'string' || !Array.isArray(receipt.eventIds)) throw new Error('invalid migration receipt; upgrade refused');
  }
  const plan = { projectRoot: root, targetVersion: VERSION, counts: readiness.counts, existingEvents: initial.length,
    migration: receiptPresent ? 'reconcile' : readiness.v2Present ? 'resume-import' : 'import',
    backupBytes: files.reduce((sum, file) => sum + file.bytes, 0), storage,
    warning: 'Close all agent/MCP sessions before applying. Archived journals cannot be opened with 0.8.0.' };
  if (options.dryRun) {
    progress?.({ phase: 'preview-complete', completed: 1, total: 1 });
    return { ...plan, applied: false };
  }
  return locked(root, ['upgrade', 'cognition-runtime-start'], async () => {
    const wasRunning = (await runtimeStatus(root)).running;
    progress?.({ phase: 'stop-runtime', completed: 0, total: null });
    if (wasRunning) await stopRuntime(root);
    let savedBackup: Awaited<ReturnType<typeof backup>> | null = null;
    let result;
    try {
      result = await locked(root, ['setup', 'checkpoint', 'knowledge', 'deadends', 'notes'], async () => {
        const backups = path.join(contextRoot(root), 'backups');
        if (await exists(backups) && (await lstat(backups)).isSymbolicLink()) throw new Error('upgrade refuses symlinked backup directory');
        const destination = path.join(backups, `upgrade-${Date.now()}-${randomUUID()}`);
        savedBackup = await locked(root, ['cognition-migration', 'cognition-journal'], () => backup(contextRoot(root), destination, progress));
        const before = await readJournal(root, { allowPartialTail: false, onProgress: progress });
        progress?.({ phase: 'migrate', completed: 0, total: null });
        if (!receiptPresent) {
          const migration = await importV1(root, progress);
          if (!migration.applied) throw new Error(migration.issues.join('; '));
          const verification = await verifyV1Import(root);
          if (!verification.verified) throw new Error(verification.issues.join('; '));
        } else if (!await v1Synced(root)) await reconcileV1State(root);
        const compacted = await compactJournal(root, { apply: true, onProgress: progress });
        progress?.({ phase: 'rebuild-projections', completed: 0, total: null });
        await rebuildProjections(root);
        const after = await readJournal(root, { allowPartialTail: false, onProgress: progress });
        if (after.length < before.length || before.some((event, index) => after[index].hash !== event.hash)) throw new Error('upgrade changed historical journal events');
        const complete = { ...plan, applied: true, backup: savedBackup, journal: { verified: true, eventCount: after.length, addedEvents: after.length - before.length }, storage: compacted };
        await atomicWriteJson(path.join(destination, 'upgrade.json'), { ...complete, completedAt: new Date().toISOString() });
        return complete;
      });
    } catch (error) {
      throw new Error(`upgrade failed; runtime remains stopped. ${savedBackup ? `Backup: ${(savedBackup as { directory: string }).directory}. ` : 'No completed backup. '} ${error instanceof Error ? error.message : String(error)}`);
    }
    // The startup lock must be released before launching a new runtime.
    return { ...result, restartRuntime: wasRunning };
  }).then(async (result) => {
    progress?.({ phase: 'restore-runtime', completed: 0, total: null });
    const runtime = result.restartRuntime ? await startRuntime(root) : await runtimeStatus(root);
    progress?.({ phase: 'complete', completed: 1, total: 1 });
    return { ...result, runtime };
  });
}
