import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitState } from '../runtime/types.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await execFileAsync('git', args, { cwd, windowsHide: true });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function readGitState(projectRoot: string): Promise<GitState> {
  const root = await git(['rev-parse', '--show-toplevel'], projectRoot);
  if (!root) {
    return { root: null, branch: null, commit: null };
  }

  return {
    root,
    branch: await git(['branch', '--show-current'], projectRoot),
    commit: await git(['rev-parse', 'HEAD'], projectRoot),
  };
}
