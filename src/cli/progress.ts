import type { ProgressReporter } from '../cognition/progress.js';

export function consoleProgress(stream: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> = process.stderr): ProgressReporter {
  let lastPhase = '';
  let lastBucket = -1;
  let lastWrite = 0;
  return ({ phase, completed, total, unit = '' }) => {
    const ratio = total === null ? null : total === 0 ? 1 : Math.min(1, completed / total);
    const bucket = ratio === null ? -1 : Math.floor(ratio * 10);
    const changed = phase !== lastPhase;
    if (!changed && bucket === lastBucket && (ratio !== 1 || lastBucket === 10)) return;
    if (!changed && ratio !== 1 && Date.now() - lastWrite < 100) return;
    const filled = ratio === null ? 0 : Math.floor(ratio * 20);
    const bar = ratio === null ? '····················' : '#'.repeat(filled) + '-'.repeat(20 - filled);
    const value = ratio === null ? 'working' : `${Math.floor(ratio * 100)}% ${completed}/${total} ${unit}`;
    stream.write(`${stream.isTTY ? '\r\x1b[2K' : ''}[${bar}] ${phase} ${value}${stream.isTTY && phase !== 'complete' && phase !== 'preview-complete' ? '' : '\n'}`);
    lastPhase = phase; lastBucket = bucket; lastWrite = Date.now();
  };
}
