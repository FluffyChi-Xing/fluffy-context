import { resolveProjectRoot } from '../project/project-resolver.js';
import { readGitWorktreeState } from '../git/git-adapter.js';
import { appendEvent, readJournal } from './journal.js';
import { v2Enabled } from './orient.js';
import { rebuildProjections } from './projections.js';
import { buildRetrievalProjection } from './retrieval.js';

export interface RecordUseInput {
  entity: 'knowledge' | 'deadend';
  entityId: string;
  eventId: string;
}

export async function recordUse(startPath: string | undefined, input: RecordUseInput): Promise<{ recorded: boolean; eventId: string }> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!input.eventId.trim()) throw new Error('feedback event ID must not be empty');
  if (!await v2Enabled(projectRoot)) throw new Error('record use requires an enabled v2 runtime');
  const events = await readJournal(projectRoot);
  const entry = buildRetrievalProjection(events).entries[`${input.entity}:${input.entityId}`];
  if (!entry) throw new Error(`${input.entity} not found in v2 retrieval: ${input.entityId}`);
  if (entry.status !== 'verified') throw new Error(`record use requires verified ${input.entity}: ${input.entityId}`);
  const git = await readGitWorktreeState(projectRoot);
  const result = await appendEvent(projectRoot, {
    type: 'record.used',
    source: { kind: 'cli' },
    idempotencyKey: `record-use:${input.entity}:${input.entityId}:${input.eventId.trim()}`,
    git: { worktreeId: git.worktreeId, branch: git.branch, ref: git.ref, head: git.commit },
    payload: { feedbackId: input.eventId.trim(), entity: input.entity, entityId: input.entityId, outcome: 'used' },
  });
  if (result.appended) await rebuildProjections(projectRoot);
  return { recorded: result.appended, eventId: result.event.eventId };
}
