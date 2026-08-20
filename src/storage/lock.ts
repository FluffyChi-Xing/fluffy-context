import { mkdir, open, readFile, rm } from 'node:fs/promises';
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
    return !Number.isFinite(createdAt) || Date.now() - createdAt > staleLockMs;
  } catch {
    return true;
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
