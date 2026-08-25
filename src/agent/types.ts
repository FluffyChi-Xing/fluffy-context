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
}

export type ContextOrientResult = ContextOrientReadyResult | ContextOrientNoContextResult;
