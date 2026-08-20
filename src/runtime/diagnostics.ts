import { access, readdir } from 'node:fs/promises';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { readJson } from '../storage/json-store.js';
import { contextRoot, contextMetadataPath, contextsRoot, indexPath, manifestPath, snapshotPath } from '../storage/layout.js';
import { rebuildIndex } from './runtime.js';
import type { ContextMetadata, IndexFile, Manifest } from './types.js';

export async function status(startPath?: string): Promise<Record<string, unknown>> {
  const projectRoot = await resolveProjectRoot(startPath);
  try {
    const manifest = await readJson<Manifest>(manifestPath(projectRoot));
    const index = await readJson<IndexFile>(indexPath(projectRoot));
    return {
      initialized: true,
      projectRoot,
      layoutVersion: manifest.layoutVersion,
      contextCount: index.contexts.length,
      contexts: index.contexts,
    };
  } catch {
    return { initialized: false, projectRoot };
  }
}

export async function doctor(startPath?: string): Promise<{ healthy: boolean; projectRoot: string; checks: string[] }> {
  const projectRoot = await resolveProjectRoot(startPath);
  const checks: string[] = [];
  let healthy = true;
  const check = async (name: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
      checks.push(`${name}: ok`);
    } catch (error) {
      healthy = false;
      checks.push(`${name}: ${error instanceof Error ? error.message : 'failed'}`);
    }
  };

  await check('manifest', async () => {
    const manifest = await readJson<Manifest>(manifestPath(projectRoot));
    if (manifest.schemaVersion !== 1 || manifest.layoutVersion !== 'compact-json-v1' || manifest.projectRoot !== projectRoot) {
      throw new Error('invalid manifest');
    }
  });
  await check('context directory', () => access(contextRoot(projectRoot)));
  await check('index', async () => {
    const index = await readJson<IndexFile>(indexPath(projectRoot));
    if (index.schemaVersion !== 1 || !Array.isArray(index.contexts)) throw new Error('invalid index');
  });
  await check('contexts', async () => {
    const entries = await readdir(contextsRoot(projectRoot));
    for (const contextId of entries) {
      const context = await readJson<ContextMetadata>(contextMetadataPath(projectRoot, contextId));
      if (context.id !== contextId || context.schemaVersion !== 1) throw new Error(`invalid context ${contextId}`);
      if (context.currentSnapshotId) await access(snapshotPath(projectRoot, contextId, context.currentSnapshotId));
    }
  });
  await check('index rebuild', async () => {
    const stored = await readJson<IndexFile>(indexPath(projectRoot));
    const rebuilt = await rebuildIndex(projectRoot);
    const rebuiltIds = new Set(rebuilt.contexts.map((entry) => entry.contextId));
    const storedIds = new Set(stored.contexts.map((entry) => entry.contextId));
    if (rebuiltIds.size !== rebuilt.contexts.length || storedIds.size !== stored.contexts.length) throw new Error('duplicate index context id');
    if (rebuiltIds.size !== storedIds.size || [...rebuiltIds].some((id) => !storedIds.has(id))) throw new Error('index rebuild mismatch');
  });

  return { healthy, projectRoot, checks };
}
