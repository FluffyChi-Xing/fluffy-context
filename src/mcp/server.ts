import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { contextOrient } from '../agent/api.js';
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
  return server;
}
