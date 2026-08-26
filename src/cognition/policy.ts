import { atomicWriteJson } from '../storage/atomic-write.js';
import { cognitionPolicyPath } from '../storage/layout.js';
import { readJson } from '../storage/json-store.js';
import type { CognitionRuntimePolicy } from './types.js';

const defaults = {
  schemaVersion: 2 as const,
  enabled: true,
  autoStart: true,
  allowHookStartup: true,
  inactivityTimeoutMs: 300_000,
  promptIntentMaxChars: 500,
  filesystemEventsEnabled: false,
  retentionMaxBytes: 64 * 1024 * 1024,
};

function booleanValue(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`runtime policy field ${field} must be boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`runtime policy field ${field} must be a non-negative integer`);
  return value;
}

export function normalizeRuntimePolicy(value: Partial<CognitionRuntimePolicy>): CognitionRuntimePolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime policy must be an object');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 2) throw new Error('unsupported runtime policy schema');
  return {
    ...defaults,
    enabled: booleanValue(value.enabled, defaults.enabled, 'enabled'),
    autoStart: booleanValue(value.autoStart, defaults.autoStart, 'autoStart'),
    allowHookStartup: booleanValue(value.allowHookStartup, defaults.allowHookStartup, 'allowHookStartup'),
    inactivityTimeoutMs: nonNegativeInteger(value.inactivityTimeoutMs, defaults.inactivityTimeoutMs, 'inactivityTimeoutMs'),
    promptIntentMaxChars: nonNegativeInteger(value.promptIntentMaxChars, defaults.promptIntentMaxChars, 'promptIntentMaxChars'),
    filesystemEventsEnabled: booleanValue(value.filesystemEventsEnabled, defaults.filesystemEventsEnabled, 'filesystemEventsEnabled'),
    retentionMaxBytes: nonNegativeInteger(value.retentionMaxBytes, defaults.retentionMaxBytes, 'retentionMaxBytes'),
  };
}

export async function loadRuntimePolicy(projectRoot: string): Promise<CognitionRuntimePolicy> {
  return normalizeRuntimePolicy(await readJson<Partial<CognitionRuntimePolicy>>(cognitionPolicyPath(projectRoot)));
}

export async function writeRuntimePolicy(projectRoot: string, policy: CognitionRuntimePolicy): Promise<void> {
  await atomicWriteJson(cognitionPolicyPath(projectRoot), normalizeRuntimePolicy(policy));
}
