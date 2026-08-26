export const COGNITION_LAYOUT_VERSION = 'event-journal-v2' as const;

export type CognitionEventSource = 'cli' | 'claude-hook' | 'mcp' | 'git-observer' | 'fs-observer' | 'migration';
export type CognitionEventType =
  | 'runtime.enabled'
  | 'runtime.started'
  | 'runtime.stopped'
  | 'host.session.started'
  | 'host.prompt.submitted'
  | 'git.state.observed'
  | 'git.branch.changed'
  | 'git.head.changed'
  | 'workspace.paths.changed'
  | 'context.checkpoint.imported'
  | 'context.state.recorded'
  | 'note.recorded'
  | 'note.resolved'
  | 'note.absorbed'
  | 'knowledge.proposed'
  | 'knowledge.verified'
  | 'knowledge.deprecated'
  | 'knowledge.rejected'
  | 'deadend.proposed'
  | 'deadend.verified'
  | 'deadend.obsoleted'
  | 'deadend.rejected'
  | 'record.used'
  | 'projection.advanced'
  | 'projection.failed';

export interface CognitionGitAnchor {
  worktreeId: string | null;
  branch: string | null;
  ref: string | null;
  head: string | null;
}

export interface CognitionEvent<T = Record<string, unknown>> {
  eventId: string;
  schemaVersion: 2;
  type: CognitionEventType;
  occurredAt: string;
  observedAt: string;
  projectId: string;
  source: { kind: CognitionEventSource; instanceId?: string };
  correlationId?: string;
  idempotencyKey: string;
  git: CognitionGitAnchor;
  privacy: { classification: 'metadata' | 'redacted-text'; redactionCount: number };
  payload: T;
  previousHash: string | null;
  hash: string;
}

export interface CognitionRuntimePolicy {
  schemaVersion: 2;
  enabled: boolean;
  autoStart: boolean;
  allowHookStartup: boolean;
  inactivityTimeoutMs: number;
  promptIntentMaxChars: number;
  filesystemEventsEnabled: boolean;
  retentionMaxBytes: number;
}

export interface CognitionManifest {
  schemaVersion: 2;
  layoutVersion: typeof COGNITION_LAYOUT_VERSION;
  projectId: string;
  createdAt: string;
  policyVersion: 1;
}

export interface Applicability {
  project: true;
  branches?: string[];
  branchMode: 'global' | 'exact' | 'ancestor-of-source' | 'descendant-of-source';
  paths?: string[];
  sourceCommit?: string | null;
  dependencyConstraints?: string[];
}

export interface CognitionLifecycleTransition {
  entity: 'knowledge' | 'deadend';
  entityId: string;
  from: 'candidate' | 'verified';
  to: 'verified' | 'deprecated' | 'rejected' | 'obsolete';
  reason?: string;
}

export interface CognitionUseFeedback {
  feedbackId: string;
  entity: 'knowledge' | 'deadend';
  entityId: string;
  outcome: 'used';
}

export interface CognitionRetrievalEntry {
  entity: 'knowledge' | 'deadend';
  entityId: string;
  status: string;
  record: Record<string, unknown>;
  applicability: Applicability;
  searchable: Record<string, string>;
  normalizedTerms: string[];
  provenance: {
    eventId: string;
    eventType: CognitionEventType;
    occurredAt: string;
    git: CognitionGitAnchor;
    anchorProvenance?: CognitionRecordPayload['anchorProvenance'];
  };
  feedback: {
    usedCount: number;
    latestUsedAt: string | null;
  };
}

export interface CognitionRetrievalProjection {
  schemaVersion: 2;
  entries: Record<string, CognitionRetrievalEntry>;
  terms: Record<string, string[]>;
}

export interface BranchWorkspace {
  schemaVersion: 2;
  workspaceKey: string;
  worktreeId: string | null;
  branch: string | null;
  ref: string | null;
  head: string | null;
  activeContextRef: string | null;
  openObservationEventIds: string[];
  pathFocus: string[];
  recentEventIds: string[];
  lastActivatedAt: string;
}

export interface ProjectionCursor {
  schemaVersion: 2;
  lastEventId: string | null;
  lastEventHash: string | null;
  updatedAt: string | null;
}

export interface MigrationReadiness {
  projectRoot: string;
  eligible: boolean;
  v1Present: boolean;
  v2Present: boolean;
  counts: { contexts: number; snapshots: number; notes: number; knowledge: number; deadends: number };
  issues: string[];
}

export interface V1ImportReceipt {
  schemaVersion: 2;
  sourceHash: string;
  importedAt: string;
  eventIds: string[];
  counts: MigrationReadiness['counts'];
}

export interface MigrationReport extends MigrationReadiness {
  applied: boolean;
  importedEventIds: string[];
}

export interface CognitionRecordPayload<T extends Record<string, unknown> = Record<string, unknown>> {
  record: T;
  sourcePath?: string;
  sourceHash?: string;
  anchorProvenance?: 'snapshot' | 'live' | 'global';
}

export interface WorkspacePathChange {
  path: string;
  kind: 'created' | 'modified' | 'deleted' | 'renamed' | 'unknown';
  fileType: 'file';
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface WorkspacePathsChangedPayload {
  schemaVersion: 1;
  paths: string[];
  changes: WorkspacePathChange[];
  pathCount: number;
  coalesced: boolean;
  truncated: boolean;
}

export interface CognitionProjection {
  schemaVersion: 2;
  contexts: Record<string, CognitionRecordPayload>;
  notes: Record<string, CognitionRecordPayload>;
  knowledge: Record<string, CognitionRecordPayload>;
  deadends: Record<string, CognitionRecordPayload>;
  workspaces: Record<string, BranchWorkspace>;
}

export interface RuntimeLease {
  schemaVersion: 2;
  protocolVersion: 1;
  projectId: string;
  instanceId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface RuntimeStatus {
  projectRoot: string;
  v2Present: boolean;
  enabled: boolean;
  migrated: boolean;
  running: boolean;
  lease: Omit<RuntimeLease, 'projectId'> | null;
}
