import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { readGitState } from '../git/git-adapter.js';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { readJson } from '../storage/json-store.js';
import { withLock } from '../storage/lock.js';
import {
  contextDirectory,
  contextMetadataPath,
  contextsRoot,
  indexPath,
  locksDirectory,
  snapshotPath,
  snapshotsDirectory,
} from '../storage/layout.js';
import type {
  CheckpointInput,
  ContextMetadata,
  ContextPatch,
  GitState,
  IndexFile,
  ResumeResult,
  Snapshot,
  StructuredContext,
} from './types.js';

export interface CheckpointOptions {
  minSaveIntervalMs?: number;
}

export type CheckpointResult =
  | { status: 'saved'; context: ContextMetadata; snapshot: Snapshot }
  | { status: 'no_change'; context: ContextMetadata; snapshot: Snapshot }
  | { status: 'rate_limited'; context: ContextMetadata; snapshot: Snapshot; retryAt: string };
import { loadManifest } from './init.js';
import { filterPaths } from '../capture/context-filter.js';

const emptyContext = (): StructuredContext => ({
  progressSummary: '',
  lastError: null,
  completed: [],
  pendingTasks: [],
  decisions: [],
  risks: [],
  relatedFiles: [],
});

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function limited(value: string, budget: number): string {
  return value.length <= budget ? value : value.slice(0, Math.max(0, budget - 1)) + '…';
}

function limitedList(values: string[], budget: { remaining: number }): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (budget.remaining <= 0) break;
    const item = limited(value, budget.remaining);
    result.push(item);
    budget.remaining -= item.length;
  }
  return result;
}

function applyPatch(base: StructuredContext, patch: ContextPatch): StructuredContext {
  return { ...base, ...patch };
}

function diffContext(previous: StructuredContext, current: StructuredContext): ContextPatch {
  const patch: ContextPatch = {};
  if (previous.progressSummary !== current.progressSummary) patch.progressSummary = current.progressSummary;
  if (previous.lastError !== current.lastError) patch.lastError = current.lastError;
  if (stableJson(previous.completed) !== stableJson(current.completed)) patch.completed = current.completed;
  if (stableJson(previous.pendingTasks) !== stableJson(current.pendingTasks)) patch.pendingTasks = current.pendingTasks;
  if (stableJson(previous.decisions) !== stableJson(current.decisions)) patch.decisions = current.decisions;
  if (stableJson(previous.risks) !== stableJson(current.risks)) patch.risks = current.risks;
  if (stableJson(previous.relatedFiles) !== stableJson(current.relatedFiles)) patch.relatedFiles = current.relatedFiles;
  return patch;
}

async function contextFromInput(projectRoot: string, input: CheckpointInput, previous?: StructuredContext): Promise<StructuredContext> {
  const relatedFiles = await filterPaths(projectRoot, input.relatedFiles ?? previous?.relatedFiles ?? []);
  return {
    progressSummary: input.progressSummary ?? previous?.progressSummary ?? '',
    lastError: input.lastError === undefined ? previous?.lastError ?? null : input.lastError,
    completed: input.completed ?? previous?.completed ?? [],
    pendingTasks: input.pendingTasks ?? previous?.pendingTasks ?? [],
    decisions: input.decisions ?? previous?.decisions ?? [],
    risks: input.risks ?? previous?.risks ?? [],
    relatedFiles,
  };
}

async function loadContext(projectRoot: string, contextId: string): Promise<ContextMetadata> {
  return readJson<ContextMetadata>(contextMetadataPath(projectRoot, contextId));
}

async function loadSnapshot(projectRoot: string, contextId: string, snapshotId: string): Promise<Snapshot> {
  const snapshot = await readJson<Snapshot>(snapshotPath(projectRoot, contextId, snapshotId));
  if (snapshot.contextId !== contextId || snapshot.schemaVersion !== 1) {
    throw new Error(`invalid snapshot ${snapshotId}`);
  }
  return snapshot;
}

async function rebuildSnapshot(projectRoot: string, contextId: string, snapshotId: string, seen = new Set<string>()): Promise<StructuredContext> {
  if (seen.has(snapshotId)) throw new Error(`snapshot cycle detected at ${snapshotId}`);
  seen.add(snapshotId);
  const snapshot = await loadSnapshot(projectRoot, contextId, snapshotId);
  let content: StructuredContext;
  if (snapshot.mode === 'baseline') {
    if (!snapshot.content || snapshot.parentSnapshotId !== null || snapshot.baseSnapshotId !== snapshot.snapshotId) {
      throw new Error(`invalid baseline snapshot ${snapshotId}`);
    }
    content = snapshot.content;
  } else {
    if (!snapshot.parentSnapshotId || !snapshot.patch) throw new Error(`incomplete patch snapshot ${snapshotId}`);
    const parentSnapshot = await loadSnapshot(projectRoot, contextId, snapshot.parentSnapshotId);
    if (parentSnapshot.baseSnapshotId !== snapshot.baseSnapshotId) throw new Error(`base_snapshot_mismatch for ${snapshotId}`);
    content = applyPatch(await rebuildSnapshot(projectRoot, contextId, snapshot.parentSnapshotId, seen), snapshot.patch);
  }
  if (hash(content) !== snapshot.contentHash || hash(content) !== snapshot.rebuildHash) {
    throw new Error(`snapshot hash mismatch for ${snapshotId}`);
  }
  return content;
}

export async function rebuildIndex(projectRoot: string): Promise<IndexFile> {
  const contexts: IndexFile['contexts'] = [];
  let entries: string[] = [];
  try {
    entries = await (await import('node:fs/promises')).readdir(contextsRoot(projectRoot));
  } catch {
    entries = [];
  }
  for (const contextId of entries) {
    try {
      const context = await loadContext(projectRoot, contextId);
      contexts.push({
        contextId: context.id,
        title: context.title,
        status: context.status,
        branch: context.branch,
        commit: context.commit,
        currentSnapshotId: context.currentSnapshotId,
        updatedAt: context.updatedAt,
      });
    } catch {
      // Doctor reports malformed context metadata; it is not indexed.
    }
  }
  const index = { schemaVersion: 1 as const, rebuiltAt: new Date().toISOString(), contexts };
  await atomicWriteJson(indexPath(projectRoot), index);
  return index;
}

async function updateIndex(projectRoot: string, entry: IndexFile['contexts'][number]): Promise<void> {
  const index = await rebuildIndex(projectRoot);
  const contexts = index.contexts.filter((item) => item.contextId !== entry.contextId);
  contexts.push(entry);
  await atomicWriteJson(indexPath(projectRoot), { schemaVersion: 1, rebuiltAt: new Date().toISOString(), contexts });
}

export async function checkpoint(startPath: string | undefined, input: CheckpointInput, options: CheckpointOptions = {}): Promise<CheckpointResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  await loadManifest(projectRoot);
  const git: GitState = await readGitState(projectRoot);
  const contextId = input.contextId ?? createId('ctx');
  const lockPath = `${locksDirectory(projectRoot)}/checkpoint.lock`;

  return withLock(lockPath, async () => {
    let context: ContextMetadata;
    let previous = emptyContext();
    let previousSnapshot: Snapshot | null = null;
    try {
      context = await loadContext(projectRoot, contextId);
      if (context.currentSnapshotId) {
        previousSnapshot = await loadSnapshot(projectRoot, contextId, context.currentSnapshotId);
        previous = await rebuildSnapshot(projectRoot, contextId, context.currentSnapshotId);
      }
    } catch (error) {
      if (input.contextId || !isNotFound(error)) throw error;
      context = {
        id: contextId,
        schemaVersion: 1,
        title: input.title ?? 'Untitled context',
        projectRoot,
        branch: git.branch,
        commit: git.commit,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastUsedAt: null,
        usageCount: 0,
        status: 'draft',
        currentSnapshotId: null,
        tags: [],
        dependencies: [],
      };
    }

    const content = await contextFromInput(projectRoot, input, previous);
    const patch = diffContext(previous, content);
    if (previousSnapshot && Object.keys(patch).length === 0) return { status: 'no_change', context, snapshot: previousSnapshot };

    const minSaveIntervalMs = options.minSaveIntervalMs ?? 10_000;
    const lastSavedAt = Date.parse(context.updatedAt);
    if (previousSnapshot && Number.isFinite(lastSavedAt) && Date.now() - lastSavedAt < minSaveIntervalMs) {
      return {
        status: 'rate_limited',
        context,
        snapshot: previousSnapshot,
        retryAt: new Date(lastSavedAt + minSaveIntervalMs).toISOString(),
      };
    }

    const now = new Date().toISOString();
    const snapshotId = createId('snap');
    const mode = previousSnapshot ? 'patch' : 'baseline';
    const snapshot: Snapshot = {
      snapshotId,
      schemaVersion: 1,
      contextId,
      parentSnapshotId: previousSnapshot?.snapshotId ?? null,
      baseSnapshotId: previousSnapshot?.baseSnapshotId ?? snapshotId,
      mode,
      createdAt: now,
      branch: git.branch,
      commit: git.commit,
      contentHash: hash(content),
      rebuildHash: hash(content),
      ...(mode === 'baseline' ? { content } : { patch }),
    };

    await mkdir(contextDirectory(projectRoot, contextId), { recursive: true });
    await mkdir(snapshotsDirectory(projectRoot, contextId), { recursive: true });
    await atomicWriteJson(snapshotPath(projectRoot, contextId, snapshotId), snapshot);
    const updatedContext: ContextMetadata = {
      ...context,
      title: input.title ?? context.title,
      branch: git.branch,
      commit: git.commit,
      updatedAt: now,
      lastUsedAt: now,
      usageCount: context.usageCount + 1,
      status: 'active',
      currentSnapshotId: snapshotId,
    };
    await atomicWriteJson(contextMetadataPath(projectRoot, contextId), updatedContext);
    await updateIndex(projectRoot, {
      contextId,
      title: updatedContext.title,
      status: updatedContext.status,
      branch: updatedContext.branch,
      commit: updatedContext.commit,
      currentSnapshotId: snapshotId,
      updatedAt: now,
    });
    return { status: 'saved', context: updatedContext, snapshot };
  });
}

export async function resume(startPath?: string, contextId?: string, maxChars = 4000): Promise<ResumeResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  await loadManifest(projectRoot);
  const git = await readGitState(projectRoot);
  const index = await rebuildIndex(projectRoot);
  const candidates = index.contexts
    .filter((entry) => !contextId || entry.contextId === contextId)
    .filter((entry) => ['active', 'stable'].includes(entry.status))
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || Number(right.branch === git.branch) - Number(left.branch === git.branch) || right.updatedAt.localeCompare(left.updatedAt));
  const candidate = candidates[0];
  if (!candidate) throw new Error('no active context found');
  const context = await loadContext(projectRoot, candidate.contextId);
  if (!context.currentSnapshotId) throw new Error('context has no snapshot');
  const snapshot = await loadSnapshot(projectRoot, candidate.contextId, context.currentSnapshotId);
  const content = await rebuildSnapshot(projectRoot, candidate.contextId, snapshot.snapshotId);
  const drift = context.branch !== git.branch || context.commit !== git.commit;
  context.lastUsedAt = new Date().toISOString();
  await atomicWriteJson(contextMetadataPath(projectRoot, context.id), context);
  const budget = { remaining: Math.max(0, maxChars) };
  const resumeSummary = {
    progressSummary: limited(content.progressSummary, budget.remaining),
    lastError: content.lastError === null ? null : limited(content.lastError, budget.remaining),
    completed: limitedList(content.completed, budget),
    pendingTasks: limitedList(content.pendingTasks, budget),
    decisions: limitedList(content.decisions, budget),
    risks: limitedList(content.risks, budget),
    relatedFiles: limitedList(content.relatedFiles, budget),
    branchOrCommitDrift: drift,
  };
  return { context, snapshot, resumeSummary, details: content };
}
