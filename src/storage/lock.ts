import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

interface LockRecord {
  pid: number;
  createdAt: string;
  owner?: string;
}

const staleLockMs = 15_000;
const heartbeatMs = 2_000;

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockRecord>;
    const age = Date.now() - (await stat(lockPath)).mtimeMs;
    if (age <= staleLockMs) return false;
    if (Number.isInteger(record.pid) && record.pid! > 0) {
      try { process.kill(record.pid!, 0); if (process.platform !== 'win32') return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
    }
    // Windows may report a terminated PID as alive. A live owner refreshes
    // mtime, so an expired heartbeat takes precedence over that probe.
    return true;
  } catch {
    // Another process can see the exclusive file before its owner finishes
    // writing the JSON. A fresh empty/partial lock is never safe to steal.
    try { return Date.now() - (await stat(lockPath)).mtimeMs > staleLockMs; }
    catch { return false; }
  }
}

async function reclaim(lockPath: string) {
  const guard = `${lockPath}.reclaim`;
  try {
    await mkdir(guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - (await stat(guard)).mtimeMs <= staleLockMs) throw new Error('context is busy; try again later');
      await rmdir(guard);
      await mkdir(guard);
    } catch { throw new Error('context is busy; try again later'); }
  }
  try {
    if (!await isStale(lockPath)) throw new Error('context is busy; try again later');
    await rm(lockPath, { force: true });
    return await open(lockPath, 'wx');
  } finally {
    await rmdir(guard).catch(() => undefined);
  }
}

export async function withLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const owner = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await isStale(lockPath)) throw new Error('context is busy; try again later');
    try { handle = await reclaim(lockPath); }
    catch { throw new Error('context is busy; try again later'); }
  }

  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), owner } satisfies LockRecord));
  } catch (error) {
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }
  const heartbeat = setInterval(() => {
    void handle.utimes(new Date(), new Date()).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    try { await handle.close(); } finally {
      try {
        const current = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord;
        if (current.owner === owner) await rm(lockPath, { force: true });
      } catch { /* A replaced lock belongs to another process. */ }
    }
  }
}
