import type {
  ContextStatus,
  DeadendDiscoveryResult,
  KnowledgeDiscoveryResult,
  Note,
  ResumeSummary,
  SnapshotMode,
} from '../runtime/types.js';

export interface ContextOrientOptions {
  contextId?: string;
  query?: string;
  scope?: string;
  maxChars?: number;
  knowledgeLimit?: number;
  deadendLimit?: number;
  noteLimit?: number;
}

export interface ContextOrientContext {
  id: string;
  title: string;
  status: ContextStatus;
  branch: string | null;
  commit: string | null;
  updatedAt: string;
}

export interface ContextOrientSnapshot {
  snapshotId: string;
  mode: SnapshotMode;
  createdAt: string;
  branch: string | null;
  commit: string | null;
}

export interface ContextUseInput {
  entity: 'knowledge' | 'deadend';
  entityId: string;
  eventId: string;
}

export interface ContextOrientExplanation {
  mode: 'v2' | 'v1-fallback';
  selection: 'requested-context' | 'exact-worktree-ref' | 'legacy-ref-branch' | 'v1';
  retrieval: {
    knowledge: Record<'status_not_verified' | 'applicability_mismatch' | 'scope_mismatch' | 'query_no_match' | 'result_limit', number> | {};
    deadends: Record<'status_not_verified' | 'applicability_mismatch' | 'scope_mismatch' | 'query_no_match' | 'result_limit', number> | {};
  };
  truncation: {
    summary: boolean;
    knowledge: boolean;
    deadends: boolean;
    notes: boolean;
  };
}

export interface ContextOrientReadyResult {
  status: 'ready';
  projectRoot: string;
  query: string | null;
  context: ContextOrientContext;
  snapshot: ContextOrientSnapshot;
  resumeSummary: ResumeSummary;
  knowledge: KnowledgeDiscoveryResult;
  deadends: DeadendDiscoveryResult;
  notes: Note[];
  truncated: boolean;
  explanation: ContextOrientExplanation;
}

export interface ContextOrientNoContextResult {
  status: 'no_context';
  projectRoot: string;
  query: string | null;
  context: null;
  snapshot: null;
  resumeSummary: null;
  knowledge: KnowledgeDiscoveryResult;
  deadends: DeadendDiscoveryResult;
  notes: Note[];
  truncated: false;
  explanation: ContextOrientExplanation;
}

export type ContextOrientResult = ContextOrientReadyResult | ContextOrientNoContextResult;
