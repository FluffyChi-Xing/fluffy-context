import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { contextExpand, contextOrient } from '../agent/api.js';
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

const expandInput = z.object({
  path: z.string().optional(),
  manifestHash: z.string(),
  candidateId: z.string().optional(),
  itemHash: z.string().optional(),
  level: z.enum(['structured', 'evidence']),
  maxChars: z.int().nonnegative().optional(),
  compile: z.object({
    contextId: z.string().optional(),
    query: z.string().optional(),
    scenario: z.enum(['resume', 'implementation', 'debugging', 'verification', 'handoff', 'exploration', 'unknown']).optional(),
    scope: z.string().optional(),
    paths: z.array(z.string()).optional(),
    maxChars: z.int().nonnegative().optional(),
    knowledgeLimit: z.int().nonnegative().optional(),
    deadendLimit: z.int().nonnegative().optional(),
    noteLimit: z.int().nonnegative().optional(),
    activityLimit: z.int().nonnegative().optional(),
    trigger: z.enum(['session-start', 'prompt', 'manual', 'tool-call']).optional(),
    adapter: z.string().optional(),
    sessionId: z.string().optional(),
    eventId: z.string().optional(),
  }),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      const result = await contextOrient(path, options);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `context_orient failed: ${errorMessage(error)}` }],
      };
    }
  });
  server.registerTool('context_expand', {
    title: 'Expand context candidate',
    description: 'Read a selected compiler candidate at structured or evidence level without writing project state or reading file contents.',
    inputSchema: expandInput,
  }, async ({ path, ...input }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      const result = await contextExpand(path, input);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `context_expand failed: ${errorMessage(error)}` }],
      };
    }
  });
  return server;
}
