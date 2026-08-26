import { atomicWriteJson } from '../storage/atomic-write.js';
import { cognitionPolicyPath } from '../storage/layout.js';
import { readJson } from '../storage/json-store.js';
import type { CognitionRuntimePolicy } from './types.js';

const defaults: Omit<CognitionRuntimePolicy, 'enabled' | 'autoStart' | 'allowHookStartup'> = {
  schemaVersion: 2,
  inactivityTimeoutMs: 300_000,
  promptIntentMaxChars: 500,
  filesystemEventsEnabled: false,
  retentionMaxBytes: 64 * 1024 * 1024,
};

export function normalizeRuntimePolicy(value: Partial<CognitionRuntimePolicy>): CognitionRuntimePolicy {
  const hasAutoStart = typeof value.autoStart === 'boolean';
  const autoStart = hasAutoStart ? value.autoStart as boolean : true;
  return {
    ...defaults,
    ...value,
    schemaVersion: 2,
    enabled: hasAutoStart ? value.enabled !== false : true,
    autoStart,
    allowHookStartup: value.allowHookStartup === true,
  };
}

export async function loadRuntimePolicy(projectRoot: string): Promise<CognitionRuntimePolicy> {
  return normalizeRuntimePolicy(await readJson<Partial<CognitionRuntimePolicy>>(cognitionPolicyPath(projectRoot)));
}

export async function writeRuntimePolicy(projectRoot: string, policy: CognitionRuntimePolicy): Promise<void> {
  await atomicWriteJson(cognitionPolicyPath(projectRoot), normalizeRuntimePolicy(policy));
}
