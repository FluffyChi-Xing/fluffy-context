import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from './server.js';

serveStdio(createMcpServer, {
  onerror: (error) => process.stderr.write(`MCP server error: ${error.message}\n`),
});
