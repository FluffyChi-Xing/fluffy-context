import { compileContext } from './compile.js';
import { withUsageTelemetry } from '../cognition/usage.js';
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

export interface InjectionOptions extends ContextCompileOptions, SessionOptions { explain?: boolean; }

export async function injectContext(startPath: string | undefined, options: InjectionOptions = {}, interfaceName: 'cli' | 'hook' | 'agent' | 'mcp' = 'agent') {
  validateSessionOptions(options);
  return withUsageTelemetry(startPath, 'compile', interfaceName === 'hook' ? 'claude-hook' : interfaceName, options, async () => {
    const scenario = options.scenario ?? inferScenario(options.query ?? '');
    const manifest = await compileContext(startPath, { ...options, scenario, maxChars: options.maxChars ?? 2400, activityLimit: options.activityLimit ?? 0 });
    const { selected, delivery } = await selectSessionDelivery(manifest, options, `${interfaceName}:${options.adapter ?? interfaceName}`);
    const text = selected.map((item) => item.text).join('\n');
    return { status: manifest.status, scenario, text, delivery,
      budget: { maxChars: manifest.budget.requested.total, usedChars: text.length, compiledChars: manifest.budget.usedChars },
      manifestHash: manifest.identity.manifestHash,
      sourceCount: selected.length,
      ...(options.explain ? {
        sources: selected.map((item) => ({ candidateId: item.candidateId, itemHash: item.itemHash, section: item.section, provenance: item.source.provenance })),
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
      next: manifest.truncation.truncated ? 'Use ctx compile / ctx expand for selected evidence.' : null };
  }, interfaceName);
}
