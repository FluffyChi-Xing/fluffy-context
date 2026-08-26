import crypto from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { loadManifest } from '../runtime/init.js';
import { listDeadends, listKnowledge } from '../runtime/knowledge.js';
import { listNotes } from '../runtime/notes.js';
import { rebuildSnapshot } from '../runtime/runtime.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { withLock } from '../storage/lock.js';
import {
  cognitionManifestPath,
  cognitionPolicyPath,
  cognitionQuarantineDirectory,
  cognitionV1ImportPath,
  cognitionV1SyncPath,
  contextMetadataPath,
  contextsRoot,
  locksDirectory,
  manifestPath,
  snapshotPath,
  snapshotsDirectory,
} from '../storage/layout.js';
import { readJson } from '../storage/json-store.js';
import type { ContextMetadata, Snapshot } from '../runtime/types.js';
import { appendEvent } from './journal.js';
import { rebuildProjections } from './projections.js';
import { v1Fingerprint } from './v1-bridge.js';
import { migrationReadiness } from './readiness.js';
import { COGNITION_LAYOUT_VERSION, type CognitionManifest, type CognitionRuntimePolicy, type MigrationReport, type V1ImportReceipt } from './types.js';

interface V1Record {
  kind: 'context' | 'note' | 'knowledge' | 'deadend';
  id: string;
  occurredAt: string;
  git: { branch: string | null; head: string | null };
  record: Record<string, unknown>;
  sourcePath: string;
  sourceHash: string;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function eventType(record: V1Record, live = false): import('./types.js').CognitionEventType {
  const status = record.record.status;
  if (record.kind === 'context') return live ? 'context.state.recorded' : 'context.checkpoint.imported';
  if (record.kind === 'note') return record.record.absorbedBySnapshotId ? 'note.absorbed' : record.record.status === 'resolved' ? 'note.resolved' : 'note.recorded';
  if (record.kind === 'knowledge') return status === 'verified' ? 'knowledge.verified' : status === 'deprecated' ? 'knowledge.deprecated' : status === 'rejected' ? 'knowledge.rejected' : 'knowledge.proposed';
  return status === 'verified' ? 'deadend.verified' : status === 'obsolete' ? 'deadend.obsoleted' : status === 'rejected' ? 'deadend.rejected' : 'deadend.proposed';
}

async function readOptional(filePath: string): Promise<string | null> {
  try { return await readFile(filePath, 'utf8'); } catch (error) { if (isNotFound(error)) return null; throw error; }
}

async function sourceRecords(projectRoot: string): Promise<{ records: V1Record[]; sourceHash: string }> {
  const sources: Array<{ filePath: string; content: string }> = [];
  const records: V1Record[] = [];
  const snapshotAnchors = new Map<string, V1Record['git']>();
  const v1ManifestPath = manifestPath(projectRoot);
  sources.push({ filePath: v1ManifestPath, content: await readFile(v1ManifestPath, 'utf8') });
  const contextIds = (await readdir(contextsRoot(projectRoot))).sort();
  for (const contextId of contextIds) {
    const contextFile = contextMetadataPath(projectRoot, contextId);
    const contextContent = await readFile(contextFile, 'utf8');
    sources.push({ filePath: contextFile, content: contextContent });
    const context = await readJson<ContextMetadata>(contextFile);
    const snapshots = (await readdir(snapshotsDirectory(projectRoot, contextId))).filter((file) => file.endsWith('.json')).sort();
    for (const file of snapshots) {
      const snapshotId = file.slice(0, -'.json'.length);
      const filePath = snapshotPath(projectRoot, contextId, snapshotId);
      const content = await readFile(filePath, 'utf8');
      sources.push({ filePath, content });
      const snapshot = await readJson<Snapshot>(filePath);
      await rebuildSnapshot(projectRoot, contextId, snapshotId);
      const git = { branch: snapshot.branch, head: snapshot.commit };
      snapshotAnchors.set(`${contextId}:${snapshotId}`, git);
      records.push({
        kind: 'context',
        id: `${contextId}:${snapshotId}`,
        occurredAt: snapshot.createdAt,
        git,
        record: { context, snapshot },
        sourcePath: filePath,
        sourceHash: sha256(content),
      });
    }
  }
  const noteFile = path.join(projectRoot, '.context', 'notes.json');
  const knowledgeFile = path.join(projectRoot, '.context', 'knowledge.json');
  const deadendFile = path.join(projectRoot, '.context', 'deadends.json');
  for (const [kind, filePath] of [['note', noteFile], ['knowledge', knowledgeFile], ['deadend', deadendFile]] as const) {
    const content = await readOptional(filePath);
    if (content === null) continue;
    sources.push({ filePath, content });
    const sourceHash = sha256(content);
    const items = kind === 'note' ? await listNotes(projectRoot, { limit: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER })
      : kind === 'knowledge' ? await listKnowledge(projectRoot, true)
        : await listDeadends(projectRoot, true);
    for (const item of items) {
      const record = item as unknown as Record<string, unknown>;
      const id = typeof record.noteId === 'string' ? record.noteId : typeof record.knowledgeId === 'string' ? record.knowledgeId : record.deadendId as string;
      const occurredAt = item.createdAt;
      const contextId = 'contextId' in item ? item.contextId : 'sourceContextId' in item ? item.sourceContextId : null;
      const snapshotId = 'snapshotId' in item ? item.snapshotId : 'sourceSnapshotId' in item ? item.sourceSnapshotId : null;
      if (snapshotId && !contextId) throw new Error(`${kind} ${id} has a snapshot without a context`);
      if (contextId && snapshotId) await rebuildSnapshot(projectRoot, contextId, snapshotId);
      records.push({ kind, id, occurredAt, git: contextId && snapshotId ? snapshotAnchors.get(`${contextId}:${snapshotId}`) ?? { branch: null, head: null } : { branch: null, head: null }, record: item as unknown as Record<string, unknown>, sourcePath: filePath, sourceHash });
    }
  }
  const sourceHash = sha256(sources.sort((left, right) => left.filePath.localeCompare(right.filePath)).map((source) => `${source.filePath}\0${sha256(source.content)}`).join('\n'));
  return { records: records.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)), sourceHash };
}

async function writeV2Metadata(projectRoot: string): Promise<void> {
  const v1 = await loadManifest(projectRoot);
  const manifest: CognitionManifest = { schemaVersion: 2, layoutVersion: COGNITION_LAYOUT_VERSION, projectId: v1.projectId, createdAt: new Date().toISOString(), policyVersion: 1 };
  const policy: CognitionRuntimePolicy = { schemaVersion: 2, enabled: true, autoStart: true, allowHookStartup: true, inactivityTimeoutMs: 300_000, promptIntentMaxChars: 500, filesystemEventsEnabled: false, retentionMaxBytes: 64 * 1024 * 1024 };
  await Promise.all([atomicWriteJson(cognitionManifestPath(projectRoot), manifest), atomicWriteJson(cognitionPolicyPath(projectRoot), policy)]);
}

async function quarantineReadiness(projectRoot: string, readiness: MigrationReport): Promise<void> {
  await mkdir(cognitionQuarantineDirectory(projectRoot), { recursive: true });
  await atomicWriteJson(path.join(cognitionQuarantineDirectory(projectRoot), 'v1-readiness.json'), {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    eligible: readiness.eligible,
    issues: readiness.issues,
  });
}

export async function importV1(startPath?: string): Promise<MigrationReport> {
  const projectRoot = await resolveProjectRoot(startPath);
  return withLock(`${locksDirectory(projectRoot)}/cognition-migration.lock`, async () => {
    const readiness = await migrationReadiness(projectRoot);
    if (!readiness.eligible) {
      const report = { ...readiness, applied: false, importedEventIds: [] };
      await quarantineReadiness(projectRoot, report);
      return report;
    }
    const { records, sourceHash } = await sourceRecords(projectRoot);
    const existingReceipt = await readOptional(cognitionV1ImportPath(projectRoot));
    if (existingReceipt) {
      const receipt = JSON.parse(existingReceipt) as V1ImportReceipt;
      if (receipt.schemaVersion !== 2 || receipt.sourceHash !== sourceHash) throw new Error('v1 source changed after import; v2 historical import is immutable');
      await rebuildProjections(projectRoot);
      await atomicWriteJson(cognitionV1SyncPath(projectRoot), { schemaVersion: 2, fingerprint: await v1Fingerprint(projectRoot), updatedAt: new Date().toISOString() });
      return { ...readiness, applied: true, importedEventIds: receipt.eventIds };
    }
    await writeV2Metadata(projectRoot);
    const importedEventIds: string[] = [];
    for (const record of records) {
    const event = await appendEvent(projectRoot, {
      type: eventType(record),
      occurredAt: record.occurredAt,
      source: { kind: 'migration' },
      idempotencyKey: `v1:${record.sourceHash}:${record.kind}:${record.id}`,
      git: { worktreeId: null, branch: record.git.branch, ref: record.git.branch, head: record.git.head },
      payload: { record: record.record, sourcePath: record.sourcePath, sourceHash: record.sourceHash, anchorProvenance: record.git.branch === null && record.git.head === null ? 'global' : 'snapshot' },
    });
    importedEventIds.push(event.event.eventId);
    }
    await rebuildProjections(projectRoot);
    await atomicWriteJson(cognitionV1SyncPath(projectRoot), { schemaVersion: 2, fingerprint: await v1Fingerprint(projectRoot), updatedAt: new Date().toISOString() });
    const receipt: V1ImportReceipt = { schemaVersion: 2, sourceHash, importedAt: new Date().toISOString(), eventIds: importedEventIds, counts: readiness.counts };
    await atomicWriteJson(cognitionV1ImportPath(projectRoot), receipt);
    return { ...readiness, v2Present: true, applied: true, importedEventIds };
  });
}

export async function reconcileV1State(startPath?: string): Promise<void> {
  const projectRoot = await resolveProjectRoot(startPath);
  await withLock(`${locksDirectory(projectRoot)}/cognition-migration.lock`, async () => {
    const readiness = await migrationReadiness(projectRoot);
    if (!readiness.eligible) return;
    const { records, sourceHash } = await sourceRecords(projectRoot);
    for (const record of records) {
      await appendEvent(projectRoot, {
        type: eventType(record, true),
        occurredAt: record.occurredAt,
        source: { kind: 'migration' },
        idempotencyKey: `v1-live-sync:${sourceHash}:${record.kind}:${record.id}`,
        git: { worktreeId: null, branch: record.git.branch, ref: record.git.branch, head: record.git.head },
        payload: { record: record.record, sourcePath: record.sourcePath, sourceHash: record.sourceHash, anchorProvenance: record.git.branch === null && record.git.head === null ? 'global' : 'snapshot' },
      });
    }
    await rebuildProjections(projectRoot);
    await atomicWriteJson(cognitionV1SyncPath(projectRoot), { schemaVersion: 2, fingerprint: await v1Fingerprint(projectRoot), updatedAt: new Date().toISOString() });
  });
}

export async function verifyV1Import(startPath?: string): Promise<{ verified: boolean; issues: string[] }> {
  const projectRoot = await resolveProjectRoot(startPath);
  try {
    const readiness = await migrationReadiness(projectRoot);
    if (!readiness.eligible) return { verified: false, issues: readiness.issues };
    const receipt = JSON.parse(await readFile(cognitionV1ImportPath(projectRoot), 'utf8')) as V1ImportReceipt;
    const { sourceHash } = await sourceRecords(projectRoot);
    if (receipt.sourceHash !== sourceHash) return { verified: false, issues: ['v1 source changed after import'] };
    const { projection, cursor } = await rebuildProjections(projectRoot);
    const actual = { contexts: Object.keys(projection.contexts).length, notes: Object.keys(projection.notes).length, knowledge: Object.keys(projection.knowledge).length, deadends: Object.keys(projection.deadends).length };
    const expected = { contexts: readiness.counts.snapshots, notes: readiness.counts.notes, knowledge: readiness.counts.knowledge, deadends: readiness.counts.deadends };
    const issues = Object.entries(expected).flatMap(([key, count]) => actual[key as keyof typeof actual] === count ? [] : [`${key} projection count mismatch`]);
    if (!cursor.lastEventId && receipt.eventIds.length > 0) issues.push('projection cursor is missing');
    return { verified: issues.length === 0, issues };
  } catch (error) {
    return { verified: false, issues: [error instanceof Error ? error.message : 'invalid v1 import'] };
  }
}
