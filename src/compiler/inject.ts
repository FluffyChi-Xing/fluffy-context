import { compileContext } from './compile.js';
import { withUsageTelemetry } from '../cognition/usage.js';
import type { ContextCompileOptions, ContextScenario } from './types.js';

export function inferScenario(query: string): ContextScenario {
  if (/error|fail|bug|异常|报错|失败|修复/i.test(query)) return 'debugging';
  if (/test|verify|验证|测试/i.test(query)) return 'verification';
  if (/resume|恢复|继续/i.test(query)) return 'resume';
  if (/handoff|交接|总结/i.test(query)) return 'handoff';
  if (/implement|add|build|实现|新增|开发/i.test(query)) return 'implementation';
  return 'exploration';
}

export interface InjectionOptions extends ContextCompileOptions { explain?: boolean; }

export async function injectContext(startPath: string | undefined, options: InjectionOptions = {}, interfaceName: 'cli' | 'hook' | 'agent' | 'mcp' = 'agent') {
  return withUsageTelemetry(startPath, 'compile', interfaceName === 'hook' ? 'claude-hook' : interfaceName, options, async () => {
    const scenario = options.scenario ?? inferScenario(options.query ?? '');
    const manifest = await compileContext(startPath, { ...options, scenario, maxChars: options.maxChars ?? 2400, activityLimit: options.activityLimit ?? 0 });
    return { status: manifest.status, scenario, text: manifest.text,
      budget: { maxChars: manifest.budget.requested.total, usedChars: manifest.budget.usedChars },
      manifestHash: manifest.identity.manifestHash,
      sourceCount: manifest.selected.length,
      ...(options.explain ? { sources: manifest.selected.map((item) => ({ candidateId: item.candidateId, itemHash: item.itemHash, section: item.section, provenance: item.source.provenance })) } : {}),
      next: manifest.truncation.truncated ? 'Use ctx compile / ctx expand for selected evidence.' : null };
  }, interfaceName);
}
