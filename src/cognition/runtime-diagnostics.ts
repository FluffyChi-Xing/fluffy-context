import path from 'node:path';
import { atomicWriteJson } from '../storage/atomic-write.js';
import { readJson } from '../storage/json-store.js';
import { cognitionRuntimeDirectory } from '../storage/layout.js';
import { VERSION } from '../version.js';

export type StartupPhase = 'spawn' | 'bootstrap' | 'publish-lease' | 'journal' | 'observation' | 'ready';

export interface RuntimeStartupDiagnostic {
  attemptId: string;
  pid: number | null;
  phase: StartupPhase;
  outcome: 'starting' | 'ready' | 'failed';
  updatedAt: string;
  nodeVersion: string;
  version: string;
  failure?: { code: string; exitCode?: number | null; signal?: string | null };
}

export function runtimeDiagnosticPath(root: string): string {
  return path.join(cognitionRuntimeDirectory(root), 'last-startup.json');
}

export async function readRuntimeDiagnostic(root: string): Promise<RuntimeStartupDiagnostic | null> {
  return readJson<RuntimeStartupDiagnostic>(runtimeDiagnosticPath(root)).catch(() => null);
}

export async function writeRuntimeDiagnostic(root: string, diagnostic: Pick<RuntimeStartupDiagnostic, 'attemptId' | 'pid' | 'phase' | 'outcome' | 'failure'>): Promise<void> {
  await atomicWriteJson(runtimeDiagnosticPath(root), {
    ...diagnostic, updatedAt: new Date().toISOString(), nodeVersion: process.version, version: VERSION,
  } satisfies RuntimeStartupDiagnostic);
}

// Diagnostics must not copy arbitrary exception messages (which may contain
// project data or credentials) into status responses. Keep bounded error codes.
export function runtimeFailureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  if (error instanceof Error && error.message === 'context is busy; try again later') return 'LOCK_BUSY';
  if (error instanceof Error && error.message === 'runtime startup was cancelled') return 'STARTUP_CANCELLED';
  return 'STARTUP_ERROR';
}

export function runtimeProcessAlive(pid: number | null | undefined): boolean | null {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
}
