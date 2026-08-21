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
  absorbNotes?: boolean;
  title?: string;
  progressSummary?: string;
  lastError?: string | null;
  completed?: string[];
  pendingTasks?: string[];
  decisions?: string[];
  risks?: string[];
  relatedFiles?: string[];
}

export type NoteKind = 'problem' | 'action' | 'observation' | 'decision';
export type NoteStatus = 'open' | 'resolved';
export type NoteActor = 'agent' | 'human';

export interface Note {
  noteId: string;
  schemaVersion: 1;
  kind: NoteKind;
  message: string;
  actor: NoteActor;
  contextId: string | null;
  snapshotId: string | null;
  relatedFiles: string[];
  status: NoteStatus;
  absorbedBySnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteInput {
  kind?: NoteKind;
  actor?: NoteActor;
  contextId?: string;
  snapshotId?: string;
  relatedFiles?: string[];
  status?: NoteStatus;
}

export interface NoteFile {
  schemaVersion: 1;
  items: Note[];
}

export interface NoteQuery {
  contextId?: string;
  openOnly?: boolean;
  limit?: number;
  maxChars?: number;
}

export interface ActivityItem {
  type: 'note' | 'checkpoint';
  occurredAt: string;
  contextId: string;
  snapshotId?: string;
  noteId?: string;
  kind?: NoteKind;
  message?: string;
  actor?: NoteActor;
  status?: NoteStatus;
  absorbedBySnapshotId?: string | null;
  title?: string;
}

export interface ActivityQuery extends NoteQuery {
  since?: string;
}

export interface ActivityResult {
  projectRoot: string;
  items: ActivityItem[];
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

export interface KnowledgeInput {
  kind?: string;
  scope?: string;
  sourceContextId?: string;
  sourceSnapshotId?: string;
  evidence?: string[];
}

export interface KnowledgeDiscoverOptions {
  scope?: string;
  statuses?: KnowledgeStatus[];
  limit?: number;
  maxChars?: number;
}

export interface KnowledgeDiscoveryHit {
  knowledge: Knowledge;
  score: number;
  matchedTerms: string[];
  matchedFields: string[];
  why: string[];
}

export interface KnowledgeConflictGroup {
  scope: string;
  knowledgeIds: string[];
  statements: string[];
}

export interface KnowledgeDiscoveryResult {
  query: string;
  total: number;
  truncated: boolean;
  hits: KnowledgeDiscoveryHit[];
  duplicateIds: string[][];
  possibleConflicts: KnowledgeConflictGroup[];
}

export interface DeadendDiscoverOptions {
  scope?: string;
  statuses?: DeadendStatus[];
  limit?: number;
  maxChars?: number;
}

export interface DeadendDiscoveryHit {
  deadend: Deadend;
  score: number;
  matchedTerms: string[];
  matchedFields: string[];
}

export interface DeadendDiscoveryResult {
  query: string;
  total: number;
  truncated: boolean;
  hits: DeadendDiscoveryHit[];
}

export interface DeadendInput {
  scope?: string;
  sourceContextId?: string;
  sourceSnapshotId?: string;
  evidence?: string[];
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

export interface AgentLoadOptions {
  contextId?: string;
  maxChars?: number;
  includeDetails?: boolean;
  query?: string;
  scope?: string;
}

export interface AgentLoadResult {
  projectRoot: string;
  context: ContextMetadata;
  snapshot: Snapshot;
  resumeSummary: ResumeSummary;
  details?: StructuredContext;
  knowledge: KnowledgeDiscoveryResult | null;
  verifiedDeadendIds: string[];
}

export interface AgentSaveResult {
  projectRoot: string;
  result: CheckpointResult;
}

export interface ContextSearchOptions {
  contextId?: string;
  scope?: string;
  limit?: number;
  maxChars?: number;
}

export interface ContextSearchHit {
  context: ContextMetadata;
  snapshotId: string;
  score: number;
  matchedTerms: string[];
  matchedFields: string[];
  summary: ResumeSummary;
}

export interface ContextSearchResult {
  projectRoot: string;
  query: string;
  total: number;
  truncated: boolean;
  hits: ContextSearchHit[];
  knowledge: KnowledgeDiscoveryResult;
  verifiedDeadendIds: string[];
}

export type CheckpointResult =
  | { status: 'saved'; context: ContextMetadata; snapshot: Snapshot }
  | { status: 'no_change'; context: ContextMetadata; snapshot: Snapshot }
  | { status: 'rate_limited'; context: ContextMetadata; snapshot: Snapshot; retryAt: string };
