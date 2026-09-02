import crypto from 'node:crypto';
import { readGitWorktreeState } from '../git/git-adapter.js';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { appendEvent, readJournal } from './journal.js';
import { inspectEvolutionProposal } from './evolution.js';
import { v2Enabled } from './orient.js';
import { projectEvents, rebuildProjections } from './projections.js';
import type { Applicability, EvolutionArtifactStatus, EvolutionLineageReference, Skill, SkillOutcome, SkillState } from './types.js';

export interface MaterializeSkillInput {
  proposalId: string;
  title: string;
  procedure: string[];
}

export interface TransitionSkillInput {
  skillId: string;
  to: Extract<EvolutionArtifactStatus, 'verified' | 'published' | 'deprecated' | 'superseded'>;
  rationale: string;
  supersedes?: EvolutionLineageReference;
}

export interface RecordSkillInvocationInput {
  skillId: string;
  invocationId: string;
  callerEventId: string;
  inputHash: string;
}

export interface RecordSkillOutcomeInput {
  skillId: string;
  invocationId: string;
  outcomeId: string;
  callerEventId: string;
  outcome: SkillOutcome['outcome'];
  summary: string;
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

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

function requireProcedure(procedure: string[]): string[] {
  if (!Array.isArray(procedure) || procedure.length === 0 || procedure.length > 32) throw new Error('skill procedure must contain 1 to 32 steps');
  return procedure.map((step) => requireText(step, 'skill procedure step'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eventRecord(event: Awaited<ReturnType<typeof readJournal>>[number]): Record<string, unknown> | null {
  const payload = event.payload as Record<string, unknown>;
  return isRecord(payload.record) ? payload.record : null;
}

function matchingRecord(record: Record<string, unknown>, expected: Record<string, unknown>, ignored: string[] = []): boolean {
  const actual = { ...record };
  for (const field of ignored) delete actual[field];
  return canonical(actual) === canonical(expected);
}

function anchor(git: Awaited<ReturnType<typeof readGitWorktreeState>>) {
  return { worktreeId: git.worktreeId, branch: git.branch, ref: git.ref, head: git.commit };
}

async function enabledProject(startPath: string | undefined): Promise<string> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!await v2Enabled(projectRoot)) throw new Error('skills require an enabled v2 runtime');
  return projectRoot;
}

export async function listSkills(startPath?: string): Promise<SkillState[]> {
  const projectRoot = await enabledProject(startPath);
  return Object.values(projectEvents(await readJournal(projectRoot)).skills).sort((left, right) => left.skill.skillId.localeCompare(right.skill.skillId));
}

export async function inspectSkill(startPath: string | undefined, skillId: string): Promise<SkillState> {
  const id = requireText(skillId, 'skill ID');
  const skill = (await listSkills(startPath)).find((item) => item.skill.skillId === id);
  if (!skill) throw new Error(`skill not found: ${id}`);
  return skill;
}

export async function materializeSkill(startPath: string | undefined, input: MaterializeSkillInput): Promise<{ materialized: boolean; skillId: string; eventId: string }> {
  const projectRoot = await enabledProject(startPath);
  const proposalId = requireText(input.proposalId, 'proposal ID');
  const proposalState = await inspectEvolutionProposal(projectRoot, proposalId);
  if (proposalState.proposal.targetKind !== 'skill' || proposalState.status !== 'candidate') throw new Error(`skill materialization requires a candidate Skill proposal: ${proposalId}`);
  const artifact = proposalState.acceptedArtifact;
  if (!artifact || artifact.kind !== 'skill' || artifact.proposalId !== proposalId) throw new Error(`skill materialization requires an accepted Skill candidate: ${proposalId}`);
  const title = requireText(input.title, 'skill title');
  const procedure = requireProcedure(input.procedure);
  const basis = { proposalId, title, procedure, applicability: artifact.applicability, lineage: artifact.lineage, proposalContentHash: artifact.contentHash };
  const expected = {
    skillId: artifact.artifactId,
    schemaVersion: 1 as const,
    proposalId,
    title,
    procedure,
    applicability: artifact.applicability as Applicability,
    status: 'candidate' as const,
    contentHash: hash(basis),
    lineage: artifact.lineage,
  };
  const existing = (await readJournal(projectRoot)).find((event) => event.type === 'skill.materialized' && eventRecord(event)?.skillId === expected.skillId);
  if (existing) {
    const record = eventRecord(existing)!;
    if (!matchingRecord(record, expected, ['createdAt'])) throw new Error(`Skill already materialized with conflicting content: ${expected.skillId}`);
    return { materialized: false, skillId: expected.skillId, eventId: existing.eventId };
  }
  const skill: Skill = { ...expected, createdAt: new Date().toISOString() };
  const git = await readGitWorktreeState(projectRoot);
  const result = await appendEvent(projectRoot, {
    type: 'skill.materialized', source: { kind: 'cli' }, idempotencyKey: `skill-materialized:${skill.skillId}:${skill.contentHash}`,
    git: anchor(git), payload: { record: skill },
  });
  if (result.appended) await rebuildProjections(projectRoot);
  return { materialized: result.appended, skillId: skill.skillId, eventId: result.event.eventId };
}

export async function transitionSkill(startPath: string | undefined, input: TransitionSkillInput): Promise<{ transitioned: boolean; eventId: string }> {
  const projectRoot = await enabledProject(startPath);
  const skill = await inspectSkill(projectRoot, input.skillId);
  const rationale = requireText(input.rationale, 'skill rationale');
  if (input.to === 'superseded' && !input.supersedes) throw new Error('superseding a Skill requires lineage');
  const request = { entity: 'skill', entityId: skill.skill.skillId, to: input.to, reason: rationale, ...(input.supersedes ? { supersedes: input.supersedes } : {}) };
  const existing = (await readJournal(projectRoot)).find((event) => {
    if (!event.type.startsWith('evolution.')) return false;
    const transition = (event.payload as Record<string, unknown>).transition;
    return isRecord(transition) && matchingRecord(transition, request, ['from']);
  });
  if (existing) return { transitioned: false, eventId: existing.eventId };
  if (!((skill.status === 'candidate' && (input.to === 'verified' || input.to === 'deprecated'))
    || (skill.status === 'verified' && (input.to === 'published' || input.to === 'deprecated' || input.to === 'superseded'))
    || (skill.status === 'published' && (input.to === 'deprecated' || input.to === 'superseded')))) {
    throw new Error(`invalid Skill transition: ${skill.status} to ${input.to}`);
  }
  const git = await readGitWorktreeState(projectRoot);
  const result = await appendEvent(projectRoot, {
    type: `evolution.${input.to}` as 'evolution.verified' | 'evolution.published' | 'evolution.deprecated' | 'evolution.superseded',
    source: { kind: 'cli' },
    idempotencyKey: `skill-transition:${skill.skill.skillId}:${input.to}:${hash({ rationale, supersedes: input.supersedes }).slice(0, 16)}`,
    git: anchor(git),
    payload: { transition: { ...request, from: skill.status } },
  });
  if (result.appended) await rebuildProjections(projectRoot);
  return { transitioned: result.appended, eventId: result.event.eventId };
}

export async function recordSkillInvocation(startPath: string | undefined, input: RecordSkillInvocationInput): Promise<{ recorded: boolean; eventId: string }> {
  const projectRoot = await enabledProject(startPath);
  const skill = await inspectSkill(projectRoot, input.skillId);
  const invocation = {
    invocationId: requireText(input.invocationId, 'invocation ID'),
    skillId: skill.skill.skillId,
    callerEventId: requireText(input.callerEventId, 'caller event ID'),
    inputHash: requireText(input.inputHash, 'skill input hash'),
  };
  const existing = (await readJournal(projectRoot)).find((event) => event.type === 'skill.invoked' && eventRecord(event)?.invocationId === invocation.invocationId);
  if (existing) {
    if (!matchingRecord(eventRecord(existing)!, invocation, ['occurredAt'])) throw new Error(`Skill invocation ID already exists: ${invocation.invocationId}`);
    return { recorded: false, eventId: existing.eventId };
  }
  if (skill.status !== 'published') throw new Error(`Skill invocation requires a published Skill: ${skill.skill.skillId}`);
  const git = await readGitWorktreeState(projectRoot);
  const result = await appendEvent(projectRoot, { type: 'skill.invoked', source: { kind: 'cli' }, idempotencyKey: `skill-invocation:${invocation.invocationId}`, git: anchor(git), payload: { record: { ...invocation, occurredAt: new Date().toISOString() } } });
  if (result.appended) await rebuildProjections(projectRoot);
  return { recorded: result.appended, eventId: result.event.eventId };
}

export async function recordSkillOutcome(startPath: string | undefined, input: RecordSkillOutcomeInput): Promise<{ recorded: boolean; eventId: string }> {
  const projectRoot = await enabledProject(startPath);
  const skill = await inspectSkill(projectRoot, input.skillId);
  const invocationId = requireText(input.invocationId, 'invocation ID');
  const outcome = {
    outcomeId: requireText(input.outcomeId, 'outcome ID'),
    invocationId,
    callerEventId: requireText(input.callerEventId, 'caller event ID'),
    outcome: input.outcome,
    summary: requireText(input.summary, 'skill outcome summary'),
  };
  const existing = (await readJournal(projectRoot)).find((event) => event.type === 'skill.outcome.recorded' && eventRecord(event)?.outcomeId === outcome.outcomeId);
  if (existing) {
    if (!matchingRecord(eventRecord(existing)!, outcome, ['occurredAt'])) throw new Error(`Skill outcome ID already exists: ${outcome.outcomeId}`);
    return { recorded: false, eventId: existing.eventId };
  }
  if (!skill.invocations.some((item) => item.invocationId === invocationId)) throw new Error(`Skill invocation not found: ${invocationId}`);
  if (skill.outcomes.some((item) => item.invocationId === invocationId)) throw new Error(`Skill outcome already recorded: ${invocationId}`);
  const git = await readGitWorktreeState(projectRoot);
  const result = await appendEvent(projectRoot, { type: 'skill.outcome.recorded', source: { kind: 'cli' }, idempotencyKey: `skill-outcome:${outcome.outcomeId}`, git: anchor(git), payload: { record: { ...outcome, occurredAt: new Date().toISOString() } } });
  if (result.appended) await rebuildProjections(projectRoot);
  return { recorded: result.appended, eventId: result.event.eventId };
}
