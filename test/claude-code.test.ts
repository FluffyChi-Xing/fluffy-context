import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { inspectClaudeIntegration, installClaudeIntegration } from '../src/integrations/claude-code.js';
import { initProject } from '../src/runtime/init.js';
import { atomicWriteJson } from '../src/storage/atomic-write.js';
import { cognitionPolicyPath } from '../src/storage/layout.js';
import { saveContext } from '../src/agent/api.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { enableRuntime, runtimeStatus, serveRuntime, stopRuntime } from '../src/cognition/runtime.js';
import { readJournal } from '../src/cognition/journal.js';
import { learnKnowledge, verifyKnowledge, transitionKnowledge } from '../src/runtime/knowledge.js';

const cli = path.resolve('dist/src/cli/main.js');

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-claude-'));
}

test('Claude session IDs deduplicate across processes, isolate subagents, and reset after compact', async () => {
  const root = await project();
  try {
    await initProject(root);
    const candidate = await learnKnowledge(root, 'Payment idempotency prevents duplicate charges.');
    await verifyKnowledge(root, candidate.knowledgeId);
    const prompt = { cwd: root, session_id: 'claude-session', prompt_id: 'prompt-one', prompt: 'payment' };
    const call = async (event: string, input: object) => {
      const response = await runCli(['hook', 'claude-code', event], root, JSON.stringify(input));
      assert.equal(response.code, 0, response.stderr);
      return JSON.parse(response.stdout);
    };
    const first = await call('user-prompt', prompt);
    assert.match(first.hookSpecificOutput.additionalContext, /idempotency/);
    assert.deepEqual(await call('user-prompt', { ...prompt, prompt_id: 'prompt-two' }), {});
    const subagent = await call('user-prompt', { ...prompt, agent_id: 'worker' });
    assert.match(subagent.hookSpecificOutput.additionalContext, /idempotency/);
    await call('session-start', { cwd: root, session_id: 'claude-session', source: 'compact' });
    assert.match((await call('user-prompt', prompt)).hookSpecificOutput.additionalContext, /idempotency/);
    const longPrompt = 'payment '.repeat(80);
    await call('user-prompt', { ...prompt, prompt: `${longPrompt}task-A` });
    assert.ok((await call('user-prompt', { ...prompt, prompt: `${longPrompt}task-B` })).hookSpecificOutput);
    await transitionKnowledge(root, candidate.knowledgeId, 'deprecated', 'Revised invariant');
    const retracted = await call('user-prompt', { ...prompt, prompt: `${longPrompt}task-B` });
    assert.match(retracted.hookSpecificOutput.additionalContext, /替代先前/);
    assert.doesNotMatch(retracted.hookSpecificOutput.additionalContext, /idempotency/);
    // Official prompt_id can be captured without the nonstandard event_id field.
    await importV1(root);
    await enableRuntime(root);
    await call('user-prompt', prompt);
    assert.ok((await readJournal(root)).some((event) => event.type === 'host.prompt.submitted' && event.payload.eventId === 'prompt-one'));
  } finally {
    await stopRuntime(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function runCli(args: string[], cwd: string, input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('Claude Code hooks inject bounded phase guidance without modifying context state', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await saveContext(root, {
      title: 'Applicant authentication',
      progressSummary: 'Implement the new entry point',
      pendingTasks: ['Add integration coverage'],
      decisions: ['Reuse the existing flow'],
      risks: ['Callbacks can repeat'],
    });
    assert.equal(saved.result.status, 'saved');
    if (saved.result.status !== 'saved') return;
    const contextPath = path.join(root, '.context', 'contexts', saved.result.context.id, 'context.json');
    const indexPath = path.join(root, '.context', 'index.json');
    const beforeContext = await readFile(contextPath, 'utf8');
    const beforeIndex = await readFile(indexPath, 'utf8');

    const session = await runCli(['hook', 'claude-code', 'session-start'], root, JSON.stringify({ cwd: root }));
    assert.equal(session.code, 0);
    assert.equal(session.stderr, '');
    assert.equal(JSON.parse(session.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(JSON.parse(session.stdout).hookSpecificOutput.additionalContext, /Orient → Plan → Implement → Verify → Handoff/);
    assert.match(JSON.parse(session.stdout).hookSpecificOutput.additionalContext, /Applicant authentication/);

    const prompt = await runCli(['hook', 'claude-code', 'user-prompt'], root, JSON.stringify({ cwd: root, prompt: 'Implement applicant authentication' }));
    assert.equal(prompt.code, 0);
    assert.equal(prompt.stderr, '');
    assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /Implement → Verify → Handoff/);
    assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /ctx note/);
    assert.equal(await readFile(contextPath, 'utf8'), beforeContext);
    assert.equal(await readFile(indexPath, 'utf8'), beforeIndex);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude Code hooks keep a running runtime alive', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initProject(root);
    await saveContext(root, { title: 'Hook context', progressSummary: 'Capture host event' });
    await importV1(root);
    await enableRuntime(root);
    const policy = JSON.parse(await readFile(cognitionPolicyPath(root), 'utf8'));
    await atomicWriteJson(cognitionPolicyPath(root), { ...policy, inactivityTimeoutMs: 5_000, allowHookStartup: false });
    runtime = await serveRuntime(root, { inactivityTimeoutMs: 5_000, heartbeatIntervalMs: 100, pollIntervalMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const result = await runCli(['hook', 'claude-code', 'user-prompt'], root, JSON.stringify({ cwd: root, session_id: 'session-keepalive', event_id: 'event-keepalive', prompt: 'continue work' }));
    assert.equal(result.code, 0);
    assert.equal((await runtimeStatus(root)).running, true);
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    assert.equal((await runtimeStatus(root)).running, true);
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude Code hooks capture redacted host events with stable identifiers', async () => {
  const root = await project();
  try {
    await initProject(root);
    await saveContext(root, { title: 'Hook context', progressSummary: 'Capture host event' });
    await importV1(root);
    await enableRuntime(root);
    const input = JSON.stringify({ cwd: root, session_id: 'session-1', event_id: 'event-1', prompt: 'Use token=secret-value to finish the task' });
    const first = await runCli(['hook', 'claude-code', 'user-prompt'], root, input);
    const second = await runCli(['hook', 'claude-code', 'user-prompt'], root, input);
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    const events = await readJournal(root);
    const captured = events.filter((event) => event.type === 'host.prompt.submitted');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].privacy.classification, 'redacted-text');
    assert.equal(captured[0].privacy.redactionCount, 1);
    assert.match(JSON.stringify(captured[0].payload), /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(captured[0].payload), /secret-value/);
    await stopRuntime(root);
  } finally {
    await stopRuntime(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Claude Code hooks start migrated runtime without stable host identifiers', async () => {
  const root = await project();
  try {
    await initProject(root);
    await saveContext(root, { title: 'Hook context', progressSummary: 'Start runtime' });
    await importV1(root);
    const result = await runCli(['hook', 'claude-code', 'session-start'], root, JSON.stringify({ cwd: root }));
    assert.equal(result.code, 0);
    assert.equal((await runtimeStatus(root)).running, true);
    const events = await readJournal(root);
    assert.equal(events.some((event) => event.type === 'host.session.started'), false);
  } finally {
    await stopRuntime(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Claude Code hooks fail open for missing context and malformed input', async () => {
  const root = await project();
  try {
    await initProject(root);
    const noContext = await runCli(['hook', 'claude-code', 'session-start'], root, JSON.stringify({ cwd: root }));
    assert.equal(noContext.code, 0);
    assert.match(JSON.parse(noContext.stdout).hookSpecificOutput.additionalContext, /没有可恢复的 Context/);

    const malformed = await runCli(['hook', 'claude-code', 'user-prompt'], root, '{');
    assert.equal(malformed.code, 0);
    assert.equal(malformed.stderr, '');
    assert.deepEqual(JSON.parse(malformed.stdout), {});

    const uninitialized = await project();
    try {
      const missing = await runCli(['hook', 'claude-code', 'user-prompt'], uninitialized, JSON.stringify({ cwd: uninitialized, prompt: 'work' }));
      assert.equal(missing.code, 0);
      assert.deepEqual(JSON.parse(missing.stdout), {});
    } finally {
      await rm(uninitialized, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude integration previews, applies idempotently, and preserves unrelated configuration', async () => {
  const root = await project();
  try {
    await initProject(root);
    const before = await installClaudeIntegration(root, false);
    assert.equal(before.applied, false);
    assert.equal(before.installationNeeded, true);
    await assert.rejects(() => readdir(path.join(root, '.claude')), /ENOENT/);

    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'existing' } } }), 'utf8');
    await mkdir(path.join(root, '.claude'));
    await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing hook' }] }] } }), 'utf8');

    const applied = await installClaudeIntegration(root, true);
    assert.equal(applied.applied, true);
    assert.equal(applied.installationNeeded, false);
    const repeated = await installClaudeIntegration(root, true);
    assert.equal(repeated.applied, false);

    const settings = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    const mcp = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Read'] });
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'existing hook');
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    assert.equal(mcp.mcpServers.existing.command, 'existing');
    assert.deepEqual(mcp.mcpServers['fluffy-context'], { command: process.execPath, args: [cli, 'agent', 'serve'] });

    const inspected = await inspectClaudeIntegration(root);
    assert.equal(inspected.installationNeeded, false);

    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'fluffy-context': { command: 'ctx', args: ['agent', 'serve'] } } }), 'utf8');
    await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'ctx hook claude-code session-start' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'ctx hook claude-code user-prompt' }] }],
    } }), 'utf8');
    const upgraded = await installClaudeIntegration(root, true);
    assert.equal(upgraded.applied, true);
    const upgradedSettings = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    const upgradedMcp = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
    assert.equal(upgradedSettings.hooks.SessionStart.length, 1);
    assert.equal(upgradedSettings.hooks.UserPromptSubmit.length, 1);
    assert.deepEqual(upgradedMcp.mcpServers['fluffy-context'], { command: process.execPath, args: [cli, 'agent', 'serve'] });

    // Repair an exec-form hook only when its path is attested by our MCP install.
    upgradedSettings.hooks.UserPromptSubmit[0].hooks = [
      { type: 'command', command: process.execPath, args: [cli, 'hook', 'claude-code', 'user-prompt'], timeout: 12 },
      { type: 'command', command: 'custom-user-hook' },
    ];
    await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify(upgradedSettings));
    assert.equal((await installClaudeIntegration(root, true)).applied, true);
    const repaired = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
    const repairedHooks = repaired.hooks.UserPromptSubmit[0].hooks;
    assert.equal(repaired.hooks.UserPromptSubmit.length, 1);
    assert.equal(repairedHooks[0].args, undefined);
    assert.equal(repairedHooks[0].timeout, 12);
    assert.equal(repairedHooks[1].command, 'custom-user-hook');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude integration refuses malformed and conflicting configuration', async () => {
  const root = await project();
  try {
    await writeFile(path.join(root, '.mcp.json'), '{', 'utf8');
    await assert.rejects(() => inspectClaudeIntegration(root));

    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'fluffy-context': { command: 'other' } } }), 'utf8');
    await assert.rejects(() => installClaudeIntegration(root, true), /conflicts/);

    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: [] }), 'utf8');
    await assert.rejects(() => installClaudeIntegration(root, true), /MCP servers must be an object/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('integration diagnostics distinguish configuration from delivery and generated hooks use the legacy shell contract', async () => {
  const root = await project();
  try {
    await initProject(root);
    await installClaudeIntegration(root, true);
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    const handler = settings.hooks.UserPromptSubmit[0].hooks[0];
    assert.equal(handler.command, `"${process.execPath}" "${cli}" hook claude-code user-prompt`);
    assert.equal(handler.args, undefined, 'Claude 2.1.12 does not support exec-form args');
    const configured = await inspectClaudeIntegration(root);
    assert.ok(configured.checks.every((check) => check.ok));
    assert.equal(configured.observation?.lastLocalInvocation, null);
    assert.equal(configured.observation?.hostAcceptance, 'not-observed');
    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const child = spawn(handler.command, [], { cwd: root, windowsHide: true, shell: true });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, output }));
      child.stdin.end(JSON.stringify({ cwd: root, session_id: 'generated-config', prompt: 'work' }));
    });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.output).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok((await inspectClaudeIntegration(root)).observation?.lastLocalInvocation);
    settings.disableAllHooks = true;
    settings.hooks.SessionStart[0].matcher = 'startup';
    settings.hooks.UserPromptSubmit[0].hooks[0].async = true;
    await writeFile(settingsPath, JSON.stringify(settings));
    const before = await readFile(settingsPath, 'utf8');
    const blocked = await inspectClaudeIntegration(root);
    assert.equal(blocked.installationNeeded, false);
    assert.deepEqual(blocked.checks.filter((check) => !check.ok).map((check) => check.name), ['project-hooks-enabled', 'session-start', 'user-prompt']);
    await installClaudeIntegration(root, true);
    assert.equal(await readFile(settingsPath, 'utf8'), before, 'custom disable/matcher/async settings remain user-owned');
    const diagnostic = await runCli(['doctor', '--integrations'], root);
    assert.equal(diagnostic.code, 0);
    assert.equal(JSON.parse(diagnostic.stdout).integrations.claude.observation.hostAcceptance, 'not-observed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
