import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { isRecord, readJson } from '../storage/json-store.js';
import { manifestPath } from '../storage/layout.js';

const cliPath = fileURLToPath(new URL('../cli/main.js', import.meta.url));
const cliCommand = `"${process.execPath}" "${cliPath}"`;
const HOOK_COMMANDS = {
  sessionStart: `${cliCommand} hook claude-code session-start`,
  userPrompt: `${cliCommand} hook claude-code user-prompt`,
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
}

export interface ClaudeIntegrationInstallResult extends ClaudeIntegrationStatus {
  applied: boolean;
  targetFiles: string[];
}

function object(value: unknown): JsonObject {
  return isRecord(value) ? { ...value } : {};
}

function hookInstalled(value: unknown, command: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((group) => isRecord(group)
    && Array.isArray(group.hooks)
    && group.hooks.some((hook) => isRecord(hook) && hook.type === 'command' && hook.command === command));
}

function addHook(value: unknown, command: string, legacyCommand: string, relocatedCommand?: string): JsonObject[] {
  const groups = Array.isArray(value) ? value.filter(isRecord).map((group) => ({ ...group })) : [];
  if (hookInstalled(groups, command)) return groups;
  let replaced = false;
  const updated = groups.map((group) => ({
    ...group,
    hooks: Array.isArray(group.hooks)
      ? group.hooks.map((hook) => {
        if (!isRecord(hook) || hook.type !== 'command' || (hook.command !== legacyCommand && hook.command !== relocatedCommand)) return hook;
        replaced = true;
        return { ...hook, command };
      })
      : group.hooks,
  }));
  return replaced ? updated : [...updated, { hooks: [{ type: 'command', command }] }];
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
  const sessionStartInstalled = hookInstalled(hooks.SessionStart, HOOK_COMMANDS.sessionStart);
  const userPromptInstalled = hookInstalled(hooks.UserPromptSubmit, HOOK_COMMANDS.userPrompt);
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
  return { status: status(projectRoot, settingsPath, mcpPath, settings, mcp, settingsExists, mcpExists, initialized, relocated !== undefined), settings, mcp, relocated };
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
  const settings = {
    ...inspected.settings,
    hooks: {
      ...settingsHooks,
      SessionStart: addHook(settingsHooks.SessionStart, HOOK_COMMANDS.sessionStart, LEGACY_HOOK_COMMANDS.sessionStart, inspected.relocated ? `${inspected.relocated} hook claude-code session-start` : undefined),
      UserPromptSubmit: addHook(settingsHooks.UserPromptSubmit, HOOK_COMMANDS.userPrompt, LEGACY_HOOK_COMMANDS.userPrompt, inspected.relocated ? `${inspected.relocated} hook claude-code user-prompt` : undefined),
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
