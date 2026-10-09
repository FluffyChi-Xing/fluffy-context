import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { filterPaths } from '../capture/context-filter.js';
import { learnKnowledge, listKnowledge } from '../runtime/knowledge.js';
import { loadManifest } from '../runtime/init.js';
import { withLock } from '../storage/lock.js';
import { locksDirectory } from '../storage/layout.js';

const sources = ['memory', '.memory', '.claude', '.zcode', '.cursor', '.curcor', '.codex', 'AGENTS.md', 'agents.md', 'CLAUDE.md', 'MEMORY.md', '.cursorrules'];
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const sensitive = /(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|\b(?:sk-|sk_|ghp_|github_pat_)[A-Za-z0-9_-]+|-----BEGIN .*PRIVATE KEY-----/i;

export async function importMemory(startPath?: string, apply = false) {
  const root = await resolveProjectRoot(startPath);
  await loadManifest(root);
  const candidates: Array<{ source: string; line: number; statement: string; fingerprint: string }> = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  const visited = new Set<string>();
  let bytes = 0;
  let entries = 0;
  const canonicalRoot = await realpath(root);
  async function scan(relative: string, depth = 0): Promise<void> {
    if (++entries > 2000 || candidates.length >= 500 || depth > 8) { skipped.push({ source: relative, reason: 'scan-budget' }); return; }
    const absolute = path.join(root, relative);
    let info;
    try { info = await lstat(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) { skipped.push({ source: relative, reason: 'symlink' }); return; }
    const resolved = await realpath(absolute);
    const within = path.relative(canonicalRoot, resolved);
    if (within.startsWith('..') || path.isAbsolute(within)) { skipped.push({ source: relative, reason: 'outside-project' }); return; }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (visited.has(key)) return;
    visited.add(key);
    if ((await filterPaths(root, [relative])).length === 0) { skipped.push({ source: relative, reason: 'ignored' }); return; }
    if (info.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) {
        if (entries >= 2000 || candidates.length >= 500) { skipped.push({ source: relative, reason: 'scan-budget' }); break; }
        await scan(path.join(relative, entry), depth + 1);
      }
      return;
    }
    if (!info.isFile() || !/\.(?:md|mdc|txt)$/i.test(relative) && path.basename(relative) !== '.cursorrules') return;
    if (info.size > 64 * 1024 || bytes + info.size > 2 * 1024 * 1024) { skipped.push({ source: relative, reason: 'byte-budget' }); return; }
    bytes += info.size;
    const text = await readFile(absolute, 'utf8');
    let managed = false;
    let code = false;
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      if (raw.includes('<!-- fluffy-context:start -->')) { managed = true; continue; }
      if (raw.includes('<!-- fluffy-context:end -->')) { managed = false; continue; }
      if (managed) continue;
      if (/^\s*```/.test(raw)) { code = !code; continue; }
      if (code || /^\s*#/.test(raw)) continue;
      const statement = raw.replace(/^\s*(?:[-*+] |\d+\. )/, '').trim();
      if (statement.length < 20 || statement.length > 1500) continue;
      if (sensitive.test(statement)) { skipped.push({ source: `${relative}:${index + 1}`, reason: 'potential-secret' }); continue; }
      if (candidates.length >= 500) { skipped.push({ source: relative, reason: 'candidate-budget' }); break; }
      candidates.push({ source: relative.replaceAll('\\', '/'), line: index + 1, statement,
        fingerprint: hash(statement.replace(/\s+/g, ' ').toLowerCase()) });
    }
  }
  for (const source of sources) await scan(source);
  const run = async () => {
    const known = new Set((await listKnowledge(root, true)).map((item) => hash(item.statement.replace(/\s+/g, ' ').toLowerCase())));
    const results = [];
    for (const candidate of candidates) {
      const duplicate = known.has(candidate.fingerprint);
      known.add(candidate.fingerprint);
      const record = apply && !duplicate ? await learnKnowledge(root, candidate.statement, {
        kind: 'imported-memory', evidence: [`${candidate.source}:${candidate.line}`, `sha256:${candidate.fingerprint}`],
      }) : null;
      results.push({ ...candidate, status: duplicate ? 'duplicate' : apply ? 'candidate' : 'preview', knowledgeId: record?.knowledgeId ?? null });
    }
    return { projectRoot: root, applied: apply, scannedBytes: bytes, results, skipped,
      trust: 'Imported text is unverified evidence; inspect and verify against the project before injection.' };
  };
  return apply ? withLock(path.join(locksDirectory(root), 'memory-import.lock'), run) : run();
}
