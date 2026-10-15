import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { withLock } from '../storage/lock.js';
import { contentHash } from './identity.js';
import type { ContextCandidate, ContextManifest } from './types.js';

const MAX_SESSIONS = 32;
const MAX_ITEMS = 128;
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;

export interface SessionOptions {
  sessionId?: string;
  taskId?: string;
  resetSession?: boolean;
}

export interface InjectionDelivery {
  mode: 'full' | 'delta' | 'unchanged';
  reason: 'stateless' | 'first-in-session' | 'reset' | 'task-or-scope-changed' | 'evidence-changed' | 'new-evidence' | 'duplicate' | 'cache-unavailable' | 'capacity';
  replacePrevious: boolean;
  omittedSources: number;
}

interface Receipt {
  sessionHash: string;
  adapterHash: string;
  boundaryHash: string;
  items: Record<string, string>;
  updatedAt: number;
  lastMode: InjectionDelivery['mode'];
}

interface Cache { schemaVersion: 1; sessions: Receipt[]; }

function cachePaths(root: string) {
  return { directory: path.join(root, '.context'), file: path.join(root, '.context', 'injection-cache.json'), lock: path.join(root, '.context', 'injection-cache.lock') };
}

async function safePath(file: string): Promise<void> {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('injection cache refuses symlinks');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readCache(file: string): Promise<Cache> {
  try {
    await safePath(file);
    if ((await lstat(file)).size > MAX_BYTES) throw new Error('injection cache exceeds size limit');
    const value = JSON.parse(await readFile(file, 'utf8')) as Cache;
    if (value.schemaVersion !== 1 || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) throw new Error('invalid injection cache');
    const now = Date.now();
    const sessions = value.sessions.filter((item) => item && HASH.test(item.sessionHash) && HASH.test(item.adapterHash) && HASH.test(item.boundaryHash)
      && Number.isSafeInteger(item.updatedAt) && item.updatedAt <= now && now - item.updatedAt < TTL_MS
      && ['full', 'delta', 'unchanged'].includes(item.lastMode)
      && item.items && typeof item.items === 'object' && !Array.isArray(item.items)
      && Object.keys(item.items).length <= MAX_ITEMS
      && Object.entries(item.items).every(([key, hash]) => HASH.test(key) && typeof hash === 'string' && HASH.test(hash)));
    return { schemaVersion: 1, sessions };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return { schemaVersion: 1, sessions: [] };
    throw error;
  }
}

export function validateSessionOptions(options: SessionOptions): void {
  for (const [name, value] of [['sessionId', options.sessionId], ['taskId', options.taskId]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 256)) throw new Error(`${name} must contain 1 to 256 characters`);
  }
  if ((options.taskId !== undefined || options.resetSession) && !options.sessionId) throw new Error('taskId and resetSession require sessionId');
}

/** Derived, bounded receipts hold hashes only. They never establish knowledge trust. */
export async function selectSessionDelivery(manifest: ContextManifest, options: SessionOptions, adapter: string, referenceBudget = 4096): Promise<{ selected: ContextCandidate[]; delivery: InjectionDelivery }> {
  const full = (reason: InjectionDelivery['reason'], replacePrevious = false) => ({ selected: manifest.selected,
    delivery: { mode: 'full' as const, reason, replacePrevious, omittedSources: 0 } });
  if (!options.sessionId) return full('stateless');
  const locations = cachePaths(manifest.projectRoot);
  try {
    await safePath(locations.directory);
    await safePath(locations.file);
    await safePath(locations.lock);
    return await withLock(locations.lock, async () => {
      const cache = await readCache(locations.file);
      const adapterHash = contentHash(adapter);
      const sessionHash = contentHash({ adapterHash, sessionId: options.sessionId });
      const previous = cache.sessions.find((item) => item.sessionHash === sessionHash);
      cache.sessions = cache.sessions.filter((item) => item.sessionHash !== sessionHash);
      if (manifest.selected.length > MAX_ITEMS) {
        await atomicWriteJson(locations.file, cache);
        return full('capacity', true);
      }
      const boundaryHash = contentHash({
        ranking: manifest.rankingVersion,
        anchor: manifest.anchor,
        task: options.taskId ?? manifest.intent.query?.normalize('NFC').replace(/\s+/g, ' ').trim() ?? '',
        context: manifest.context?.id ?? null,
        snapshot: manifest.snapshot?.snapshotId ?? null,
        scenario: manifest.intent.scenario,
        scope: manifest.intent.scope,
        paths: manifest.intent.paths,
        budget: manifest.budget.requested.total,
        referenceBudget,
        recipe: manifest.recipe ?? null,
        graph: manifest.graph ?? null,
      });
      const items = Object.fromEntries(manifest.selected.map((item) => [contentHash(item.candidateId), contentHash({ item: item.itemHash, text: item.text })]));
      let result = full(options.resetSession ? 'reset' : !previous ? 'first-in-session' : 'task-or-scope-changed', Boolean(previous) || Boolean(options.resetSession));
      if (previous && !options.resetSession && previous.boundaryHash === boundaryHash) {
        // Retractions and edits require a replacement packet, never a silent delta.
        const removedOrChanged = Object.entries(previous.items).some(([key, hash]) => items[key] !== hash);
        if (removedOrChanged) result = full('evidence-changed', true);
        else {
          const selected = manifest.selected.filter((item) => previous.items[contentHash(item.candidateId)] === undefined);
          return await save(selected, { mode: selected.length ? 'delta' : 'unchanged', reason: selected.length ? 'new-evidence' : 'duplicate', replacePrevious: false, omittedSources: manifest.selected.length - selected.length });
        }
      }
      return await save(result.selected, result.delivery);

      async function save(selected: ContextCandidate[], delivery: InjectionDelivery) {
        cache.sessions.push({ sessionHash, adapterHash, boundaryHash, items, updatedAt: Date.now(), lastMode: delivery.mode });
        cache.sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.sessionHash.localeCompare(b.sessionHash));
        cache.sessions = cache.sessions.slice(0, MAX_SESSIONS);
        await atomicWriteJson(locations.file, cache);
        return { selected, delivery };
      }
    });
  } catch {
    // A receipt is an optimization. Busy, damaged or unwritable caches must not
    // prevent context from reaching the caller or turn a hook into a blocker.
    return full('cache-unavailable', true);
  }
}

export async function inspectInjectionSession(root: string, adapter: string) {
  const locations = cachePaths(root);
  try {
    await safePath(locations.directory);
    const cache = await readCache(locations.file);
    const receipt = cache.sessions.filter((item) => item.adapterHash === contentHash(adapter)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return { available: true, lastLocalInvocation: receipt ? { at: new Date(receipt.updatedAt).toISOString(), mode: receipt.lastMode } : null,
      hostAcceptance: 'not-observed' as const };
  } catch {
    return { available: false, lastLocalInvocation: null, hostAcceptance: 'not-observed' as const };
  }
}
