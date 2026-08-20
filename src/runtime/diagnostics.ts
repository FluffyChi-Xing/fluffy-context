import { access } from 'node:fs/promises';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { readJson } from '../storage/json-store.js';
import { contextRoot, indexPath, manifestPath } from '../storage/layout.js';
import type { IndexFile, Manifest } from './types.js';

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
  try {
    const manifest = await readJson<Manifest>(manifestPath(projectRoot));
    if (manifest.layoutVersion !== 'compact-json-v1') {
      checks.push('unsupported layout version');
    } else {
      checks.push('manifest');
    }
    await access(contextRoot(projectRoot));
    checks.push('context directory');
    await readJson<IndexFile>(indexPath(projectRoot));
    checks.push('index');
  } catch (error) {
    checks.push(error instanceof Error ? error.message : 'diagnostic failed');
  }
  return { healthy: checks.length === 3, projectRoot, checks };
}
