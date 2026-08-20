#!/usr/bin/env node
import { checkpoint, resume } from '../runtime/runtime.js';
import { doctor, status } from '../runtime/diagnostics.js';
import { initProject } from '../runtime/init.js';
import { learnKnowledge, listKnowledge, verifyKnowledge, recordDeadend, listDeadends, verifyDeadend } from '../runtime/knowledge.js';
import type { CheckpointInput, DeadendInput, KnowledgeInput } from '../runtime/types.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`);
  return value;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`missing required option ${name}`);
  return value;
}

function listOption(args: string[], name: string): string[] | undefined {
  const value = option(args, name);
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined;
}

function positionals(args: string[], options: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--') || args[index] === '-m') {
      if (options.includes(args[index])) index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function validateOptions(args: string[], allowed: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('-')) continue;
    if (!allowed.includes(argument)) throw new Error(`unknown option ${argument}`);
    if (argument !== '--all' && argument !== '--help' && argument !== '--version') index += 1;
  }
}

function numericOption(args: string[], name: string, defaultValue: number): number {
  const value = option(args, name);
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function usage(): string {
  return 'usage: ctx init|checkpoint|resume|status|doctor|learn|knowledge|deadend|deadends [options]';
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(args: string[]): Promise<void> {
  if (args.includes('--version')) {
    print('0.1.0');
    return;
  }
  if (args.length === 0 || args.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const command = args[0];
  const target = option(args, '--path');
  switch (command) {
    case 'init':
      print(await initProject(target ?? args[1]));
      return;
    case 'checkpoint': {
      const input: CheckpointInput = {
        contextId: option(args, '--context'),
        title: option(args, '--title'),
        progressSummary: option(args, '--progress'),
        lastError: option(args, '--last-error') ?? null,
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
      validateOptions(args.slice(1), ['--path', '--context', '--max-chars']);
      print(await resume(target, option(args, '--context'), numericOption(args, '--max-chars', 4000)));
      return;
    case 'status':
      print(await status(target));
      return;
    case 'doctor':
      print(await doctor(target));
      return;
    case 'learn': {
      const statement = positionals(args.slice(1), ['--path', '--scope', '--context', '--snapshot', '--evidence']);
      const input: KnowledgeInput = {
        scope: option(args, '--scope'),
        sourceContextId: option(args, '--context'),
        sourceSnapshotId: option(args, '--snapshot'),
        evidence: listOption(args, '--evidence'),
      };
      print(await learnKnowledge(target, statement.join(' '), input));
      return;
    }
    case 'knowledge':
      if (args[1] === 'verify') print(await verifyKnowledge(target, args[2]));
      else print(await listKnowledge(target, args.includes('--all')));
      return;
    case 'deadend':
      if (args[1] === 'verify') print(await verifyDeadend(target, args[2]));
      else {
        const input: DeadendInput = {
          scope: option(args, '--scope'),
          sourceContextId: option(args, '--context'),
          sourceSnapshotId: option(args, '--snapshot'),
          evidence: listOption(args, '--evidence'),
        };
        print(await recordDeadend(target, option(args, '--attempt') ?? args[1], option(args, '--reason') ?? option(args, '-m') ?? '', input));
      }
      return;
    case 'deadends':
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
