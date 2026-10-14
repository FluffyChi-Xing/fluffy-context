import { readdir } from 'node:fs/promises';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { readJson, isRecord } from '../storage/json-store.js';
import { contextsRoot, contextMetadataPath, snapshotsDirectory } from '../storage/layout.js';
import { journalStorage } from './journal-segments.js';
import { readAdmissionStats } from './admission.js';
import { readJournalIndexed } from './journal-index.js';
import { listDeadends, listKnowledge } from '../runtime/knowledge.js';
import { listNotes } from '../runtime/notes.js';
import type { CognitionEvent, UsageOperationCompletedPayload } from './types.js';
import type { ContextMetadata, Deadend, Knowledge, Note } from '../runtime/types.js';
import { HOST_CAPABILITIES } from './host-capabilities.js';

export type UsageReportFormat = 'json' | 'ascii';
export type UsageGranularity = 'day' | 'week' | 'month';

export interface UsageReportOptions {
  since?: string;
  until?: string;
  days?: number;
  month?: string;
  granularity?: UsageGranularity;
  baselineTokens?: number;
  baselineSource?: 'manual' | 'recorded-control';
}

export interface UsageMetric<T> { value: T | null; quality: 'measured' | 'estimated' | 'derived' | 'unavailable'; unit: string; method?: string; }
interface Window { from: string; to: string; kind: 'rolling' | 'calendar-month' | 'explicit'; granularity: UsageGranularity; }

interface TrendBucket {
  operations: number;
  usageOperations: number;
  recordsUsed: number;
  outputChars: number;
  estimatedOutputTokens: number;
  knowledgeCreated: number;
  knowledgeVerified: number;
  deadendsCreated: number;
  deadendsVerified: number;
}

export interface UsageReport {
  schemaVersion: 1;
  generatedAt: string;
  projectRoot: string;
  window: Window;
  dataQuality: Record<string, unknown>;
  assets: Record<string, unknown>;
  reuse: Record<string, unknown>;
  investment: Record<string, unknown>;
  payback: Record<string, unknown>;
  operations: Record<string, unknown>;
  delivery: Record<string, unknown>;
  trends: Array<Record<string, unknown>>;
  warnings: string[];
}

function metric<T>(value: T | null, quality: UsageMetric<T>['quality'], unit: string, method?: string): UsageMetric<T> {
  return { value, quality, unit, ...(method ? { method } : {}) };
}

function iso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`invalid ISO date: ${value}`);
  return new Date(time).toISOString();
}

function windowOf(options: UsageReportOptions, now = new Date()): Window {
  if (options.month && !/^\d{4}-\d{2}$/.test(options.month)) throw new Error('--month must be YYYY-MM');
  if (options.since && options.month) throw new Error('--since and --month cannot be combined');
  if (options.days !== undefined && (!Number.isInteger(options.days) || options.days < 0)) throw new Error('--days must be a non-negative integer');
  const to = options.until ? iso(options.until) : now.toISOString();
  const toMs = Date.parse(to);
  if (options.month) {
    const [year, month] = options.month.split('-').map(Number);
    const from = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    if (month < 1 || month > 12 || end.getUTCMonth() !== month % 12) throw new Error('--month must be a valid calendar month');
    return { from: from.toISOString(), to: end.toISOString(), kind: 'calendar-month', granularity: options.granularity ?? 'week' };
  }
  const from = options.since ? iso(options.since) : new Date(toMs - (options.days ?? 30) * 86_400_000).toISOString();
  if (Date.parse(from) > toMs) throw new Error('--since must not be after --until');
  return { from, to, kind: options.since || options.until ? 'explicit' : 'rolling', granularity: options.granularity ?? 'day' };
}

function inWindow(event: CognitionEvent, window: Window): boolean {
  const time = Date.parse(event.occurredAt);
  return time >= Date.parse(window.from) && time < Date.parse(window.to);
}

function dayStart(value: string, granularity: UsageGranularity): string {
  const date = new Date(value);
  if (granularity === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
  if (granularity === 'week') {
    const day = date.getUTCDay();
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - (day === 0 ? 6 : day - 1))).toISOString();
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

async function contexts(projectRoot: string): Promise<{ items: ContextMetadata[]; snapshots: number }> {
  let ids: string[] = [];
  try { ids = await readdir(contextsRoot(projectRoot)); } catch { return { items: [], snapshots: 0 }; }
  const items: ContextMetadata[] = [];
  let snapshots = 0;
  for (const id of ids) {
    try {
      const item = await readJson<ContextMetadata>(contextMetadataPath(projectRoot, id), (value): value is ContextMetadata => isRecord(value) && value.schemaVersion === 1 && value.id === id);
      items.push(item);
      snapshots += (await readdir(snapshotsDirectory(projectRoot, id))).filter((file) => file.endsWith('.json')).length;
    } catch { /* invalid files are reported by doctor */ }
  }
  return { items, snapshots };
}

function usagePayload(event: CognitionEvent): UsageOperationCompletedPayload | null {
  if (event.type !== 'usage.operation.completed' || !isRecord(event.payload)) return null;
  const payload = event.payload as Partial<UsageOperationCompletedPayload>;
  return (payload.operation === 'orient' || payload.operation === 'compile' || payload.operation === 'expand' || payload.operation === 'resume')
    && (payload.interface === 'cli' || payload.interface === 'mcp' || payload.interface === 'agent' || payload.interface === 'hook')
    && typeof payload.success === 'boolean'
    && typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) && payload.durationMs >= 0
    && typeof payload.inputChars === 'number' && Number.isFinite(payload.inputChars) && payload.inputChars >= 0
    && typeof payload.outputChars === 'number' && Number.isFinite(payload.outputChars) && payload.outputChars >= 0
    && typeof payload.inputBytes === 'number' && Number.isFinite(payload.inputBytes) && payload.inputBytes >= 0
    && typeof payload.outputBytes === 'number' && Number.isFinite(payload.outputBytes) && payload.outputBytes >= 0
    && typeof payload.estimatedInputTokens === 'number' && Number.isFinite(payload.estimatedInputTokens) && payload.estimatedInputTokens >= 0
    && typeof payload.estimatedOutputTokens === 'number' && Number.isFinite(payload.estimatedOutputTokens) && payload.estimatedOutputTokens >= 0
    && payload.estimatedMethod === 'chars-div-four'
    ? payload as UsageOperationCompletedPayload : null;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function groupedOperationStats(events: CognitionEvent[], keyFor: (payload: UsageOperationCompletedPayload) => string): Record<string, unknown> {
  const groups = new Map<string, UsageOperationCompletedPayload[]>();
  for (const event of events) {
    const payload = usagePayload(event);
    if (!payload) continue;
    const key = keyFor(payload);
    groups.set(key, [...(groups.get(key) ?? []), payload]);
  }
  const byOperation: Record<string, unknown> = {};
  for (const [operation, values] of groups) {
    const durations = values.map((item) => item.durationMs);
    byOperation[operation] = {
      calls: values.length,
      successes: values.filter((item) => item.success).length,
      failures: values.filter((item) => !item.success).length,
      successRate: values.filter((item) => item.success).length / values.length,
      errorRate: values.filter((item) => !item.success).length / values.length,
      durationMs: { average: durations.reduce((sum, value) => sum + value, 0) / values.length, p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: Math.max(...durations) },
      inputChars: values.reduce((sum, item) => sum + item.inputChars, 0),
      outputChars: values.reduce((sum, item) => sum + item.outputChars, 0),
      inputBytes: values.reduce((sum, item) => sum + item.inputBytes, 0),
      outputBytes: values.reduce((sum, item) => sum + item.outputBytes, 0),
      estimatedInputTokens: values.reduce((sum, item) => sum + item.estimatedInputTokens, 0),
      estimatedOutputTokens: values.reduce((sum, item) => sum + item.estimatedOutputTokens, 0),
    };
  }
  return byOperation;
}

function operationStats(events: CognitionEvent[]): { byOperation: Record<string, unknown>; byInterface: Record<string, unknown> } {
  return {
    byOperation: groupedOperationStats(events, (payload) => payload.operation),
    byInterface: groupedOperationStats(events, (payload) => payload.interface),
  };
}

function deliveryStats(events: CognitionEvent[], history: CognitionEvent[]): Record<string, unknown> {
  const declared = new Set(history.filter((event) => event.type === 'host.capability.declared').map((event) => {
    const payload = event.payload as Record<string, unknown>;
    return `${payload.interface}/${payload.adapter}`;
  }));
  const observations = events.filter((event) => event.type === 'host.trigger.observed');
  const grouped = (keyFor: (payload: Record<string, unknown>) => string) => {
    const groups: Record<string, { observed: number; failed: number; unsupported: number; byMode: Record<string, number> }> = {};
    for (const event of observations) {
      const payload = event.payload as Record<string, unknown>;
      const key = keyFor(payload);
      const entry = groups[key] ?? { observed: 0, failed: 0, unsupported: 0, byMode: {} };
      const status = payload.status as 'observed' | 'failed' | 'unsupported';
      entry[status] += 1;
      if (typeof payload.deliveryMode === 'string') entry.byMode[payload.deliveryMode] = (entry.byMode[payload.deliveryMode] ?? 0) + 1;
      groups[key] = entry;
    }
    return Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, {
      ...value,
      total: value.observed + value.failed + value.unsupported,
      errorRate: value.observed + value.failed === 0 ? null : value.failed / (value.observed + value.failed),
    }]));
  };
  const observedPairs = new Set(observations.map((event) => {
    const payload = event.payload as Record<string, unknown>;
    return `${payload.interface}/${payload.adapter}/${payload.trigger}`;
  }));
  const unobservedSupported = HOST_CAPABILITIES.filter((item) => declared.has(`${item.interface}/${item.adapter}`)).flatMap((item) => item.triggers.filter((trigger) => !observedPairs.has(`${item.interface}/${item.adapter}/${trigger}`)).map((trigger) => ({ interface: item.interface, adapter: item.adapter, trigger })));
  const known = new Set(HOST_CAPABILITIES.flatMap((item) => item.triggers.map((trigger) => `${item.interface}/${item.adapter}/${trigger}`)));
  const unknownTriggerPairs = [...new Set(observations.flatMap((event) => {
    const payload = event.payload as Record<string, unknown>;
    const pair = `${payload.interface}/${payload.adapter}/${payload.trigger}`;
    return known.has(pair) ? [] : [pair];
  }))].sort();
  const unknownTriggerCount = observations.filter((event) => {
    const payload = event.payload as Record<string, unknown>;
    return !known.has(`${payload.interface}/${payload.adapter}/${payload.trigger}`);
  }).length;
  return {
    available: observations.length > 0,
    observationCount: observations.length,
    declaredAdapters: [...declared].sort(),
    byInterface: grouped((payload) => String(payload.interface)),
    byTrigger: grouped((payload) => String(payload.trigger)),
    byMode: observations.reduce<Record<string, number>>((result, event) => {
      const mode = (event.payload as Record<string, unknown>).deliveryMode;
      if (typeof mode === 'string') result[mode] = (result[mode] ?? 0) + 1;
      return result;
    }, {}),
    unobservedSupported,
    unknownTriggerCount,
    unknownTriggerPairs,
    reason: observations.length ? null : 'No host trigger observations in this window; this does not prove a trigger failed',
  };
}

export async function buildUsageReport(startPath: string | undefined, options: UsageReportOptions = {}): Promise<UsageReport> {
  if (options.baselineTokens !== undefined && (!Number.isSafeInteger(options.baselineTokens) || options.baselineTokens < 0)) throw new Error('baselineTokens must be a non-negative safe integer');
  const projectRoot = await resolveProjectRoot(startPath);
  const window = windowOf(options);
  let events: CognitionEvent[] = [];
  let journalVerified = true;
  let journalRead: { mode: string; reason: string | null } = { mode: 'unavailable', reason: null };
  try {
    const result = await readJournalIndexed(projectRoot);
    events = result.events;
    journalRead = { mode: result.mode, reason: result.reason };
    journalVerified = result.mode === 'full';
  } catch (error) {
    if (!(error instanceof Error && /ENOENT|manifest|not initialized/i.test(error.message))) throw error;
    journalVerified = false;
  }
  const scoped = events.filter((event) => inWindow(event, window));
  const storage = await journalStorage(projectRoot, journalRead.mode !== 'indexed');
  const admission = await readAdmissionStats(projectRoot);
  const journalBytes = storage.bytes;
  const eventTypes: Record<string, number> = {};
  for (const event of scoped) eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
  const semanticEvents = scoped.filter((event) => /^(context\.|knowledge\.|deadend\.|note\.|experience\.|evolution\.|skill\.|recipe\.|record\.used)/.test(event.type)).length;
  const usageEvents = scoped.map((event) => ({ event, payload: usagePayload(event) })).filter((item): item is { event: CognitionEvent; payload: UsageOperationCompletedPayload } => item.payload !== null);
  const knowledge = await listKnowledge(projectRoot, true);
  const deadends = await listDeadends(projectRoot, true);
  const notes = await listNotes(projectRoot, { limit: Number.MAX_SAFE_INTEGER, maxChars: 0 });
  const contextData = await contexts(projectRoot);
  const used = new Map<string, number>();
  for (const event of events.filter((item) => item.type === 'record.used')) {
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.entity === 'string' && typeof payload.entityId === 'string') used.set(`${payload.entity}:${payload.entityId}`, (used.get(`${payload.entity}:${payload.entityId}`) ?? 0) + 1);
  }
  const verified = [...knowledge.filter((item) => item.status === 'verified').map((item) => `knowledge:${item.knowledgeId}`), ...deadends.filter((item) => item.status === 'verified').map((item) => `deadend:${item.deadendId}`)];
  const usedVerified = verified.filter((key) => (used.get(key) ?? 0) > 0).length;
  const recordUsed = scoped.filter((event) => event.type === 'record.used').length;
  const lifecycle = (type: string) => scoped.filter((event) => event.type === type).length;
  const buckets = new Map<string, TrendBucket>();
  for (const event of scoped) {
    const key = dayStart(event.occurredAt, window.granularity);
    const bucket = buckets.get(key) ?? { operations: 0, usageOperations: 0, recordsUsed: 0, outputChars: 0, estimatedOutputTokens: 0, knowledgeCreated: 0, knowledgeVerified: 0, deadendsCreated: 0, deadendsVerified: 0 };
    const payload = usagePayload(event);
    if (payload) {
      bucket.operations += 1;
      bucket.usageOperations += 1;
      bucket.outputChars += payload.outputChars;
      bucket.estimatedOutputTokens += payload.estimatedOutputTokens;
    }
    if (event.type === 'record.used') bucket.recordsUsed += 1;
    if (event.type === 'knowledge.proposed') bucket.knowledgeCreated += 1;
    if (event.type === 'knowledge.verified') bucket.knowledgeVerified += 1;
    if (event.type === 'deadend.proposed') bucket.deadendsCreated += 1;
    if (event.type === 'deadend.verified') bucket.deadendsVerified += 1;
    buckets.set(key, bucket);
  }
  const ctxTokens = usageEvents.reduce((sum, item) => sum + item.payload.estimatedOutputTokens, 0);
  const inputTokens = usageEvents.reduce((sum, item) => sum + item.payload.estimatedInputTokens, 0);
  const totalTokens = ctxTokens + inputTokens;
  const baseline = options.baselineTokens ?? null;
  const savings = baseline === null || usageEvents.length === 0 ? null : baseline - totalTokens;
  const investment = metric(ctxTokens, 'estimated', 'tokens', 'chars-div-four');
  const rawAssets = verified.length;
  const usedCount = verified.reduce((sum, key) => sum + Math.min(used.get(key) ?? 0, 3), 0);
  const trendEntries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  let cumulativeInvestmentTokens = 0;
  let cumulativeOutputChars = 0;

  const trends = trendEntries.map(([periodStart, values]) => {
    cumulativeInvestmentTokens += values.estimatedOutputTokens;
    cumulativeOutputChars += values.outputChars;
    // A window-total baseline cannot establish when savings occurred.
    const cumulativeSavings = null;
    return {
      periodStart,
      ...values,
      cumulativeOutputChars,
      cumulativeEstimatedOutputTokens: cumulativeInvestmentTokens,
      cumulativeEstimatedSavings: cumulativeSavings,
    };
  });
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), projectRoot, window,
    dataQuality: { journalVerified, journalRead, journalBytes, journalStorage: storage, admission, eventTypes, semanticEventRatio: metric(scoped.length ? semanticEvents / scoped.length : null, 'derived', 'ratio', 'semantic lifecycle events / window events; not a correctness score'), journalEventCount: events.length, windowEventCount: scoped.length, usageEventCount: usageEvents.length, firstUsageAt: usageEvents[0]?.event.occurredAt ?? null, lastUsageAt: usageEvents.at(-1)?.event.occurredAt ?? null, measuredMetricCount: usageEvents.length * 7, estimatedMetricCount: usageEvents.length * 2 + (ctxTokens > 0 ? 1 : 0), unavailableMetricCount: 1 },
    assets: {
      knowledge: { total: knowledge.length, candidate: knowledge.filter((item) => item.status === 'candidate').length, verified: knowledge.filter((item) => item.status === 'verified').length, retired: knowledge.filter((item) => ['deprecated', 'rejected'].includes(item.status)).length, created: lifecycle('knowledge.proposed'), verifiedInWindow: lifecycle('knowledge.verified') },
      deadends: { total: deadends.length, candidate: deadends.filter((item) => item.status === 'candidate').length, verified: deadends.filter((item) => item.status === 'verified').length, retired: deadends.filter((item) => ['obsolete', 'rejected'].includes(item.status)).length, created: lifecycle('deadend.proposed'), verifiedInWindow: lifecycle('deadend.verified') },
      notes: { total: notes.length, createdInWindow: lifecycle('note.recorded') }, contexts: { total: contextData.items.length, active: contextData.items.filter((item) => ['active', 'stable'].includes(item.status)).length, snapshots: contextData.snapshots }, rawVerifiedAssetCount: rawAssets, effectiveAssetPoints: metric(rawAssets + usedCount * 0.25, 'derived', 'asset-points'), assumptions: { reuseBonusPerUse: 0.25, maxBonusUses: 3 },
    },
    reuse: { recordUsedInWindow: recordUsed, recordUsedTotal: events.filter((event) => event.type === 'record.used').length, usedVerifiedAssetCount: usedVerified, verifiedAssetReuseRate: metric(rawAssets === 0 ? null : usedVerified / rawAssets, 'derived', 'ratio', 'explicit record.used events only; retrieval and injection do not imply use') },
    investment: { contextOutputTokens: investment, contextInputTokens: metric(inputTokens, 'estimated', 'tokens', 'chars-div-four'), totalContextTokens: metric(totalTokens, 'estimated', 'tokens', 'chars-div-four'), providerTokens: metric(null, 'unavailable', 'tokens') },
    payback: {
      baselineTokens: baseline,
      baselineSource: options.baselineSource ?? null,
      estimatedSavings: savings === null ? metric(null, 'unavailable', 'tokens') : metric(savings, 'estimated', 'tokens'),
      estimatedROI: savings === null || totalTokens === 0 ? null : savings / totalTokens,
      status: baseline === null ? 'no_baseline' : 'unpaired_baseline',
      paybackAt: null,
      paybackPeriodDays: null,
    },
    operations: { available: usageEvents.length > 0, ...operationStats(scoped), reason: usageEvents.length > 0 ? null : 'operation output telemetry is not yet recorded' },
    delivery: deliveryStats(scoped, events),
    trends,
    warnings: [...(journalRead.mode === 'indexed' ? ['Indexed read reuses previously verified sealed segments; run ctx journal verify for current full-chain verification'] : !journalVerified ? ['v2 journal unavailable; lifecycle metrics may be incomplete'] : []), 'Provider token usage is unavailable', 'chars-div-four is a rough estimate, especially for CJK; context compression is not proven task savings', ...(baseline !== null ? ['Window baseline is unpaired; no causal savings or payback date can be established'] : []), ...(usageEvents.length === 0 ? ['Token investment is unavailable until operation output telemetry is recorded'] : [])],
  };
}

export function formatUsageReport(report: Record<string, any>): string {
  const assets = report.assets; const payback = report.payback;
  const lines = ['fluffy-context usage report', `Window: ${String(report.window.from).slice(0, 10)} to ${String(report.window.to).slice(0, 10)}`, '', 'ASSET VALUE', `  Verified knowledge       ${assets.knowledge.verified}`, `  Verified deadends        ${assets.deadends.verified}`, `  Used verified assets     ${report.reuse.usedVerifiedAssetCount}`, `  Asset points             ${assets.effectiveAssetPoints.value.toFixed(2)}  derived`, '', 'TOKEN INVESTMENT', `  Estimated tokens         ${report.investment.totalContextTokens.value}  estimated (input + output)`, '  Provider tokens          n/a  unavailable', '', 'RETURN', `  Baseline tokens          ${payback.baselineTokens ?? 'n/a'}`, `  Estimated savings        ${payback.estimatedSavings.value ?? 'n/a'}`, `  ROI                      ${payback.estimatedROI ?? 'n/a'}`, `  Payback                  ${payback.status}`, '', 'COMMAND OUTPUT TREND', `  Usage events             ${report.dataQuality.usageEventCount}`, '', 'DATA QUALITY', `  Journal verified         ${report.dataQuality.journalVerified ? 'yes' : 'no'}`, `  Window events            ${report.dataQuality.windowEventCount}`, `  Warnings                 ${report.warnings.length}`];
  lines.push(`  Journal bytes            ${report.dataQuality.journalBytes}`, `  Semantic event ratio     ${report.dataQuality.semanticEventRatio.value ?? 'n/a'}  derived`, '', 'EVENT TYPES');
  lines.push(`  Archives                 ${report.dataQuality.journalStorage.archives}`, `  Expanded journal bytes   ${report.dataQuality.journalStorage.expandedBytes ?? 'n/a (indexed read)'}`);
  for (const [type, count] of Object.entries(report.dataQuality.eventTypes)) lines.push(`  ${type}: ${count}`);
  lines.push(`  Budget-rejected observations ${Object.values(report.dataQuality.admission.dropped).reduce((sum, count) => Number(sum) + Number(count), 0)}`);
  lines.push('', 'HOST DELIVERY', `  Trigger observations      ${report.delivery.observationCount}`, `  Unsupported trigger pairs ${report.delivery.unknownTriggerCount}`, `  Unobserved supported      ${report.delivery.unobservedSupported.length}`);
  for (const pair of report.delivery.unknownTriggerPairs) lines.push(`    ${pair}`);
  for (const [mode, count] of Object.entries(report.delivery.byMode)) lines.push(`  ${mode}: ${count}`);
  lines.push('', ...report.warnings.map((warning: string) => `  ${warning}`));
  return `${lines.join('\n')}\n`;
}
