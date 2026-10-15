import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson } from '../src/storage/atomic-write.js';

test('concurrent atomic writes never share a temporary file within one millisecond', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-atomic-'));
  try {
    t.mock.method(Date, 'now', () => 1234);
    const destination = path.join(root, 'state.json');
    await Promise.all(Array.from({ length: 32 }, (_, index) => atomicWriteJson(destination, { index, text: 'x'.repeat(4096) })));
    const final = JSON.parse(await fs.readFile(destination, 'utf8'));
    assert.equal(final.text, 'x'.repeat(4096));
    assert.ok(Number.isInteger(final.index) && final.index >= 0 && final.index < 32);
    assert.deepEqual(await fs.readdir(root), ['state.json']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows atomic replacement retries transient sharing failures without deleting the destination', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-atomic-'));
  const destination = path.join(root, 'state.json');
  const original = fs.rename;
  try {
    await atomicWriteJson(destination, { version: 'old' });
    let calls = 0;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      calls++;
      if (calls < 4) {
        assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { version: 'old' });
        throw Object.assign(new Error('simulated sharing violation'), { code: ['EPERM', 'EACCES', 'EBUSY'][calls - 1] });
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    await atomicWriteJson(destination, { version: 'new' });
    assert.equal(calls, 4);
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { version: 'new' });
    assert.deepEqual(await fs.readdir(root), ['state.json']);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('permanent atomic replacement failure preserves the old file and cleans its temporary file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-atomic-'));
  const destination = path.join(root, 'state.json');
  try {
    await atomicWriteJson(destination, { version: 'old' });
    let calls = 0;
    t.mock.method(fs, 'rename', async () => {
      calls++;
      throw Object.assign(new Error('simulated persistent permission failure'), { code: 'EPERM' });
    });
    syncBuiltinESMExports();
    await assert.rejects(atomicWriteJson(destination, { version: 'new' }), { code: 'EPERM' });
    assert.equal(calls, process.platform === 'win32' ? 9 : 1);
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { version: 'old' });
    assert.deepEqual(await fs.readdir(root), ['state.json']);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
