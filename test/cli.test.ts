import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('dist/src/cli/main.js');

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-cli-'));
}

function runCli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test('each command has focused help without creating runtime files', async () => {
  const root = await project();
  try {
    const commands = ['init', 'checkpoint', 'resume', 'status', 'doctor', 'learn', 'knowledge', 'deadend', 'deadends', 'note', 'activity'];
    for (const command of commands) {
      const result = await runCli([command, '--help'], root);
      assert.equal(result.code, 0, command);
      assert.match(result.stdout, new RegExp(`usage: ctx ${command}`), command);
      assert.equal(result.stderr, '');
    }
    const noteAdd = await runCli(['note', 'add', '--help'], root);
    assert.equal(noteAdd.code, 0);
    assert.match(noteAdd.stdout, /note add/);
    const noteList = await runCli(['note', 'list', '--help'], root);
    assert.equal(noteList.code, 0);
    assert.match(noteList.stdout, /note list/);
    const verify = await runCli(['knowledge', 'verify', '--help'], root);
    assert.equal(verify.code, 0);
    assert.match(verify.stdout, /knowledge verify/);
    const deadendVerify = await runCli(['deadend', 'verify', '--help'], root);
    assert.equal(deadendVerify.code, 0);
    assert.match(deadendVerify.stdout, /deadend verify/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cli rejects unknown options and returns JSON for business commands', async () => {
  const root = await project();
  try {
    const invalid = await runCli(['status', '--unknown'], root);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /unknown option/);
    const init = await runCli(['init', '--path', root], root);
    assert.equal(init.code, 0);
    assert.doesNotThrow(() => JSON.parse(init.stdout));
    const status = await runCli(['status', '--path', root], root);
    assert.equal(status.code, 0);
    assert.equal(JSON.parse(status.stdout).initialized, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
