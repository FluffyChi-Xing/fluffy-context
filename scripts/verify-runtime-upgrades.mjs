import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [candidateArg, ...baselineArgs] = process.argv.slice(2);
const npmCli = process.env.npm_execpath;
if (!npmCli || !candidateArg || baselineArgs.length === 0) {
  throw new Error('Usage: npm run verify:runtime-upgrades -- <candidate.tgz> <baseline.tgz> [...]');
}
const candidate = path.resolve(candidateArg);
const baselines = baselineArgs.map((file) => path.resolve(file));
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const results = [];
const receipt = path.resolve('.context', 'builds', `runtime-upgrades-${Date.now()}.json`);
function saveReceipt() {
  mkdirSync(path.dirname(receipt), { recursive: true });
  writeFileSync(receipt, JSON.stringify({ checkedAt: new Date().toISOString(), environment: { platform: process.platform, node: process.version },
    evidenceKind: 'synthetic isolated projects; not production-host acceptance', results }, null, 2) + '\n');
}
for (const baseline of baselines) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ctx-upgrade-'));
  const consumer = path.join(fixture, 'consumer');
  const project = path.join(fixture, 'project with spaces 中文');
  mkdirSync(consumer);
  mkdirSync(project);
  const entry = path.join(consumer, 'node_modules/fluffy-context/dist/src/cli/main.js');
  const invoke = (args) => JSON.parse(execFileSync(process.execPath, [entry, ...args, '--path', project], {
    cwd: project, windowsHide: true, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const version = () => JSON.parse(execFileSync(process.execPath, [entry, '--version'], { windowsHide: true, encoding: 'utf8' }));
  const install = (artifact) => execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', artifact], {
    cwd: consumer, windowsHide: true, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const journal = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    'const { readJournal } = await import(process.argv[1]); console.log(JSON.stringify(await readJournal(process.argv[2])));',
    pathToFileURL(path.join(consumer, 'node_modules/fluffy-context/dist/src/cognition/journal.js')).href, project],
  { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }));
  let result;
  try {
    install(baseline);
    const from = version();
    invoke(['init', '--no-start', '--no-integrations']);
    invoke(['checkpoint', '--title', 'Upgrade fixture', '--progress', 'Preserve this checkpoint across package upgrades']);
    assert.equal(invoke(['runtime', 'start']).running, true);
    assert.equal(invoke(['runtime', 'stop']).lease, null);
    const before = journal();
    install(candidate);
    const to = version();
    // Match the reported sequence first: old stop -> package replacement -> start.
    const first = invoke(['runtime', 'start']);
    assert.equal(first.running, true);
    assert.equal(first.diagnostics.state, 'ready');
    assert.equal(invoke(['runtime', 'stop']).lease, null);
    const upgrade = invoke(['upgrade', '--no-progress']);
    const cycles = [];
    for (let i = 0; i < 2; i++) {
      const started = invoke(['runtime', 'start']);
      assert.equal(started.running, true);
      assert.equal(invoke(['runtime', 'status']).lease.instanceId, started.lease.instanceId);
      assert.equal(invoke(['runtime', 'stop']).lease, null);
      cycles.push(started.lease.instanceId);
    }
    const after = journal();
    assert.deepEqual(after.slice(0, before.length), before, 'upgrade must preserve all historical events');
    let active = null;
    for (const event of after.filter((event) => ['runtime.started', 'runtime.stopped'].includes(event.type))) {
      if (event.type === 'runtime.started') { assert.equal(active, null); active = event.source.instanceId; }
      else { assert.equal(event.source.instanceId, active); active = null; }
    }
    assert.equal(active, null);
    const verification = invoke(['journal', 'verify']);
    const resumed = invoke(['resume']);
    assert.equal(resumed.context.title, 'Upgrade fixture');
    const continuity = invoke(['checkpoint', '--context', resumed.context.id, '--objective', 'Preserve upgraded task continuity',
      '--constraints', 'Keep all historical events', '--validation-refs', 'synthetic upgrade matrix; not production acceptance', '--open-questions', 'Company trial pending']);
    assert.equal(continuity.status, 'saved');
    const packet = invoke(['inject', '--scenario', 'handoff', '--context', resumed.context.id]);
    assert.equal(packet.handoff.snapshotId, continuity.snapshot.snapshotId);
    assert.match(packet.text, /Preserve upgraded task continuity/);
    assert.ok(packet.expandRefs.length > 0);
    const expanded = invoke(['expand', '--ref', JSON.stringify(packet.expandRefs[0])]);
    assert.equal(expanded.candidateId, packet.expandRefs[0].candidateId);
    const finalJournal = journal();
    assert.deepEqual(finalJournal.slice(0, before.length), before);
    const finalVerification = invoke(['journal', 'verify']);
    assert.equal(finalVerification.verified, true);
    result = { from, to, baseline, baselineSha256: digest(baseline), candidateSha256: digest(candidate), fixture,
      preservedEvents: before.length, finalEventsBeforeContinuity: after.length, cycles, verification,
      handoffSnapshotId: packet.handoff.snapshotId, expandedCandidateId: expanded.candidateId,
      finalEvents: finalJournal.length, finalVerification,
      upgradeStatus: upgrade.status ?? 'completed', passed: true };
  } catch (error) {
    let status = null;
    try { status = invoke(['runtime', 'status']); } catch { /* Keep the original failure. */ }
    results.push({ baseline, candidate, fixture, passed: false, error: error.message, status });
    saveReceipt();
    console.error(receipt);
    throw error;
  } finally {
    try { invoke(['runtime', 'stop']); } catch { /* Preserve fixture and original failure for investigation. */ }
  }
  results.push(result);
  saveReceipt();
  console.log(JSON.stringify({ from: result.from, to: result.to, passed: true, preservedEvents: result.preservedEvents }));
}
console.log(receipt);
