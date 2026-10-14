import { appendEvent } from '../cognition/journal.js';
import { v2Enabled } from '../cognition/orient.js';
import { ensureRuntimeForSession, touchRuntime } from '../cognition/runtime.js';
import { loadRuntimePolicy } from '../cognition/policy.js';
import { readGitWorktreeState } from '../git/git-adapter.js';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { injectContext } from '../compiler/inject.js';
import { contentHash } from '../compiler/identity.js';
import { recordHostCapability, recordHostTrigger } from '../cognition/host-capabilities.js';

interface ClaudeCodeHookInput {
  cwd?: unknown;
  prompt?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  event_id?: unknown;
  eventId?: unknown;
  prompt_id?: unknown;
  agent_id?: unknown;
}

const HOOK_RESPONSE = '{}\n';

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function stableId(input: ClaudeCodeHookInput, name: 'session' | 'event'): string | undefined {
  return name === 'session' ? text(input.session_id) ?? text(input.sessionId) : text(input.prompt_id) ?? text(input.event_id) ?? text(input.eventId);
}

function eventIdentity(input: ClaudeCodeHookInput, event: 'session-start' | 'user-prompt', sessionId: string | undefined): string | undefined {
  const supplied = stableId(input, 'event');
  if (supplied) return supplied;
  // Zcode's UserPromptSubmit payload has a session_id and prompt but no
  // event_id. Derive a deterministic identity so the hook is observable and
  // retry-safe without persisting the prompt itself. Repeated identical
  // prompts in that host session intentionally collapse to one lifecycle
  // event because the host supplied no per-event identity.
  if (!sessionId) return undefined;
  return `derived:${event}:${sessionId}:${text(input.prompt) ?? ''}`;
}

function redactIntent(value: string): { intent: string; redactionCount: number } {
  let redactionCount = 0;
  const intent = value
    .replace(/(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, () => { redactionCount += 1; return '[REDACTED]'; })
    .replace(/\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_-]+\b/g, () => { redactionCount += 1; return '[REDACTED]'; });
  return { intent, redactionCount };
}

async function capture(event: 'session-start' | 'user-prompt', input: ClaudeCodeHookInput): Promise<void> {
  const cwd = text(input.cwd);
  const projectRoot = await resolveProjectRoot(cwd);
  if (!await v2Enabled(projectRoot)) return;
  const policy = await loadRuntimePolicy(projectRoot);
  const sessionId = stableId(input, 'session');
  const eventId = eventIdentity(input, event, sessionId);
  if (!sessionId || !eventId) return;
  const sessionHash = contentHash(sessionId);
  const eventHash = contentHash(eventId);
  await recordHostCapability(projectRoot, 'hook', 'claude-code');
  await recordHostTrigger(projectRoot, { interface: 'hook', adapter: 'claude-code', trigger: event, status: 'observed', sessionId, taskId: eventId, observationId: `${sessionId}:${eventId}` });
  const state = await readGitWorktreeState(projectRoot);
  const captured = event === 'user-prompt' ? redactIntent(compact(text(input.prompt) ?? '', policy.promptIntentMaxChars)) : { intent: '', redactionCount: 0 };
  await appendEvent(projectRoot, {
    type: event === 'session-start' ? 'host.session.started' : 'host.prompt.submitted',
    source: { kind: 'claude-hook', instanceId: sessionHash },
    correlationId: sessionHash,
    idempotencyKey: `claude-hook:${event}:${sessionHash}:${eventHash}`,
    git: { worktreeId: state.worktreeId, branch: state.branch, ref: state.ref, head: state.commit },
    privacy: { classification: captured.redactionCount > 0 || event === 'user-prompt' ? 'redacted-text' : 'metadata', redactionCount: captured.redactionCount },
    payload: event === 'user-prompt' ? { eventId: eventHash, intent: captured.intent } : { eventId: eventHash },
  });
}

async function maybeStartRuntime(input: ClaudeCodeHookInput): Promise<void> {
  await ensureRuntimeForSession(text(input.cwd), { source: 'claude-hook', timeoutMs: 1_000 });
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
    await maybeStartRuntime(input).catch(() => undefined);
    await touchRuntime(text(input.cwd)).catch(() => false);
    await capture(event, input).catch(() => undefined);
    await touchRuntime(text(input.cwd)).catch(() => false);
    const cwd = text(input.cwd);
    const rawSessionId = stableId(input, 'session')?.trim();
    const sessionId = rawSessionId ? contentHash({ session: rawSessionId, agent: text(input.agent_id) ?? null }) : undefined;
    const result = await injectContext(cwd, {
        query: compact(text(input.prompt) ?? '', 500) || undefined,
        scenario: event === 'session-start' ? 'resume' : undefined,
        trigger: event === 'session-start' ? 'session-start' : 'prompt',
        adapter: 'claude-code',
        sessionId,
        taskId: sessionId ? contentHash(text(input.prompt) ?? '') : undefined,
        resetSession: Boolean(sessionId) && event === 'session-start',
        maxChars: event === 'session-start' ? 1200 : 1800,
        knowledgeLimit: 5,
        deadendLimit: 3,
        noteLimit: 8,
      }, 'hook');
    if (result.delivery.mode === 'unchanged') return HOOK_RESPONSE;
    const guidance = event === 'session-start' ? 'Orient → Plan → Implement → Verify → Handoff' : 'Implement → Verify → Handoff';
    const update = result.delivery.replacePrevious ? '本次证据包替代先前的项目上下文；未再出现的旧证据不应继续作为当前依据。\n'
      : result.delivery.mode === 'delta' ? '以下是当前任务的新增项目证据。\n' : '';
    const additionalContext = `${guidance}\n将项目上下文作为证据；重要发现用 ctx note，阶段结束用 ctx checkpoint。\n${update}${result.status === 'no_context' ? '当前没有可恢复的 Context。\n' : ''}${result.text}`;
    return `${JSON.stringify({ hookSpecificOutput: {
      hookEventName: event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
      additionalContext,
    } })}\n`;
  } catch {
    return HOOK_RESPONSE;
  }
}
