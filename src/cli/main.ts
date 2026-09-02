#!/usr/bin/env node
import { checkpoint, resume } from '../runtime/runtime.js';
import { contextCompile, contextExpand, contextOrient, contextUsageReport, inspectRecipe, inspectSkill, listRecipes, listSkills, loadContext, materializeContextRecipe, materializeContextSkill, recordContextSkillInvocation, recordContextSkillOutcome, transitionContextRecipe, transitionContextSkill } from '../agent/api.js';
import { formatUsageReport } from '../cognition/usage-report.js';
import { importV1, verifyV1Import } from '../cognition/migration-v1.js';
import { recordUse } from '../cognition/feedback.js';
import { readJournal, verifyJournal } from '../cognition/journal.js';
import { projectEvents } from '../cognition/projections.js';
import { disableRuntime, enableRuntime, ensureRuntimeForSession, runtimeStatus, serveRuntime, setFilesystemEvents, startRuntime, stopRuntime } from '../cognition/runtime.js';
import { loadRuntimePolicy } from '../cognition/policy.js';
import { migrationReadiness } from '../cognition/readiness.js';
import { runClaudeCodeHook } from '../hooks/claude-code.js';
import { readGitWorktreeState } from '../git/git-adapter.js';
import { inspectClaudeIntegration, installClaudeIntegration } from '../integrations/claude-code.js';
import { doctor, status } from '../runtime/diagnostics.js';
import { initProject } from '../runtime/init.js';
import { discoverKnowledge, learnKnowledge, listKnowledge, verifyKnowledge, recordDeadend, listDeadends, verifyDeadend, transitionKnowledge, transitionDeadend } from '../runtime/knowledge.js';
import { addNote, listActivity, listNotes } from '../runtime/notes.js';
import type { ActivityQuery, CheckpointInput, DeadendInput, KnowledgeInput, NoteInput, NoteKind, NoteStatus, NoteActor } from '../runtime/types.js';
import type { ContextExpandLevel } from '../compiler/types.js';
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

function graphHopsOption(args: string[]): 0 | 1 | 2 | undefined {
  const value = option(args, '--graph-hops');
  if (value === undefined) return undefined;
  if (value !== '0' && value !== '1' && value !== '2') throw new Error('--graph-hops must be one of: 0, 1, 2');
  return Number(value) as 0 | 1 | 2;
}

const recipeBudgets = (value: string | undefined): Record<string, number> | undefined => value === undefined ? undefined : Object.fromEntries(value.split(',').map((item) => { const [section, budget] = item.split('=', 2); const parsed = Number(budget); if (!section || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000) throw new Error('--budgets must be section=non-negative-integer up to 100000'); return [section, parsed]; }));

const HELP: Record<string, string> = {
  init: `usage: ctx init [path] [--path <path>]

Initialize the local .context runtime layout. Re-running init is safe.

Options:
  --path <path>  Project path`,
  usage: `usage: ctx usage report [options]

Show read-only context asset, reuse, token investment, and operation metrics.

Options:
  --path <path>                  Project path
  --since <ISO>                  Window start
  --until <ISO>                  Window end
  --days <number>                Rolling window length (default: 30)
  --month <YYYY-MM>              Calendar month window
  --granularity <value>          day|week|month
  --format <value>               json|ascii (default: json)
  --baseline-tokens <number>    Explicit comparison token count
  --baseline-source <value>      manual|recorded-control`,
  'usage report': `usage: ctx usage report [options]

Show read-only context asset, reuse, token investment, and operation metrics.

Options:
  --path <path>                  Project path
  --since <ISO>                  Window start
  --until <ISO>                  Window end
  --days <number>                Rolling window length (default: 30)
  --month <YYYY-MM>              Calendar month window
  --granularity <value>          day|week|month
  --format <value>               json|ascii (default: json)
  --baseline-tokens <number>    Explicit comparison token count
  --baseline-source <value>      manual|recorded-control`,
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
  compile: `usage: ctx compile [query] [options]

Compile bounded, provider-neutral context with source provenance and selection explanations.

Options:
  --path <path>              Project path
  --context <id>             Context ID
  --recipe-id <id>           Explicit verified or published Recipe
  --graph-hops <0|1|2>       Optional bounded evidence-graph traversal
  --scenario <scenario>      resume|implementation|debugging|verification|handoff|exploration|unknown
  --scope <scope>            Exact consensus scope
  --paths <paths>            Comma-separated project-relative paths
  --max-chars <number>       Maximum compiled characters
  --knowledge-limit <number> Maximum knowledge matches (default: 10)
  --deadend-limit <number>   Maximum deadend matches (default: 10)
  --note-limit <number>      Maximum open notes (default: 20)
  --activity-limit <number>  Maximum recent activity groups (default: 20)`,
  expand: `usage: ctx expand [options]

Expand one selected compiler candidate without writing project state.

Options:
  --path <path>              Project path
  --manifest-hash <hash>     Manifest identity hash from ctx compile
  --candidate-id <id>        Selected candidate ID
  --item-hash <hash>         Selected item hash
  --level <level>            structured|evidence
  --max-chars <number>       Maximum expanded characters
  --compile-max-chars <number> Original compile budget (default: 4000)
  --context <id>             Context ID
  --recipe-id <id>           Explicit verified or published Recipe
  --graph-hops <0|1|2>       Optional bounded evidence-graph traversal
  --query <text>             Original compile query
  --scenario <scenario>      resume|implementation|debugging|verification|handoff|exploration|unknown
  --scope <scope>            Exact consensus scope
  --paths <paths>            Comma-separated project-relative paths
  --knowledge-limit <number> Maximum knowledge matches (default: 10)
  --deadend-limit <number>   Maximum deadend matches (default: 10)
  --note-limit <number>      Maximum open notes (default: 20)
  --activity-limit <number>  Maximum recent activity groups (default: 20)`,
  agent: `usage: ctx agent serve

Start an MCP stdio server for Agent integrations.

Run "ctx agent serve --help" for details.`,
  'agent serve': `usage: ctx agent serve

Start an MCP stdio server exposing context_orient, context_expand, context_compile, context_resume, context_note_list, context_note_add, context_usage_report, and context_checkpoint tools.

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
       ctx knowledge deprecate|reject <knowledge-id> --reason <text> [--path <path>]
       ctx knowledge discover <query> [options]

List, govern, or discover project knowledge.

Options:
  --all                  Include unverified items
  --path <path>          Project path`,
  'knowledge verify': `usage: ctx knowledge verify <knowledge-id> [--path <path>]

Mark a candidate knowledge item as verified.`,
  'knowledge deprecate': `usage: ctx knowledge deprecate <knowledge-id> --reason <text> [--path <path>]

Retire a verified knowledge item with an explicit governance reason.`,
  'knowledge reject': `usage: ctx knowledge reject <knowledge-id> --reason <text> [--path <path>]

Reject a candidate knowledge item with an explicit governance reason.`,
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
       ctx deadend obsolete|reject <deadend-id> --reason <text> [--path <path>]

Record or govern a candidate deadend.

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

Mark a candidate deadend as verified.`,
  'deadend obsolete': `usage: ctx deadend obsolete <deadend-id> --reason <text> [--path <path>]

Retire a verified deadend with an explicit governance reason.`,
  'deadend reject': `usage: ctx deadend reject <deadend-id> --reason <text> [--path <path>]

Reject a candidate deadend with an explicit governance reason.`,
  feedback: `usage: ctx feedback use knowledge|deadend <id> --event-id <stable-id> [--path <path>]

Record explicit use of verified v2 retrieval material.`,
  'feedback use': `usage: ctx feedback use knowledge|deadend <id> --event-id <stable-id> [--path <path>]

Record an idempotent use signal that affects deterministic rank only.`,
  skill: `usage: ctx skill list [--path <path>]
       ctx skill inspect <skill-id> [--path <path>]
       ctx skill materialize <proposal-id> --title <title> --procedure <steps> [--path <path>]
       ctx skill verify|publish|deprecate <skill-id> --rationale <text> [--path <path>]
       ctx skill supersede <skill-id> --rationale <text> --supersedes <entity:id> [--path <path>]
       ctx skill invoke <skill-id> --invocation-id <id> --caller-event <id> --input-hash <hash> [--path <path>]
       ctx skill outcome <skill-id> --invocation-id <id> --outcome-id <id> --caller-event <id> --outcome <value> --summary <text> [--path <path>]`,
  journal: `usage: ctx journal verify [--path <path>]

Validate the v2 journal hash chain and replay projections in memory.`,
  'journal verify': `usage: ctx journal verify [--path <path>]

Validate journal integrity without writing derived state.`,
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
  migrate: `usage: ctx migrate v1 --dry-run|--apply [--path <path>]
       ctx migrate verify [--path <path>]

Inspect, explicitly import, or verify v1 Context data for the event-journal runtime.`,
  'migrate v1': `usage: ctx migrate v1 --dry-run|--apply [--path <path>]

Validate v1 Context, Snapshot, Note, Knowledge, and Deadend data for v2 migration.

Options:
  --dry-run              Inspect only; no v2 data is created
  --apply                Explicitly append immutable v1 provenance events
  --path <path>          Project path`,
  'migrate verify': `usage: ctx migrate verify [--path <path>]

Rebuild v2 projections and verify imported v1 parity.

Options:
  --path <path>          Project path`,
  recipe: `usage: ctx recipe list|inspect|materialize|verify|publish|deprecate|supersede [options]

List, inspect, materialize, or govern immutable compiler Recipes.

Options:
  --path <path>          Project path
  --title <text>         Recipe title for materialize
  --sources <items>      Comma-separated source preferences
  --sections <items>     Comma-separated section preferences
  --budgets <items>      Comma-separated section=characters budgets
  --rationale <text>     Governance rationale
  --supersedes <ref>     Superseding entity:id`,
  'recipe verify': `usage: ctx recipe verify <recipe-id> --rationale <text> [--path <path>]

Mark a candidate compiler Recipe as verified.`,
  'recipe publish': `usage: ctx recipe publish <recipe-id> --rationale <text> [--path <path>]

Publish a verified compiler Recipe.`,
  'recipe deprecate': `usage: ctx recipe deprecate <recipe-id> --rationale <text> [--path <path>]

Retire a compiler Recipe with an explicit governance reason.`,
  'recipe supersede': `usage: ctx recipe supersede <recipe-id> --rationale <text> --supersedes <entity:id> [--path <path>]

Supersede a compiler Recipe while retaining its history.`,
  filesystem: `usage: ctx filesystem enable|disable|status [--path <path>]

Control whether the Runtime records filtered file metadata changes.`,
  'filesystem enable': `usage: ctx filesystem enable [--path <path>]

Enable filtered filesystem change observation and restart a running Runtime.`,
  'filesystem disable': `usage: ctx filesystem disable [--path <path>]

Disable filesystem change observation and restart a running Runtime.`,
  'filesystem status': `usage: ctx filesystem status [--path <path>]

Show the filesystem observation policy and Runtime status.`,
  runtime: `usage: ctx runtime enable|disable|start|stop|status [--path <path>]

Control the local Knowledge Runtime lifecycle.`,
  'runtime status': `usage: ctx runtime status [--path <path>]

Show the read-only runtime policy, migration and authenticated lease status.

Options:
  --path <path>          Project path`,
  'runtime enable': `usage: ctx runtime enable [--path <path>]

Explicitly enable the migrated local Knowledge Runtime.`,
  'runtime disable': `usage: ctx runtime disable [--path <path>]

Stop the local runtime and disable future startup without deleting v2 history.`,
  'runtime start': `usage: ctx runtime start [--path <path>]

Start the enabled runtime as a loopback-only background process.`,
  'runtime stop': `usage: ctx runtime stop [--path <path>]

Stop the local runtime through authenticated loopback IPC.`,
  'runtime serve': `usage: ctx runtime serve [--path <path>]

Internal runtime daemon entry point.`,
};

function usage(): string {
  return `usage: ctx init|checkpoint|resume|orient|compile|expand|usage|agent|hook|integrate|status|doctor|learn|knowledge|deadend|deadends|note|activity|migrate|runtime|filesystem|feedback|skill|recipe|journal [options]

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
  const nested = (command === 'agent' && args[1] === 'serve')
    || (command === 'hook' && args[1] === 'claude-code')
    || (command === 'integrate' && args[1] === 'claude')
    || (command === 'knowledge' && ['verify', 'discover', 'deprecate', 'reject'].includes(args[1]))
    || (command === 'deadend' && ['verify', 'obsolete', 'reject'].includes(args[1]))
    || (command === 'feedback' && args[1] === 'use')
    || (command === 'journal' && args[1] === 'verify')
    || (command === 'note' && ['add', 'list'].includes(args[1]))
    || (command === 'migrate' && ['v1', 'verify'].includes(args[1]))
    || (command === 'recipe' && ['list', 'inspect', 'materialize', 'verify', 'publish', 'deprecate', 'supersede'].includes(args[1]))
    || (command === 'runtime' && ['enable', 'disable', 'start', 'stop', 'status', 'serve'].includes(args[1]))
    || (command === 'usage' && args[1] === 'report');
  const key = nested ? `${command} ${args[1]}` : command;
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
      print(await loadContext(target, { contextId: option(args, '--context'), maxChars: numericOption(args, '--max-chars', 4000) }, 'cli'));
      return;
    case 'orient': {
      const valueOptions = ['--path', '--context', '--scope', '--max-chars', '--knowledge-limit', '--deadend-limit', '--note-limit'];
      validateOptions(args.slice(1), valueOptions, valueOptions);
      const query = positionals(args.slice(1), valueOptions);
      validatePositionals(query, 1, HELP.orient);
      await ensureRuntimeForSession(target, { source: 'cli', timeoutMs: 1_000 }).catch(() => undefined);
      print(await contextOrient(target, {
        contextId: option(args, '--context'),
        query: query[0],
        scope: option(args, '--scope'),
        maxChars: numericOption(args, '--max-chars', 4000),
        knowledgeLimit: numericOption(args, '--knowledge-limit', 10),
        deadendLimit: numericOption(args, '--deadend-limit', 10),
        noteLimit: numericOption(args, '--note-limit', 20),
      }, 'cli'));
      return;
    }
    case 'compile': {
      const valueOptions = ['--path', '--context', '--recipe-id', '--graph-hops', '--scenario', '--scope', '--paths', '--max-chars', '--knowledge-limit', '--deadend-limit', '--note-limit', '--activity-limit'];
      validateOptions(args.slice(1), valueOptions, valueOptions);
      const query = positionals(args.slice(1), valueOptions);
      validatePositionals(query, 1, HELP.compile);
      print(await contextCompile(target, {
        contextId: option(args, '--context'),
        recipeId: option(args, '--recipe-id'),
        graphHops: graphHopsOption(args),
        query: query[0],
        scenario: enumOption(args, '--scenario', ['resume', 'implementation', 'debugging', 'verification', 'handoff', 'exploration', 'unknown'] as const),
        scope: option(args, '--scope'),
        paths: listOption(args, '--paths'),
        maxChars: numericOption(args, '--max-chars', 4000),
        knowledgeLimit: numericOption(args, '--knowledge-limit', 10),
        deadendLimit: numericOption(args, '--deadend-limit', 10),
        noteLimit: numericOption(args, '--note-limit', 20),
        activityLimit: numericOption(args, '--activity-limit', 20),
      }, 'cli'));
      return;
    }
    case 'expand': {
      const valueOptions = ['--path', '--manifest-hash', '--candidate-id', '--item-hash', '--level', '--max-chars', '--compile-max-chars', '--context', '--recipe-id', '--graph-hops', '--query', '--scenario', '--scope', '--paths', '--knowledge-limit', '--deadend-limit', '--note-limit', '--activity-limit'];
      validateOptions(args.slice(1), valueOptions, valueOptions);
      validatePositionals(positionals(args.slice(1), valueOptions), 0, HELP.expand);
      const level = enumOption(args, '--level', ['structured', 'evidence'] as const);
      if (!level) throw new Error('--level is required');
      const manifestHash = option(args, '--manifest-hash');
      if (!manifestHash) throw new Error('--manifest-hash is required');
      const compileMaxChars = numericOption(args, '--compile-max-chars', 4000);
      await ensureRuntimeForSession(target, { source: 'cli', timeoutMs: 1_000 }).catch(() => undefined);
      print(await contextExpand(target, {
        manifestHash,
        candidateId: option(args, '--candidate-id'),
        itemHash: option(args, '--item-hash'),
        level: level as ContextExpandLevel,
        maxChars: option(args, '--max-chars') === undefined ? undefined : numericOption(args, '--max-chars', 0),
        compile: {
          contextId: option(args, '--context'),
          recipeId: option(args, '--recipe-id'),
          graphHops: graphHopsOption(args),
          query: option(args, '--query'),
          scenario: enumOption(args, '--scenario', ['resume', 'implementation', 'debugging', 'verification', 'handoff', 'exploration', 'unknown'] as const),
          scope: option(args, '--scope'),
          paths: listOption(args, '--paths'),
          maxChars: compileMaxChars,
          knowledgeLimit: numericOption(args, '--knowledge-limit', 10),
          deadendLimit: numericOption(args, '--deadend-limit', 10),
          noteLimit: numericOption(args, '--note-limit', 20),
          activityLimit: numericOption(args, '--activity-limit', 20),
        },
      }));
      return;
    }
    case 'usage': {
      if (args[1] !== 'report') throw new Error(HELP.usage);
      const valueOptions = ['--path', '--since', '--until', '--days', '--month', '--granularity', '--format', '--baseline-tokens', '--baseline-source'];
      validateOptions(args.slice(2), valueOptions, valueOptions);
      validatePositionals(positionals(args.slice(2), valueOptions), 0, HELP['usage report']);
      const report = await contextUsageReport(target, {
        since: option(args, '--since'),
        until: option(args, '--until'),
        days: option(args, '--days') === undefined ? undefined : numericOption(args, '--days', 30),
        month: option(args, '--month'),
        granularity: enumOption(args, '--granularity', ['day', 'week', 'month'] as const),
        baselineTokens: option(args, '--baseline-tokens') === undefined ? undefined : numericOption(args, '--baseline-tokens', 0),
        baselineSource: enumOption(args, '--baseline-source', ['manual', 'recorded-control'] as const),
      });
      if (enumOption(args, '--format', ['json', 'ascii'] as const) === 'ascii') process.stdout.write(formatUsageReport(report));
      else print(report);
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
      const valueOptions = ['--path', '--kind', '--scope', '--context', '--snapshot', '--evidence', '--branch-mode', '--paths'];
      validateOptions(args.slice(1), valueOptions, valueOptions);
      const statement = positionals(args.slice(1), valueOptions);
      if (statement.length === 0) throw new Error(HELP.learn);
      const branchMode = enumOption(args, '--branch-mode', ['global', 'exact'] as const) ?? 'global';
      const git = branchMode === 'exact' ? await readGitWorktreeState(target ?? process.cwd()) : null;
      const input: KnowledgeInput = {
        kind: option(args, '--kind'),
        scope: option(args, '--scope'),
        sourceContextId: option(args, '--context'),
        sourceSnapshotId: option(args, '--snapshot'),
        evidence: listOption(args, '--evidence'),
        applicability: { project: true, branchMode, ...(branchMode === 'exact' ? { branches: [git?.ref ?? git?.branch ?? 'detached'], sourceCommit: git?.commit ?? null } : {}), ...(listOption(args, '--paths') ? { paths: listOption(args, '--paths') } : {}) },
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
    case 'feedback': {
      if (args[1] !== 'use' || !['knowledge', 'deadend'].includes(args[2])) throw new Error(HELP.feedback);
      validateOptions(args.slice(3), ['--path', '--event-id'], ['--path', '--event-id']);
      const values = positionals(args.slice(3), ['--path', '--event-id']);
      if (values.length !== 1) throw new Error(HELP['feedback use']);
      print(await recordUse(target, { entity: args[2] as 'knowledge' | 'deadend', entityId: values[0], eventId: option(args, '--event-id') ?? '' }));
      return;
    }
    case 'filesystem': {
      if (!['enable', 'disable', 'status'].includes(args[1])) throw new Error(HELP.filesystem);
      validateOptions(args.slice(2), ['--path'], ['--path']);
      validatePositionals(positionals(args.slice(2), ['--path']), 0, HELP[`filesystem ${args[1]}`]);
      if (args[1] === 'status') {
        const status = await runtimeStatus(target);
        print({ projectRoot: status.projectRoot, migrated: status.migrated, enabled: status.enabled, running: status.running, filesystemEventsEnabled: status.migrated ? (await loadRuntimePolicy(status.projectRoot)).filesystemEventsEnabled : false });
      } else {
        print(await setFilesystemEvents(target, args[1] === 'enable'));
      }
      return;
    }
    case 'skill': {
      const action = args[1];
      if (action === 'list') {
        validateOptions(args.slice(2), ['--path'], ['--path']);
        validatePositionals(positionals(args.slice(2), ['--path']), 0, HELP.skill);
        print(await listSkills(target));
        return;
      }
      if (!action) throw new Error(HELP.skill);
      const skillId = positionals(args.slice(2), ['--path', '--title', '--procedure', '--rationale', '--supersedes', '--invocation-id', '--caller-event', '--input-hash', '--outcome-id', '--outcome', '--summary'])[0];
      if (action === 'inspect') {
        validateOptions(args.slice(2), ['--path'], ['--path']);
        const values = positionals(args.slice(2), ['--path']);
        if (values.length !== 1) throw new Error(HELP.skill);
        print(await inspectSkill(target, values[0]));
        return;
      }
      if (action === 'materialize') {
        const options = ['--path', '--title', '--procedure'];
        validateOptions(args.slice(2), options, options);
        const values = positionals(args.slice(2), options);
        if (values.length !== 1) throw new Error(HELP.skill);
        print(await materializeContextSkill(target, { proposalId: values[0], title: option(args, '--title') ?? '', procedure: listOption(args, '--procedure') ?? [] }));
        return;
      }
      if (['verify', 'publish', 'deprecate', 'supersede'].includes(action)) {
        const options = ['--path', '--rationale', '--supersedes'];
        validateOptions(args.slice(2), options, options);
        const values = positionals(args.slice(2), options);
        if (values.length !== 1) throw new Error(HELP.skill);
        const supersedes = option(args, '--supersedes');
        const [entity, entityId] = supersedes?.split(':', 2) ?? [];
        if (action === 'supersede' && (!entity || !entityId || !['knowledge', 'deadend', 'skill', 'compiler-recipe', 'experience', 'proposal'].includes(entity))) throw new Error('--supersedes must be <entity:id>');
        print(await transitionContextSkill(target, {
          skillId: values[0],
          to: action === 'supersede' ? 'superseded' : action as 'verified' | 'published' | 'deprecated',
          rationale: option(args, '--rationale') ?? '',
          ...(supersedes ? { supersedes: { entity: entity as 'knowledge' | 'deadend' | 'skill' | 'compiler-recipe' | 'experience' | 'proposal', entityId: entityId!, relation: 'supersedes' as const } } : {}),
        }));
        return;
      }
      if (action === 'invoke') {
        const options = ['--path', '--invocation-id', '--caller-event', '--input-hash'];
        validateOptions(args.slice(2), options, options);
        const values = positionals(args.slice(2), options);
        if (values.length !== 1) throw new Error(HELP.skill);
        print(await recordContextSkillInvocation(target, { skillId: values[0], invocationId: option(args, '--invocation-id') ?? '', callerEventId: option(args, '--caller-event') ?? '', inputHash: option(args, '--input-hash') ?? '' }));
        return;
      }
      if (action === 'outcome') {
        const options = ['--path', '--invocation-id', '--outcome-id', '--caller-event', '--outcome', '--summary'];
        validateOptions(args.slice(2), options, options);
        const values = positionals(args.slice(2), options);
        if (values.length !== 1) throw new Error(HELP.skill);
        print(await recordContextSkillOutcome(target, { skillId: values[0], invocationId: option(args, '--invocation-id') ?? '', outcomeId: option(args, '--outcome-id') ?? '', callerEventId: option(args, '--caller-event') ?? '', outcome: enumOption(args, '--outcome', ['success', 'failure', 'partial', 'irrelevant', 'unknown'] as const) ?? 'unknown', summary: option(args, '--summary') ?? '' }));
        return;
      }
      void skillId;
      throw new Error(HELP.skill);
    }
    case 'recipe': {
      const action = args[1];
      const valueOptions = ['--path', '--title', '--sources', '--sections', '--budgets', '--rationale', '--supersedes'];
      if (action === 'list') {
        validateOptions(args.slice(2), ['--path'], ['--path']);
        validatePositionals(positionals(args.slice(2), ['--path']), 0, HELP.recipe);
        print(await listRecipes(target));
        return;
      }
      if (action === 'inspect') {
        validateOptions(args.slice(2), ['--path'], ['--path']);
        const values = positionals(args.slice(2), ['--path']);
        if (values.length !== 1) throw new Error(HELP.recipe);
        print(await inspectRecipe(target, values[0]));
        return;
      }
      if (action === 'materialize') {
        validateOptions(args.slice(2), valueOptions, valueOptions);
        const values = positionals(args.slice(2), valueOptions);
        if (values.length !== 1) throw new Error(HELP.recipe);
        print(await materializeContextRecipe(target, {
          proposalId: values[0],
          title: option(args, '--title') ?? '',
          preferredSources: listOption(args, '--sources') as never,
          preferredSections: listOption(args, '--sections') as never,
          sectionBudgets: recipeBudgets(option(args, '--budgets')) as never,
        }));
        return;
      }
      if (['verify', 'publish', 'deprecate', 'supersede'].includes(action ?? '')) {
        validateOptions(args.slice(2), ['--path', '--rationale', '--supersedes'], ['--path', '--rationale', '--supersedes']);
        const values = positionals(args.slice(2), ['--path', '--rationale', '--supersedes']);
        if (values.length !== 1) throw new Error(HELP.recipe);
        const supersedes = option(args, '--supersedes');
        const [entity, entityId] = supersedes?.split(':', 2) ?? [];
        if (action === 'supersede' && (!entity || !entityId || !['knowledge', 'deadend', 'skill', 'compiler-recipe', 'experience', 'proposal'].includes(entity))) throw new Error('--supersedes must be <entity:id>');
        print(await transitionContextRecipe(target, {
          recipeId: values[0],
          to: action === 'supersede' ? 'superseded' : action as 'verified' | 'published' | 'deprecated',
          rationale: option(args, '--rationale') ?? '',
          ...(supersedes ? { supersedes: { entity: entity as never, entityId: entityId!, relation: 'supersedes' as const } } : {}),
        }));
        return;
      }
      throw new Error(HELP.recipe);
    }
    case 'journal': {
      if (args[1] !== 'verify') throw new Error(HELP.journal);
      validateOptions(args.slice(2), ['--path'], ['--path']);
      validatePositionals(positionals(args.slice(2), ['--path']), 0, HELP['journal verify']);
      const root = target ?? process.cwd();
      const events = await verifyJournal(root);
      const projection = projectEvents(events);
      const last = events.at(-1);
      print({ verified: true, eventCount: events.length, cursor: { eventId: last?.eventId ?? null, hash: last?.hash ?? null }, counts: { contexts: Object.keys(projection.contexts).length, notes: Object.keys(projection.notes).length, knowledge: Object.keys(projection.knowledge).length, deadends: Object.keys(projection.deadends).length } });
      return;
    }
    case 'migrate': {
      if (args[1] === 'v1') {
        validateOptions(args.slice(2), ['--dry-run', '--apply', '--path'], ['--path']);
        validatePositionals(positionals(args.slice(2), ['--path']), 0, HELP['migrate v1']);
        if (args.includes('--dry-run') === args.includes('--apply')) throw new Error(HELP['migrate v1']);
        print(args.includes('--apply') ? await importV1(target) : await migrationReadiness(target));
      } else if (args[1] === 'verify') {
        validateOptions(args.slice(2), ['--path'], ['--path']);
        validatePositionals(positionals(args.slice(2), ['--path']), 0, HELP['migrate verify']);
        print(await verifyV1Import(target));
      } else {
        throw new Error(HELP.migrate);
      }
      return;
    }
    case 'runtime': {
      if (!['enable', 'disable', 'start', 'stop', 'status', 'serve'].includes(args[1])) throw new Error(HELP.runtime);
      validateOptions(args.slice(2), ['--path'], ['--path']);
      validatePositionals(positionals(args.slice(2), ['--path']), 0, HELP[`runtime ${args[1]}`]);
      if (args[1] === 'enable') print(await enableRuntime(target));
      else if (args[1] === 'disable') print(await disableRuntime(target));
      else if (args[1] === 'start') print(await startRuntime(target));
      else if (args[1] === 'stop') print(await stopRuntime(target));
      else if (args[1] === 'status') print(await runtimeStatus(target));
      else {
        const runtime = await serveRuntime(target);
        process.once('SIGINT', () => { void runtime.close('signal'); });
        process.once('SIGTERM', () => { void runtime.close('signal'); });
        await new Promise<void>(() => undefined);
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
      } else if (args[1] === 'deprecate' || args[1] === 'reject') {
        validateOptions(args.slice(2), ['--path', '--reason'], ['--path', '--reason']);
        const values = positionals(args.slice(2), ['--path', '--reason']);
        if (values.length !== 1) throw new Error(HELP[`knowledge ${args[1]}`]);
        print(await transitionKnowledge(target, values[0], args[1] === 'deprecate' ? 'deprecated' : 'rejected', option(args, '--reason') ?? ''));
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
      } else if (args[1] === 'obsolete' || args[1] === 'reject') {
        validateOptions(args.slice(2), ['--path', '--reason'], ['--path', '--reason']);
        const values = positionals(args.slice(2), ['--path', '--reason']);
        if (values.length !== 1) throw new Error(HELP[`deadend ${args[1]}`]);
        print(await transitionDeadend(target, values[0], args[1] === 'obsolete' ? 'obsolete' : 'rejected', option(args, '--reason') ?? ''));
      } else {
        const valueOptions = ['--path', '--attempt', '--reason', '-m', '--scope', '--context', '--snapshot', '--evidence', '--branch-mode', '--paths'];
        validateOptions(args.slice(1), valueOptions, valueOptions);
        const values = positionals(args.slice(1), valueOptions);
        validatePositionals(values, 1, HELP.deadend);
        const branchMode = enumOption(args, '--branch-mode', ['global', 'exact'] as const) ?? 'global';
        const git = branchMode === 'exact' ? await readGitWorktreeState(target ?? process.cwd()) : null;
        const input: DeadendInput = {
          scope: option(args, '--scope'),
          sourceContextId: option(args, '--context'),
          sourceSnapshotId: option(args, '--snapshot'),
          evidence: listOption(args, '--evidence'),
          applicability: { project: true, branchMode, ...(branchMode === 'exact' ? { branches: [git?.ref ?? git?.branch ?? 'detached'], sourceCommit: git?.commit ?? null } : {}), ...(listOption(args, '--paths') ? { paths: listOption(args, '--paths') } : {}) },
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
