import type { ResumeSummary, StructuredContext } from './types.js';

/** Render work state without inventing verification or rewriting old snapshots. */
export function summarizeContext(content: StructuredContext, maxChars: number, branchOrCommitDrift = false): ResumeSummary {
  let remaining = Math.max(0, maxChars);
  const text = (value: string): string => {
    const result = value.length <= remaining ? value : remaining ? `${value.slice(0, remaining - 1)}…` : '';
    remaining -= result.length;
    return result;
  };
  const list = (values: string[]) => values.flatMap((value) => remaining > 0 ? [text(value)] : []);
  return {
    ...(content.objective === undefined ? {} : { objective: text(content.objective) }),
    ...(content.constraints === undefined ? {} : { constraints: list(content.constraints) }),
    progressSummary: text(content.progressSummary),
    lastError: content.lastError === null ? null : text(content.lastError),
    pendingTasks: list(content.pendingTasks),
    ...(content.openQuestions === undefined ? {} : { openQuestions: list(content.openQuestions) }),
    ...(content.validationRefs === undefined ? {} : { validationRefs: list(content.validationRefs) }),
    completed: list(content.completed), decisions: list(content.decisions),
    risks: list(content.risks), relatedFiles: list(content.relatedFiles), branchOrCommitDrift,
  };
}
