import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ensureRuntimeForSession } from '../cognition/runtime.js';
import { createMcpServer } from './server.js';

await ensureRuntimeForSession(process.cwd(), { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
serveStdio(createMcpServer, {
  onerror: (error) => process.stderr.write(`MCP server error: ${error.message}\n`),
});
