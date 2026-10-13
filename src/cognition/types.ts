export const COGNITION_LAYOUT_VERSION = 'event-journal-v2' as const;

export type CognitionEventSource = 'cli' | 'claude-hook' | 'mcp' | 'agent' | 'git-observer' | 'fs-observer' | 'migration';
export type CognitionEventType =
  | 'runtime.enabled'
  | 'runtime.started'
  | 'runtime.stopped'
  | 'host.session.started'
  | 'host.prompt.submitted'
  | 'host.capability.declared'
  | 'host.trigger.observed'
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
  | 'experience.recorded'
  | 'evolution.proposed'
  | 'evolution.candidate.accepted'
  | 'evolution.verified'
  | 'evolution.published'
  | 'evolution.rejected'
  | 'evolution.deprecated'
  | 'evolution.superseded'
  | 'skill.materialized'
  | 'recipe.materialized'
  | 'skill.invoked'
  | 'skill.outcome.recorded'
  | 'record.used'
  | 'usage.operation.completed'
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

export type EvolutionArtifactKind = 'knowledge' | 'deadend' | 'skill' | 'compiler-recipe';
export type EvolutionArtifactStatus = 'candidate' | 'verified' | 'published' | 'rejected' | 'deprecated' | 'superseded' | 'obsolete';
export type EvolutionLineageRelation = 'derived_from' | 'supports' | 'contradicts' | 'supersedes' | 'validated_by' | 'used_for';

export interface EvolutionEvidenceReference {
  eventId: string;
  relation: Extract<EvolutionLineageRelation, 'derived_from' | 'supports' | 'contradicts' | 'validated_by'>;
}

export interface EvolutionLineageReference {
  entity: EvolutionArtifactKind | 'experience' | 'proposal';
  entityId: string;
  relation: Extract<EvolutionLineageRelation, 'supports' | 'contradicts' | 'supersedes' | 'used_for'>;
}

export interface Experience {
  experienceId: string;
  schemaVersion: 1;
  sourceEventIds: string[];
  sourceContextIds: string[];
  sourceSnapshotIds: string[];
  paths: string[];
  git: CognitionGitAnchor;
  privacy: { classification: 'metadata' | 'redacted-text'; redactionCount: number };
  extractor: { id: string; version: string };
  contentHash: string;
  summary: string;
  createdAt: string;
}

export interface EvolutionProposal {
  proposalId: string;
  schemaVersion: 1;
  targetKind: EvolutionArtifactKind;
  targetId: string;
  status: 'candidate';
  sourceExperienceIds: string[];
  evidence: EvolutionEvidenceReference[];
  lineage: EvolutionLineageReference[];
  applicability: Applicability;
  contentHash: string;
  summary: string;
  extractor: { id: string; version: string };
  createdAt: string;
}

export interface EvolutionCandidateArtifact {
  artifactId: string;
  schemaVersion: 1;
  proposalId: string;
  kind: Extract<EvolutionArtifactKind, 'skill' | 'compiler-recipe'>;
  status: 'candidate';
  applicability: Applicability;
  contentHash: string;
  lineage: EvolutionLineageReference[];
  rationale: string;
  createdAt: string;
}

export interface EvolutionProposalLifecycleEntry {
  eventId: string;
  occurredAt: string;
  from: EvolutionArtifactStatus;
  to: EvolutionArtifactStatus;
  reason: string;
  supersedes?: EvolutionLineageReference;
}

export interface EvolutionProposalState {
  proposal: EvolutionProposal;
  status: EvolutionArtifactStatus;
  lifecycle: EvolutionProposalLifecycleEntry[];
  acceptedArtifact: EvolutionCandidateArtifact | null;
}

export interface Skill {
  skillId: string;
  schemaVersion: 1;
  proposalId: string;
  title: string;
  procedure: string[];
  applicability: Applicability;
  status: 'candidate';
  contentHash: string;
  lineage: EvolutionLineageReference[];
  createdAt: string;
}

export interface SkillLifecycleEntry {
  eventId: string;
  occurredAt: string;
  from: EvolutionArtifactStatus;
  to: EvolutionArtifactStatus;
  reason: string;
  supersedes?: EvolutionLineageReference;
}

export interface SkillState {
  skill: Skill;
  status: EvolutionArtifactStatus;
  lifecycle: SkillLifecycleEntry[];
  invocations: SkillInvocation[];
  outcomes: SkillOutcome[];
}

export type CompilerRecipeSource = 'context' | 'knowledge' | 'deadend' | 'note';
export type CompilerRecipeSection = 'summary' | 'pending' | 'decision' | 'risk' | 'note' | 'knowledge' | 'deadend' | 'activity';

export interface CompilerRecipe {
  recipeId: string;
  schemaVersion: 1;
  proposalId: string;
  title: string;
  applicability: Applicability;
  preferredSources?: CompilerRecipeSource[];
  preferredSections?: CompilerRecipeSection[];
  sectionBudgets?: Partial<Record<CompilerRecipeSection, number>>;
  status: 'candidate';
  contentHash: string;
  lineage: EvolutionLineageReference[];
  createdAt: string;
}

export interface CompilerRecipeLifecycleEntry {
  eventId: string;
  occurredAt: string;
  from: EvolutionArtifactStatus;
  to: EvolutionArtifactStatus;
  reason: string;
  supersedes?: EvolutionLineageReference;
}

export interface CompilerRecipeState {
  recipe: CompilerRecipe;
  status: EvolutionArtifactStatus;
  lifecycle: CompilerRecipeLifecycleEntry[];
}

export interface EvolutionLifecycleTransition {
  entity: EvolutionArtifactKind | 'proposal';
  entityId: string;
  from: EvolutionArtifactStatus;
  to: EvolutionArtifactStatus;
  reason: string;
  supersedes?: EvolutionLineageReference;
}

export interface SkillInvocation {
  invocationId: string;
  skillId: string;
  callerEventId: string;
  inputHash: string;
  occurredAt: string;
}

export interface SkillOutcome {
  outcomeId: string;
  invocationId: string;
  callerEventId: string;
  outcome: 'success' | 'failure' | 'partial' | 'irrelevant' | 'unknown';
  summary: string;
  occurredAt: string;
}

export interface EvidenceGraphNode {
  nodeId: string;
  kind: 'context' | 'snapshot' | 'experience' | 'proposal' | 'knowledge' | 'deadend' | 'skill' | 'recipe' | 'path' | 'test' | 'commit' | 'branch-worktree';
}

export interface EvidenceGraphEdge {
  edgeId: string;
  from: string;
  to: string;
  type: 'derived_from' | 'supports' | 'contradicts' | 'supersedes' | 'used_for' | 'observed_in' | 'changed_in' | 'co_changed_with' | 'tests';
  sourceEventIds: string[];
  derivationVersion: string;
  occurredAt: string;
  confidence?: number;
}

export interface EvidenceGraphProjection {
  schemaVersion: 1;
  derivationVersion: 'evidence-graph-v1';
  nodes: EvidenceGraphNode[];
  edges: EvidenceGraphEdge[];
}

export interface CognitionUseFeedback {
  feedbackId: string;
  entity: 'knowledge' | 'deadend';
  entityId: string;
  outcome: 'used';
}

export interface UsageOperationCompletedPayload {
  operation: 'orient' | 'compile' | 'expand' | 'resume';
  interface: 'cli' | 'mcp' | 'agent' | 'hook';
  success: boolean;
  durationMs: number;
  inputChars: number;
  outputChars: number;
  inputBytes: number;
  outputBytes: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedMethod: 'chars-div-four';
  errorClass?: string;
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
  experiences: Record<string, Experience>;
  proposals: Record<string, EvolutionProposalState>;
  skills: Record<string, SkillState>;
  recipes: Record<string, CompilerRecipeState>;
  evidenceGraph: EvidenceGraphProjection;
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
