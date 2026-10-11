import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/runtime/init.js';
import { checkpoint } from '../src/runtime/runtime.js';
import { upgradeProject } from '../src/runtime/upgrade.js';
import { importV1 } from '../src/cognition/migration-v1.js';
import { appendEvent, readJournal, verifyJournal } from '../src/cognition/journal.js';
import { cognitionJournalDirectory, cognitionV1ImportPath } from '../src/storage/layout.js';
import { loadRuntimePolicy, writeRuntimePolicy } from '../src/cognition/policy.js';
import { runtimeStatus, startRuntime, stopRuntime } from '../src/cognition/runtime.js';
import { consoleProgress } from '../src/cli/progress.js';

const exec = promisify(execFile);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ctx 升级 test '));
  t.after(async () => { await stopRuntime(root); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  await initProject(root);
  await checkpoint(root, { progressSummary: '保留已经完成的工作和升级前的历史数据' });
  return root;
}

async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function scan(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await scan(file);
      else result[path.relative(root, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await scan(root);
  return result;
}

test('upgrade preview is read-only; apply backs up exact bytes and repeat preserves event identities', async (t) => {
  const root = await fixture(t);
  const before = await tree(path.join(root, '.context'));
  const preview = await upgradeProject(root, { dryRun: true });
  assert.equal(preview.applied, false);
  assert.deepEqual(await tree(path.join(root, '.context')), before);
  const phases: string[] = [];
  const upgraded = await upgradeProject(root, { onProgress: (event) => phases.push(event.phase) });
  assert.ok('backup' in upgraded && upgraded.backup);
  assert.deepEqual(await tree(path.join(upgraded.backup.directory, 'data')), before);
  assert.ok(phases.includes('import-records'));
  assert.equal(phases.at(-1), 'complete');
  const events = await verifyJournal(root);
  const again = await upgradeProject(root);
  assert.ok('journal' in again);
  assert.equal(again.journal.addedEvents, 0);
  assert.deepEqual(await verifyJournal(root), events);
  assert.equal((await runtimeStatus(root)).running, false);
});

test('upgrade archives large legacy logs losslessly and preserves disabled policy', async (t) => {
  const root = await fixture(t);
  await importV1(root);
  const policy = { ...await loadRuntimePolicy(root), enabled: false, autoStart: false, retentionMaxBytes: 12345 };
  await writeRuntimePolicy(root, policy);
  await appendEvent(root, { type: 'runtime.enabled', idempotencyKey: 'large-legacy-history', payload: { legacy: '旧日志内容'.repeat(100_000) } });
  const before = await verifyJournal(root);
  const upgraded = await upgradeProject(root);
  assert.ok('journal' in upgraded);
  assert.ok(upgraded.storage.savedBytes > 1_000_000);
  assert.deepEqual(await verifyJournal(root), before);
  assert.deepEqual(await loadRuntimePolicy(root), policy);
  assert.equal(upgraded.runtime.running, false);
});

test('upgrade resumes a missing import receipt without resetting policy or duplicating records', async (t) => {
  const root = await fixture(t);
  await importV1(root);
  const policy = { ...await loadRuntimePolicy(root), enabled: false, filesystemEventsEnabled: true };
  await writeRuntimePolicy(root, policy);
  const before = await verifyJournal(root);
  await rm(cognitionV1ImportPath(root));
  await upgradeProject(root);
  assert.deepEqual(await verifyJournal(root), before);
  assert.deepEqual(await loadRuntimePolicy(root), policy);
});

test('upgrade rejects corrupt journals before backup or source mutation', async (t) => {
  const root = await fixture(t);
  await importV1(root);
  const directory = cognitionJournalDirectory(root);
  await writeFile(path.join(directory, '00000001.ndjson'), '{broken');
  const before = await tree(path.join(root, '.context'));
  await assert.rejects(upgradeProject(root), /invalid journal record/);
  assert.deepEqual(await tree(path.join(root, '.context')), before);
});

test('upgrade restores a previously running runtime after successful verification', async (t) => {
  const root = await fixture(t);
  await importV1(root);
  await startRuntime(root);
  const previous = (await runtimeStatus(root)).lease;
  const result = await upgradeProject(root);
  assert.ok('runtime' in result);
  assert.equal(result.runtime.running, true);
  const events = await readJournal(root);
  const stopped = events.findIndex((event) => event.type === 'runtime.stopped' && event.source.instanceId === previous?.instanceId);
  const restarted = events.findIndex((event) => event.type === 'runtime.started' && event.source.instanceId === result.runtime.lease?.instanceId);
  assert.ok(stopped >= 0 && restarted > stopped, 'shutdown must finish its journal write before the replacement runtime starts');
});

test('upgrade failure keeps the verified backup and leaves runtime stopped for inspection', async (t) => {
  const root = await fixture(t);
  await assert.rejects(upgradeProject(root, { onProgress: ({ phase }) => {
    if (phase === 'migrate') throw new Error('injected interruption');
  } }), /Backup: .*injected interruption/);
  const backups = await readdir(path.join(root, '.context', 'backups'));
  assert.equal(backups.length, 1);
  const location = path.join(root, '.context', 'backups', backups[0]);
  assert.ok(JSON.parse(await readFile(path.join(location, 'backup.json'), 'utf8')).files.length > 0);
  await assert.rejects(readFile(path.join(location, 'upgrade.json')), /ENOENT/);
  assert.equal((await runtimeStatus(root)).running, false);
  assert.equal((await upgradeProject(root)).applied, true);
});

test('upgrade refuses a symlinked backup directory without writing outside the project', async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ctx-upgrade-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, '.context', 'backups'), 'junction');
  await assert.rejects(upgradeProject(root), /symlinked backup directory/);
  assert.deepEqual(await readdir(outside), []);
});

test('upgrade CLI emits progress on stderr and JSON on stdout, with quiet and preview controls', async (t) => {
  const root = await fixture(t);
  const cli = path.resolve('dist/src/cli/main.js');
  const before = await tree(path.join(root, '.context'));
  const preview = await exec(process.execPath, [cli, 'upgrade', '--path', root, '--dry-run']);
  assert.equal(JSON.parse(preview.stdout).applied, false);
  assert.match(preview.stderr, /\[#+\] preview-complete 100%/);
  assert.doesNotMatch(preview.stderr, /\x1b/);
  assert.deepEqual(await tree(path.join(root, '.context')), before);
  const applied = await exec(process.execPath, [cli, 'upgrade', '--path', root, '--no-progress']);
  assert.equal(JSON.parse(applied.stdout).applied, true);
  assert.equal(applied.stderr, '');
});

test('progress uses in-place rendering only for terminals', () => {
  let output = '';
  const render = consoleProgress({ isTTY: true, write: ((value: string) => { output += value; return true; }) as NodeJS.WriteStream['write'] });
  render({ phase: 'backup', completed: 5, total: 10, unit: 'bytes' });
  render({ phase: 'complete', completed: 1, total: 1 });
  assert.match(output, /\r\x1b\[2K\[##########----------\] backup 50%/);
  assert.ok(output.endsWith('\n'));
});
