import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { filterPaths } from '../capture/context-filter.js';
import { appendEvent } from './journal.js';
import type { CognitionGitAnchor, WorkspacePathChange } from './types.js';

const defaultDebounceMs = 250;
const defaultMaxPaths = 100;
const defaultMaxPayloadBytes = 16 * 1024;

export type WatchCallback = (eventType: string, filename: string | Buffer | null) => void;
export type WatchFactory = (projectRoot: string, callback: WatchCallback) => { close(): void };

interface FileMetadata {
  sizeBytes: number;
  mtimeMs: number;
}

export interface FilesystemObserverOptions {
  anchor?: () => CognitionGitAnchor;
  debounceMs?: number;
  maxPaths?: number;
  maxPayloadBytes?: number;
  watchFactory?: WatchFactory;
  onChanged?: (result: FilesystemObservationResult) => void;
}

export interface FilesystemObservationResult {
  changed: boolean;
  paths: string[];
}

function defaultWatchFactory(projectRoot: string, callback: WatchCallback): FSWatcher {
  return watch(projectRoot, { recursive: true }, callback);
}

function normalizeCandidate(projectRoot: string, filename: string | Buffer | null): string | null {
  if (filename === null) return null;
  const value = filename.toString().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return null;
  const absolute = resolve(projectRoot, value);
  const relative = absolute.slice(resolve(projectRoot).length).replaceAll('\\', '/').replace(/^\/+/, '');
  return relative || null;
}

function metadataEqual(left: FileMetadata | undefined, right: FileMetadata): boolean {
  return left?.sizeBytes === right.sizeBytes && left.mtimeMs === right.mtimeMs;
}

function payloadSize(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

export class FilesystemObserver {
  private readonly debounceMs: number;
  private readonly maxPaths: number;
  private readonly maxPayloadBytes: number;
  private readonly anchor: () => CognitionGitAnchor;
  private readonly watchFactory: WatchFactory;
  private readonly onChanged: ((result: FilesystemObservationResult) => void) | undefined;
  private readonly pendingPaths = new Map<string, string>();
  private readonly known = new Map<string, FileMetadata>();
  private watcher: { close(): void } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending = Promise.resolve<FilesystemObservationResult>({ changed: false, paths: [] });
  private closed = false;

  constructor(private readonly projectRoot: string, options: FilesystemObserverOptions = {}) {
    this.debounceMs = options.debounceMs ?? defaultDebounceMs;
    this.maxPaths = options.maxPaths ?? defaultMaxPaths;
    this.maxPayloadBytes = options.maxPayloadBytes ?? defaultMaxPayloadBytes;
    this.anchor = options.anchor ?? (() => ({ worktreeId: null, branch: null, ref: null, head: null }));
    this.watchFactory = options.watchFactory ?? defaultWatchFactory;
    this.onChanged = options.onChanged;
  }

  start(): void {
    if (this.closed || this.watcher) return;
    this.watcher = this.watchFactory(this.projectRoot, (eventType, filename) => {
      const relative = normalizeCandidate(this.projectRoot, filename);
      if (relative) this.pendingPaths.set(relative, eventType);
      this.scheduleFlush();
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    this.closed = true;
  }

  observeNow(): Promise<FilesystemObservationResult> {
    return this.flush();
  }

  async flush(): Promise<FilesystemObservationResult> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const paths = [...this.pendingPaths.entries()];
    this.pendingPaths.clear();
    if (paths.length === 0) return { changed: false, paths: [] };
    const operation = this.pending.then(() => this.process(paths), () => this.process(paths));
    this.pending = operation;
    return operation;
  }

  async drain(): Promise<void> {
    await this.pending;
    if (this.pendingPaths.size > 0) await this.flush();
    await this.pending;
  }

  close(): void {
    this.stop();
  }

  private scheduleFlush(delay = this.debounceMs): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, delay);
  }

  private async process(paths: Array<[string, string]>): Promise<FilesystemObservationResult> {
    const filtered = await filterPaths(this.projectRoot, paths.map(([relative]) => relative));
    const eventTypes = new Map(paths);
    const changes: WorkspacePathChange[] = [];
    for (const relative of filtered.slice(0, this.maxPaths)) {
      const absolute = resolve(this.projectRoot, relative);
      let current: FileMetadata | null = null;
      try {
        const value = await stat(absolute);
        if (!value.isFile()) continue;
        current = { sizeBytes: value.size, mtimeMs: value.mtimeMs };
      } catch {
        current = null;
      }
      const previous = this.known.get(relative);
      if (current && metadataEqual(previous, current)) continue;
      if (!current && !previous) continue;
      if (current) this.known.set(relative, current);
      else this.known.delete(relative);
      changes.push({
        path: relative,
        kind: current ? (previous ? 'modified' : eventTypes.get(relative) === 'rename' ? 'created' : 'modified') : 'deleted',
        fileType: 'file',
        ...(current ? { sizeBytes: current.sizeBytes, mtimeMs: current.mtimeMs } : {}),
      });
    }
    if (changes.length === 0) return { changed: false, paths: [] };
    const limitedChanges = changes.slice(0, this.maxPaths);
    const basePayload = {
      schemaVersion: 1 as const,
      paths: limitedChanges.map((change) => change.path),
      changes: limitedChanges,
      pathCount: limitedChanges.length,
      coalesced: paths.length > 1,
      truncated: filtered.length > limitedChanges.length || payloadSize({ changes: limitedChanges }) > this.maxPayloadBytes,
    };
    while (basePayload.changes.length > 1 && payloadSize(basePayload) > this.maxPayloadBytes) {
      basePayload.changes.pop();
      basePayload.paths.pop();
      basePayload.pathCount = basePayload.changes.length;
      basePayload.truncated = true;
    }
    if (basePayload.changes.length === 0 || payloadSize(basePayload) > this.maxPayloadBytes) return { changed: false, paths: [] };
    const result = await appendEvent(this.projectRoot, {
      type: 'workspace.paths.changed',
      source: { kind: 'fs-observer' },
      idempotencyKey: `fs:paths:${basePayload.paths.join(',')}:${basePayload.changes.map((change) => `${change.kind}:${change.sizeBytes ?? ''}:${change.mtimeMs ?? ''}`).join(',')}`,
      git: this.anchor(),
      payload: basePayload,
    });
    const observation = { changed: result.appended, paths: basePayload.paths };
    if (observation.changed) this.onChanged?.(observation);
    return observation;
  }
}
