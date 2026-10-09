// Run through npm so npm_execpath identifies the same npm installation as the caller.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('Run this script with npm run install:local');
const npm = (args, capture = false) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd: root, windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
});
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const globalRoot = npm(['root', '--global'], true).trim();
const installed = path.join(globalRoot, 'fluffy-context');
const entry = path.join(installed, 'dist', 'src', 'cli', 'main.js');
const ctx = (args) => execFileSync(process.execPath, [entry, ...args], { cwd: root, windowsHide: true, encoding: 'utf8' });

npm(['run', 'build']);
const destination = path.join(root, '.context', 'builds');
mkdirSync(destination, { recursive: true });
const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', destination], true));
const original = path.join(destination, packed.filename);
const sha256 = digest(original);
const artifact = path.join(destination, `${packed.name}-${packed.version}-${sha256.slice(0, 12)}.tgz`);
if (original !== artifact) renameSync(original, artifact);
if (existsSync(entry)) ctx(['runtime', 'stop', '--path', root]);
npm(['install', '--global', artifact, '--ignore-scripts']);
if (lstatSync(installed).isSymbolicLink()) throw new Error('Expected an unpacked global installation, not a source link');
const mismatches = [];
for (const file of packed.files) {
  const relative = file.path;
  if (digest(path.join(root, relative)) !== digest(path.join(installed, relative))) mismatches.push(relative);
}
if (mismatches.length) throw new Error(`Global package content mismatch: ${mismatches.join(', ')}`);
const initialization = JSON.parse(ctx(['init', '--path', root]));
const version = JSON.parse(ctx(['--version']));
const receipt = {
  installedAt: new Date().toISOString(), version, artifact, sha256, installed,
  verifiedFiles: packed.files.length, runtime: initialization.runtime, storage: initialization.storage,
};
writeFileSync(path.join(destination, `install-${sha256.slice(0, 12)}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
