import { contextOrient } from '../agent/api.js';
import type { ContextOrientReadyResult } from '../agent/types.js';

interface ClaudeCodeHookInput {
  cwd?: unknown;
  prompt?: unknown;
}

const HOOK_RESPONSE = '{}\n';

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function lines(label: string, values: string[], limit: number): string[] {
  return values.slice(0, limit).map((value) => `- ${label}: ${compact(value, 240)}`);
}

function readyContext(result: ContextOrientReadyResult): string[] {
  const content = [
    `当前 Context：${compact(result.context.title, 160)}`,
    `进度：${compact(result.resumeSummary.progressSummary, 360)}`,
    ...lines('待办', result.resumeSummary.pendingTasks, 4),
    ...lines('决策', result.resumeSummary.decisions, 3),
    ...lines('风险', result.resumeSummary.risks, 3),
    ...result.knowledge.hits.slice(0, 5).map((hit) => `- 已验证知识：${compact(hit.knowledge.statement, 240)}`),
    ...result.deadends.hits.slice(0, 3).map((hit) => `- 已验证死路（避免）：${compact(hit.deadend.attempt, 180)}；${compact(hit.deadend.reason, 180)}`),
    ...result.notes.slice(0, 8).map((note) => `- 开放 Note：${compact(note.message, 220)}`),
  ];
  if (result.truncated) content.push('- 上下文已按预算截断；需要时使用 context_orient 或 ctx orient 进一步查询。');
  return content;
}

function sessionContext(result: Awaited<ReturnType<typeof contextOrient>>): string {
  const phases = [
    '开发阶段：Orient → Plan → Implement → Verify → Handoff。',
    '先基于以下上下文明确计划；实现中记录重要观察/决策/阻塞为 ctx note；验证后显式 ctx checkpoint，总结完成、待办、决策和风险。不要自动保存 Snapshot。',
  ];
  if (result.status === 'no_context') {
    phases.push('当前没有可恢复的 Context。开始有意义的工作后，使用 ctx checkpoint 创建一个。');
  } else {
    phases.push(...readyContext(result));
  }
  return phases.join('\n');
}

function promptContext(result: Awaited<ReturnType<typeof contextOrient>>): string {
  const phases = [
    '开发阶段：Implement → Verify → Handoff。',
    '实现时用 ctx note 记录重要观察、决策或阻塞；完成后运行适用的验证。阶段结束时显式 ctx checkpoint（可 --absorb-notes），不要由 Hook 自动保存。',
  ];
  if (result.status === 'no_context') {
    phases.push('当前没有可恢复的 Context；如果这项工作会继续，先建立 checkpoint。');
  } else {
    phases.push(...readyContext(result));
  }
  return phases.join('\n');
}

async function parseInput(raw: string): Promise<ClaudeCodeHookInput | null> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' ? value as ClaudeCodeHookInput : null;
  } catch {
    return null;
  }
}

export async function runClaudeCodeHook(event: 'session-start' | 'user-prompt', raw: string): Promise<string> {
  const input = await parseInput(raw);
  if (!input) return HOOK_RESPONSE;
  try {
    const cwd = text(input.cwd);
    const result = event === 'session-start'
      ? await contextOrient(cwd, { maxChars: 1200, noteLimit: 8 })
      : await contextOrient(cwd, {
        query: compact(text(input.prompt) ?? '', 500) || undefined,
        maxChars: 1800,
        knowledgeLimit: 5,
        deadendLimit: 3,
        noteLimit: 8,
      });
    const additionalContext = event === 'session-start' ? sessionContext(result) : promptContext(result);
    return `${JSON.stringify({ additionalContext })}\n`;
  } catch {
    return HOOK_RESPONSE;
  }
}
