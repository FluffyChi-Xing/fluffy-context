import { readGitWorktreeState, type GitWorktreeState } from '../git/git-adapter.js';
import { appendEvent } from './journal.js';

function anchor(state: GitWorktreeState) {
  return { worktreeId: state.worktreeId, branch: state.branch, ref: state.ref, head: state.commit };
}

function key(state: GitWorktreeState): string {
  return `${state.worktreeId ?? 'none'}\0${state.ref ?? 'detached'}\0${state.commit ?? 'missing'}`;
}

export class GitObserver {
  private previous: GitWorktreeState | null = null;
  private pending = Promise.resolve();

  constructor(private readonly projectRoot: string) {}

  get current(): GitWorktreeState | null {
    return this.previous;
  }

  observeNow(): Promise<{ state: GitWorktreeState; changed: boolean }> {
    const observation = this.pending.then(() => this.observe());
    this.pending = observation.then(() => undefined, () => undefined);
    return observation;
  }

  async drain(): Promise<void> {
    await this.pending;
  }

  private async observe(): Promise<{ state: GitWorktreeState; changed: boolean }> {
    const state = await readGitWorktreeState(this.projectRoot);
    const previous = this.previous;
    const changed = !previous || key(previous) !== key(state);
    if (!changed) return { state, changed: false };
    const currentKey = key(state);
    await appendEvent(this.projectRoot, {
      type: 'git.state.observed',
      source: { kind: 'git-observer' },
      idempotencyKey: `git:state:${currentKey}`,
      git: anchor(state),
      payload: { detached: state.detached, fingerprint: state.fingerprint },
    });
    if (previous && (previous.ref !== state.ref || previous.branch !== state.branch || previous.worktreeId !== state.worktreeId)) {
      await appendEvent(this.projectRoot, {
        type: 'git.branch.changed',
        source: { kind: 'git-observer' },
        idempotencyKey: `git:branch:${previous.worktreeId ?? 'none'}:${previous.ref ?? 'detached'}:${currentKey}`,
        git: anchor(state),
        payload: { previous: anchor(previous), current: anchor(state) },
      });
    }
    if (previous && previous.commit !== state.commit) {
      await appendEvent(this.projectRoot, {
        type: 'git.head.changed',
        source: { kind: 'git-observer' },
        idempotencyKey: `git:head:${previous.worktreeId ?? 'none'}:${previous.commit ?? 'missing'}:${currentKey}`,
        git: anchor(state),
        payload: { previous: anchor(previous), current: anchor(state) },
      });
    }
    this.previous = state;
    return { state, changed: true };
  }
}
