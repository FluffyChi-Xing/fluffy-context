export type ContextStatus = 'draft' | 'active' | 'stable' | 'archived' | 'deleted';
export type SnapshotMode = 'baseline' | 'patch';

export interface GitState {
  root: string | null;
  branch: string | null;
  commit: string | null;
}

export interface ContextMetadata {
  id: string;
  schemaVersion: 1;
  title: string;
  projectRoot: string;
  branch: string | null;
  commit: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  usageCount: number;
  status: ContextStatus;
  currentSnapshotId: string | null;
  tags: string[];
  dependencies: string[];
}

export interface StructuredContext {
  progressSummary: string;
  lastError: string | null;
  completed: string[];
  pendingTasks: string[];
  decisions: string[];
  risks: string[];
  relatedFiles: string[];
}

export type ContextPatch = Partial<StructuredContext>;

export interface Snapshot {
  snapshotId: string;
  schemaVersion: 1;
  contextId: string;
  parentSnapshotId: string | null;
  baseSnapshotId: string;
  mode: SnapshotMode;
  createdAt: string;
  branch: string | null;
  commit: string | null;
  contentHash: string;
  rebuildHash: string;
  content?: StructuredContext;
  patch?: ContextPatch;
}

export interface Manifest {
  schemaVersion: 1;
  layoutVersion: 'compact-json-v1';
  projectId: string;
  projectRoot: string;
  initializedAt: string;
}

export interface IndexEntry {
  contextId: string;
  title: string;
  status: ContextStatus;
  branch: string | null;
  commit: string | null;
  currentSnapshotId: string | null;
  updatedAt: string;
}

export interface IndexFile {
  schemaVersion: 1;
  rebuiltAt: string;
  contexts: IndexEntry[];
}

export interface CheckpointInput {
  contextId?: string;
  title?: string;
  progressSummary?: string;
  lastError?: string | null;
  completed?: string[];
  pendingTasks?: string[];
  decisions?: string[];
  risks?: string[];
  relatedFiles?: string[];
}

export type KnowledgeStatus = 'candidate' | 'verified' | 'deprecated' | 'rejected';
export type DeadendStatus = 'candidate' | 'verified' | 'obsolete' | 'rejected';

export interface Knowledge {
  knowledgeId: string;
  kind: string;
  statement: string;
  scope: string;
  confidence: number;
  status: KnowledgeStatus;
  sourceContextIds: string[];
  sourceSnapshotIds: string[];
  supportingEvidence: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Deadend {
  deadendId: string;
  attempt: string;
  reason: string;
  observedEvidence: string[];
  scope: string;
  status: DeadendStatus;
  sourceContextId: string | null;
  sourceSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeFile {
  schemaVersion: 1;
  items: Knowledge[];
}

export interface DeadendFile {
  schemaVersion: 1;
  items: Deadend[];
}

export interface ResumeSummary extends StructuredContext {
  branchOrCommitDrift: boolean;
}

export interface ResumeResult {
  context: ContextMetadata;
  snapshot: Snapshot;
  resumeSummary: ResumeSummary;
  details: StructuredContext;
}
