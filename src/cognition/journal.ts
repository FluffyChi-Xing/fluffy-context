import crypto from 'node:crypto';
import { appendFile, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { loadManifest } from '../runtime/init.js';
import { withLock } from '../storage/lock.js';
import { cognitionJournalDirectory, locksDirectory } from '../storage/layout.js';
import type { CognitionEvent, CognitionEventSource, CognitionEventType, CognitionGitAnchor } from './types.js';
import { appendJournalLine, archiveSegment, journalFiles, journalStorage, readSegment } from './journal-segments.js';
import { loadRuntimePolicy } from './policy.js';
import { recordAdmissionDrop } from './admission.js';
import type { ProgressReporter } from './progress.js';

const eventTypes: ReadonlySet<string> = new Set([
  'runtime.enabled', 'runtime.started', 'runtime.stopped', 'host.session.started', 'host.prompt.submitted',
  'git.state.observed', 'git.branch.changed', 'git.head.changed', 'workspace.paths.changed',
  'context.checkpoint.imported', 'context.state.recorded', 'note.recorded', 'note.resolved', 'note.absorbed',
  'knowledge.proposed', 'knowledge.verified', 'knowledge.deprecated', 'knowledge.rejected',
  'deadend.proposed', 'deadend.verified', 'deadend.obsoleted', 'deadend.rejected',
  'experience.recorded',
  'evolution.proposed', 'evolution.candidate.accepted', 'evolution.verified', 'evolution.published', 'evolution.rejected', 'evolution.deprecated', 'evolution.superseded',
  'skill.materialized', 'recipe.materialized', 'skill.invoked', 'skill.outcome.recorded', 'record.used',
  'usage.operation.completed',
  'projection.advanced', 'projection.failed',
]);
const sourceKinds: ReadonlySet<string> = new Set(['cli', 'claude-hook', 'mcp', 'agent', 'git-observer', 'fs-observer', 'migration']);


export interface AppendEventInput<T = Record<string, unknown>> {
  eventId?: string;
  type: CognitionEventType;
  occurredAt?: string;
  source?: { kind: CognitionEventSource; instanceId?: string };
  correlationId?: string;
  idempotencyKey: string;
  git?: CognitionGitAnchor;
  privacy?: { classification: 'metadata' | 'redacted-text'; redactionCount: number };
  payload: T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function eventId(): string {
  return `evt-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

export function eventHash<T>(event: Omit<CognitionEvent<T>, 'hash'>): string {
  return digest(event);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validGitAnchor(value: unknown): value is CognitionGitAnchor {
  return isRecord(value)
    && (typeof value.worktreeId === 'string' || value.worktreeId === null)
    && (typeof value.branch === 'string' || value.branch === null)
    && (typeof value.ref === 'string' || value.ref === null)
    && (typeof value.head === 'string' || value.head === null);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validEvolutionId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validLineage(value: unknown): boolean {
  return isRecord(value)
    && (value.entity === 'knowledge' || value.entity === 'deadend' || value.entity === 'skill' || value.entity === 'compiler-recipe' || value.entity === 'experience' || value.entity === 'proposal')
    && typeof value.entityId === 'string' && value.entityId.trim().length > 0
    && (value.relation === 'supports' || value.relation === 'contradicts' || value.relation === 'supersedes' || value.relation === 'used_for');
}

function validEvolutionEvidence(value: unknown): boolean {
  return isRecord(value)
    && typeof value.eventId === 'string' && value.eventId.trim().length > 0
    && (value.relation === 'derived_from' || value.relation === 'supports' || value.relation === 'contradicts' || value.relation === 'validated_by');
}

function validApplicability(value: unknown): boolean {
  return isRecord(value)
    && value.project === true
    && (value.branchMode === 'global' || value.branchMode === 'exact' || value.branchMode === 'ancestor-of-source' || value.branchMode === 'descendant-of-source')
    && (value.branches === undefined || Array.isArray(value.branches) && value.branches.every((item) => typeof item === 'string' && item.trim().length > 0))
    && (value.paths === undefined || Array.isArray(value.paths) && value.paths.every((item) => typeof item === 'string' && item.trim().length > 0))
    && (value.sourceCommit === undefined || typeof value.sourceCommit === 'string' || value.sourceCommit === null)
    && (value.dependencyConstraints === undefined || Array.isArray(value.dependencyConstraints) && value.dependencyConstraints.every((item) => typeof item === 'string' && item.trim().length > 0));
}

function validEvolutionTransition(from: unknown, to: unknown): boolean {
  if ((from !== 'candidate' && from !== 'verified' && from !== 'published' && from !== 'rejected' && from !== 'deprecated' && from !== 'superseded' && from !== 'obsolete') || (to !== 'verified' && to !== 'published' && to !== 'rejected' && to !== 'deprecated' && to !== 'superseded' && to !== 'obsolete')) return false;
  return (from === 'candidate' && (to === 'verified' || to === 'rejected' || to === 'deprecated'))
    || (from === 'verified' && (to === 'published' || to === 'deprecated' || to === 'superseded' || to === 'obsolete'))
    || (from === 'published' && (to === 'deprecated' || to === 'superseded' || to === 'obsolete'));
}

function validSkill(value: unknown): boolean {
  return isRecord(value)
    && typeof value.skillId === 'string' && value.skillId.trim().length > 0
    && value.schemaVersion === 1
    && typeof value.proposalId === 'string' && value.proposalId.trim().length > 0
    && typeof value.title === 'string' && value.title.trim().length > 0
    && Array.isArray(value.procedure) && value.procedure.length > 0 && value.procedure.length <= 32 && value.procedure.every((step) => typeof step === 'string' && step.trim().length > 0)
    && validApplicability(value.applicability)
    && value.status === 'candidate'
    && typeof value.contentHash === 'string' && value.contentHash.trim().length > 0
    && Array.isArray(value.lineage) && value.lineage.every(validLineage)
    && validIsoDate(value.createdAt);
}

const recipeSources = new Set(['context', 'knowledge', 'deadend', 'note']);
const recipeSections = new Set(['summary', 'pending', 'decision', 'risk', 'note', 'knowledge', 'deadend', 'activity']);

function validRecipe(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set(['recipeId', 'schemaVersion', 'proposalId', 'title', 'applicability', 'preferredSources', 'preferredSections', 'sectionBudgets', 'status', 'contentHash', 'lineage', 'createdAt']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  const validPreferences = (items: unknown, allowedItems: Set<string>) => items === undefined
    || (Array.isArray(items) && items.length <= allowedItems.size && items.every((item) => typeof item === 'string' && allowedItems.has(item)) && new Set(items).size === items.length);
  const sectionBudgets = isRecord(value.sectionBudgets) ? value.sectionBudgets : null;
  const validBudgets = value.sectionBudgets === undefined || (sectionBudgets !== null
    && Object.keys(sectionBudgets).every((key) => recipeSections.has(key) && validNonNegativeInteger(sectionBudgets[key]) && sectionBudgets[key] <= 100_000));
  return typeof value.recipeId === 'string' && value.recipeId.trim().length > 0
    && value.schemaVersion === 1
    && typeof value.proposalId === 'string' && value.proposalId.trim().length > 0
    && typeof value.title === 'string' && value.title.trim().length > 0
    && validApplicability(value.applicability)
    && validPreferences(value.preferredSources, recipeSources)
    && validPreferences(value.preferredSections, recipeSections)
    && validBudgets
    && value.status === 'candidate'
    && typeof value.contentHash === 'string' && value.contentHash.trim().length > 0
    && Array.isArray(value.lineage) && value.lineage.every(validLineage)
    && validIsoDate(value.createdAt);
}

function validatePayloadBoundary(input: AppendEventInput): void {
  const payload = input.payload as Record<string, unknown>;
  if (input.type === 'host.prompt.submitted' && (typeof payload.intent !== 'string' || payload.intent.trim().length === 0)) {
    throw new Error('host prompt intent must not be empty');
  }
  if (['note.recorded', 'note.resolved', 'note.absorbed'].includes(input.type)) {
    const record = payload.record;
    if (!isRecord(record) || typeof record.message !== 'string' || record.message.trim().length === 0) throw new Error('note message must not be empty');
  }
  if (input.type === 'usage.operation.completed') {
    const requiredNumbers = ['durationMs', 'inputChars', 'outputChars', 'inputBytes', 'outputBytes', 'estimatedInputTokens', 'estimatedOutputTokens'];
    if (payload.operation !== 'orient' && payload.operation !== 'compile' && payload.operation !== 'expand' && payload.operation !== 'resume') throw new Error('invalid usage operation');
    if (payload.interface !== 'cli' && payload.interface !== 'mcp' && payload.interface !== 'agent' && payload.interface !== 'hook') throw new Error('invalid usage interface');
    if (typeof payload.success !== 'boolean' || payload.estimatedMethod !== 'chars-div-four' || requiredNumbers.some((key) => typeof payload[key] !== 'number' || !Number.isFinite(payload[key]) || payload[key] < 0)) throw new Error('invalid usage telemetry payload');
    if (!payload.success && typeof payload.errorClass !== 'string') throw new Error('usage errors require an error class');
  }
  if (input.type === 'workspace.paths.changed') {
    const changes = payload.changes;
    if (!Array.isArray(changes) || changes.length === 0) throw new Error('workspace activity must contain changes');
  }
  if (input.type === 'experience.recorded') {
    const experience = payload.record;
    if (!isRecord(experience)) throw new Error('experience record is required');
    validEvolutionId(experience.experienceId, 'experience id');
    if (experience.schemaVersion !== 1 || !Array.isArray(experience.sourceEventIds) || experience.sourceEventIds.length === 0 || !experience.sourceEventIds.every((value) => typeof value === 'string' && value.trim().length > 0) || !Array.isArray(experience.sourceContextIds) || !experience.sourceContextIds.every((value) => typeof value === 'string') || !Array.isArray(experience.sourceSnapshotIds) || !experience.sourceSnapshotIds.every((value) => typeof value === 'string') || !Array.isArray(experience.paths) || !experience.paths.every((value) => typeof value === 'string') || !validGitAnchor(experience.git) || !isRecord(experience.privacy) || (experience.privacy.classification !== 'metadata' && experience.privacy.classification !== 'redacted-text') || !validNonNegativeInteger(experience.privacy.redactionCount) || !isRecord(experience.extractor) || typeof experience.extractor.id !== 'string' || experience.extractor.id.trim().length === 0 || typeof experience.extractor.version !== 'string' || experience.extractor.version.trim().length === 0 || typeof experience.contentHash !== 'string' || experience.contentHash.trim().length === 0 || typeof experience.summary !== 'string' || experience.summary.trim().length === 0 || !validIsoDate(experience.createdAt)) throw new Error('invalid experience record');
  }
  if (input.type === 'evolution.proposed') {
    const proposal = payload.record;
    if (!isRecord(proposal)) throw new Error('evolution proposal record is required');
    validEvolutionId(proposal.proposalId, 'proposal id');
    if (proposal.schemaVersion !== 1 || (proposal.targetKind !== 'knowledge' && proposal.targetKind !== 'deadend' && proposal.targetKind !== 'skill' && proposal.targetKind !== 'compiler-recipe') || typeof proposal.targetId !== 'string' || proposal.targetId.trim().length === 0 || proposal.status !== 'candidate' || !Array.isArray(proposal.sourceExperienceIds) || proposal.sourceExperienceIds.length === 0 || !proposal.sourceExperienceIds.every((value) => typeof value === 'string' && value.trim().length > 0) || !Array.isArray(proposal.evidence) || proposal.evidence.length === 0 || !proposal.evidence.every(validEvolutionEvidence) || !Array.isArray(proposal.lineage) || !proposal.lineage.every(validLineage) || !validApplicability(proposal.applicability) || typeof proposal.contentHash !== 'string' || proposal.contentHash.trim().length === 0 || typeof proposal.summary !== 'string' || proposal.summary.trim().length === 0 || !isRecord(proposal.extractor) || typeof proposal.extractor.id !== 'string' || proposal.extractor.id.trim().length === 0 || typeof proposal.extractor.version !== 'string' || proposal.extractor.version.trim().length === 0 || !validIsoDate(proposal.createdAt)) throw new Error('invalid evolution proposal record');
  }
  if (input.type === 'evolution.candidate.accepted') {
    const artifact = payload.record;
    if (!isRecord(artifact) || typeof artifact.artifactId !== 'string' || artifact.artifactId.trim().length === 0 || artifact.schemaVersion !== 1 || typeof artifact.proposalId !== 'string' || artifact.proposalId.trim().length === 0 || (artifact.kind !== 'skill' && artifact.kind !== 'compiler-recipe') || artifact.status !== 'candidate' || !validApplicability(artifact.applicability) || typeof artifact.contentHash !== 'string' || artifact.contentHash.trim().length === 0 || !Array.isArray(artifact.lineage) || !artifact.lineage.every(validLineage) || typeof artifact.rationale !== 'string' || artifact.rationale.trim().length === 0 || !validIsoDate(artifact.createdAt)) throw new Error('invalid evolution candidate artifact');
  }
  if (['evolution.verified', 'evolution.published', 'evolution.rejected', 'evolution.deprecated', 'evolution.superseded'].includes(input.type)) {
    const transition = payload.transition;
    if (!isRecord(transition) || (transition.entity !== 'knowledge' && transition.entity !== 'deadend' && transition.entity !== 'skill' && transition.entity !== 'compiler-recipe' && transition.entity !== 'proposal') || typeof transition.entityId !== 'string' || transition.entityId.trim().length === 0 || !validEvolutionTransition(transition.from, transition.to) || typeof transition.reason !== 'string' || transition.reason.trim().length === 0 || (transition.supersedes !== undefined && !validLineage(transition.supersedes))) throw new Error('invalid evolution lifecycle transition');
    if ((input.type === 'evolution.verified' && transition.to !== 'verified') || (input.type === 'evolution.published' && transition.to !== 'published') || (input.type === 'evolution.rejected' && transition.to !== 'rejected') || (input.type === 'evolution.deprecated' && transition.to !== 'deprecated') || (input.type === 'evolution.superseded' && (transition.to !== 'superseded' || !validLineage(transition.supersedes)))) throw new Error('evolution lifecycle event does not match transition');
  }
  if (input.type === 'skill.materialized') {
    if (!validSkill(payload.record)) throw new Error('invalid skill record');
  }
  if (input.type === 'recipe.materialized') {
    if (!validRecipe(payload.record)) throw new Error('invalid compiler recipe record');
  }
  if (input.type === 'skill.invoked') {
    const invocation = payload.record;
    if (!isRecord(invocation)) throw new Error('skill invocation record is required');
    validEvolutionId(invocation.invocationId, 'invocation id');
    if (typeof invocation.skillId !== 'string' || invocation.skillId.trim().length === 0 || typeof invocation.callerEventId !== 'string' || invocation.callerEventId.trim().length === 0 || typeof invocation.inputHash !== 'string' || invocation.inputHash.trim().length === 0 || !validIsoDate(invocation.occurredAt)) throw new Error('invalid skill invocation record');
  }
  if (input.type === 'skill.outcome.recorded') {
    const outcome = payload.record;
    if (!isRecord(outcome)) throw new Error('skill outcome record is required');
    validEvolutionId(outcome.outcomeId, 'outcome id');
    if (typeof outcome.invocationId !== 'string' || outcome.invocationId.trim().length === 0 || typeof outcome.callerEventId !== 'string' || outcome.callerEventId.trim().length === 0 || (outcome.outcome !== 'success' && outcome.outcome !== 'failure' && outcome.outcome !== 'partial' && outcome.outcome !== 'irrelevant' && outcome.outcome !== 'unknown') || typeof outcome.summary !== 'string' || outcome.summary.trim().length === 0 || !validIsoDate(outcome.occurredAt)) throw new Error('invalid skill outcome record');
  }
}

function validateEventShape(event: unknown, projectId: string, file: string, line: number): asserts event is CognitionEvent {
  if (!isRecord(event)
    || event.schemaVersion !== 2
    || typeof event.eventId !== 'string'
    || event.eventId.length === 0
    || typeof event.type !== 'string'
    || !eventTypes.has(event.type)
    || !validIsoDate(event.occurredAt)
    || !validIsoDate(event.observedAt)
    || event.projectId !== projectId
    || !isRecord(event.source)
    || typeof event.source.kind !== 'string'
    || !sourceKinds.has(event.source.kind)
    || (event.source.instanceId !== undefined && typeof event.source.instanceId !== 'string')
    || (event.correlationId !== undefined && typeof event.correlationId !== 'string')
    || typeof event.idempotencyKey !== 'string'
    || event.idempotencyKey.length === 0
    || !validGitAnchor(event.git)
    || !isRecord(event.privacy)
    || (event.privacy.classification !== 'metadata' && event.privacy.classification !== 'redacted-text')
    || typeof event.privacy.redactionCount !== 'number'
    || !Number.isSafeInteger(event.privacy.redactionCount)
    || event.privacy.redactionCount < 0
    || !isRecord(event.payload)
    || (event.previousHash !== null && typeof event.previousHash !== 'string')
    || typeof event.hash !== 'string'
    || event.hash.length === 0) {
    throw new Error(`invalid journal record schema at ${file}:${line}`);
  }
}

async function recoverPartialTail(projectRoot: string): Promise<void> {
  const files = await journalFiles(projectRoot);
  const file = files.at(-1);
  if (!file || file.endsWith('.gz')) return;
  const filePath = path.join(cognitionJournalDirectory(projectRoot), file);
  const content = await readFile(filePath, 'utf8');
  if (content.endsWith('\n')) return;
  const boundary = content.lastIndexOf('\n');
  const tail = content.slice(boundary + 1);
  try {
    JSON.parse(tail);
    await appendFile(filePath, '\n', 'utf8');
  } catch {
    await truncate(filePath, boundary < 0 ? 0 : Buffer.byteLength(content.slice(0, boundary + 1), 'utf8'));
  }
}

export async function readJournal(startPath?: string, options: { allowPartialTail?: boolean; onProgress?: ProgressReporter } = {}): Promise<CognitionEvent[]> {
  const projectRoot = await resolveProjectRoot(startPath);
  const projectId = (await loadManifest(projectRoot)).projectId;
  const events: CognitionEvent[] = [];
  let previousHash: string | null = null;
  const files = await journalFiles(projectRoot);
  options.onProgress?.({ phase: 'verify-journal', completed: 0, total: files.length, unit: 'segments' });
  let completed = 0;
  for (const file of files) {
    const content = (await readSegment(projectRoot, file)).toString('utf8');
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      let event: CognitionEvent;
      try {
        event = JSON.parse(line) as CognitionEvent;
      } catch (error) {
        if (options.allowPartialTail !== false && file === files.at(-1) && !file.endsWith('.gz') && index === lines.length - 1 && !content.endsWith('\n')) break;
        throw new Error(`invalid journal record ${file}:${index + 1}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
      }
      validateEventShape(event, projectId, file, index + 1);
      validatePayloadBoundary(event);
      const { hash, ...withoutHash } = event;
      if (event.previousHash !== previousHash || hash !== eventHash(withoutHash)) {
        throw new Error(`invalid journal hash chain at ${file}:${index + 1}`);
      }
      previousHash = event.hash;
      events.push(event);
    }
    options.onProgress?.({ phase: 'verify-journal', completed: ++completed, total: files.length, unit: 'segments' });
  }
  return events;
}

export async function verifyJournal(startPath?: string): Promise<CognitionEvent[]> {
  return readJournal(startPath, { allowPartialTail: false });
}

export async function compactJournal(startPath?: string, options: { apply?: boolean; minBytes?: number; onProgress?: ProgressReporter } = {}) {
  const root = await resolveProjectRoot(startPath);
  const minBytes = options.minBytes ?? 1;
  if (!Number.isSafeInteger(minBytes) || minBytes < 0) throw new Error('minBytes must be a non-negative integer');
  const operation = async () => {
    const events = await readJournal(root, { allowPartialTail: false, onProgress: options.onProgress });
    const before = await journalStorage(root);
    const eligible = [];
    for (const file of await journalFiles(root)) {
      if (!file.endsWith('.gz') && (await readSegment(root, file)).length >= minBytes) eligible.push(file);
    }
    if (options.apply) {
      options.onProgress?.({ phase: 'archive', completed: 0, total: eligible.length, unit: 'segments' });
      for (const [index, file] of eligible.entries()) {
        await archiveSegment(root, file);
        options.onProgress?.({ phase: 'archive', completed: index + 1, total: eligible.length, unit: 'segments' });
      }
      // Complete deletion after an interrupted publication, but only after validation.
      for (const file of await journalFiles(root)) if (file.endsWith('.gz')) await archiveSegment(root, file);
      const replay = await readJournal(root, { allowPartialTail: false, onProgress: options.onProgress });
      if (replay.length !== events.length || replay.at(-1)?.hash !== events.at(-1)?.hash) throw new Error('journal replay changed during compaction');
    }
    const after = options.apply ? await journalStorage(root) : before;
    return { applied: options.apply === true, eligible, events: events.length, headHash: events.at(-1)?.hash ?? null,
      bytesBefore: before.bytes, bytesAfter: after.bytes, savedBytes: before.bytes - after.bytes, archives: after.archives };
  };
  return options.apply ? withLock(`${locksDirectory(root)}/cognition-journal.lock`, operation) : operation();
}

export async function appendEvent<T>(startPath: string | undefined, input: AppendEventInput<T>): Promise<{ event: CognitionEvent<T>; appended: boolean }> {
  return (await appendEvents(startPath, [input]))[0];
}

// One validation replay and one lock for a batch; every published line remains
// independently recoverable and retries retain the same idempotency semantics.
export async function appendEvents<T>(startPath: string | undefined, inputs: AppendEventInput<T>[]): Promise<Array<{ event: CognitionEvent<T>; appended: boolean }>> {
  for (const input of inputs) validatePayloadBoundary(input as AppendEventInput);
  if (!inputs.length) return [];
  const projectRoot = await resolveProjectRoot(startPath);
  return withLock(`${locksDirectory(projectRoot)}/cognition-journal.lock`, async () => {
    await recoverPartialTail(projectRoot);
    const existing = await readJournal(projectRoot);
    const byKey = new Map(existing.map((event) => [event.idempotencyKey, event]));
    const projectId = (await loadManifest(projectRoot)).projectId;
    const results: Array<{ event: CognitionEvent<T>; appended: boolean }> = [];
    for (const input of inputs) {
      const duplicate = byKey.get(input.idempotencyKey);
      if (duplicate) {
        const candidate = {
          type: input.type,
          source: input.source ?? { kind: 'cli' },
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
          git: input.git ?? { worktreeId: null, branch: null, ref: null, head: null },
          privacy: input.privacy ?? { classification: 'metadata', redactionCount: 0 },
          payload: input.payload,
        };
        const existingSemantic = {
          type: duplicate.type,
          source: duplicate.source,
          correlationId: duplicate.correlationId,
          idempotencyKey: duplicate.idempotencyKey,
          git: duplicate.git,
          privacy: duplicate.privacy,
          payload: duplicate.payload,
        };
        if (canonical(candidate) !== canonical(existingSemantic)) throw new Error(`idempotency key conflict: ${input.idempotencyKey}`);
        results.push({ event: duplicate as CognitionEvent<T>, appended: false });
        continue;
      }
      const now = new Date().toISOString();
      const eventWithoutHash: Omit<CognitionEvent<T>, 'hash'> = {
        eventId: input.eventId ?? eventId(),
        schemaVersion: 2,
        type: input.type,
        occurredAt: input.occurredAt ?? now,
        observedAt: now,
        projectId,
        source: input.source ?? { kind: 'cli' },
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        idempotencyKey: input.idempotencyKey,
        git: input.git ?? { worktreeId: null, branch: null, ref: null, head: null },
        privacy: input.privacy ?? { classification: 'metadata', redactionCount: 0 },
        payload: input.payload,
        previousHash: existing.at(-1)?.hash ?? null,
      };
      const event = { ...eventWithoutHash, hash: eventHash(eventWithoutHash) };
      const line = `${JSON.stringify(event)}\n`;
      if (['workspace.paths.changed', 'host.prompt.submitted', 'usage.operation.completed'].includes(input.type)) {
        let limit: number | undefined;
        try { limit = (await loadRuntimePolicy(projectRoot)).retentionMaxBytes; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (limit !== undefined && (await journalStorage(projectRoot)).bytes + Buffer.byteLength(line) > limit) {
          await recordAdmissionDrop(projectRoot, input.type);
          throw new Error('observation budget exceeded; semantic records remain writable');
        }
      }
      await appendJournalLine(projectRoot, line);
      existing.push(event as CognitionEvent);
      byKey.set(event.idempotencyKey, event as CognitionEvent);
      results.push({ event, appended: true });
    }
    return results;
  });
}
