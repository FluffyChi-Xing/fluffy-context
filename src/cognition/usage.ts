import { appendEvent } from './journal.js';
import type { CognitionEventSource, UsageOperationCompletedPayload } from './types.js';

export type UsageOperation = UsageOperationCompletedPayload['operation'];
export type UsageInterface = UsageOperationCompletedPayload['interface'];

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

function interfaceFor(source: CognitionEventSource): UsageInterface {
  return source === 'mcp' ? 'mcp' : source === 'claude-hook' ? 'hook' : source === 'agent' ? 'agent' : 'cli';
}

export async function recordUsageOperation(
  startPath: string | undefined,
  operation: UsageOperation,
  source: CognitionEventSource,
  input: unknown,
  output: unknown,
  startedAt: number,
  success: boolean,
  error?: unknown,
  interfaceName: UsageInterface = interfaceFor(source),
): Promise<void> {
  const inputText = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  const outputText = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  const payload: UsageOperationCompletedPayload = {
    operation,
    interface: interfaceName,
    success,
    durationMs: Math.max(0, Date.now() - startedAt),
    inputChars: inputText.length,
    outputChars: outputText.length,
    inputBytes: Buffer.byteLength(inputText),
    outputBytes: Buffer.byteLength(outputText),
    estimatedInputTokens: Math.ceil(inputText.length / 4),
    estimatedOutputTokens: Math.ceil(outputText.length / 4),
    estimatedMethod: 'chars-div-four',
    ...(success ? {} : { errorClass: errorClass(error) }),
  };
  if (success && output && typeof output === 'object' && 'expandRefs' in output) {
    const result = output as { budget: { taskChars: number }; text: string; handoff: unknown; expandRefs: unknown[]; referenceBudget: { usedChars: number }; sourceReview: { required: number }; delivery: { replacePrevious: boolean } };
    payload.contextDelivery = { taskChars: result.budget.taskChars, referenceChars: result.referenceBudget.usedChars,
      references: result.expandRefs.length, sourceReviews: result.sourceReview.required,
      replacements: Number(result.delivery.replacePrevious), handoffs: Number(Boolean(result.handoff)) };
  }
  try {
    await appendEvent(startPath, {
      type: 'usage.operation.completed',
      source: { kind: source },
      idempotencyKey: `usage:${operation}:${source}:${startedAt}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      payload,
    });
  } catch {
    // Observability must not affect the operation being observed.
  }
}

export async function withUsageTelemetry<T>(
  startPath: string | undefined,
  operation: UsageOperation,
  source: CognitionEventSource,
  input: unknown,
  action: () => Promise<T>,
  interfaceName: UsageInterface = interfaceFor(source),
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await action();
    await recordUsageOperation(startPath, operation, source, input, result, startedAt, true, undefined, interfaceName);
    return result;
  } catch (error) {
    await recordUsageOperation(startPath, operation, source, input, { error: errorClass(error) }, startedAt, false, error, interfaceName);
    throw error;
  }
}
