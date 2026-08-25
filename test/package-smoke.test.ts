import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
    assert.equal(JSON.parse(version.stdout), '0.4.0');

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
      ['--input-type=module', '-e', "import { contextOrient } from 'fluffy-context'; import { contextOrient as agentOrient } from 'fluffy-context/agent'; if (typeof contextOrient !== 'function' || contextOrient !== agentOrient) process.exit(1);"],
      consumer,
    );
    assert.equal(imports.code, 0, imports.stderr);

    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.version, '0.4.0');
    assert.equal(await readdir(path.join(packageRoot, 'skills', 'fluffy-context')).then((files) => files.includes('SKILL.md')), true);
  } finally {
    await rm(consumer, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (tarball) await rm(tarball, { force: true });
  }
});
