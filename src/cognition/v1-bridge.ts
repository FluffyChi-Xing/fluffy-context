import crypto from 'node:crypto';
import path from 'node:path';
import { access, readFile, readdir } from 'node:fs/promises';
import { readGitWorktreeState } from '../git/git-adapter.js';
import { cognitionManifestPath, cognitionPolicyPath, cognitionV1SyncPath, contextsRoot, deadendsPath, knowledgePath, notesPath, snapshotsDirectory } from '../storage/layout.js';
import { readJson } from '../storage/json-store.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import type { ContextMetadata, Deadend, Knowledge, Note, Snapshot } from '../runtime/types.js';
import { appendEvent } from './journal.js';
import { rebuildProjections } from './projections.js';
import type { CognitionRuntimePolicy } from './types.js';

function digest(record: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export async function v1Fingerprint(projectRoot: string): Promise<string> {
  const files = [notesPath(projectRoot), knowledgePath(projectRoot), deadendsPath(projectRoot)];
  const contextIds = await readdir(contextsRoot(projectRoot)).catch(() => []);
  const contextFiles = contextIds.map((contextId) => path.join(contextsRoot(projectRoot), contextId, 'context.json'));
  const snapshots = (await Promise.all(contextIds.map(async (contextId) => {
    const directory = snapshotsDirectory(projectRoot, contextId);
    const files = await readdir(directory).catch(() => []);
    return files.filter((file) => file.endsWith('.json')).map((file) => path.join(directory, file));
  }))).flat();
  const contents = await Promise.all([...files, ...contextFiles, ...snapshots].map(async (file) => readFile(file, 'utf8').catch(() => '')));
  return digest(contents);
}

export async function v1Synced(projectRoot: string): Promise<boolean> {
  try {
    const [current, cursor] = await Promise.all([v1Fingerprint(projectRoot), readJson<{ fingerprint: string }>(cognitionV1SyncPath(projectRoot))]);
    return current === cursor.fingerprint;
  } catch {
    return false;
  }
}

async function enabled(projectRoot: string): Promise<boolean> {
  try {
    await access(cognitionManifestPath(projectRoot));
    return (await readJson<CognitionRuntimePolicy>(cognitionPolicyPath(projectRoot))).enabled;
  } catch {
    return false;
  }
}

async function mirror(projectRoot: string, type: 'context.state.recorded' | 'note.recorded' | 'note.absorbed' | 'knowledge.proposed' | 'knowledge.verified' | 'deadend.proposed' | 'deadend.verified', record: Record<string, unknown>, identity: string): Promise<void> {
  if (!await enabled(projectRoot)) return;
  try {
    const state = await readGitWorktreeState(projectRoot);
    const { appended } = await appendEvent(projectRoot, {
      type,
      source: { kind: 'cli' },
      idempotencyKey: `v1-live:${type}:${identity}:${digest(record)}`,
      git: { worktreeId: state.worktreeId, branch: state.branch, ref: state.ref, head: state.commit },
      payload: { record, anchorProvenance: 'live' },
    });
    if (appended) await rebuildProjections(projectRoot);
    await atomicWriteJson(cognitionV1SyncPath(projectRoot), { schemaVersion: 2, fingerprint: await v1Fingerprint(projectRoot), updatedAt: new Date().toISOString() });
  } catch {
    // v1 remains authoritative when v2 mirroring is unavailable.
  }
}

export async function mirrorCheckpoint(projectRoot: string, context: ContextMetadata, snapshot: Snapshot): Promise<void> {
  await mirror(projectRoot, 'context.state.recorded', { context, snapshot }, `${context.id}:${snapshot.snapshotId}`);
}

export async function mirrorNote(projectRoot: string, note: Note, absorbed = false): Promise<void> {
  await mirror(projectRoot, absorbed ? 'note.absorbed' : 'note.recorded', note as unknown as Record<string, unknown>, note.noteId);
}

export async function mirrorKnowledge(projectRoot: string, knowledge: Knowledge): Promise<void> {
  await mirror(projectRoot, knowledge.status === 'verified' ? 'knowledge.verified' : 'knowledge.proposed', knowledge as unknown as Record<string, unknown>, knowledge.knowledgeId);
}

export async function mirrorDeadend(projectRoot: string, deadend: Deadend): Promise<void> {
  await mirror(projectRoot, deadend.status === 'verified' ? 'deadend.verified' : 'deadend.proposed', deadend as unknown as Record<string, unknown>, deadend.deadendId);
}
