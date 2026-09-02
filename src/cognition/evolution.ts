import crypto from 'node:crypto';
import { readGitWorktreeState } from '../git/git-adapter.js';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { appendEvent, readJournal } from './journal.js';
import { v2Enabled } from './orient.js';
import { projectEvents, rebuildProjections } from './projections.js';
import type { Applicability, CognitionEvent, CognitionEventType, EvolutionArtifactKind, EvolutionArtifactStatus, EvolutionCandidateArtifact, EvolutionLineageReference, EvolutionProposal, EvolutionProposalState, Experience } from './types.js';

const extractor = { id: 'deterministic-maintainer', version: '1' };
const maxEvidenceEvents = 32;
const allowedEvidenceTypes: ReadonlySet<CognitionEventType> = new Set([
  'host.prompt.submitted',
  'context.checkpoint.imported', 'context.state.recorded',
  'note.recorded', 'note.resolved', 'note.absorbed',
  'git.state.observed', 'git.branch.changed', 'git.head.changed',
  'workspace.paths.changed', 'record.used', 'usage.operation.completed',
]);

type ProposalTargetKind = Extract<EvolutionArtifactKind, 'skill' | 'compiler-recipe'>;

export interface ProposeEvolutionInput {
  eventIds?: string[];
  recentLimit?: number;
  targetKind?: ProposalTargetKind;
}

export interface ProposeEvolutionResult {
  experienceId: string;
  experienceEventId: string;
  proposalId: string | null;
  proposalEventId: string | null;
  recorded: boolean;
}

export interface AcceptEvolutionCandidateInput {
  proposalId: string;
  rationale: string;
}

export interface TransitionEvolutionProposalInput {
  proposalId: string;
  to: Extract<EvolutionArtifactStatus, 'verified' | 'rejected' | 'deprecated' | 'superseded'>;
  rationale: string;
  supersedes?: EvolutionLineageReference;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function anchor(event: CognitionEvent) {
  return { worktreeId: event.git.worktreeId, branch: event.git.branch, ref: event.git.ref, head: event.git.head };
}

function currentAnchor(state: Awaited<ReturnType<typeof readGitWorktreeState>>) {
  return { worktreeId: state.worktreeId, branch: state.branch, ref: state.ref, head: state.commit };
}

function requireReason(reason: string): string {
  const value = reason.trim();
  if (!value) throw new Error('evolution rationale must not be empty');
  return value;
}

function selectEvidence(events: CognitionEvent[], input: ProposeEvolutionInput): CognitionEvent[] {
  const selected = input.eventIds
    ? input.eventIds.map((eventId) => {
      if (!eventId.trim()) throw new Error('evidence event ID must not be empty');
      return eventId;
    })
    : events.filter((event) => allowedEvidenceTypes.has(event.type)).slice(-(input.recentLimit ?? maxEvidenceEvents)).map((event) => event.eventId);
  if (selected.length === 0) throw new Error('evolution extraction requires evidence events');
  if (selected.length > maxEvidenceEvents) throw new Error(`evolution extraction supports at most ${maxEvidenceEvents} evidence events`);
  if (new Set(selected).size !== selected.length) throw new Error('evolution evidence event IDs must be unique');
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const evidence = selected.map((eventId) => byId.get(eventId));
  if (evidence.some((event) => !event)) throw new Error('evolution evidence event was not found');
  if (evidence.some((event) => !allowedEvidenceTypes.has(event!.type))) throw new Error('evolution evidence event type is not allowed');
  return evidence as CognitionEvent[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function sourceReferences(events: CognitionEvent[]): { contextIds: string[]; snapshotIds: string[]; paths: string[] } {
  const contextIds = new Set<string>();
  const snapshotIds = new Set<string>();
  const paths = new Set<string>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const record = payload.record;
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      const item = record as Record<string, unknown>;
      const snapshot = item.snapshot;
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        const value = snapshot as Record<string, unknown>;
        if (typeof value.contextId === 'string') contextIds.add(value.contextId);
        if (typeof value.snapshotId === 'string') snapshotIds.add(value.snapshotId);
      }
      if (typeof item.contextId === 'string') contextIds.add(item.contextId);
      if (typeof item.snapshotId === 'string') snapshotIds.add(item.snapshotId);
    }
    for (const value of stringArray(payload.paths)) paths.add(value.replaceAll('\\', '/'));
  }
  return { contextIds: [...contextIds].sort(), snapshotIds: [...snapshotIds].sort(), paths: [...paths].sort() };
}

function privacy(events: CognitionEvent[]): Experience['privacy'] {
  const redactionCount = events.reduce((total, event) => total + event.privacy.redactionCount, 0);
  return { classification: events.some((event) => event.privacy.classification === 'redacted-text') ? 'redacted-text' : 'metadata', redactionCount };
}

function applicability(event: CognitionEvent): Applicability {
  if (event.git.ref === null && event.git.branch === null) return { project: true, branchMode: 'global' };
  return { project: true, branchMode: 'exact', branches: [event.git.ref ?? event.git.branch ?? 'detached'], sourceCommit: event.git.head };
}

function candidateEligible(events: CognitionEvent[]): boolean {
  const hasContext = events.some((event) => event.type === 'context.checkpoint.imported' || event.type === 'context.state.recorded');
  const hasActivity = events.some((event) => event.type.startsWith('git.') || event.type === 'workspace.paths.changed');
  const hasUse = events.some((event) => event.type === 'record.used');
  return hasContext && hasActivity && hasUse;
}

async function enabledProject(startPath: string | undefined): Promise<string> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!await v2Enabled(projectRoot)) throw new Error('evolution requires an enabled v2 runtime');
  return projectRoot;
}

export async function proposeEvolution(startPath: string | undefined, input: ProposeEvolutionInput = {}): Promise<ProposeEvolutionResult> {
  const projectRoot = await enabledProject(startPath);
  const events = await readJournal(projectRoot);
  const evidence = selectEvidence(events, input);
  const references = sourceReferences(evidence);
  const sourceEventIds = evidence.map((event) => event.eventId);
  const last = evidence.at(-1)!;
  const experienceBasis = { sourceEventIds, sourceContextIds: references.contextIds, sourceSnapshotIds: references.snapshotIds, paths: references.paths, git: anchor(last), privacy: privacy(evidence), extractor, createdAt: last.occurredAt };
  const experience: Experience = {
    experienceId: `exp-${hash(experienceBasis).slice(0, 20)}`,
    schemaVersion: 1,
    ...experienceBasis,
    contentHash: hash(experienceBasis),
    summary: `Metadata-only experience from ${sourceEventIds.length} journal events.`,
  };
  const experienceResult = await appendEvent(projectRoot, {
    type: 'experience.recorded', source: { kind: 'agent' }, occurredAt: experience.createdAt,
    idempotencyKey: `experience:${experience.experienceId}`, git: experience.git,
    privacy: experience.privacy, payload: { record: experience },
  });
  let proposalResult: Awaited<ReturnType<typeof appendEvent>> | null = null;
  let proposal: EvolutionProposal | null = null;
  if (candidateEligible(evidence)) {
    const targetKind = input.targetKind ?? 'skill';
    const proposalBasis = { sourceExperienceIds: [experience.experienceId], evidence: sourceEventIds.map((eventId) => ({ eventId, relation: 'derived_from' as const })), applicability: applicability(last), targetKind, extractor, createdAt: experience.createdAt };
    const contentHash = hash(proposalBasis);
    proposal = {
      proposalId: `proposal-${contentHash.slice(0, 20)}`,
      schemaVersion: 1,
      targetKind,
      targetId: `${targetKind}-${contentHash.slice(0, 20)}`,
      status: 'candidate',
      sourceExperienceIds: proposalBasis.sourceExperienceIds,
      evidence: proposalBasis.evidence,
      lineage: [],
      applicability: proposalBasis.applicability,
      contentHash,
      summary: `Candidate ${targetKind} derived from metadata-only experience ${experience.experienceId}.`,
      extractor,
      createdAt: experience.createdAt,
    };
    proposalResult = await appendEvent(projectRoot, {
      type: 'evolution.proposed', source: { kind: 'agent' }, occurredAt: proposal.createdAt,
      idempotencyKey: `evolution-proposal:${proposal.proposalId}`, git: experience.git,
      privacy: experience.privacy, payload: { record: proposal },
    });
  }
  if (experienceResult.appended || proposalResult?.appended) await rebuildProjections(projectRoot);
  return { experienceId: experience.experienceId, experienceEventId: experienceResult.event.eventId, proposalId: proposal?.proposalId ?? null, proposalEventId: proposalResult?.event.eventId ?? null, recorded: experienceResult.appended || Boolean(proposalResult?.appended) };
}

export async function listEvolutionProposals(startPath?: string): Promise<EvolutionProposalState[]> {
  const projectRoot = await enabledProject(startPath);
  return Object.values(projectEvents(await readJournal(projectRoot)).proposals).sort((left, right) => left.proposal.proposalId.localeCompare(right.proposal.proposalId));
}

export async function inspectEvolutionProposal(startPath: string | undefined, proposalId: string): Promise<EvolutionProposalState> {
  const proposal = (await listEvolutionProposals(startPath)).find((item) => item.proposal.proposalId === proposalId);
  if (!proposal) throw new Error(`evolution proposal not found: ${proposalId}`);
  return proposal;
}

export async function acceptEvolutionCandidate(startPath: string | undefined, input: AcceptEvolutionCandidateInput): Promise<{ accepted: boolean; eventId: string }> {
  const projectRoot = await enabledProject(startPath);
  const rationale = requireReason(input.rationale);
  const state = await inspectEvolutionProposal(projectRoot, input.proposalId);
  if (state.proposal.targetKind !== 'skill' && state.proposal.targetKind !== 'compiler-recipe') throw new Error('only skill and compiler-recipe proposals can be accepted in Phase 1');
  if (state.status !== 'candidate') throw new Error(`candidate acceptance requires a candidate proposal: ${input.proposalId}`);
  if (state.acceptedArtifact) throw new Error(`candidate artifact already accepted: ${input.proposalId}`);
  const git = await readGitWorktreeState(projectRoot);
  const artifact: EvolutionCandidateArtifact = {
    artifactId: state.proposal.targetId,
    schemaVersion: 1,
    proposalId: state.proposal.proposalId,
    kind: state.proposal.targetKind,
    status: 'candidate',
    applicability: state.proposal.applicability,
    contentHash: state.proposal.contentHash,
    lineage: state.proposal.lineage,
    rationale,
    createdAt: new Date().toISOString(),
  };
  const result = await appendEvent(projectRoot, {
    type: 'evolution.candidate.accepted', source: { kind: 'cli' }, idempotencyKey: `evolution-accept:${artifact.artifactId}:${hash(rationale).slice(0, 16)}`,
    git: currentAnchor(git), payload: { record: artifact },
  });
  if (result.appended) await rebuildProjections(projectRoot);
  return { accepted: result.appended, eventId: result.event.eventId };
}

export async function transitionEvolutionProposal(startPath: string | undefined, input: TransitionEvolutionProposalInput): Promise<{ transitioned: boolean; eventId: string }> {
  const projectRoot = await enabledProject(startPath);
  const rationale = requireReason(input.rationale);
  const state = await inspectEvolutionProposal(projectRoot, input.proposalId);
  if (input.to === 'superseded' && !input.supersedes) throw new Error('superseding an evolution proposal requires lineage');
  const git = await readGitWorktreeState(projectRoot);
  const result = await appendEvent(projectRoot, {
    type: `evolution.${input.to}` as Extract<CognitionEventType, 'evolution.verified' | 'evolution.rejected' | 'evolution.deprecated' | 'evolution.superseded'>,
    source: { kind: 'cli' },
    idempotencyKey: `evolution-transition:${input.proposalId}:${state.status}:${input.to}:${hash({ rationale, supersedes: input.supersedes }).slice(0, 16)}`,
    git: currentAnchor(git),
    payload: { transition: { entity: 'proposal', entityId: input.proposalId, from: state.status, to: input.to, reason: rationale, ...(input.supersedes ? { supersedes: input.supersedes } : {}) } },
  });
  if (result.appended) await rebuildProjections(projectRoot);
  return { transitioned: result.appended, eventId: result.event.eventId };
}
