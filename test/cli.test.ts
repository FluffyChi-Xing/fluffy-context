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

test('cli reports the package release version', async () => {
  const root = await project();
  try {
    const result = await runCli(['--version'], root);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout), '0.3.1');
    assert.equal(result.stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('each command has focused help without creating runtime files', async () => {
  const root = await project();
  try {
    const commands = ['init', 'checkpoint', 'resume', 'orient', 'agent', 'hook', 'integrate', 'status', 'doctor', 'learn', 'knowledge', 'deadend', 'deadends', 'note', 'activity', 'migrate', 'runtime'];
    for (const command of commands) {
      const result = await runCli([command, '--help'], root);
      assert.equal(result.code, 0, command);
      assert.match(result.stdout, new RegExp(`usage: ctx ${command}`), command);
      assert.equal(result.stderr, '');
    }
    const agentServe = await runCli(['agent', 'serve', '--help'], root);
    assert.equal(agentServe.code, 0);
    assert.match(agentServe.stdout, /agent serve/);
    const hook = await runCli(['hook', 'claude-code', '--help'], root);
    assert.equal(hook.code, 0);
    assert.match(hook.stdout, /hook claude-code/);
    const integrate = await runCli(['integrate', 'claude', 'install', '--help'], root);
    assert.equal(integrate.code, 0);
    assert.match(integrate.stdout, /integrate claude install/);
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
    const discover = await runCli(['knowledge', 'discover', '--help'], root);
    assert.equal(discover.code, 0);
    assert.match(discover.stdout, /knowledge discover/);
    const migrate = await runCli(['migrate', 'v1', '--help'], root);
    assert.equal(migrate.code, 0);
    assert.match(migrate.stdout, /migrate v1/);
    const migrateVerify = await runCli(['migrate', 'verify', '--help'], root);
    assert.equal(migrateVerify.code, 0);
    assert.match(migrateVerify.stdout, /migrate verify/);
    const runtime = await runCli(['runtime', 'status', '--help'], root);
    assert.equal(runtime.code, 0);
    assert.match(runtime.stdout, /runtime status/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v1 migration CLI applies only on explicit confirmation and verifies the import', async () => {
  const root = await project();
  try {
    const initialized = await runCli(['init', '--path', root], root);
    assert.equal(initialized.code, 0);
    const preview = await runCli(['migrate', 'v1', '--dry-run', '--path', root], root);
    assert.equal(preview.code, 0, preview.stderr);
    assert.deepEqual(await readdir(path.join(root, '.context')), ['contexts', 'index.json', 'locks', 'manifest.json']);
    const applied = await runCli(['migrate', 'v1', '--apply', '--path', root], root);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).applied, true);
    const verification = await runCli(['migrate', 'verify', '--path', root], root);
    assert.equal(verification.code, 0, verification.stderr);
    assert.equal(JSON.parse(verification.stdout).verified, true);
    const invalid = await runCli(['migrate', 'v1', '--dry-run', '--apply', '--path', root], root);
    assert.notEqual(invalid.code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime status and v1 migration dry-run remain read-only', async () => {
  const root = await project();
  try {
    const initialized = await runCli(['init', '--path', root], root);
    assert.equal(initialized.code, 0);
    const migration = await runCli(['migrate', 'v1', '--dry-run', '--path', root], root);
    assert.equal(migration.code, 0, migration.stderr);
    assert.equal(JSON.parse(migration.stdout).eligible, true);
    const runtime = await runCli(['runtime', 'status', '--path', root], root);
    assert.equal(runtime.code, 0, runtime.stderr);
    assert.equal(JSON.parse(runtime.stdout).v2Present, false);
    assert.deepEqual((await readdir(path.join(root, '.context'))).sort(), ['contexts', 'index.json', 'locks', 'manifest.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('knowledge discover CLI returns deterministic JSON and validates filters', async () => {
  const root = await project();
  try {
    const init = await runCli(['init', '--path', root], root);
    assert.equal(init.code, 0);
    const candidate = await runCli(['learn', 'Applicant authentication uses SMS verification', '--kind', 'workflow', '--scope', 'project', '--path', root], root);
    assert.equal(candidate.code, 0);
    const candidateId = JSON.parse(candidate.stdout).knowledgeId as string;
    const verify = await runCli(['knowledge', 'verify', candidateId, '--path', root], root);
    assert.equal(verify.code, 0);
    const discovered = await runCli(['knowledge', 'discover', '投保人认证', '--path', root, '--scope', 'project', '--limit', '1', '--max-chars', '12'], root);
    assert.equal(discovered.code, 0);
    const output = JSON.parse(discovered.stdout);
    assert.equal(output.total, 1);
    assert.equal(output.hits[0].knowledge.knowledgeId, candidateId);
    assert.equal(output.hits[0].knowledge.statement, 'Applicant a…');

    const candidateTwo = await runCli(['learn', 'Applicant authentication remains a candidate', '--path', root], root);
    assert.equal(candidateTwo.code, 0);
    const all = await runCli(['knowledge', 'discover', 'applicant authentication', '--all', '--path', root], root);
    assert.equal(all.code, 0);
    assert.equal(JSON.parse(all.stdout).total, 2);

    const empty = await runCli(['knowledge', 'discover', '--path', root], root);
    assert.notEqual(empty.code, 0);
    assert.match(empty.stderr, /knowledge discover/);
    const invalidStatus = await runCli(['knowledge', 'discover', 'auth', '--status', 'unknown', '--path', root], root);
    assert.notEqual(invalidStatus.code, 0);
    assert.match(invalidStatus.stderr, /invalid knowledge status/);
    const unknown = await runCli(['knowledge', 'discover', 'auth', '--unknown', '--path', root], root);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /unknown option/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('orient CLI returns no_context and validates options', async () => {
  const root = await project();
  try {
    const init = await runCli(['init', '--path', root], root);
    assert.equal(init.code, 0);
    const noContext = await runCli(['orient', 'authentication', '--path', root, '--scope', 'project', '--knowledge-limit', '1', '--deadend-limit', '1', '--note-limit', '1'], root);
    assert.equal(noContext.code, 0);
    const output = JSON.parse(noContext.stdout);
    assert.equal(output.status, 'no_context');
    assert.equal(output.query, 'authentication');
    assert.equal(output.context, null);

    const tooMany = await runCli(['orient', 'authentication', 'extra', '--path', root], root);
    assert.notEqual(tooMany.code, 0);
    assert.match(tooMany.stderr, /ctx orient/);
    const unknown = await runCli(['orient', '--unknown', '--path', root], root);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /unknown option/);
    const invalidLimit = await runCli(['orient', '--max-chars', 'invalid', '--path', root], root);
    assert.notEqual(invalidLimit.code, 0);
    assert.match(invalidLimit.stderr, /non-negative integer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude integration CLI previews and validates nested commands', async () => {
  const root = await project();
  try {
    const preview = await runCli(['integrate', 'claude', 'install', '--path', root], root);
    assert.equal(preview.code, 0);
    assert.equal(JSON.parse(preview.stdout).applied, false);
    assert.deepEqual(await readdir(root), []);

    const unknown = await runCli(['integrate', 'claude', 'install', '--unknown', '--path', root], root);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /unknown option/);
    const invalid = await runCli(['hook', 'claude-code', 'unknown'], root);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /hook claude-code/);
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
