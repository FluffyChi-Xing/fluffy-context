#!/usr/bin/env node
import { checkpoint, resume } from '../runtime/runtime.js';
import { doctor, status } from '../runtime/diagnostics.js';
import { initProject } from '../runtime/init.js';
import { learnKnowledge, listKnowledge, verifyKnowledge, recordDeadend, listDeadends, verifyDeadend } from '../runtime/knowledge.js';
import type { CheckpointInput } from '../runtime/types.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function listOption(args: string[], name: string): string[] | undefined {
  const value = option(args, name);
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(args: string[]): Promise<void> {
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
      print(await resume(target, option(args, '--context')));
      return;
    case 'status':
      print(await status(target));
      return;
    case 'doctor':
      print(await doctor(target));
      return;
    case 'learn':
      print(await learnKnowledge(target, args.slice(1).filter((arg) => !arg.startsWith('--')).join(' '), option(args, '--scope')));
      return;
    case 'knowledge':
      if (args[1] === 'verify') print(await verifyKnowledge(target, args[2]));
      else print(await listKnowledge(target, args.includes('--all')));
      return;
    case 'deadend':
      if (args[1] === 'verify') print(await verifyDeadend(target, args[2]));
      else print(await recordDeadend(target, option(args, '--attempt') ?? args[1], option(args, '--reason') ?? option(args, '-m') ?? ''));
      return;
    case 'deadends':
      print(await listDeadends(target, args.includes('--all')));
      return;
    default:
      throw new Error('usage: ctx init|checkpoint|resume|status|doctor [options]');
  }
}

run(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
