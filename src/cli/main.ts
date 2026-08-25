#!/usr/bin/env node
import { checkpoint, resume } from '../runtime/runtime.js';
import { contextOrient } from '../agent/api.js';
import { runClaudeCodeHook } from '../hooks/claude-code.js';
import { inspectClaudeIntegration, installClaudeIntegration } from '../integrations/claude-code.js';
import { doctor, status } from '../runtime/diagnostics.js';
import { initProject } from '../runtime/init.js';
import { discoverKnowledge, learnKnowledge, listKnowledge, verifyKnowledge, recordDeadend, listDeadends, verifyDeadend } from '../runtime/knowledge.js';
import { addNote, listActivity, listNotes } from '../runtime/notes.js';
import type { ActivityQuery, CheckpointInput, DeadendInput, KnowledgeInput, NoteInput, NoteKind, NoteStatus, NoteActor } from '../runtime/types.js';
import { VERSION } from '../version.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`);
  return value;
}

function listOption(args: string[], name: string): string[] | undefined {
  const value = option(args, name);
  return value === undefined ? undefined : value.split(',').map((item) => item.trim()).filter(Boolean);
}

function positionals(args: string[], valueOptions: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('-')) {
      if (valueOptions.includes(args[index])) index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function validateOptions(args: string[], allowed: string[], valueOptions: string[] = []): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('-')) continue;
    if (!allowed.includes(argument)) throw new Error(`unknown option ${argument}`);
    if (valueOptions.includes(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`missing value for ${argument}`);
      index += 1;
    }
  }
}

function numericOption(args: string[], name: string, defaultValue: number): number {
  const value = option(args, name);
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function enumOption<T extends string>(args: string[], name: string, values: readonly T[]): T | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) throw new Error(`${name} must be one of: ${values.join(', ')}`);
  return value as T;
}

const HELP: Record<string, string> = {
  init: `usage: ctx init [path] [--path <path>]

Initialize the local .context runtime layout. Re-running init is safe.

Options:
  --path <path>  Project path`,
  checkpoint: `usage: ctx checkpoint [options]

Save structured work state as a baseline or incremental snapshot.

Options:
  --path <path>          Project path
  --context <id>         Existing context ID
  --title <text>         Context title
  --progress <text>      Current progress summary
  --last-error <text>    Last error (blank clears it)
  --completed <items>    Comma-separated completed items
  --pending <items>      Comma-separated pending tasks
  --decisions <items>    Comma-separated decisions
  --risks <items>        Comma-separated risks
  --files <paths>        Comma-separated related paths
  --absorb-notes         Mark open notes for this context as absorbed`,
  resume: `usage: ctx resume [options]

Resume the most relevant active or stable context.

Options:
  --path <path>          Project path
  --context <id>         Context ID
  --max-chars <number>   Maximum summary characters`,
  orient: `usage: ctx orient [query] [options]

Prepare bounded task context from the current work, verified consensus, matching deadends, and open notes.

Options:
  --path <path>              Project path
  --context <id>             Context ID
  --scope <scope>            Exact consensus scope
  --max-chars <number>       Maximum display characters
  --knowledge-limit <number> Maximum knowledge matches (default: 10)
  --deadend-limit <number>   Maximum deadend matches (default: 10)
  --note-limit <number>      Maximum open notes (default: 20)`,
  agent: `usage: ctx agent serve

Start an MCP stdio server for Agent integrations.

Run "ctx agent serve --help" for details.`,
  'agent serve': `usage: ctx agent serve

Start an MCP stdio server exposing the context_orient tool.

The server owns standard input/output; do not use it interactively.`,
  hook: `usage: ctx hook claude-code session-start|user-prompt

Run a Claude Code lifecycle hook. This command reads Hook JSON from standard input.`,
  'hook claude-code': `usage: ctx hook claude-code session-start|user-prompt

Emit best-effort, read-only phased Context guidance for Claude Code.`,
  integrate: `usage: ctx integrate claude inspect|install [--path <path>] [--apply]

Inspect or explicitly install project-local Claude Code hooks and MCP configuration.`,
  'integrate claude': `usage: ctx integrate claude inspect|install [--path <path>] [--apply]

Inspect configuration, or preview/install project-local Claude Code integration.`,
  'integrate claude inspect': `usage: ctx integrate claude inspect [--path <path>]

Report whether the project has the Claude Code hooks and MCP server configured.`,
  'integrate claude install': `usage: ctx integrate claude install [--path <path>] [--apply]

Preview configuration changes by default. Pass --apply to merge project-local .claude/settings.json and .mcp.json.`,
  status: `usage: ctx status [--path <path>]

Show the initialized project and context index.`,
  doctor: `usage: ctx doctor [--path <path>]

Check runtime files and snapshot integrity without modifying them.`,
  learn: `usage: ctx learn <statement> [options]

Record a candidate project knowledge item.

Options:
  --path <path>          Project path
  --kind <kind>          Knowledge kind
  --scope <scope>        Knowledge scope
  --context <id>         Source context ID
  --snapshot <id>        Source snapshot ID
  --evidence <items>     Comma-separated evidence references`,
  knowledge: `usage: ctx knowledge [--all] [--path <path>]
       ctx knowledge verify <knowledge-id> [--path <path>]
       ctx knowledge discover <query> [options]

List candidate/verified knowledge, verify one item, or discover matching knowledge.

Options:
  --all                  Include unverified items
  --path <path>          Project path`,
  'knowledge verify': `usage: ctx knowledge verify <knowledge-id> [--path <path>]

Mark a knowledge item as verified.`,
  'knowledge discover': `usage: ctx knowledge discover <query> [options]

Find matching project knowledge using deterministic lexical and alias rules.

Options:
  --path <path>          Project path
  --scope <scope>        Exact knowledge scope
  --status <statuses>    Comma-separated candidate/verified/deprecated/rejected
  --all                  Include all knowledge statuses
  --limit <number>       Maximum matches (default: 10)
  --max-chars <number>   Maximum text characters per match`,
  deadend: `usage: ctx deadend [attempt] [options]
       ctx deadend verify <deadend-id> [--path <path>]

Record or verify a candidate deadend.

Options:
  --path <path>          Project path
  --attempt <text>       Attempt description
  --reason <text>        Why it failed
  -m <text>              Alias for --reason
  --scope <scope>        Deadend scope
  --context <id>         Source context ID
  --snapshot <id>        Source snapshot ID
  --evidence <items>     Comma-separated evidence references`,
  'deadend verify': `usage: ctx deadend verify <deadend-id> [--path <path>]

Mark a deadend as verified.`,
  deadends: `usage: ctx deadends [--all] [--path <path>]

List recorded deadends.`,
  note: `usage: ctx note add <message> [options]
       ctx note list [options]

Agent-facing short-term notes for problems, actions, observations, and decisions.

Run \"ctx note add --help\" or \"ctx note list --help\" for details.`,
  'note add': `usage: ctx note add <message> [options]

Append a short note without creating a Context Snapshot.

Options:
  --path <path>          Project path
  --kind <kind>          problem|action|observation|decision
  --context <id>         Context ID
  --snapshot <id>        Snapshot ID
  --files <paths>        Comma-separated related paths
  --actor <actor>        agent|human
  --status <status>      open|resolved`,
  'note list': `usage: ctx note list [options]

List recent notes for an Agent or integration.

Options:
  --path <path>          Project path
  --context <id>         Context ID
  --open                 Only unresolved and unabsorbed notes
  --limit <number>       Maximum notes (default: 50)
  --max-chars <number>   Maximum message characters`,
  activity: `usage: ctx activity [options]

Show a Human-oriented timeline of notes and saved checkpoints.

Options:
  --path <path>          Project path
  --context <id>         Context ID
  --since <ISO>          Only activity at or after this time
  --open                 Only open notes
  --limit <number>       Maximum items (default: 50)
  --max-chars <number>   Maximum message characters`,
};

function usage(): string {
  return `usage: ctx init|checkpoint|resume|orient|agent|hook|integrate|status|doctor|learn|knowledge|deadend|deadends|note|activity [options]

Run \"ctx <command> --help\" for command details.`;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function stdin(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) value += chunk.toString();
  return value;
}

function printHelp(args: string[]): boolean {
  const command = args[0];
  if (!command) {
    process.stdout.write(`${usage()}\n`);
    return true;
  }
  const key = args[1] === 'verify' || args[1] === 'add' || args[1] === 'list' || args[1] === 'discover' || args[1] === 'serve' || args[1] === 'claude' ? `${command} ${args[1]}` : command;
  const nestedKey = key === 'integrate claude' && (args[2] === 'inspect' || args[2] === 'install') ? `${key} ${args[2]}` : key;
  const help = HELP[nestedKey];
  if (!help) return false;
  if (args.includes('--help')) {
    process.stdout.write(`${help}\n`);
    return true;
  }
  return false;
}

function validatePositionals(values: string[], max: number, usageText: string): void {
  if (values.length > max) throw new Error(usageText);
}

async function run(args: string[]): Promise<void> {
  if (args.includes('--version')) {
    print(VERSION);
    return;
  }
  if (args.length === 0 || args[0] === '--help') {
    printHelp([]);
    return;
  }
  if (args.includes('--help') && printHelp(args)) return;

  const command = args[0];
  const target = option(args, '--path');
  switch (command) {
    case 'init': {
      validateOptions(args.slice(1), ['--path'], ['--path']);
      const values = positionals(args.slice(1), ['--path']);
      validatePositionals(values, 1, HELP.init);
      print(await initProject(target ?? values[0]));
      return;
    }
    case 'checkpoint': {
      validateOptions(args.slice(1), ['--path', '--context', '--title', '--progress', '--last-error', '--completed', '--pending', '--decisions', '--risks', '--files', '--absorb-notes'], ['--path', '--context', '--title', '--progress', '--last-error', '--completed', '--pending', '--decisions', '--risks', '--files']);
      validatePositionals(positionals(args.slice(1), ['--path', '--context', '--title', '--progress', '--last-error', '--completed', '--pending', '--decisions', '--risks', '--files']), 0, HELP.checkpoint);
      const input: CheckpointInput = {
        contextId: option(args, '--context'),
        absorbNotes: args.includes('--absorb-notes'),
        title: option(args, '--title'),
        progressSummary: option(args, '--progress'),
        lastError: option(args, '--last-error'),
        completed: listOption(args, '--completed'),
        pendingTasks: listOption(args, '--pending'),
        decisions: listOption(args, '--decisions'),
        risks: listOption(args, '--risks'),
        relatedFiles: listOption(args, '--files'),
      };
      print(await checkpoint(target, input));
      return;
    }
    case 'resume':
      validateOptions(args.slice(1), ['--path', '--context', '--max-chars'], ['--path', '--context', '--max-chars']);
      validatePositionals(positionals(args.slice(1), ['--path', '--context', '--max-chars']), 0, HELP.resume);
      print(await resume(target, option(args, '--context'), numericOption(args, '--max-chars', 4000)));
      return;
    case 'orient': {
      const valueOptions = ['--path', '--context', '--scope', '--max-chars', '--knowledge-limit', '--deadend-limit', '--note-limit'];
      validateOptions(args.slice(1), valueOptions, valueOptions);
      const query = positionals(args.slice(1), valueOptions);
      validatePositionals(query, 1, HELP.orient);
      print(await contextOrient(target, {
        contextId: option(args, '--context'),
        query: query[0],
        scope: option(args, '--scope'),
        maxChars: numericOption(args, '--max-chars', 4000),
        knowledgeLimit: numericOption(args, '--knowledge-limit', 10),
        deadendLimit: numericOption(args, '--deadend-limit', 10),
        noteLimit: numericOption(args, '--note-limit', 20),
      }));
      return;
    }
    case 'agent':
      if (args[1] !== 'serve') throw new Error(HELP.agent);
      validateOptions(args.slice(2), [], []);
      validatePositionals(positionals(args.slice(2), []), 0, HELP['agent serve']);
      await import('../mcp/main.js');
      return;
    case 'hook': {
      if (args[1] !== 'claude-code' || !['session-start', 'user-prompt'].includes(args[2])) throw new Error(HELP['hook claude-code']);
      validateOptions(args.slice(3), [], []);
      validatePositionals(positionals(args.slice(3), []), 0, HELP['hook claude-code']);
      process.stdout.write(await runClaudeCodeHook(args[2] as 'session-start' | 'user-prompt', await stdin()));
      return;
    }
    case 'integrate': {
      if (args[1] !== 'claude' || !['inspect', 'install'].includes(args[2])) throw new Error(HELP['integrate claude']);
      const valueOptions = ['--path'];
      const allowed = args[2] === 'install' ? [...valueOptions, '--apply'] : valueOptions;
      validateOptions(args.slice(3), allowed, valueOptions);
      validatePositionals(positionals(args.slice(3), valueOptions), 0, HELP[`integrate claude ${args[2]}`]);
      if (args[2] === 'inspect') print(await inspectClaudeIntegration(target));
      else print(await installClaudeIntegration(target, args.includes('--apply')));
      return;
    }
    case 'status':
      validateOptions(args.slice(1), ['--path'], ['--path']);
      validatePositionals(positionals(args.slice(1), ['--path']), 0, HELP.status);
      print(await status(target));
      return;
    case 'doctor':
      validateOptions(args.slice(1), ['--path'], ['--path']);
      validatePositionals(positionals(args.slice(1), ['--path']), 0, HELP.doctor);
      print(await doctor(target));
      return;
    case 'learn': {
      const valueOptions = ['--path', '--kind', '--scope', '--context', '--snapshot', '--evidence'];
      validateOptions(args.slice(1), valueOptions, valueOptions);
      const statement = positionals(args.slice(1), valueOptions);
      if (statement.length === 0) throw new Error(HELP.learn);
      const input: KnowledgeInput = {
        kind: option(args, '--kind'),
        scope: option(args, '--scope'),
        sourceContextId: option(args, '--context'),
        sourceSnapshotId: option(args, '--snapshot'),
        evidence: listOption(args, '--evidence'),
      };
      print(await learnKnowledge(target, statement.join(' '), input));
      return;
    }
    case 'note': {
      if (args[1] === 'add') {
        const valueOptions = ['--path', '--kind', '--context', '--snapshot', '--files', '--actor', '--status'];
        validateOptions(args.slice(2), valueOptions, valueOptions);
        const values = positionals(args.slice(2), valueOptions);
        if (values.length === 0) throw new Error(HELP['note add']);
        const input: NoteInput = {
          kind: enumOption(args, '--kind', ['problem', 'action', 'observation', 'decision'] as const) as NoteKind | undefined,
          actor: enumOption(args, '--actor', ['agent', 'human'] as const) as NoteActor | undefined,
          contextId: option(args, '--context'),
          snapshotId: option(args, '--snapshot'),
          relatedFiles: listOption(args, '--files'),
          status: enumOption(args, '--status', ['open', 'resolved'] as const) as NoteStatus | undefined,
        };
        print(await addNote(target, values.join(' '), input));
      } else if (args[1] === 'list') {
        const valueOptions = ['--path', '--context', '--limit', '--max-chars'];
        validateOptions(args.slice(2), [...valueOptions, '--open'], valueOptions);
        validatePositionals(positionals(args.slice(2), valueOptions), 0, HELP['note list']);
        print(await listNotes(target, { contextId: option(args, '--context'), openOnly: args.includes('--open'), limit: numericOption(args, '--limit', 50), maxChars: numericOption(args, '--max-chars', 500) }));
      } else {
        throw new Error(HELP.note);
      }
      return;
    }
    case 'activity': {
      const valueOptions = ['--path', '--context', '--since', '--limit', '--max-chars'];
      validateOptions(args.slice(1), [...valueOptions, '--open'], valueOptions);
      validatePositionals(positionals(args.slice(1), valueOptions), 0, HELP.activity);
      const query: ActivityQuery = {
        contextId: option(args, '--context'),
        since: option(args, '--since'),
        openOnly: args.includes('--open'),
        limit: numericOption(args, '--limit', 50),
        maxChars: numericOption(args, '--max-chars', 500),
      };
      print(await listActivity(target, query));
      return;
    }
    case 'knowledge': {
      if (args[1] === 'discover') {
        const valueOptions = ['--path', '--scope', '--status', '--limit', '--max-chars'];
        validateOptions(args.slice(2), [...valueOptions, '--all'], valueOptions);
        const query = positionals(args.slice(2), valueOptions);
        if (query.length === 0) throw new Error(HELP['knowledge discover']);
        const statuses = args.includes('--all') ? ['candidate', 'verified', 'deprecated', 'rejected'] : (listOption(args, '--status') ?? ['verified']);
        if (statuses.some((status) => !['candidate', 'verified', 'deprecated', 'rejected'].includes(status))) throw new Error('--status contains an invalid knowledge status');
        print(await discoverKnowledge(target, query.join(' '), {
          scope: option(args, '--scope'),
          statuses: statuses as import('../runtime/types.js').KnowledgeStatus[],
          limit: numericOption(args, '--limit', 10),
          maxChars: numericOption(args, '--max-chars', 4000),
        }));
      } else if (args[1] === 'verify') {
        validateOptions(args.slice(2), ['--path'], ['--path']);
        const values = positionals(args.slice(2), ['--path']);
        if (values.length !== 1) throw new Error(HELP['knowledge verify']);
        print(await verifyKnowledge(target, values[0]));
      } else {
        validateOptions(args.slice(1), ['--all', '--path'], ['--path']);
        validatePositionals(positionals(args.slice(1), ['--path']), 0, HELP.knowledge);
        print(await listKnowledge(target, args.includes('--all')));
      }
      return;
    }
    case 'deadend':
      if (args[1] === 'verify') {
        validateOptions(args.slice(2), ['--path'], ['--path']);
        const values = positionals(args.slice(2), ['--path']);
        if (values.length !== 1) throw new Error(HELP['deadend verify']);
        print(await verifyDeadend(target, values[0]));
      } else {
        const valueOptions = ['--path', '--attempt', '--reason', '-m', '--scope', '--context', '--snapshot', '--evidence'];
        validateOptions(args.slice(1), valueOptions, valueOptions);
        const values = positionals(args.slice(1), valueOptions);
        validatePositionals(values, 1, HELP.deadend);
        const input: DeadendInput = {
          scope: option(args, '--scope'),
          sourceContextId: option(args, '--context'),
          sourceSnapshotId: option(args, '--snapshot'),
          evidence: listOption(args, '--evidence'),
        };
        print(await recordDeadend(target, option(args, '--attempt') ?? values[0], option(args, '--reason') ?? option(args, '-m') ?? '', input));
      }
      return;
    case 'deadends':
      validateOptions(args.slice(1), ['--all', '--path'], ['--path']);
      validatePositionals(positionals(args.slice(1), ['--path']), 0, HELP.deadends);
      print(await listDeadends(target, args.includes('--all')));
      return;
    default:
      throw new Error(usage());
  }
}

run(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
