import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ignoredPath } from '../storage/layout.js';

const builtinPatterns = [
  '.context/**',
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'coverage/**',
  'tmp/**',
  '.cache/**',
  '*.log',
  '*.tgz',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'credentials*',
  '*credential*',
  'secret*',
  '*token*',
];
const builtinDirectories = new Set(['.context', '.git', 'node_modules', 'dist', 'build', 'coverage', 'tmp', '.cache', '.next']);

interface Rule {
  pattern: string;
  negated: boolean;
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`^${source}$`);
}

function matches(pattern: string, relativePath: string): boolean {
  const directoryPattern = pattern.endsWith('/');
  const normalized = pattern.replace(/^\//, '').replace(/\/$/, '');
  const expression = globToRegExp(directoryPattern ? `${normalized}/**` : normalized);
  return expression.test(relativePath) || (!pattern.startsWith('/') && expression.test(relativePath.split('/').slice(-1)[0]));
}

export async function readProjectRules(projectRoot: string): Promise<Rule[]> {
  try {
    const content = await readFile(ignoredPath(projectRoot), 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => ({ negated: line.startsWith('!'), pattern: line.replace(/^!/, '') }));
  } catch {
    return [];
  }
}

export async function filterPaths(projectRoot: string, paths: string[]): Promise<string[]> {
  const projectRules = await readProjectRules(projectRoot);
  return paths
    .map((filePath) => filePath.replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter((relativePath) => {
      if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return false;
      const normalized = path.posix.normalize(relativePath);
      if (normalized === '..' || normalized.startsWith('../')) return false;
      if (normalized.split('/').some((part) => builtinDirectories.has(part))) return false;
      if (builtinPatterns.some((pattern) => matches(pattern, normalized))) return false;

      let included = true;
      for (const rule of projectRules) {
        if (matches(rule.pattern, normalized)) {
          included = rule.negated;
        }
      }
      return included;
    })
    .map((filePath) => path.posix.normalize(filePath));
}
