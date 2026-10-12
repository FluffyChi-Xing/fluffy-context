import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectRoot, withProjectResolution } from '../src/project/project-resolver.js';

test('project resolution is stable within a request and refreshes on the next request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-resolution-'));
  const child = path.join(root, 'child');
  try {
    await mkdir(path.join(root, '.context'));
    await mkdir(child);
    await withProjectResolution(async () => {
      assert.equal(await resolveProjectRoot(child), root);
      await promisify(execFile)('git', ['init', child], { windowsHide: true });
      assert.equal(await resolveProjectRoot(child), root);
    });
    assert.equal(await withProjectResolution(() => resolveProjectRoot(child)), await realpath(child));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
