import { readRuntimeDiagnostic, runtimeFailureCode, writeRuntimeDiagnostic, type StartupPhase } from './runtime-diagnostics.js';

// A small dedicated entry records bootstrap failures too, without importing the
// entire CLI/MCP command graph before the runtime can report its progress.
const [root, attemptId] = process.argv.slice(2);
let phase: StartupPhase = 'bootstrap';
async function progress(next: StartupPhase): Promise<void> {
  phase = next;
  if ((await readRuntimeDiagnostic(root))?.attemptId !== attemptId) throw new Error('runtime startup was cancelled');
  await writeRuntimeDiagnostic(root, { attemptId, pid: process.pid, phase, outcome: phase === 'ready' ? 'ready' : 'starting' });
}

try {
  if (!root || !attemptId) throw new Error('runtime startup was cancelled');
  await progress('bootstrap');
  const { serveRuntime } = await import('./runtime.js');
  const runtime = await serveRuntime(root, { onStartupPhase: progress });
  process.once('SIGINT', () => { void runtime.close('signal').catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void runtime.close('signal').catch(() => { process.exitCode = 1; }); });
} catch (error) {
  if (root && attemptId && (await readRuntimeDiagnostic(root))?.attemptId === attemptId) {
    await writeRuntimeDiagnostic(root, { attemptId, pid: process.pid, phase, outcome: 'failed', failure: { code: runtimeFailureCode(error) } }).catch(() => undefined);
    // serveRuntime has drained/closed its resources before rejecting. Clear only
    // this attempt's marker so a corrected configuration can be retried at once.
    await import('./runtime.js').then(({ clearRuntimeStartup }) => clearRuntimeStartup(root, attemptId)).catch(() => undefined);
  }
  process.exitCode = 1;
}
