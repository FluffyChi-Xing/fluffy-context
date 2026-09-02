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

export function cognitionRoot(projectRoot: string): string {
  return path.join(contextRoot(projectRoot), 'v2');
}

export function cognitionManifestPath(projectRoot: string): string {
  return path.join(cognitionRoot(projectRoot), 'manifest.json');
}

export function cognitionPolicyPath(projectRoot: string): string {
  return path.join(cognitionRoot(projectRoot), 'policy.json');
}

export function cognitionJournalDirectory(projectRoot: string): string {
  return path.join(cognitionRoot(projectRoot), 'journal');
}

export function cognitionProjectionsDirectory(projectRoot: string): string {
  return path.join(cognitionRoot(projectRoot), 'projections');
}

export function cognitionProjectionCursorPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'cursor.json');
}

export function cognitionBranchesDirectory(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'branches');
}

export function cognitionContextsProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'contexts.json');
}

export function cognitionKnowledgeProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'knowledge.json');
}

export function cognitionDeadendsProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'deadends.json');
}

export function cognitionNotesProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'notes.json');
}

export function cognitionExperiencesProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'experiences.json');
}

export function cognitionProposalsProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'proposals.json');
}

export function cognitionSkillsProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'skills.json');
}

export function cognitionRecipesProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'recipes.json');
}

export function cognitionEvidenceGraphProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'evidence-graph.json');
}

export function cognitionRetrievalProjectionPath(projectRoot: string): string {
  return path.join(cognitionProjectionsDirectory(projectRoot), 'retrieval.json');
}

export function cognitionMigrationsDirectory(projectRoot: string): string {
  return path.join(cognitionRoot(projectRoot), 'migrations');
}

export function cognitionV1ImportPath(projectRoot: string): string {
  return path.join(cognitionMigrationsDirectory(projectRoot), 'v1-import.json');
}

export function cognitionRuntimeDirectory(projectRoot: string): string {
  return path.join(cognitionRoot(projectRoot), 'runtime');
}

export function cognitionRuntimeLeasePath(projectRoot: string): string {
  return path.join(cognitionRuntimeDirectory(projectRoot), 'lease.json');
}

export function cognitionRuntimeSecretPath(projectRoot: string): string {
  return path.join(cognitionRuntimeDirectory(projectRoot), 'secret');
}

export function cognitionRuntimeStartupPath(projectRoot: string): string {
  return path.join(cognitionRuntimeDirectory(projectRoot), 'startup.json');
}

export function cognitionV1SyncPath(projectRoot: string): string {
  return path.join(cognitionRuntimeDirectory(projectRoot), 'v1-sync.json');
}

export function cognitionQuarantineDirectory(projectRoot: string): string {
  return path.join(cognitionRoot(projectRoot), 'quarantine');
}
