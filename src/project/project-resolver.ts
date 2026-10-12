import { access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const execFileAsync = promisify(execFile);
const resolutionScope = new AsyncLocalStorage<Map<string, Promise<string>>>();

// Cache only within one request, never across MCP calls or runtime polls.
export function withProjectResolution<T>(operation: () => T): T {
  if (resolutionScope.getStore()) return operation();
  return resolutionScope.run(new Map(), operation);
}

async function gitRoot(directory: string): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      windowsHide: true,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveProjectRoot(startPath = process.cwd()): Promise<string> {
  const initial = path.resolve(startPath);
  const cache = resolutionScope.getStore();
  if (!cache) return resolveUncached(initial);
  const pending = cache.get(initial);
  if (pending) return pending;
  const operation = resolveUncached(initial);
  cache.set(initial, operation);
  try {
    const root = await operation;
    cache.set(root, Promise.resolve(root));
    return root;
  } catch (error) {
    cache.delete(initial);
    throw error;
  }
}

async function resolveUncached(initial: string): Promise<string> {
  const directory = (await stat(initial)).isDirectory() ? initial : path.dirname(initial);
  const root = await gitRoot(directory);
  if (root) {
    return path.resolve(root);
  }

  let current = directory;
  while (true) {
    try {
      await access(path.join(current, '.context'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return directory;
      }
      current = parent;
    }
  }
}
