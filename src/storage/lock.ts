import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

interface LockRecord {
  pid: number;
  createdAt: string;
}

const staleLockMs = 60_000;

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const record = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockRecord>;
    const createdAt = Date.parse(record.createdAt ?? '');
    if (Number.isInteger(record.pid) && record.pid! > 0) {
      try { process.kill(record.pid!, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
    }
    return !Number.isFinite(createdAt) || Date.now() - createdAt > staleLockMs;
  } catch {
    // Another process can see the exclusive file before its owner finishes
    // writing the JSON. A fresh empty/partial lock is never safe to steal.
    try { return Date.now() - (await stat(lockPath)).mtimeMs > staleLockMs; }
    catch { return false; }
  }
}

export async function withLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() } satisfies LockRecord));
  } catch {
    if (await isStale(lockPath)) {
      await rm(lockPath, { force: true });
      handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() } satisfies LockRecord));
    } else {
      throw new Error('context is busy; try again later');
    }
  }

  try {
    return await operation();
  } finally {
    try { await handle.close(); } finally { await rm(lockPath, { force: true }); }
  }
}
