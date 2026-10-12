import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../dist/src/runtime/init.js';
import { importV1 } from '../dist/src/cognition/migration-v1.js';
import { enableRuntime } from '../dist/src/cognition/runtime.js';
import { importMemory } from '../dist/src/cognition/import-memory.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-import-benchmark-'));
const timings = {};
async function measure(name, operation) {
  const start = performance.now();
  const result = await operation();
  timings[name] = Math.round(performance.now() - start);
  return result;
}
try {
  execFileSync('git', ['init', root], { windowsHide: true });
  await initProject(root);
  await importV1(root);
  await enableRuntime(root);
  await mkdir(path.join(root, '.zcode'));
  await writeFile(path.join(root, '.zcode', 'MEMORY.md'), Array.from({ length: 40 }, (_, i) =>
    `- Production rule ${i}: callbacks must preserve the original request identifier.`).join('\n'));
  const result = await measure('import40Ms', () => importMemory(root, true));
  await measure('repeatImportMs', () => importMemory(root, true));
  for (const args of [['knowledge', 'discover', 'callbacks'], ['learn', 'Callbacks retain their source evidence.'], ['inject', 'callbacks']]) {
    await measure(`${args[0]}CliMs`, () => execFileSync(process.execPath,
      ['dist/src/cli/main.js', ...args, '--path', root], { windowsHide: true, stdio: 'pipe' }));
  }
  console.log(JSON.stringify({ candidates: result.results.length, timings }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
