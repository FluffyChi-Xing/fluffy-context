import { boundedItems, expansionReferences, handoffDescriptor } from './delivery.js';
import { compileContext } from './compile.js';
import { withUsageTelemetry } from '../cognition/usage.js';
import { recordHostCapability, recordHostTrigger } from '../cognition/host-capabilities.js';
import type { ContextCompileOptions, ContextScenario } from './types.js';
import { selectSessionDelivery, validateSessionOptions, type SessionOptions } from './session.js';

export function inferScenario(query: string): ContextScenario {
  if (!query.trim()) return 'resume';
  if (/error|fail|bug|异常|报错|失败|修复/i.test(query)) return 'debugging';
  if (/test|verify|验证|测试/i.test(query)) return 'verification';
  if (/resume|恢复|继续/i.test(query)) return 'resume';
  if (/handoff|交接|总结/i.test(query)) return 'handoff';
  if (/implement|add|build|实现|新增|开发/i.test(query)) return 'implementation';
  return 'exploration';
}

export interface InjectionOptions extends ContextCompileOptions, SessionOptions { explain?: boolean; maxReferenceChars?: number; }

export async function injectContext(startPath: string | undefined, options: InjectionOptions = {}, interfaceName: 'cli' | 'hook' | 'agent' | 'mcp' = 'agent') {
  validateSessionOptions(options);
  const maxReferenceChars = options.maxReferenceChars ?? 4096;
  if (!Number.isSafeInteger(maxReferenceChars) || maxReferenceChars < 0 || maxReferenceChars > 16000) throw new Error('maxReferenceChars must be an integer from 0 to 16000');
  const adapter = interfaceName === 'agent' ? 'agent-api' : interfaceName;
  if (interfaceName !== 'hook') await recordHostCapability(startPath, interfaceName, adapter);
  try {
    const result = await withUsageTelemetry(startPath, 'compile', interfaceName === 'hook' ? 'claude-hook' : interfaceName, options, async () => {
    const scenario = options.scenario ?? inferScenario(options.query ?? '');
    const compileOptions = { ...options, scenario, maxChars: options.maxChars ?? 2400, activityLimit: options.activityLimit ?? 0 };
    const manifest = await compileContext(startPath, compileOptions);
    const { selected, delivery } = await selectSessionDelivery(manifest, options, `${interfaceName}:${options.adapter ?? interfaceName}`, maxReferenceChars);
    const text = selected.map((item) => item.text).join('\n');
    const references = expansionReferences(manifest, selected, compileOptions, maxReferenceChars);
    const reviews = manifest.excluded.filter((item) => item.reason === 'source_review_required');
    const diagnostics = boundedItems(reviews.map((item) => ({ knowledgeId: item.source!.entityId, ...item.source!.sourceState })), 2048);
    const explained = boundedItems(selected.map((item) => ({ candidateId: item.candidateId, itemHash: item.itemHash, section: item.section, provenance: item.source.provenance, sourceState: item.source.sourceState })), 4096);
    const handoff = handoffDescriptor(manifest, selected);
    return { status: manifest.status, scenario, text, delivery,
      budget: { maxChars: manifest.budget.requested.total, usedChars: text.length, compiledChars: manifest.budget.usedChars, taskChars: selected.filter((item) => !['knowledge', 'deadend'].includes(item.section)).reduce((sum, item) => sum + item.text.length, 0) },
      manifestHash: manifest.identity.manifestHash,
      handoff,
      expandRefs: references.items,
      referenceBudget: { maxChars: maxReferenceChars, usedChars: references.usedChars, omitted: references.omitted, includes: 'serialized reference objects; envelope excluded' },
      sourceReview: { states: Object.fromEntries(['unchanged', 'changed', 'missing', 'unknown'].map((state) => [state, manifest.selected.filter((item) => item.source.sourceState?.state === state).length])), required: reviews.length, items: diagnostics.items, omitted: diagnostics.omitted, budget: { maxChars: 2048, usedChars: diagnostics.usedChars }, next: reviews.length ? 'ctx knowledge review --review-required' : null },
      sourceCount: selected.length,
      ...(options.explain ? {
        sources: explained.items,
        diagnosticBudget: { maxChars: 4096, usedChars: explained.usedChars, omitted: explained.omitted, includes: 'serialized source objects; fixed selection summary excluded' },
        selection: {
          groups: manifest.budget.groups ?? null,
          sections: manifest.budget.sections,
          excludedCounts: manifest.excluded.reduce<Record<string, number>>((counts, item) => {
            counts[item.reason] = (counts[item.reason] ?? 0) + 1;
            return counts;
          }, {}),
          omittedByBudget: manifest.truncation.candidatesOmittedByBudget,
          partiallyTruncated: manifest.truncation.candidatesPartiallyTruncated,
        },
      } : {}),
      next: manifest.truncation.truncated || references.omitted ? 'Pass an expandRefs object to context_expand (CLI: ctx expand --ref <json>). For omitted evidence, run ctx compile with the same query and a larger --max-chars budget.' : null };
    }, interfaceName);
    if (interfaceName !== 'hook') await recordHostTrigger(startPath, { interface: interfaceName, adapter, trigger: options.resetSession ? 'context-reset' : options.trigger ?? (interfaceName === 'mcp' ? 'tool-call' : 'manual'), status: 'observed', deliveryMode: result.delivery.replacePrevious ? 'replacement' : result.delivery.mode, sessionId: options.sessionId, taskId: options.taskId });
    return result;
  } catch (error) {
    if (interfaceName !== 'hook') await recordHostTrigger(startPath, { interface: interfaceName, adapter, trigger: options.resetSession ? 'context-reset' : options.trigger ?? (interfaceName === 'mcp' ? 'tool-call' : 'manual'), status: 'failed', sessionId: options.sessionId, taskId: options.taskId });
    throw error;
  }
}
