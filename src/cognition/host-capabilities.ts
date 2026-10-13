import { appendEvent, readJournal } from './journal.js';
import { resolveProjectRoot } from '../project/project-resolver.js';
import type { CognitionEvent } from './types.js';
import { createHash } from 'node:crypto';

export type HostInterface = 'cli' | 'mcp' | 'agent' | 'hook';
export type HostTriggerStatus = 'observed' | 'unsupported' | 'failed';
export type HostDeliveryMode = 'full' | 'delta' | 'replacement' | 'unchanged' | 'none';

export interface HostCapability {
  interface: HostInterface;
  adapter: string;
  triggers: string[];
  sessionIdentity: string;
  deliveryMode: 'full' | 'delta' | 'explicit' | 'none';
  fallback: string;
}

export interface HostTriggerObservation {
  interface: HostInterface;
  adapter: string;
  trigger: string;
  status: HostTriggerStatus;
  deliveryMode?: HostDeliveryMode;
  sessionId?: string;
  taskId?: string;
  observationId?: string;
}

export interface HostCapabilityReport {
  schemaVersion: 1;
  projectRoot: string;
  capabilities: HostCapability[];
  declaredAdapters: string[];
  observations: { total: number; byInterface: Record<string, number>; byTrigger: Record<string, number>; byStatus: Record<string, number>; byDeliveryMode: Record<string, number> };
  journalEventCount: number;
}

export const HOST_CAPABILITIES: readonly HostCapability[] = [
  { interface: 'cli', adapter: 'cli', triggers: ['manual', 'context-reset'], sessionIdentity: 'explicit sessionId when supplied', deliveryMode: 'delta', fallback: 'run ctx inject or ctx orient explicitly' },
  { interface: 'mcp', adapter: 'mcp', triggers: ['tool-call', 'context-reset'], sessionIdentity: 'client supplied sessionId', deliveryMode: 'explicit', fallback: 'call context_inject or context_orient explicitly' },
  { interface: 'agent', adapter: 'agent-api', triggers: ['manual', 'context-reset'], sessionIdentity: 'caller supplied sessionId', deliveryMode: 'delta', fallback: 'call the Agent API explicitly' },
  { interface: 'hook', adapter: 'claude-code', triggers: ['session-start', 'user-prompt'], sessionIdentity: 'host session_id + agent_id hash', deliveryMode: 'delta', fallback: 'project guidance and explicit ctx inject' },
];

function capability(interfaceName: HostInterface, adapter: string): HostCapability {
  return HOST_CAPABILITIES.find((item) => item.interface === interfaceName && item.adapter === adapter) ?? {
    interface: interfaceName, adapter, triggers: [], sessionIdentity: 'unknown', deliveryMode: 'none', fallback: 'explicit tool call required',
  };
}

export async function recordHostCapability(startPath: string | undefined, interfaceName: HostInterface, adapter: string): Promise<void> {
  const value = capability(interfaceName, adapter);
  try {
    await appendEvent(startPath, {
      type: 'host.capability.declared',
      source: { kind: interfaceName === 'hook' ? 'claude-hook' : interfaceName },
      idempotencyKey: `host-capability:${value.interface}:${value.adapter}`,
      payload: { schemaVersion: 1, ...value },
    });
  } catch { /* capability telemetry must not block the host */ }
}

export async function recordHostTrigger(startPath: string | undefined, observation: HostTriggerObservation): Promise<void> {
  try {
    const hashed = (value: string | undefined) => value ? createHash('sha256').update(value).digest('hex') : undefined;
    const { observationId, sessionId, taskId, ...metadata } = observation;
    await appendEvent(startPath, {
      type: 'host.trigger.observed',
      source: { kind: observation.interface === 'hook' ? 'claude-hook' : observation.interface },
      idempotencyKey: `host-trigger:${observation.interface}:${observation.adapter}:${observation.trigger}:${observationId ? hashed(observationId) : `${Date.now()}:${Math.random().toString(36).slice(2)}`}`,
      payload: { schemaVersion: 1, ...metadata, ...(sessionId ? { sessionId: hashed(sessionId) } : {}), ...(taskId ? { taskId: hashed(taskId) } : {}) },
    });
  } catch { /* trigger telemetry must not block the host */ }
}

export async function buildHostCapabilityReport(startPath: string | undefined): Promise<HostCapabilityReport> {
  const projectRoot = await resolveProjectRoot(startPath);
  const events: CognitionEvent[] = await readJournal(projectRoot);
  const observations = events.filter((event) => event.type === 'host.trigger.observed');
  const count = (field: string) => observations.reduce<Record<string, number>>((result, event) => {
    const value = (event.payload as Record<string, unknown>)[field];
    if (typeof value === 'string') result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
  const declaredAdapters = events.filter((event) => event.type === 'host.capability.declared').map((event) => {
    const payload = event.payload as Record<string, unknown>;
    return `${payload.interface}/${payload.adapter}`;
  });
  return { schemaVersion: 1, projectRoot, capabilities: HOST_CAPABILITIES.map((item) => ({ ...item, triggers: [...item.triggers] })), declaredAdapters, observations: { total: observations.length, byInterface: count('interface'), byTrigger: count('trigger'), byStatus: count('status'), byDeliveryMode: count('deliveryMode') }, journalEventCount: events.length };
}

export function formatHostCapabilityReport(report: HostCapabilityReport): string {
  const lines = ['fluffy-context host capabilities', `Project: ${report.projectRoot}`, '', 'CAPABILITIES'];
  for (const item of report.capabilities) lines.push(`  ${item.interface}/${item.adapter}: ${item.triggers.join(', ')} (${item.deliveryMode})`);
  lines.push(`  Declared locally: ${report.declaredAdapters.join(', ') || 'none'}`, '', 'OBSERVATIONS', `  Total: ${report.observations.total}`, `  Journal events: ${report.journalEventCount}`);
  for (const [label, values] of [['Interface', report.observations.byInterface], ['Trigger', report.observations.byTrigger], ['Status', report.observations.byStatus], ['Delivery', report.observations.byDeliveryMode]] as const) {
    lines.push(`  ${label}:`);
    for (const [key, value] of Object.entries(values)) lines.push(`    ${key}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}
