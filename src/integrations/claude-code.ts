import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { isRecord, readJson } from '../storage/json-store.js';
import { manifestPath } from '../storage/layout.js';
import { inspectInjectionSession } from '../compiler/session.js';

const cliPath = fileURLToPath(new URL('../cli/main.js', import.meta.url));
const cliCommand = `"${process.execPath}" "${cliPath}"`;
const HOOK_COMMANDS = {
  sessionStart: `${cliCommand} hook claude-code session-start`,
  userPrompt: `${cliCommand} hook claude-code user-prompt`,
};
const HOOK_HANDLERS = {
  // Keep the shell command contract supported by Claude Code 2.1.12.
  // Older hosts silently discard the newer exec-form args field.
  sessionStart: { type: 'command', command: HOOK_COMMANDS.sessionStart },
  userPrompt: { type: 'command', command: HOOK_COMMANDS.userPrompt },
};
const LEGACY_HOOK_COMMANDS = {
  sessionStart: 'ctx hook claude-code session-start',
  userPrompt: 'ctx hook claude-code user-prompt',
};
const MCP_SERVER = { command: process.execPath, args: [cliPath, 'agent', 'serve'] };
const LEGACY_MCP_SERVER = { command: 'ctx', args: ['agent', 'serve'] };

type JsonObject = Record<string, unknown>;

export interface ClaudeIntegrationStatus {
  projectRoot: string;
  initialized: boolean;
  settingsPath: string;
  mcpPath: string;
  settingsExists: boolean;
  mcpExists: boolean;
  sessionStartInstalled: boolean;
  userPromptInstalled: boolean;
  mcpInstalled: boolean;
  mcpConflict: boolean;
  installationNeeded: boolean;
  capabilities: { automaticInjection: string[]; sessionIdentity: string; missingSession: string; mcp: string; projectGuidance: string };
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  observation?: Awaited<ReturnType<typeof inspectInjectionSession>>;
  nextSteps: string[];
}

export interface ClaudeIntegrationInstallResult extends ClaudeIntegrationStatus {
  applied: boolean;
  targetFiles: string[];
}

function object(value: unknown): JsonObject {
  return isRecord(value) ? { ...value } : {};
}

type HookHandler = { type: string; command: string; args?: string[] };

function sameHandler(hook: unknown, handler: HookHandler): boolean {
  return isRecord(hook) && hook.type === 'command' && hook.command === handler.command
    && (handler.args === undefined ? hook.args === undefined
      : Array.isArray(hook.args) && hook.args.length === handler.args.length && hook.args.every((arg, i) => arg === handler.args![i]));
}

function hookInstalled(value: unknown, handler: typeof HOOK_HANDLERS.sessionStart): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((group) => isRecord(group)
    && Array.isArray(group.hooks)
    && group.hooks.some((hook) => sameHandler(hook, handler)));
}

function addHook(value: unknown, handler: HookHandler, previousCommands: Array<string | undefined>, previousHandler?: HookHandler): JsonObject[] {
  const groups = Array.isArray(value) ? value.filter(isRecord).map((group) => ({ ...group })) : [];
  if (hookInstalled(groups, handler)) return groups;
  let replaced = false;
  const updated = groups.map((group) => ({
    ...group,
    hooks: Array.isArray(group.hooks)
      ? group.hooks.map((hook) => {
        if (!isRecord(hook) || hook.type !== 'command' || typeof hook.command !== 'string'
          || (!previousCommands.includes(hook.command) && !(previousHandler && sameHandler(hook, previousHandler)))) return hook;
        replaced = true;
        const migrated = { ...hook, ...handler };
        delete migrated.args;
        return migrated;
      })
      : group.hooks,
  }));
  return replaced ? updated : [...updated, { hooks: [handler] }];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadObject(filePath: string): Promise<JsonObject> {
  if (!await exists(filePath)) return {};
  return readJson<JsonObject>(filePath, isRecord);
}

function validateConfig(settings: JsonObject, mcp: JsonObject): void {
  if (settings.hooks !== undefined && !isRecord(settings.hooks)) throw new Error('Claude Code settings hooks must be an object');
  const hooks = object(settings.hooks);
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`Claude Code ${event} hooks must be an array`);
  }
  if (mcp.mcpServers !== undefined && !isRecord(mcp.mcpServers)) throw new Error('Claude Code MCP servers must be an object');
}

function mcpInstalled(value: unknown, server = MCP_SERVER): boolean {
  return isRecord(value)
    && value.command === server.command
    && Array.isArray(value.args)
    && value.args.length === server.args.length
    && value.args.every((item, index) => item === server.args[index]);
}

function status(projectRoot: string, settingsPath: string, mcpPath: string, settings: JsonObject, mcp: JsonObject, settingsExists: boolean, mcpExists: boolean, initialized: boolean, relocatable = false): ClaudeIntegrationStatus {
  const hooks = object(settings.hooks);
  const sessionStartInstalled = hookInstalled(hooks.SessionStart, HOOK_HANDLERS.sessionStart);
  const userPromptInstalled = hookInstalled(hooks.UserPromptSubmit, HOOK_HANDLERS.userPrompt);
  const mcpServers = object(mcp.mcpServers);
  const configuredMcp = mcpServers['fluffy-context'];
  const installed = mcpInstalled(configuredMcp);
  const mcpConflict = configuredMcp !== undefined && !installed && !mcpInstalled(configuredMcp, LEGACY_MCP_SERVER) && !relocatable;
  return {
    projectRoot,
    initialized,
    settingsPath,
    mcpPath,
    settingsExists,
    mcpExists,
    sessionStartInstalled,
    userPromptInstalled,
    mcpInstalled: installed,
    mcpConflict,
    installationNeeded: !sessionStartInstalled || !userPromptInstalled || !installed,
    capabilities: { automaticInjection: ['SessionStart', 'UserPromptSubmit'], sessionIdentity: 'session_id (agent_id isolates subagents)', missingSession: 'full context; no deduplication', mcp: 'explicit tool calls; not a lifecycle hook', projectGuidance: 'best-effort instructions; host execution is not guaranteed' },
    checks: [],
    nextSteps: [],
  };
}

async function relocatedCommand(value: unknown): Promise<string | undefined> {
  if (!isRecord(value) || typeof value.command !== 'string' || !path.isAbsolute(value.command)
    || !/^node(?:\.exe)?$/i.test(path.basename(value.command)) || !Array.isArray(value.args)
    || value.args.length !== 3 || value.args[1] !== 'agent' || value.args[2] !== 'serve'
    || typeof value.args[0] !== 'string' || !path.isAbsolute(value.args[0])) return;
  const entry = value.args[0];
  const packageRoot = path.resolve(path.dirname(entry), '../../..');
  if (path.normalize(entry) !== path.join(packageRoot, 'dist', 'src', 'cli', 'main.js')) return;
  try {
    const pkg = await readJson<JsonObject>(path.join(packageRoot, 'package.json'), isRecord);
    if (pkg.name !== 'fluffy-context' || !isRecord(pkg.bin) || pkg.bin.ctx !== 'dist/src/cli/main.js') return;
    await access(entry);
    return `"${value.command}" "${entry}"`;
  } catch { return; }
}

async function inspect(projectRoot: string): Promise<{ status: ClaudeIntegrationStatus; settings: JsonObject; mcp: JsonObject; relocated?: string }> {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const mcpPath = path.join(projectRoot, '.mcp.json');
  const [settingsExists, mcpExists, initialized] = await Promise.all([
    exists(settingsPath),
    exists(mcpPath),
    exists(manifestPath(projectRoot)),
  ]);
  const [settings, mcp] = await Promise.all([loadObject(settingsPath), loadObject(mcpPath)]);
  validateConfig(settings, mcp);
  const relocated = await relocatedCommand(object(mcp.mcpServers)['fluffy-context']);
  const result = status(projectRoot, settingsPath, mcpPath, settings, mcp, settingsExists, mcpExists, initialized, relocated !== undefined);
  const hooks = object(settings.hooks);
  const compatibleHook = (value: unknown, handler: typeof HOOK_HANDLERS.sessionStart) => Array.isArray(value) && value.some((group) => isRecord(group)
    && (group.matcher === undefined || group.matcher === '' || group.matcher === '*')
    && Array.isArray(group.hooks) && group.hooks.some((hook) => sameHandler(hook, handler) && isRecord(hook) && hook.async !== true && hook.asyncRewake !== true));
  result.checks = [
    { name: 'node', ok: await exists(process.execPath), detail: process.execPath },
    { name: 'cli', ok: await exists(cliPath), detail: cliPath },
    { name: 'project-hooks-enabled', ok: settings.disableAllHooks !== true, detail: 'Project settings only; user, local, managed and command-line overrides are not evaluated.' },
    { name: 'session-start', ok: compatibleHook(hooks.SessionStart, HOOK_HANDLERS.sessionStart), detail: 'Requires an unrestricted synchronous SessionStart hook for startup/resume/clear/compact.' },
    { name: 'user-prompt', ok: compatibleHook(hooks.UserPromptSubmit, HOOK_HANDLERS.userPrompt), detail: 'Requires a synchronous UserPromptSubmit hook.' },
    { name: 'mcp', ok: result.mcpInstalled, detail: 'Configuration only; host connection and workspace trust require host verification.' },
  ];
  result.observation = await inspectInjectionSession(projectRoot, 'hook:claude-code');
  if (result.mcpConflict) result.nextSteps.push('Resolve the conflicting fluffy-context MCP configuration before installing.');
  else if (result.installationNeeded) result.nextSteps.push('Preview ctx integrate claude install, then apply with --apply.');
  if (settings.disableAllHooks === true) result.nextSteps.push('Hooks are disabled by project preference; enable them in Claude settings if intended.');
  if (result.checks.some((check) => !check.ok) && !result.installationNeeded) result.nextSteps.push('Review hook matchers and async settings; inspection does not overwrite custom settings.');
  result.nextSteps.push('In Claude, check workspace trust and /hooks, reconnect MCP, and inspect the debug log after a new session and prompt. Local invocation receipts do not prove host acceptance.');
  return { status: result, settings, mcp, relocated };
}

export async function inspectClaudeIntegration(startPath: string | undefined): Promise<ClaudeIntegrationStatus> {
  const projectRoot = await resolveProjectRoot(startPath);
  return (await inspect(projectRoot)).status;
}

export async function installClaudeIntegration(startPath: string | undefined, apply: boolean): Promise<ClaudeIntegrationInstallResult> {
  const projectRoot = await resolveProjectRoot(startPath);
  const inspected = await inspect(projectRoot);
  const targetFiles = [inspected.status.settingsPath, inspected.status.mcpPath];
  if (!apply || !inspected.status.installationNeeded) return { ...inspected.status, applied: false, targetFiles };
  if (inspected.status.mcpConflict) throw new Error('existing fluffy-context MCP server configuration conflicts with the generated integration');

  const settingsHooks = object(inspected.settings.hooks);
  const priorMcp = object(object(inspected.mcp.mcpServers)['fluffy-context']);
  const priorHandler = (event: string) => inspected.relocated
    ? { type: 'command', command: priorMcp.command as string, args: [(priorMcp.args as string[])[0], 'hook', 'claude-code', event] } : undefined;
  const settings = {
    ...inspected.settings,
    hooks: {
      ...settingsHooks,
      SessionStart: addHook(settingsHooks.SessionStart, HOOK_HANDLERS.sessionStart, [HOOK_COMMANDS.sessionStart, LEGACY_HOOK_COMMANDS.sessionStart, inspected.relocated ? `${inspected.relocated} hook claude-code session-start` : undefined], priorHandler('session-start')),
      UserPromptSubmit: addHook(settingsHooks.UserPromptSubmit, HOOK_HANDLERS.userPrompt, [HOOK_COMMANDS.userPrompt, LEGACY_HOOK_COMMANDS.userPrompt, inspected.relocated ? `${inspected.relocated} hook claude-code user-prompt` : undefined], priorHandler('user-prompt')),
    },
  };
  const mcpServers = object(inspected.mcp.mcpServers);
  const mcp = {
    ...inspected.mcp,
    mcpServers: { ...mcpServers, 'fluffy-context': { ...object(mcpServers['fluffy-context']), ...MCP_SERVER } },
  };
  await Promise.all([
    atomicWriteJson(inspected.status.settingsPath, settings),
    atomicWriteJson(inspected.status.mcpPath, mcp),
  ]);
  return { ...(await inspect(projectRoot)).status, applied: true, targetFiles };
}
