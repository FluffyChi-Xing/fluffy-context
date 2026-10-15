import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function retryFileOperation(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await operation(); return; }
    catch (error) {
      // Windows scanners and readers can briefly deny rename/unlink. Retrying
      // the atomic operation preserves the old destination; never delete it.
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt, 100)));
    }
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  // Several projections can be rebuilt within the same millisecond in one
  // process. A timestamp alone lets concurrent writes share and remove a file.
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await retryFileOperation(() => rename(temporaryPath, filePath));
  } finally {
    await retryFileOperation(() => rm(temporaryPath, { force: true }));
  }
}
