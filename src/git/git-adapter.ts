import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitState } from '../runtime/types.js';

export interface GitWorktreeState extends GitState {
  ref: string | null;
  detached: boolean;
  worktreeId: string | null;
  fingerprint: string | null;
}

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
  const state = await readGitWorktreeState(projectRoot);
  return { root: state.root, branch: state.branch, commit: state.commit };
}

export async function readGitWorktreeState(projectRoot: string): Promise<GitWorktreeState> {
  const root = await git(['rev-parse', '--show-toplevel'], projectRoot);
  if (!root) {
    return { root: null, branch: null, commit: null, ref: null, detached: false, worktreeId: null, fingerprint: null };
  }
  const [branch, commit, ref, gitDir] = await Promise.all([
    git(['branch', '--show-current'], projectRoot),
    git(['rev-parse', 'HEAD'], projectRoot),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], projectRoot),
    git(['rev-parse', '--git-dir'], projectRoot),
  ]);
  const detached = ref === null;
  const worktreeId = crypto.createHash('sha256').update(`${root}\0${gitDir ?? projectRoot}`).digest('hex').slice(0, 16);
  const fingerprint = crypto.createHash('sha256').update(`${worktreeId}\0${ref ?? 'detached'}\0${commit ?? 'missing'}`).digest('hex').slice(0, 16);
  return { root, branch, commit, ref, detached, worktreeId, fingerprint };
}
