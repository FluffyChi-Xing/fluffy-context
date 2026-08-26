import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileContext } from '../src/compiler/compile.js';
import { FilesystemObserver, type WatchCallback } from '../src/cognition/filesystem-observer.js';
import { projectEvents } from '../src/cognition/projections.js';
import { initProject } from '../src/runtime/init.js';
import { checkpoint } from '../src/runtime/runtime.js';
import { addNote } from '../src/runtime/notes.js';
import { learnKnowledge, recordDeadend, verifyDeadend, verifyKnowledge } from '../src/runtime/knowledge.js';
import type { CognitionEvent } from '../src/cognition/types.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'context-compiler-'));
}

function event(type: CognitionEvent['type'], payload: CognitionEvent['payload'], eventId: string, ref = 'refs/heads/main'): CognitionEvent {
  return {
    eventId,
    schemaVersion: 2,
    type,
    occurredAt: '2026-08-27T00:00:00.000Z',
    observedAt: '2026-08-27T00:00:00.000Z',
    projectId: 'project',
    source: { kind: 'fs-observer' },
    idempotencyKey: eventId,
    git: { worktreeId: 'worktree', branch: 'main', ref, head: 'head' },
    privacy: { classification: 'metadata', redactionCount: 0 },
    payload,
    previousHash: null,
    hash: eventId,
  };
}

test('Compiler emits a deterministic bounded manifest with governed sources', async () => {
  const root = await project();
  try {
    await initProject(root);
    const saved = await checkpoint(root, {
      title: 'Fix authentication regression',
      progressSummary: 'Investigate the failing authentication callback',
      pendingTasks: ['Run the regression test suite'],
      decisions: ['Keep signature validation at the boundary'],
      risks: ['The callback can fail on malformed input'],
      relatedFiles: ['src/auth.ts'],
    });
    assert.equal(saved.status, 'saved');
    const note = await addNote(root, 'Authentication callback failure needs reproduction', { contextId: saved.context.id });
    const candidate = await learnKnowledge(root, 'Callbacks require signature validation');
    const knowledge = await verifyKnowledge(root, candidate.knowledgeId);
    const deadend = await recordDeadend(root, 'Retried without validating the signature', 'The callback remained exploitable');
    await verifyDeadend(root, deadend.deadendId);

    const first = await compileContext(root, { query: 'debug authentication callback signature', maxChars: 1000 });
    const second = await compileContext(root, { query: 'debug authentication callback signature', maxChars: 1000 });
    assert.deepEqual(first, second);
    assert.equal(first.status, 'ready');
    assert.equal(first.intent.scenario, 'debugging');
    assert.ok(first.intent.signals.some((signal) => signal.source === 'explicit-query'));
    assert.ok(first.selected.some((candidate) => candidate.source.entityId === saved.context.id));
    assert.ok(first.selected.some((candidate) => candidate.source.entityId === note.noteId));
    assert.ok(first.selected.some((candidate) => candidate.source.entityId === knowledge.knowledgeId));
    assert.ok(first.selected.some((candidate) => candidate.source.entityId === deadend.deadendId));
    assert.ok(first.excluded.every((item) => item.reason !== 'v2_unavailable'));
    assert.ok(first.budget.usedChars <= 1000);
    assert.ok(first.text.length <= 1000);

    const empty = await compileContext(root, { contextId: saved.context.id, maxChars: 0 });
    assert.equal(empty.budget.usedChars, 0);
    assert.equal(empty.selected.length, 0);
    assert.equal(empty.truncation.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FilesystemObserver records only real allowed file metadata changes', async () => {
  const root = await project();
  let callback: WatchCallback | undefined;
  let closed = false;
  try {
    await initProject(root);
    const observer = new FilesystemObserver(root, {
      debounceMs: 0,
      watchFactory: (_root, next) => {
        callback = next;
        return { close: () => { closed = true; } };
      },
    });
    observer.start();
    await writeFile(path.join(root, 'allowed.txt'), 'one');
    callback?.('rename', 'allowed.txt');
    const created = await observer.flush();
    assert.deepEqual(created.paths, ['allowed.txt']);
    assert.equal(created.changed, true);

    callback?.('change', 'allowed.txt');
    assert.equal((await observer.flush()).changed, false);
    await writeFile(path.join(root, 'allowed.txt'), 'two');
    callback?.('change', 'allowed.txt');
    const modified = await observer.flush();
    assert.deepEqual(modified.paths, ['allowed.txt']);

    await writeFile(path.join(root, '.env'), 'secret');
    callback?.('change', '.env');
    assert.equal((await observer.flush()).changed, false);
    await rm(path.join(root, 'allowed.txt'));
    callback?.('rename', 'allowed.txt');
    assert.equal((await observer.flush()).changed, true);
    observer.close();
    assert.equal(closed, true);

    const journal = await readFile(path.join(root, '.context', 'v2', 'journal', '00000001.ndjson'), 'utf8');
    assert.equal(journal.includes('one'), false);
    assert.equal(journal.includes('two'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace path events update bounded pathFocus and ignore unsafe paths', () => {
  const projection = projectEvents([
    event('workspace.paths.changed', {
      schemaVersion: 1,
      paths: ['src\\main.ts', '../escape.ts', '/absolute.ts', 'src/main.ts', 'src/other.ts'],
      changes: [],
      pathCount: 5,
      coalesced: true,
      truncated: false,
    }, 'event-paths'),
  ]);
  const workspace = Object.values(projection.workspaces)[0];
  assert.deepEqual(workspace.pathFocus, ['src/main.ts', 'src/other.ts']);
});
