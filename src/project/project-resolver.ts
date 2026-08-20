import { access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

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
