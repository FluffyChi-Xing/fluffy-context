import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/runtime/init.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { readJournal } from '../src/cognition/journal.js';
import { enableRuntime, observeRuntime, runtimeStatus, serveRuntime } from '../src/cognition/runtime.js';
import { cognitionRuntimeSecretPath } from '../src/storage/layout.js';

const execFileAsync = promisify(execFile);

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-runtime-'));
}

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

async function initializedRuntime(root: string): Promise<void> {
  await initProject(root);
  await importV1(root);
  await enableRuntime(root);
}

test('runtime serves authenticated loopback IPC without exposing its capability token', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await initializedRuntime(root);
    runtime = await serveRuntime(root);
    const status = await runtimeStatus(root);
    assert.equal(status.running, true);
    assert.equal(status.lease?.host, '127.0.0.1');
    assert.ok((status.lease?.port ?? 0) > 0);
    assert.equal('projectId' in (status.lease ?? {}), false);
    const secret = await readFile(cognitionRuntimeSecretPath(root), 'utf8');
    assert.ok(secret.length >= 40);
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(await observeRuntime(root), true);
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime observes exact Git branch and HEAD transitions', async () => {
  const root = await project();
  let runtime: Awaited<ReturnType<typeof serveRuntime>> | null = null;
  try {
    await git(['init'], root);
    await git(['config', 'user.email', 'runtime@example.test'], root);
    await git(['config', 'user.name', 'Runtime Test'], root);
    await git(['commit', '--allow-empty', '-m', 'initial'], root);
    await initializedRuntime(root);
    runtime = await serveRuntime(root);
    await git(['checkout', '-b', 'feature/runtime'], root);
    assert.equal(await observeRuntime(root), true);
    await git(['commit', '--allow-empty', '-m', 'runtime branch'], root);
    assert.equal(await observeRuntime(root), true);
    const events = await readJournal(root);
    assert.ok(events.some((event) => event.type === 'git.branch.changed' && event.git.branch === 'feature/runtime'));
    assert.ok(events.some((event) => event.type === 'git.head.changed' && event.git.branch === 'feature/runtime'));
  } finally {
    await runtime?.close('test');
    await rm(root, { recursive: true, force: true });
  }
});
