import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setupProject } from '../src/runtime/setup.js';
import { initProject } from '../src/runtime/init.js';
import { checkpoint, resume } from '../src/runtime/runtime.js';
import { importV1, reconcileV1State } from '../src/cognition/migration-v1.js';
import { readJournal } from '../src/cognition/journal.js';
import { importMemory } from '../src/cognition/import-memory.js';
import { discoverKnowledge, listKnowledge, learnKnowledge, verifyKnowledge } from '../src/runtime/knowledge.js';
import { injectContext } from '../src/compiler/inject.js';
import { buildUsageReport } from '../src/cognition/usage-report.js';
import { disableRuntime } from '../src/cognition/runtime.js';
import { installClaudeIntegration } from '../src/integrations/claude-code.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ctx-next-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('setup migrates once, preserves instructions and disabled policy after later checkpoints', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'AGENTS.md'), '# Existing instructions\n');
  const first = await setupProject(root, { start: false });
  assert.equal(first.journal.verified, true);
  assert.equal(first.migrated, true);
  await checkpoint(root, { progressSummary: 'Implement semantic admission' });
  await disableRuntime(root);
  const second = await setupProject(root, { start: false });
  assert.equal(second.runtime.enabled, false);
  assert.equal(second.migrated, false);
  const text = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith('# Existing instructions'));
  assert.equal(text.split('<!-- fluffy-context:start -->').length, 2);
});

test('memory preview is read-only; apply deduplicates, retains provenance and excludes secrets', async (t) => {
  const root = await fixture(t);
  await initProject(root);
  await mkdir(path.join(root, 'memory'));
  const statement = 'Use a transaction when updating inventory and reservation records.';
  await writeFile(path.join(root, 'memory', 'facts.md'), `# Memory\n- ${statement}\n- password=extremely-private-value-do-not-import\n`);
  await writeFile(path.join(root, 'AGENTS.md'), statement);
  await writeFile(path.join(root, '.contextignored'), 'memory/ignored.md\n');
  await writeFile(path.join(root, 'memory', 'ignored.md'), 'This ignored finding must never enter the knowledge store.');
  await writeFile(path.join(root, 'memory', 'oversized.md'), 'x'.repeat(65537));
  const preview = await importMemory(root);
  assert.equal((await listKnowledge(root, true)).length, 0);
  assert.ok(preview.skipped.some((item) => item.reason === 'potential-secret'));
  assert.ok(preview.skipped.some((item) => item.reason === 'ignored'));
  assert.ok(preview.skipped.some((item) => item.reason === 'byte-budget'));
  assert.equal(preview.results.filter((item) => item.status === 'preview').length, 1);
  await importMemory(root, true);
  await importMemory(root, true);
  const records = await listKnowledge(root, true);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'candidate');
  assert.ok(records[0].supportingEvidence.some((value) => value === 'memory/facts.md:2'));
  assert.equal((await listKnowledge(root)).length, 0);
});

test('reconciliation ignores read counters and appends only changed entities', async (t) => {
  const root = await fixture(t);
  await initProject(root);
  await checkpoint(root, { progressSummary: 'Original task' });
  await learnKnowledge(root, 'A durable fact that remains unchanged.');
  await importV1(root);
  const before = (await readJournal(root)).length;
  await resume(root);
  await reconcileV1State(root);
  assert.equal((await readJournal(root)).length, before);
  // Simulate an older client updating the authoritative file without mirroring.
  const file = path.join(root, '.context', 'knowledge.json');
  const knowledge = JSON.parse(await readFile(file, 'utf8'));
  knowledge.items[0].statement = 'An updated fact from an older client.';
  await writeFile(file, JSON.stringify(knowledge));
  await reconcileV1State(root);
  assert.equal((await readJournal(root)).length, before + 1);
  await reconcileV1State(root);
  assert.equal((await readJournal(root)).length, before + 1);
});

test('injection obeys text budget and candidate trust, report does not invent payback', async (t) => {
  const root = await fixture(t);
  await setupProject(root, { start: false, integrations: false });
  await checkpoint(root, { progressSummary: 'Investigating inventory failures', pendingTasks: ['Run reservation tests'] });
  await learnKnowledge(root, 'Unverified inventory claims must never be injected.');
  const result = await injectContext(root, { query: 'inventory error', maxChars: 160 });
  assert.equal(result.scenario, 'debugging');
  assert.ok(result.text.length <= 160);
  assert.ok(!result.text.includes('Unverified inventory claims'));
  assert.equal(result.sources, undefined);
  // beta.12 budgets actionable references separately from the evidence text.
  const referenceChars = result.expandRefs.reduce((sum, ref) => sum + JSON.stringify(ref).length, 0);
  assert.equal(result.referenceBudget.usedChars, referenceChars);
  assert.ok(referenceChars <= result.referenceBudget.maxChars);
  assert.ok(result.sourceReview.budget.usedChars <= result.sourceReview.budget.maxChars);
  const { text, expandRefs, sourceReview, ...envelope } = result;
  assert.ok(JSON.stringify(envelope).length < 1400);
  const withoutReferences = await injectContext(root, { query: 'inventory error', maxChars: 160, maxReferenceChars: 0 });
  assert.deepEqual(withoutReferences.expandRefs, []);
  assert.equal(withoutReferences.referenceBudget.usedChars, 0);
  const explained = await injectContext(root, { query: 'inventory error', maxChars: 160, explain: true });
  assert.ok(Array.isArray(explained.sources));
  const report = await buildUsageReport(root, { baselineTokens: 1000 });
  assert.equal(report.payback.status, 'unpaired_baseline');
  assert.equal(report.payback.paybackAt, null);
  assert.ok(Number(report.dataQuality.journalBytes) > 0);
  assert.ok((report.investment.totalContextTokens as { value: number }).value > 0);
  assert.ok(report.trends.every((trend) => trend.cumulativeEstimatedSavings === null));
});

test('integration relocates a verified prior installation without replacing unrelated settings', async (t) => {
  const root = await fixture(t);
  await initProject(root);
  const oldPackage = path.join(root, 'old-install');
  const oldEntry = path.join(oldPackage, 'dist', 'src', 'cli', 'main.js');
  await mkdir(path.dirname(oldEntry), { recursive: true });
  await writeFile(oldEntry, '// previous package entry');
  await writeFile(path.join(oldPackage, 'package.json'), JSON.stringify({ name: 'fluffy-context', bin: { ctx: 'dist/src/cli/main.js' } }));
  await mkdir(path.join(root, '.claude'));
  const oldCommand = `"${process.execPath}" "${oldEntry}"`;
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] }, hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `${oldCommand} hook claude-code session-start` }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${oldCommand} hook claude-code user-prompt` }] }],
  } }));
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'fluffy-context': { command: process.execPath, args: [oldEntry, 'agent', 'serve'], env: { CUSTOM: 'retained' } } } }));
  assert.equal((await installClaudeIntegration(root, true)).installationNeeded, false);
  const settings = JSON.parse(await readFile(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.ok(!settings.hooks.SessionStart[0].hooks[0].command.includes(oldEntry));
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  const mcp = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['fluffy-context'].env.CUSTOM, 'retained');
  assert.equal((await installClaudeIntegration(root, true)).applied, false);
});

test('runtime exits promptly when shutdown drains pending filesystem activity', async (t) => {
  const root = await fixture(t);
  await setupProject(root, { start: false, integrations: false });
  const runtimeUrl = new URL('../src/cognition/runtime.js', import.meta.url).href;
  const script = `
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const { serveRuntime, setFilesystemEvents } = await import(${JSON.stringify(runtimeUrl)});
    const root = process.argv[1];
    await setFilesystemEvents(root, true);
    const runtime = await serveRuntime(root, { inactivityTimeoutMs: 60000, pollIntervalMs: 60000 });
    await writeFile(path.join(root, 'pending.txt'), 'pending observation');
    await new Promise(resolve => setTimeout(resolve, 80));
    await runtime.close('test-pending-flush');
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root], { timeout: 12000, windowsHide: true });
});

test('knowledge diagnostics respect query, status and scope, not mere topic overlap', async (t) => {
  const root = await fixture(t);
  await initProject(root);
  for (const statement of ['Journal compression preserves event identity', 'Journal readers verify hash chains']) {
    const item = await learnKnowledge(root, statement);
    await verifyKnowledge(root, item.knowledgeId);
  }
  const candidate = await learnKnowledge(root, 'Journal readers must not verify hash chains');
  const unrelated = await learnKnowledge(root, 'Unrelated secrets must never appear in diagnostics');
  await verifyKnowledge(root, unrelated.knowledgeId);
  const result = await discoverKnowledge(root, 'Journal', { limit: 1, maxChars: 40 });
  assert.deepEqual(result.possibleConflicts, []);
  assert.ok(!JSON.stringify(result).includes(candidate.knowledgeId));
  assert.ok(!JSON.stringify(result).includes(unrelated.knowledgeId));
});

test('knowledge text and diagnostic budgets bound evidence and contradictory pairs', async (t) => {
  const root = await fixture(t);
  await initProject(root);
  for (const statement of ['Journal must cache results', 'Journal must not cache results']) {
    const item = await learnKnowledge(root, statement, { evidence: ['x'.repeat(1000), 'y'.repeat(1000)] });
    await verifyKnowledge(root, item.knowledgeId);
  }
  const result = await discoverKnowledge(root, 'Journal', { limit: 1, maxChars: 12 });
  assert.equal(result.possibleConflicts.length, 1);
  assert.ok(result.possibleConflicts.flatMap((item) => item.statements).join('').length <= 12);
  assert.ok(result.hits.every((item) => item.knowledge.statement.length + item.knowledge.supportingEvidence.join('').length <= 12));
  assert.equal(result.truncated, true);
  const zero = await discoverKnowledge(root, 'Journal', { maxChars: 0 });
  assert.ok(zero.hits.every((item) => item.knowledge.statement === '' && item.knowledge.supportingEvidence.length === 0));
  await assert.rejects(() => discoverKnowledge(root, 'Journal', { maxChars: -1 }), /non-negative/);
});
