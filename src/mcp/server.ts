import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { addNote, listNotes } from '../runtime/notes.js';
import { contextCompile, contextExpand, contextOrient, contextUsageReport, loadContext, saveContext } from '../agent/api.js';
import { ensureRuntimeForSession } from '../cognition/runtime.js';
import { VERSION } from '../version.js';

const orientInput = z.object({
  path: z.string().optional(),
  contextId: z.string().optional(),
  query: z.string().optional(),
  scope: z.string().optional(),
  maxChars: z.int().nonnegative().optional(),
  knowledgeLimit: z.int().nonnegative().optional(),
  deadendLimit: z.int().nonnegative().optional(),
  noteLimit: z.int().nonnegative().optional(),
});

const scenario = z.enum(['resume', 'implementation', 'debugging', 'verification', 'handoff', 'exploration', 'unknown']);
const trigger = z.enum(['session-start', 'prompt', 'manual', 'tool-call']);
const noteKind = z.enum(['problem', 'action', 'observation', 'decision']);
const noteActor = z.enum(['agent', 'human']);
const noteStatus = z.enum(['open', 'resolved']);

const compileOptions = z.object({
  contextId: z.string().optional(),
  query: z.string().optional(),
  scenario: scenario.optional(),
  scope: z.string().optional(),
  paths: z.array(z.string()).optional(),
  maxChars: z.int().nonnegative().optional(),
  knowledgeLimit: z.int().nonnegative().optional(),
  deadendLimit: z.int().nonnegative().optional(),
  noteLimit: z.int().nonnegative().optional(),
  activityLimit: z.int().nonnegative().optional(),
  trigger: trigger.optional(),
  adapter: z.string().optional(),
  sessionId: z.string().optional(),
  eventId: z.string().optional(),
});

const expandInput = z.object({
  path: z.string().optional(),
  manifestHash: z.string(),
  candidateId: z.string().optional(),
  itemHash: z.string().optional(),
  level: z.enum(['structured', 'evidence']),
  maxChars: z.int().nonnegative().optional(),
  compile: compileOptions,
});

const compileInput = z.object({ path: z.string().optional(), ...compileOptions.shape });

const resumeInput = z.object({
  path: z.string().optional(),
  contextId: z.string().optional(),
  maxChars: z.int().nonnegative().optional(),
  includeDetails: z.boolean().optional(),
  query: z.string().optional(),
  scope: z.string().optional(),
});

const noteListInput = z.object({
  path: z.string().optional(),
  contextId: z.string().optional(),
  openOnly: z.boolean().optional(),
  limit: z.int().nonnegative().optional(),
  maxChars: z.int().nonnegative().optional(),
});

const noteAddInput = z.object({
  path: z.string().optional(),
  message: z.string(),
  kind: noteKind.optional(),
  actor: noteActor.optional(),
  contextId: z.string().optional(),
  snapshotId: z.string().optional(),
  relatedFiles: z.array(z.string()).optional(),
  status: noteStatus.optional(),
});

const checkpointInput = z.object({
  path: z.string().optional(),
  contextId: z.string().optional(),
  absorbNotes: z.boolean().optional(),
  title: z.string().optional(),
  progressSummary: z.string().optional(),
  lastError: z.string().nullable().optional(),
  completed: z.array(z.string()).optional(),
  pendingTasks: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  relatedFiles: z.array(z.string()).optional(),
});

const usageReportInput = z.object({
  path: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  days: z.int().nonnegative().optional(),
  month: z.string().optional(),
  granularity: z.enum(['day', 'week', 'month']).optional(),
  baselineTokens: z.number().nonnegative().optional(),
  baselineSource: z.enum(['manual', 'recorded-control']).optional(),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function successResponse<T>(result: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function failureResponse(tool: string, error: unknown) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `${tool} failed: ${errorMessage(error)}` }],
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'fluffy-context', version: VERSION });
  server.registerTool('context_orient', {
    title: 'Orient context',
    description: 'Load bounded, read-only task context with verified consensus and open notes. Compiler manifests expose deterministic levels, hashes, and estimated tokens through the Agent API and CLI.',
    inputSchema: orientInput,
  }, async ({ path, ...options }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await contextOrient(path, options, 'mcp'));
    } catch (error) {
      return failureResponse('context_orient', error);
    }
  });
  server.registerTool('context_expand', {
    title: 'Expand context candidate',
    description: 'Read a selected compiler candidate at structured or evidence level without writing project state or reading file contents.',
    inputSchema: expandInput,
  }, async ({ path, ...input }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await contextExpand(path, input, 'mcp'));
    } catch (error) {
      return failureResponse('context_expand', error);
    }
  });
  server.registerTool('context_compile', {
    title: 'Compile context manifest',
    description: 'Compile a bounded, deterministic, read-only context manifest without writing project state or reading file contents.',
    inputSchema: compileInput,
  }, async ({ path, ...options }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await contextCompile(path, options, 'mcp'));
    } catch (error) {
      return failureResponse('context_compile', error);
    }
  });
  server.registerTool('context_resume', {
    title: 'Resume context',
    description: 'Resume the selected active context with a bounded summary and optional details. This may update the existing lastUsedAt field.',
    inputSchema: resumeInput,
  }, async ({ path, ...options }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await loadContext(path, options, 'mcp'));
    } catch (error) {
      return failureResponse('context_resume', error);
    }
  });
  server.registerTool('context_note_list', {
    title: 'List context notes',
    description: 'List bounded notes without modifying project state or absorbing or resolving notes.',
    inputSchema: noteListInput,
  }, async ({ path, ...query }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse({ notes: await listNotes(path, query) });
    } catch (error) {
      return failureResponse('context_note_list', error);
    }
  });
  server.registerTool('context_note_add', {
    title: 'Add context note',
    description: 'Append one explicit note to project state. This writes the local context store but does not create a Snapshot.',
    inputSchema: noteAddInput,
  }, async ({ path, message, ...input }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await addNote(path, message, input));
    } catch (error) {
      return failureResponse('context_note_add', error);
    }
  });
  server.registerTool('context_usage_report', {
    title: 'Context usage report',
    description: 'Build a read-only report of context assets, explicit reuse, estimated token investment, and operation metrics.',
    inputSchema: usageReportInput,
  }, async ({ path, ...options }) => {
    try {
      return successResponse(await contextUsageReport(path, options));
    } catch (error) {
      return failureResponse('context_usage_report', error);
    }
  });
  server.registerTool('context_checkpoint', {
    title: 'Checkpoint context',
    description: 'Explicitly save context progress and create a Snapshot when changes are present; runtime rate limits remain enforced.',
    inputSchema: checkpointInput,
  }, async ({ path, ...input }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await saveContext(path, input));
    } catch (error) {
      return failureResponse('context_checkpoint', error);
    }
  });
  return server;
}
