export interface MemoryBlock { line: number; endLine: number; headings: string[]; statement: string; }

const sensitive = /(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|\b(?:sk-|sk_|ghp_|github_pat_)[A-Za-z0-9_-]+|-----BEGIN .*PRIVATE KEY-----/i;

/** Conservative Markdown extraction: metadata and fenced examples are not facts. */
export function memoryBlocks(text: string) {
  const blocks: MemoryBlock[] = [];
  const skipped: Array<{ line: number; reason: string }> = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headings: string[] = [];
  let frontMatter = lines[0]?.trim() === '---';
  let managed = false;
  let comment = false;
  let fence: { marker: string; length: number } | undefined;
  let pending: string[] = [];
  let line = 0;
  let endLine = 0;
  let kind: 'paragraph' | 'list' | 'table' = 'paragraph';
  const flush = () => {
    const statement = pending.join(kind === 'table' ? '\n' : ' ').trim();
    if (statement.length >= 20) {
      if (statement.length > 1500) skipped.push({ line, reason: 'block-too-long' });
      else if (sensitive.test(statement)) skipped.push({ line, reason: 'potential-secret' });
      else blocks.push({ line, endLine, headings: headings.filter(Boolean), statement });
    }
    pending = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (frontMatter) {
      if (index > 0 && /^(---|\.\.\.)$/.test(trimmed)) frontMatter = false;
      continue;
    }
    if (raw.includes('<!-- fluffy-context:start -->')) { flush(); managed = true; continue; }
    if (raw.includes('<!-- fluffy-context:end -->')) { managed = false; continue; }
    if (managed) continue;
    if (comment || trimmed.startsWith('<!--')) { flush(); comment = !raw.includes('-->'); continue; }
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (marker?.[0] === fence.marker && marker.length >= fence.length && trimmed === marker) fence = undefined;
      continue;
    }
    if (marker) { flush(); fence = { marker: marker[0], length: marker.length }; continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      flush(); headings.length = heading[1].length;
      // Metadata must not leak secrets skipped from candidate statements.
      headings[heading[1].length - 1] = sensitive.test(heading[2]) ? '[redacted heading]' : heading[2].slice(0, 120);
      continue;
    }
    if (!trimmed || /^\s*(?:[-*_]\s*){3,}$/.test(raw)) { flush(); continue; }
    const list = /^\s*(?:[-*+] |\d+[.)] )(.*)$/.exec(raw);
    const nextKind = /^\s*\|.*\|\s*$/.test(raw) ? 'table' : list ? 'list' : 'paragraph';
    if (list || (pending.length && nextKind !== kind && !(kind === 'list' && /^\s+\S/.test(raw)))) flush();
    if (!pending.length) { line = index + 1; kind = nextKind; }
    pending.push(list ? list[1].trim() : trimmed);
    endLine = index + 1;
  }
  flush();
  if (frontMatter) skipped.push({ line: 1, reason: 'unclosed-front-matter' });
  return { blocks, skipped };
}
