import type { CognitionGitAnchor } from '../cognition/types.js';
import type { ContextOrientResult } from '../agent/types.js';
import type { Deadend, Knowledge, Note, ResumeSummary, StructuredContext } from '../runtime/types.js';

export type ContextScenario = 'resume' | 'implementation' | 'debugging' | 'verification' | 'handoff' | 'exploration' | 'unknown';
export type ContextSourceKind = 'current-context' | 'checkpoint' | 'note' | 'journal' | 'knowledge' | 'deadend';
export type ContextCandidateSection = 'summary' | 'pending' | 'decision' | 'risk' | 'note' | 'knowledge' | 'deadend';
export type ContextSignalOrigin = 'explicit' | 'deterministic';

export interface ContextAnchor {
  projectRoot: string;
  worktreeId: string | null;
  branch: string | null;
  ref: string | null;
  head: string | null;
}

export interface ContextIntentSignal {
  source: 'explicit-query' | 'explicit-scenario' | 'context-state' | 'host-prompt' | 'path' | 'git';
  value: string;
  origin: ContextSignalOrigin;
  confidence: 'high' | 'medium' | 'low';
}

export interface ContextIntent {
  schemaVersion: 1;
  trigger: 'session-start' | 'prompt' | 'manual' | 'tool-call';
  query: string | null;
  normalizedTerms: string[];
  scenario: ContextScenario;
  scope: string | null;
  paths: string[];
  contextId: string | null;
  anchor: ContextAnchor;
  signals: ContextIntentSignal[];
  requestedSections: ContextCandidateSection[];
  budget: ContextBudget;
  adapter: string;
  sessionId: string | null;
  eventId: string | null;
}

export interface ContextBudget {
  unit: 'chars';
  total: number;
  reservedForRenderer: number;
  sections?: Partial<Record<ContextCandidateSection, number>>;
}

export interface ContextSourceApplicability {
  project: true;
  branchMode: 'global' | 'exact' | 'unsupported';
  branches: string[];
  paths: string[];
  worktreeId: string | null;
  ref: string | null;
}

export interface ContextProvenance {
  origin: 'v1-file' | 'v2-journal' | 'mixed' | 'live';
  eventId: string | null;
  eventType: string | null;
  occurredAt: string | null;
  sourcePath: string | null;
  sourceHash: string | null;
  anchorProvenance: 'snapshot' | 'live' | 'global' | null;
}

export interface ContextSourceDescriptor {
  sourceId: string;
  kind: ContextSourceKind;
  entityId: string;
  contextId: string | null;
  snapshotId: string | null;
  status: string | null;
  scope: string | null;
  paths: string[];
  anchor: ContextAnchor;
  applicability: ContextSourceApplicability;
  privacy: { classification: 'metadata' | 'redacted-text' | 'unknown'; redactionCount: number };
  provenance: ContextProvenance;
}

export interface ContextCandidate<T = unknown> {
  candidateId: string;
  section: ContextCandidateSection;
  source: ContextSourceDescriptor;
  content: T;
  text: string;
  priority: number;
  score: number;
  matchedTerms: string[];
  matchedFields: string[];
  originalChars: number;
  selectedChars: number;
  selected: boolean;
  truncated: boolean;
}

export type ContextExclusionReason =
  | 'no_active_context'
  | 'context_mismatch'
  | 'status_not_verified'
  | 'not_open'
  | 'absorbed'
  | 'applicability_mismatch'
  | 'scope_mismatch'
  | 'path_mismatch'
  | 'query_no_match'
  | 'result_limit'
  | 'budget'
  | 'unsupported_applicability'
  | 'v2_unavailable';

export interface ContextExclusion {
  candidateId: string;
  source: ContextSourceDescriptor | null;
  reason: ContextExclusionReason;
  detail?: string;
}

export interface ContextTruncation {
  truncated: boolean;
  summary: boolean;
  pending: boolean;
  decisions: boolean;
  risks: boolean;
  notes: boolean;
  knowledge: boolean;
  deadends: boolean;
  candidatesOmittedByBudget: number;
  candidatesPartiallyTruncated: number;
}

export interface ContextBudgetReport {
  requested: ContextBudget;
  usedChars: number;
  remainingChars: number;
  sections: Partial<Record<ContextCandidateSection, { allocated: number; consumed: number; truncated: boolean }>>;
}

export interface ContextManifestProvenance {
  journalRead: boolean;
  journalEventCount: number;
  selectedSourceIds: string[];
  selectedEventIds: string[];
  fallbackReason: string | null;
}

export interface ContextCompileOptions {
  contextId?: string;
  query?: string;
  scenario?: ContextScenario;
  scope?: string;
  paths?: string[];
  maxChars?: number;
  knowledgeLimit?: number;
  deadendLimit?: number;
  noteLimit?: number;
  trigger?: ContextIntent['trigger'];
  adapter?: string;
  sessionId?: string;
  eventId?: string;
}

export interface ContextManifest {
  schemaVersion: 1;
  compilerVersion: '0.7.0';
  rankingVersion: 'compiler-ranking-v1';
  status: 'ready' | 'no_context';
  projectRoot: string;
  mode: 'v2' | 'v1-fallback';
  anchor: ContextAnchor;
  intent: ContextIntent;
  context: ContextOrientResult['context'];
  snapshot: ContextOrientResult['snapshot'];
  resumeSummary: ResumeSummary | null;
  sections: {
    summary: ContextCandidate[];
    pending: ContextCandidate[];
    decision: ContextCandidate[];
    risk: ContextCandidate[];
    notes: ContextCandidate[];
    knowledge: ContextCandidate[];
    deadends: ContextCandidate[];
  };
  selected: ContextCandidate[];
  excluded: ContextExclusion[];
  budget: ContextBudgetReport;
  truncation: ContextTruncation;
  provenance: ContextManifestProvenance;
  text: string;
}

export type CompilerRecord = StructuredContext | Note | Knowledge | Deadend;
export type CompilerGitAnchor = CognitionGitAnchor;
