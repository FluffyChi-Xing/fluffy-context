import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { filterPaths } from '../capture/context-filter.js';
import { learnKnowledge, listKnowledge } from '../runtime/knowledge.js';
import { loadManifest } from '../runtime/init.js';
import { withLock } from '../storage/lock.js';
import { locksDirectory } from '../storage/layout.js';
import { memoryBlocks, type MemoryBlock } from './memory-blocks.js';
import { readMemoryReceipts, writeMemoryReceipts, type MemorySourceReceipt } from './memory-receipts.js';

const sources = ['memory', '.memory', '.claude', '.zcode', '.cursor', '.curcor', '.codex', 'AGENTS.md', 'agents.md', 'CLAUDE.md', 'MEMORY.md', '.cursorrules'];
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const isWorktreeStorage = (relative: string) => /^\.claude\/worktrees(?:\/|$)/i.test(relative.replaceAll('\\', '/'));
async function hasGitBoundary(directory: string): Promise<boolean> {
  try { await lstat(path.join(directory, '.git')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function importMemory(startPath?: string, apply = false) {
  const root = await resolveProjectRoot(startPath);
  await loadManifest(root);
  await readMemoryReceipts(root);
  const candidates: Array<MemoryBlock & { source: string; sourceHash: string; fingerprint: string }> = [];
  const scanned = new Map<string, { sourceHash: string; complete: boolean }>();
  const skipped: Array<{ source: string; reason: string }> = [];
  const visited = new Set<string>();
  let bytes = 0;
  let entries = 0;
  const canonicalRoot = await realpath(root);
  async function scan(relative: string, depth = 0): Promise<void> {
    if (isWorktreeStorage(relative)) { skipped.push({ source: relative, reason: 'worktree-storage' }); return; }
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
      if (await hasGitBoundary(absolute)) { skipped.push({ source: relative, reason: 'nested-repository' }); return; }
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
    const source = relative.replaceAll('\\', '/');
    const sourceHash = hash(text);
    const parsed = memoryBlocks(text);
    skipped.push(...parsed.skipped.map((item) => ({ source: `${source}:${item.line}`, reason: item.reason })));
    const available = 500 - candidates.length;
    const complete = parsed.blocks.length <= available && parsed.skipped.length === 0;
    if (parsed.blocks.length > available) skipped.push({ source, reason: 'candidate-budget' });
    scanned.set(source, { sourceHash, complete });
    for (const block of parsed.blocks.slice(0, available)) candidates.push({ ...block, source, sourceHash,
      fingerprint: hash(block.statement.replace(/\s+/g, ' ').toLowerCase()) });
  }
  const run = async () => {
    const receipts = await readMemoryReceipts(root);
    for (const source of sources) await scan(source);
    const knowledge = await listKnowledge(root, true);
    const byId = new Map(knowledge.map((item) => [item.knowledgeId, item]));
    const known = new Map<string, string | null>(knowledge.map((item) => [hash(item.statement.replace(/\s+/g, ' ').toLowerCase()), item.knowledgeId]));
    const results = [];
    for (const candidate of candidates) {
      const duplicate = known.has(candidate.fingerprint);
      const record = apply && !duplicate ? await learnKnowledge(root, candidate.statement, {
        kind: 'imported-memory', evidence: [`${candidate.source}:${candidate.line}`, `lines:${candidate.line}-${candidate.endLine}`, `sha256:${candidate.fingerprint}`, `source-sha256:${candidate.sourceHash}`],
      }) : null;
      const knowledgeId = record?.knowledgeId ?? known.get(candidate.fingerprint) ?? null;
      known.set(candidate.fingerprint, knowledgeId);
      if (record) byId.set(record.knowledgeId, record);
      results.push({ ...candidate, status: duplicate ? 'duplicate' : apply ? 'candidate' : 'preview', knowledgeId,
        knowledgeStatus: knowledgeId ? byId.get(knowledgeId)?.status ?? null : null });
    }
    const previous = new Map(receipts.sources.map((item) => [item.source, item]));
    const updates = new Map(previous);
    const changes: Array<{ source: string; status: string; previousHash: string | null; currentHash: string | null; reviewKnowledgeIds: string[] }> = [];
    for (const source of new Set([...previous.keys(), ...scanned.keys()])) {
      const before = previous.get(source);
      const current = scanned.get(source);
      let missing = false;
      if (!current && before) {
        // Only an absent source under an allowed, non-symlinked path is a deletion.
        // Budget exclusions, ignore rules and symlinks leave the baseline intact.
        for (const part of !isWorktreeStorage(source) && (await filterPaths(root, [source])).length ? source.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')) : []) {
          try {
            const location = path.join(root, part);
            const info = await lstat(location);
            if (info.isSymbolicLink() || info.isDirectory() && await hasGitBoundary(location)) break;
          }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true; else throw error; break; }
        }
      }
      const status = current ? !current.complete ? 'partial' : !before ? 'new' : before.sourceHash === current.sourceHash ? 'unchanged' : 'modified'
        : missing ? before?.sourceHash === null ? 'unchanged' : 'removed' : 'unavailable';
      const blocks = results.filter((item) => item.source === source).flatMap((item) => item.knowledgeId ? [{ fingerprint: item.fingerprint, knowledgeId: item.knowledgeId }] : []);
      const currentFingerprints = new Set(results.filter((item) => item.source === source).map((item) => item.fingerprint));
      const canCompare = Boolean(current?.complete || missing);
      const reviewKnowledgeIds = [...new Set([...(before?.reviewKnowledgeIds ?? []), ...(canCompare ? before?.blocks.filter((item) => !currentFingerprints.has(item.fingerprint)).map((item) => item.knowledgeId) ?? [] : [])])]
        .filter((id) => ['candidate', 'verified'].includes(byId.get(id)?.status ?? '') && !blocks.some((block) => block.knowledgeId === id));
      // Keep acknowledged IDs in the baseline so a later source edit reopens review.
      const unresolved = reviewKnowledgeIds.filter((id) => !canCompare || !byId.get(id)?.memoryReview?.sources.some((review) => review.source === source && review.sourceHash === (current?.sourceHash ?? null)));
      changes.push({ source, status, previousHash: before?.sourceHash ?? null, currentHash: current?.sourceHash ?? null, reviewKnowledgeIds: unresolved });
      if (canCompare) updates.set(source, { source, sourceHash: current?.sourceHash ?? null, blocks, reviewKnowledgeIds } satisfies MemorySourceReceipt);
    }
    if (apply) await writeMemoryReceipts(root, { schemaVersion: 1, sources: [...updates.values()] });
    return { projectRoot: root, applied: apply, scannedBytes: bytes, results, skipped,
      changes, reviewRequired: [...new Set(changes.flatMap((item) => item.reviewKnowledgeIds))],
      reviewPolicy: 'Source changes never alter knowledge status. Inspect affected IDs and explicitly deprecate/reject outdated records. Partial or unavailable scans do not replace the source baseline.',
      trust: 'Imported text is unverified evidence; inspect and verify against the project before injection.' };
  };
  return apply ? withLock(path.join(locksDirectory(root), 'memory-import.lock'), run) : run();
}
