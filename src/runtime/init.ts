import { mkdir, access, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { readJson } from '../storage/json-store.js';
import {
  contextRoot,
  ignoredPath,
  indexPath,
  locksDirectory,
  manifestPath,
  contextsRoot,
} from '../storage/layout.js';
import type { IndexFile, Manifest } from './types.js';

export interface InitResult {
  projectRoot: string;
  alreadyInitialized: boolean;
}

const ignoredTemplate = `# Context Runtime project rules\n# Add paths that must never enter context collection.\n\n# Build output\ndist/\nbuild/\ncoverage/\n\n# Local secrets\n.env\n.env.*\n`;

export async function initProject(startPath?: string): Promise<InitResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  const manifestFile = manifestPath(projectRoot);
  const requiredPaths = [manifestFile, indexPath(projectRoot), contextsRoot(projectRoot), locksDirectory(projectRoot)];

  let present = 0;
  for (const requiredPath of requiredPaths) {
    try {
      await access(requiredPath);
      present += 1;
    } catch {
      // Missing path is handled below.
    }
  }
  if (present === requiredPaths.length) return { projectRoot, alreadyInitialized: true };
  if (present > 0) throw new Error('context layout is incomplete; run ctx doctor before repairing it');

  await mkdir(contextsRoot(projectRoot), { recursive: true });
  await mkdir(locksDirectory(projectRoot), { recursive: true });
  const manifest: Manifest = {
    schemaVersion: 1,
    layoutVersion: 'compact-json-v1',
    projectId: crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 16),
    projectRoot,
    initializedAt: new Date().toISOString(),
  };
  await atomicWriteJson(manifestFile, manifest);
  await atomicWriteJson(indexPath(projectRoot), { schemaVersion: 1, rebuiltAt: new Date().toISOString(), contexts: [] } satisfies IndexFile);

  try {
    await access(ignoredPath(projectRoot));
  } catch {
    await writeFile(ignoredPath(projectRoot), ignoredTemplate, 'utf8');
  }

  return { projectRoot, alreadyInitialized: false };
}

export async function loadManifest(projectRoot: string): Promise<Manifest> {
  return readJson<Manifest>(manifestPath(projectRoot));
}
