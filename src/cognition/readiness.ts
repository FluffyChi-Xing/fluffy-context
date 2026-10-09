import { access, readdir } from 'node:fs/promises';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { contextMetadataPath, contextsRoot, cognitionManifestPath, manifestPath, snapshotPath, snapshotsDirectory } from '../storage/layout.js';
import { readJson } from '../storage/json-store.js';
import { listDeadends, listKnowledge } from '../runtime/knowledge.js';
import { listNotes } from '../runtime/notes.js';
import { rebuildSnapshot } from '../runtime/runtime.js';
import type { ContextMetadata, Manifest } from '../runtime/types.js';
import type { MigrationReadiness } from './types.js';
import type { ProgressReporter } from './progress.js';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function migrationReadiness(startPath?: string, onProgress?: ProgressReporter): Promise<MigrationReadiness> {
  const projectRoot = await resolveProjectRoot(startPath);
  const counts = { contexts: 0, snapshots: 0, notes: 0, knowledge: 0, deadends: 0 };
  const issues: string[] = [];
  const v1Present = await exists(manifestPath(projectRoot));
  const v2Present = await exists(cognitionManifestPath(projectRoot));

  if (!v1Present) {
    issues.push('v1 manifest is missing');
    return { projectRoot, eligible: false, v1Present, v2Present, counts, issues };
  }

  try {
    const manifest = await readJson<Manifest>(manifestPath(projectRoot));
    if (manifest.schemaVersion !== 1 || manifest.layoutVersion !== 'compact-json-v1' || manifest.projectRoot !== projectRoot) {
      issues.push('v1 manifest is invalid');
    }
  } catch (error) {
    issues.push(`v1 manifest: ${error instanceof Error ? error.message : 'invalid'}`);
  }

  let contextIds: string[] = [];
  try {
    contextIds = await readdir(contextsRoot(projectRoot));
  } catch (error) {
    issues.push(`v1 contexts: ${error instanceof Error ? error.message : 'unavailable'}`);
  }

  onProgress?.({ phase: 'inspect-contexts', completed: 0, total: contextIds.length, unit: 'contexts' });
  for (const [index, contextId] of contextIds.entries()) {
    try {
      const context = await readJson<ContextMetadata>(contextMetadataPath(projectRoot, contextId));
      if (context.schemaVersion !== 1 || context.id !== contextId || context.projectRoot !== projectRoot) {
        throw new Error('invalid context metadata');
      }
      counts.contexts += 1;
      const snapshots = (await readdir(snapshotsDirectory(projectRoot, contextId))).filter((entry) => entry.endsWith('.json'));
      counts.snapshots += snapshots.length;
      for (const snapshotFile of snapshots) {
        const snapshotId = snapshotFile.slice(0, -'.json'.length);
        await readJson(snapshotPath(projectRoot, contextId, snapshotId));
        await rebuildSnapshot(projectRoot, contextId, snapshotId);
      }
    } catch (error) {
      issues.push(`context ${contextId}: ${error instanceof Error ? error.message : 'invalid'}`);
    }
    onProgress?.({ phase: 'inspect-contexts', completed: index + 1, total: contextIds.length, unit: 'contexts' });
  }

  try {
    counts.notes = (await listNotes(projectRoot, { limit: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER })).length;
  } catch (error) {
    issues.push(`notes: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  try {
    counts.knowledge = (await listKnowledge(projectRoot, true)).length;
  } catch (error) {
    issues.push(`knowledge: ${error instanceof Error ? error.message : 'invalid'}`);
  }
  try {
    counts.deadends = (await listDeadends(projectRoot, true)).length;
  } catch (error) {
    issues.push(`deadends: ${error instanceof Error ? error.message : 'invalid'}`);
  }

  return { projectRoot, eligible: issues.length === 0, v1Present, v2Present, counts, issues };
}
