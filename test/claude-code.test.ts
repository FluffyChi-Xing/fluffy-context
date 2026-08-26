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

const cli = path.resolve('dist/src/cli/main.js');

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-claude-'));
}

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
    assert.match(JSON.parse(session.stdout).additionalContext, /Orient → Plan → Implement → Verify → Handoff/);
    assert.match(JSON.parse(session.stdout).additionalContext, /Applicant authentication/);

    const prompt = await runCli(['hook', 'claude-code', 'user-prompt'], root, JSON.stringify({ cwd: root, prompt: 'Implement applicant authentication' }));
    assert.equal(prompt.code, 0);
    assert.equal(prompt.stderr, '');
    assert.match(JSON.parse(prompt.stdout).additionalContext, /Implement → Verify → Handoff/);
    assert.match(JSON.parse(prompt.stdout).additionalContext, /ctx note/);
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
    assert.match(JSON.parse(noContext.stdout).additionalContext, /没有可恢复的 Context/);

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
