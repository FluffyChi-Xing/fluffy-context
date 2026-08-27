import { compileContext } from './compile.js';
import { extractActivity } from './activity.js';
import { validateManifestIdentity } from './identity.js';
import { readJournal } from '../cognition/journal.js';
import { projectEvents, workspaceKey } from '../cognition/projections.js';
import type {
  ContextCandidate,
  ContextExpandInput,
  ContextExpandLevel,
  ContextExpandResult,
  ContextManifest,
  ContextSourceDescriptor,
} from './types.js';
import { rebuildSnapshot } from '../runtime/runtime.js';
import { listDeadends, listKnowledge } from '../runtime/knowledge.js';
import { listNotes } from '../runtime/notes.js';
import type { Deadend, Knowledge, Note, RecordApplicability, StructuredContext } from '../runtime/types.js';

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  if (maxChars <= 0) return { text: '', truncated: true };
  return { text: `${value.slice(0, maxChars - 1)}…`, truncated: true };
}

function isExpandLevel(value: string): value is ContextExpandLevel {
  return value === 'structured' || value === 'evidence';
}

function validateInput(input: ContextExpandInput): void {
  if (!input.manifestHash.trim()) throw new Error('context expand manifest hash must not be empty');
  if (!input.candidateId?.trim() && !input.itemHash?.trim()) throw new Error('context expand requires candidateId or itemHash');
  if (!isExpandLevel(input.level)) throw new Error('context expand level must be structured or evidence');
  if (input.maxChars !== undefined && (!Number.isSafeInteger(input.maxChars) || input.maxChars < 0)) throw new Error('context expand maxChars must be a non-negative integer');
}

function selectedCandidate(manifest: ContextManifest, input: ContextExpandInput): ContextCandidate {
  const byId = input.candidateId ? manifest.selected.find((item) => item.candidateId === input.candidateId) : undefined;
  const byHash = input.itemHash ? manifest.selected.find((item) => item.itemHash === input.itemHash) : undefined;
  if (byId && byHash && byId.candidateId !== byHash.candidateId) throw new Error('context expand candidate selectors do not match');
  const candidate = byId ?? byHash;
  if (!candidate) throw new Error('context expand candidate not selected');
  if (!candidate.expandable) throw new Error('context expand candidate is not expandable');
  if (candidate.level !== 'summary') throw new Error('context expand candidate is already expanded');
  return candidate;
}

function contextField(content: StructuredContext, candidate: ContextCandidate): unknown {
  const field = (candidate.content as { field?: unknown }).field;
  if (typeof field !== 'string') throw new Error('context expand current context field is invalid');
  if (field === 'title') return (candidate.content as { value?: unknown }).value ?? '';
  if (field === 'progressSummary' || field === 'lastError') return content[field];
  if (field === 'pendingTasks' || field === 'completed' || field === 'decisions' || field === 'risks' || field === 'relatedFiles') {
    const discriminator = candidate.candidateId.split(':').at(-1) ?? '';
    const index = Number(discriminator);
    const values = content[field];
    if (!Number.isInteger(index) || index < 0 || index >= values.length) throw new Error(`context expand current context item is unavailable: ${field}`);
    return values[index];
  }
  throw new Error(`context expand unsupported current context field: ${field}`);
}

function currentContextText(value: unknown, candidate: ContextCandidate): string {
  const field = (candidate.content as { field?: unknown }).field;
  if (typeof field !== 'string') throw new Error('context expand current context field is invalid');
  return `${field}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}`;
}

function recordText(source: ContextSourceDescriptor, value: Note | Knowledge | Deadend): string {
  if (source.kind === 'note') {
    const note = value as Note;
    return `${note.kind}: ${note.message}`;
  }
  if (source.kind === 'knowledge') return (value as Knowledge).statement;
  const deadend = value as Deadend;
  return `${deadend.attempt}: ${deadend.reason}`;
}

function evidenceText(source: ContextSourceDescriptor, value: unknown, structuredText: string): string {
  return `${structuredText}\nevidence: ${JSON.stringify({
    source: source.provenance,
    ...(source.kind === 'knowledge' ? { supportingEvidence: (value as Knowledge).supportingEvidence } : {}),
    ...(source.kind === 'deadend' ? { observedEvidence: (value as Deadend).observedEvidence } : {}),
    ...(source.kind === 'note' ? { relatedFiles: (value as Note).relatedFiles } : {}),
  })}`;
}

function recordApplicability(value: unknown): RecordApplicability | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const applicability = (value as { applicability?: unknown }).applicability;
  if (!applicability || typeof applicability !== 'object' || Array.isArray(applicability)) return undefined;
  return applicability as RecordApplicability;
}

function ensureApplicable(source: ContextSourceDescriptor, value: unknown, manifest: ContextManifest): void {
  const applicability = recordApplicability(value);
  if (!applicability) return;
  if (applicability.branchMode !== source.applicability.branchMode) throw new Error(`context expand source applicability changed: ${source.entityId}`);
  if (applicability.branchMode === 'exact') {
    const branch = manifest.anchor.ref ?? manifest.anchor.branch ?? 'detached';
    const branches = (applicability.branches ?? []).map((item) => item.toLowerCase());
    if (branches.length > 0 && !branches.includes(branch.toLowerCase()) && !branches.includes((manifest.anchor.branch ?? '').toLowerCase())) throw new Error(`context expand source is not applicable: ${source.entityId}`);
    if (applicability.sourceCommit && applicability.sourceCommit !== manifest.anchor.head) throw new Error(`context expand source commit is not applicable: ${source.entityId}`);
    if (source.applicability.worktreeId && source.applicability.worktreeId !== manifest.anchor.worktreeId) throw new Error(`context expand source worktree is not applicable: ${source.entityId}`);
    if (source.applicability.ref && source.applicability.ref !== manifest.anchor.ref) throw new Error(`context expand source ref is not applicable: ${source.entityId}`);
  }
  if (source.scope && typeof (value as { scope?: unknown }).scope === 'string' && source.scope !== (value as { scope: string }).scope) throw new Error(`context expand source scope changed: ${source.entityId}`);
  const paths = applicability.paths ?? [];
  if (source.paths.length > 0 && paths.length > 0 && !source.paths.some((path) => paths.includes(path))) throw new Error(`context expand source paths changed: ${source.entityId}`);
}

async function resolveCandidate(projectRoot: string, manifest: ContextManifest, candidate: ContextCandidate, level: ContextExpandLevel): Promise<{ content: unknown; text: string }> {
  const source = candidate.source;
  if (source.kind === 'current-context') {
    if (!source.contextId || !source.snapshotId) throw new Error('context expand current context source is incomplete');
    const content = await rebuildSnapshot(projectRoot, source.contextId, source.snapshotId);
    const value = contextField(content, candidate);
    const text = currentContextText(value, candidate);
    return { content: level === 'evidence' ? { field: (candidate.content as { field: string }).field, value, source: source.provenance } : { field: (candidate.content as { field: string }).field, value }, text: level === 'evidence' ? evidenceText(source, { value }, text) : text };
  }
  if (source.kind === 'note') {
    const note = (await listNotes(projectRoot, { contextId: source.contextId ?? undefined, limit: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER })).find((item) => item.noteId === source.entityId);
    if (!note) throw new Error(`context expand note not found: ${source.entityId}`);
    const text = recordText(source, note);
    return { content: level === 'evidence' ? { ...note, provenance: source.provenance } : note, text: level === 'evidence' ? evidenceText(source, note, text) : text };
  }
  if (source.kind === 'knowledge') {
    const knowledge = (await listKnowledge(projectRoot, true)).find((item) => item.knowledgeId === source.entityId);
    if (!knowledge || knowledge.status !== 'verified') throw new Error(`context expand knowledge is no longer verified: ${source.entityId}`);
    ensureApplicable(source, knowledge, manifest);
    const text = recordText(source, knowledge);
    return { content: level === 'evidence' ? { ...knowledge, provenance: source.provenance } : knowledge, text: level === 'evidence' ? evidenceText(source, knowledge, text) : text };
  }
  if (source.kind === 'deadend') {
    const deadend = (await listDeadends(projectRoot, true)).find((item) => item.deadendId === source.entityId);
    if (!deadend || deadend.status !== 'verified') throw new Error(`context expand deadend is no longer verified: ${source.entityId}`);
    ensureApplicable(source, deadend, manifest);
    const text = recordText(source, deadend);
    return { content: level === 'evidence' ? { ...deadend, provenance: source.provenance } : deadend, text: level === 'evidence' ? evidenceText(source, deadend, text) : text };
  }
  if (source.kind === 'journal') {
    const events = manifest.provenance.journalRead ? await readJournal(projectRoot) : [];
    const projection = events.length > 0 ? projectEvents(events) : null;
    const workspace = projection?.workspaces[workspaceKey(manifest.anchor)] ?? null;
    const records = await extractActivity(projectRoot, events, manifest.anchor, workspace, Number.MAX_SAFE_INTEGER);
    const activity = records.find((item) => item.eventId === source.entityId);
    if (!activity) throw new Error(`context expand activity not found: ${source.entityId}`);
    return { content: activity, text: `activity: ${activity.changes.map((change) => `${change.path} (${change.kind})`).join(', ')}` };
  }
  throw new Error(`context expand source kind is not supported: ${source.kind}`);
}

export async function expandContext(startPath: string | undefined, input: ContextExpandInput): Promise<ContextExpandResult> {
  validateInput(input);
  const manifest = await compileContext(startPath, input.compile);
  if (!validateManifestIdentity(manifest) || manifest.identity.manifestHash !== input.manifestHash) throw new Error('context expand manifest hash mismatch');
  const candidate = selectedCandidate(manifest, input);
  const resolved = await resolveCandidate(manifest.projectRoot, manifest, candidate, input.level);
  const limited = truncateText(resolved.text, input.maxChars ?? Number.MAX_SAFE_INTEGER);
  const content = limited.truncated ? null : resolved.content;
  const requestedChars = input.maxChars ?? resolved.text.length;
  return {
    status: limited.truncated ? 'partial' : 'complete',
    projectRoot: manifest.projectRoot,
    manifestHash: manifest.identity.manifestHash,
    candidateId: candidate.candidateId,
    itemHash: candidate.itemHash,
    previousLevel: candidate.level,
    requestedLevel: input.level,
    resolvedLevel: input.level,
    source: candidate.source,
    content,
    text: limited.text,
    budget: { requestedChars, usedChars: limited.text.length, remainingChars: Math.max(0, requestedChars - limited.text.length), truncated: limited.truncated },
    provenance: manifest.provenance,
  };
}
