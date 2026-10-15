import type { ContextCandidate, ContextCompileOptions, ContextExpandInput, ContextManifest } from './types.js';

export function boundedItems<T>(items: T[], maxChars: number): { items: T[]; usedChars: number; omitted: number } {
  const selected: T[] = [];
  let usedChars = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (usedChars + size > maxChars) continue;
    selected.push(item);
    usedChars += size;
  }
  return { items: selected, usedChars, omitted: items.length - selected.length };
}

/** Each reference is a complete context_expand argument object, scoped to its project. */
export function expansionReferences(manifest: ContextManifest, selected: ContextCandidate[], options: ContextCompileOptions, maxChars: number) {
  const compile: ContextCompileOptions = {};
  for (const key of ['contextId', 'recipeId', 'graphHops', 'query', 'scenario', 'scope', 'paths', 'maxChars', 'knowledgeLimit', 'deadendLimit', 'noteLimit', 'activityLimit', 'trigger', 'adapter', 'sessionId', 'eventId'] as const) {
    if (options[key] !== undefined) Object.assign(compile, { [key]: options[key] });
  }
  const candidates = selected.filter((item) => item.expandable).sort((a, b) => Number(b.truncated) - Number(a.truncated)
    || Number(b.section === 'knowledge' || b.section === 'deadend') - Number(a.section === 'knowledge' || a.section === 'deadend'));
  return boundedItems(candidates.map((item): ContextExpandInput & { path: string } => ({ path: manifest.projectRoot,
    manifestHash: manifest.identity.manifestHash, candidateId: item.candidateId, itemHash: item.itemHash,
    level: 'evidence', maxChars: 4000, compile })), maxChars);
}

export function handoffDescriptor(manifest: ContextManifest, selected: ContextCandidate[]) {
  if (!['resume', 'handoff'].includes(manifest.intent.scenario) || !manifest.context || !manifest.snapshot
    || !selected.some((item) => item.source.kind === 'current-context')) return null;
  const fields = ['objective', 'constraints', 'validationRefs', 'openQuestions', 'pendingTasks'] as const;
  return { schemaVersion: 1, contextId: manifest.context.id, snapshotId: manifest.snapshot.snapshotId,
    branch: manifest.snapshot.branch, commit: manifest.snapshot.commit,
    validation: 'recorded-references-only; current working tree is not verified',
    fields: Object.fromEntries(fields.map((field) => [field,
      !manifest.resumeSummary?.[field]?.length ? 'not-recorded'
        : selected.some((item) => item.matchedFields.includes(field)) ? selected.some((item) => item.matchedFields.includes(field) && item.truncated) || manifest.excluded.some((item) => item.reason === 'budget' && item.candidateId.includes(`:${field}:`)) ? 'partial-in-text' : 'in-text' : 'omitted-by-budget'])),
  };
}
