import { readFile, stat } from 'node:fs/promises';

export const EFFECTIVENESS_TASKS = ['resume', 'repeated-error', 'cross-file-change', 'branch-switch', 'conflicting-knowledge'] as const;
export type EffectivenessTask = typeof EFFECTIVENESS_TASKS[number];

interface TaskRun {
  task: EffectivenessTask;
  variant: 'control' | 'context';
  repositoryCommit: string;
  model: string;
  acceptanceId: string;
  success: boolean;
  testsPassed: boolean;
  durationMs: number;
  retries: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  evidenceUsedIds?: string[];
}

export interface EffectivenessInput { schemaVersion: 1; runs: TaskRun[]; }
export interface EffectivenessReport {
  schemaVersion: 1;
  sampleCount: number;
  missingTasks: EffectivenessTask[];
  pairs: Array<{ task: EffectivenessTask; control: TaskRun; context: TaskRun; durationDeltaMs: number; retryDelta: number; providerTokenDelta: number | null; providerTokenQuality: 'measured' | 'unavailable'; evidenceUsedCount: number }>;
  aggregate: { controlSuccesses: number; contextSuccesses: number; correctnessRegressions: number; controlTestsPassed: number; contextTestsPassed: number; durationDeltaMs: number; retryDelta: number; providerTokenDelta: number | null; providerTokenPairs: number; evidenceUsedCount: number };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function run(value: unknown): value is TaskRun {
  if (!record(value)) return false;
  const keys = new Set(['task', 'variant', 'repositoryCommit', 'model', 'acceptanceId', 'success', 'testsPassed', 'durationMs', 'retries', 'providerInputTokens', 'providerOutputTokens', 'evidenceUsedIds']);
  return Object.keys(value).every((key) => keys.has(key))
    && EFFECTIVENESS_TASKS.includes(value.task as EffectivenessTask)
    && (value.variant === 'control' || value.variant === 'context')
    && ['repositoryCommit', 'model', 'acceptanceId'].every((key) => typeof value[key] === 'string' && (value[key] as string).trim().length > 0 && (value[key] as string).length <= 256)
    && typeof value.success === 'boolean' && typeof value.testsPassed === 'boolean'
    && nonnegative(value.durationMs) && nonnegative(value.retries)
    && (value.providerInputTokens === undefined || nonnegative(value.providerInputTokens))
    && (value.providerOutputTokens === undefined || nonnegative(value.providerOutputTokens))
    && (value.evidenceUsedIds === undefined || (Array.isArray(value.evidenceUsedIds) && value.evidenceUsedIds.length <= 100 && value.evidenceUsedIds.every((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 256)));
}

export function evaluateEffectiveness(input: unknown): EffectivenessReport {
  if (!record(input) || input.schemaVersion !== 1 || !Array.isArray(input.runs) || input.runs.length > 100 || !input.runs.every(run)) throw new Error('invalid effectiveness input');
  const grouped = new Map<EffectivenessTask, Partial<Record<TaskRun['variant'], TaskRun>>>();
  for (const item of input.runs) {
    const pair = grouped.get(item.task) ?? {};
    if (pair[item.variant]) throw new Error(`duplicate effectiveness run: ${item.task}/${item.variant}`);
    pair[item.variant] = item;
    grouped.set(item.task, pair);
  }
  const pairs: EffectivenessReport['pairs'] = [];
  for (const task of EFFECTIVENESS_TASKS) {
    const pair = grouped.get(task);
    if (!pair) continue;
    if (!pair.control || !pair.context) throw new Error(`unpaired effectiveness task: ${task}`);
    const { control, context } = pair;
    if (control.repositoryCommit !== context.repositoryCommit || control.model !== context.model || control.acceptanceId !== context.acceptanceId) throw new Error(`incompatible effectiveness baseline: ${task}`);
    const tokens = (item: TaskRun) => item.providerInputTokens !== undefined && item.providerOutputTokens !== undefined ? item.providerInputTokens + item.providerOutputTokens : null;
    const controlTokens = tokens(control);
    const contextTokens = tokens(context);
    pairs.push({ task, control, context, durationDeltaMs: context.durationMs - control.durationMs, retryDelta: context.retries - control.retries,
      providerTokenDelta: controlTokens === null || contextTokens === null ? null : contextTokens - controlTokens,
      providerTokenQuality: controlTokens === null || contextTokens === null ? 'unavailable' : 'measured',
      evidenceUsedCount: context.evidenceUsedIds?.length ?? 0 });
  }
  const providerPairs = pairs.filter((pair) => pair.providerTokenDelta !== null);
  return { schemaVersion: 1, sampleCount: pairs.length, missingTasks: EFFECTIVENESS_TASKS.filter((task) => !grouped.has(task)), pairs,
    aggregate: { controlSuccesses: pairs.filter((pair) => pair.control.success).length, contextSuccesses: pairs.filter((pair) => pair.context.success).length,
      correctnessRegressions: pairs.filter((pair) => pair.control.success && !pair.context.success).length,
      controlTestsPassed: pairs.filter((pair) => pair.control.testsPassed).length, contextTestsPassed: pairs.filter((pair) => pair.context.testsPassed).length,
      durationDeltaMs: pairs.reduce((sum, pair) => sum + pair.durationDeltaMs, 0), retryDelta: pairs.reduce((sum, pair) => sum + pair.retryDelta, 0),
      providerTokenDelta: providerPairs.length ? providerPairs.reduce((sum, pair) => sum + pair.providerTokenDelta!, 0) : null,
      providerTokenPairs: providerPairs.length, evidenceUsedCount: pairs.reduce((sum, pair) => sum + pair.evidenceUsedCount, 0) } };
}

export async function evaluateEffectivenessFile(file: string): Promise<EffectivenessReport> {
  if ((await stat(file)).size > 1024 * 1024) throw new Error('effectiveness input exceeds 1 MiB');
  return evaluateEffectiveness(JSON.parse(await readFile(file, 'utf8')));
}
