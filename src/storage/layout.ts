import path from 'node:path';

export function contextRoot(projectRoot: string): string {
  return path.join(projectRoot, '.context');
}

export function manifestPath(projectRoot: string): string {
  return path.join(contextRoot(projectRoot), 'manifest.json');
}

export function indexPath(projectRoot: string): string {
  return path.join(contextRoot(projectRoot), 'index.json');
}

export function ignoredPath(projectRoot: string): string {
  return path.join(projectRoot, '.contextignored');
}

export function contextsRoot(projectRoot: string): string {
  return path.join(contextRoot(projectRoot), 'contexts');
}

export function contextDirectory(projectRoot: string, contextId: string): string {
  return path.join(contextsRoot(projectRoot), contextId);
}

export function contextMetadataPath(projectRoot: string, contextId: string): string {
  return path.join(contextDirectory(projectRoot, contextId), 'context.json');
}

export function snapshotsDirectory(projectRoot: string, contextId: string): string {
  return path.join(contextDirectory(projectRoot, contextId), 'snaps');
}

export function snapshotPath(projectRoot: string, contextId: string, snapshotId: string): string {
  return path.join(snapshotsDirectory(projectRoot, contextId), `${snapshotId}.json`);
}

export function locksDirectory(projectRoot: string): string {
  return path.join(contextRoot(projectRoot), 'locks');
}

export function knowledgePath(projectRoot: string): string {
  return path.join(contextRoot(projectRoot), 'knowledge.json');
}

export function deadendsPath(projectRoot: string): string {
  return path.join(contextRoot(projectRoot), 'deadends.json');
}

export function notesPath(projectRoot: string): string {
  return path.join(contextRoot(projectRoot), 'notes.json');
}
