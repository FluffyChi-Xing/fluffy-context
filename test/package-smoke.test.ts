import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const npmCli = process.env.npm_execpath;

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test('packed package exposes the CLI, Agent API, declarations, and shipped skill', async () => {
  const consumer = await mkdtemp(path.join(os.tmpdir(), 'fluffy-context-consumer-'));
  let tarball: string | undefined;
  try {
    assert.ok(npmCli, 'npm_execpath must identify the npm CLI');
    const packed = await run(process.execPath, [npmCli, 'pack', '--json'], root);
    assert.equal(packed.code, 0, packed.stderr);
    const [{ filename, files: packedFiles }] = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    tarball = path.join(root, filename);
    const files = new Set(packedFiles.map((file) => file.path));
    for (const file of [
      'README.md',
      'CHANGELOG.md',
      'ROADMAP-1.0.md',
      'HOST-ACCEPTANCE.md',
      'LICENSE',
      'skills/fluffy-context/SKILL.md',
      'dist/src/cli/main.js',
      'dist/src/agent/index.js',
      'dist/src/agent/index.d.ts',
      'dist/src/mcp/main.js',
      'dist/src/hooks/claude-code.js',
      'dist/src/integrations/claude-code.js',
    ]) {
      assert.equal(files.has(file), true, file);
    }
    assert.equal([...files].some((file) => file.startsWith('dist/test/')), false);
    assert.equal([...files].some((file) => file.startsWith('src/')), false);

    const installed = await run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer);
    assert.equal(installed.code, 0, installed.stderr);

    const packageRoot = path.join(consumer, 'node_modules', 'fluffy-context');
    const cli = path.join(packageRoot, 'dist', 'src', 'cli', 'main.js');
    const version = await run(process.execPath, [cli, '--version'], consumer);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(JSON.parse(version.stdout), '1.0.0-beta.7');

    for (const args of [
      [cli, 'orient', '--help'],
      [cli, 'agent', 'serve', '--help'],
      [cli, 'hook', 'claude-code', '--help'],
      [cli, 'integrate', 'claude', 'install', '--help'],
    ]) {
      const help = await run(process.execPath, args, consumer);
      assert.equal(help.code, 0, help.stderr);
    }

    const imports = await run(
      process.execPath,
      ['--input-type=module', '-e', "import { VERSION } from 'fluffy-context/version'; import { compileContext, contextExpand, contextOrient, proposeContextEvolution, listContextEvolutionProposals, inspectContextEvolutionProposal, acceptContextEvolutionCandidate, transitionContextEvolutionProposal, recordContextUse } from 'fluffy-context'; import { compileContext as agentCompile, contextExpand as agentExpand, contextOrient as agentOrient, proposeContextEvolution as agentPropose, listContextEvolutionProposals as agentList, inspectContextEvolutionProposal as agentInspect, acceptContextEvolutionCandidate as agentAccept, transitionContextEvolutionProposal as agentTransition } from 'fluffy-context/agent'; if (VERSION !== '1.0.0-beta.7' || typeof compileContext !== 'function' || typeof agentCompile !== 'function' || typeof contextExpand !== 'function' || typeof agentExpand !== 'function' || typeof contextOrient !== 'function' || typeof recordContextUse !== 'function' || [proposeContextEvolution, listContextEvolutionProposals, inspectContextEvolutionProposal, acceptContextEvolutionCandidate, transitionContextEvolutionProposal].some((value) => typeof value !== 'function') || contextOrient !== agentOrient || compileContext !== agentCompile || contextExpand !== agentExpand || proposeContextEvolution !== agentPropose || listContextEvolutionProposals !== agentList || inspectContextEvolutionProposal !== agentInspect || acceptContextEvolutionCandidate !== agentAccept || transitionContextEvolutionProposal !== agentTransition) process.exit(1);"],
      consumer,
    );
    assert.equal(imports.code, 0, imports.stderr);
    const governanceImports = await run(process.execPath, ['--input-type=module', '-e',
      "import { reviewKnowledge, batchKnowledge } from 'fluffy-context'; import { reviewKnowledge as review, batchKnowledge as batch } from 'fluffy-context/agent'; if (typeof review !== 'function' || typeof batch !== 'function' || review !== reviewKnowledge || batch !== batchKnowledge) process.exit(1);"], consumer);
    assert.equal(governanceImports.code, 0, governanceImports.stderr);

    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.version, '1.0.0-beta.7');
    assert.equal(await readdir(path.join(packageRoot, 'skills', 'fluffy-context')).then((files) => files.includes('SKILL.md')), true);

    // Exercise the shipped package's cognition loop, not source imports.
    const command = async (...args: string[]) => {
      const result = await run(process.execPath, [cli, ...args], consumer);
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const initialized = await command('init', '--no-start', '--no-integrations');
    assert.equal(initialized.journal.verified, true);
    assert.equal((await command('init', '--no-start', '--no-integrations')).migrated, false);
    const statement = 'Reservation changes require the inventory transaction boundary.';
    await writeFile(path.join(consumer, 'MEMORY.md'), statement);
    const preview = await command('import');
    assert.equal(preview.applied, false);
    assert.equal(preview.results[0].status, 'preview');
    const imported = await command('import', '--apply');
    const id = imported.results[0].knowledgeId;
    assert.ok(id);
    assert.equal((await command('import', '--apply')).results[0].status, 'duplicate');
    const unverified = await command('inject', 'inventory transaction', '--max-chars', '800');
    assert.equal(unverified.text.includes(statement), false);
    assert.equal((await command('knowledge', 'review', '--source', 'MEMORY.md')).items[0].knowledgeId, id);
    const batchArgs = ['knowledge', 'batch', 'verify', '--ids', id, '--reason', 'Verified package fixture', '--evidence', 'test/package-smoke.test.ts'];
    const batchPreview = await command(...batchArgs);
    assert.equal(batchPreview.applied, false);
    assert.equal((await command(...batchArgs, '--apply', '--expected-token', batchPreview.token)).applied, true);
    const verified = await command('inject', 'inventory transaction', '--max-chars', '800');
    assert.equal(verified.status, 'ready');
    assert.ok(verified.text.includes(statement));
    assert.ok(verified.budget.usedChars <= 800);
    assert.equal((await command('knowledge', 'list'))[0].knowledgeId, id);
    const candidate = await command('knowledge', 'add', 'A newly reviewed package finding remains a candidate.');
    assert.equal(candidate.status, 'candidate');
    const help = await run(process.execPath, [cli, '--help'], consumer);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Daily workflow:/);
    assert.doesNotMatch(help.stdout, /evolution|filesystem/);
    await command('report');
    await command('journal', 'verify');
  } finally {
    await rm(consumer, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (tarball) await rm(tarball, { force: true });
  }
});
