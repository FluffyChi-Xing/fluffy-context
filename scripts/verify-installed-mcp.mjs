import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { VERSION } from '../dist/src/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run with npm run verify:installed-mcp');
const globalRoot = execFileSync(process.execPath, [npmCli, 'root', '--global'], { encoding: 'utf8', windowsHide: true }).trim();
const entry = path.join(globalRoot, 'fluffy-context', 'dist', 'src', 'cli', 'main.js');
const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'agent', 'serve'], cwd: root, stderr: 'pipe' });
const client = new Client({ name: 'fluffy-context-installed-acceptance', version: '1.0.0' });
let stderr = '';
transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  if (!tools.includes('context_host_capabilities') || !tools.includes('context_inject') || !tools.includes('context_usage_report')) throw new Error('installed MCP tool list is incomplete');
  const capabilities = await client.callTool({ name: 'context_host_capabilities', arguments: { path: root } });
  if (capabilities.isError || capabilities.structuredContent?.schemaVersion !== 1) throw new Error('installed MCP capability tool failed');
  const sessionId = `installed-mcp-${Date.now()}`;
  const injection = await client.callTool({ name: 'context_inject', arguments: { path: root, query: `${VERSION} installed MCP acceptance`, scenario: 'handoff', sessionId, taskId: `${VERSION}-host-acceptance`, maxChars: 1200 } });
  if (injection.isError || injection.structuredContent?.delivery?.mode !== 'full') throw new Error('installed MCP injection failed');
  const reference = injection.structuredContent?.expandRefs?.[0];
  if (!reference || !injection.structuredContent?.handoff?.snapshotId) throw new Error('installed MCP handoff/reference contract missing');
  const expanded = await client.callTool({ name: 'context_expand', arguments: reference });
  if (expanded.isError || expanded.structuredContent?.candidateId !== reference.candidateId) throw new Error('installed MCP reference expansion failed');
  const report = await client.callTool({ name: 'context_host_capabilities', arguments: { path: root } });
  if (report.isError || !(report.structuredContent?.observations?.byInterface?.mcp >= 1)) throw new Error('MCP trigger receipt was not observed');
  if (stderr.trim()) throw new Error(`MCP server wrote stderr: ${stderr.trim()}`);
  const receipt = { checkedAt: new Date().toISOString(), clientKind: 'standalone-mcp-stdio', hostReconnect: 'not-measured', entry, toolCount: tools.length, capabilitySchema: capabilities.structuredContent.schemaVersion,
    deliveryMode: injection.structuredContent.delivery.mode, handoffSnapshotId: injection.structuredContent.handoff.snapshotId,
    expandedCandidateId: expanded.structuredContent.candidateId, expansionStatus: expanded.structuredContent.status,
    mcpObservations: report.structuredContent.observations.byInterface.mcp,
    modelAdoption: 'not-measured' };
  const destination = path.join(root, '.context', 'builds');
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, `installed-mcp-${Date.now()}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await client.close();
}
