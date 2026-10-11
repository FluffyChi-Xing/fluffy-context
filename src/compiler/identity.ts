import crypto from 'node:crypto';
import type { ContextManifest } from './types.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function contentHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function estimateTokens(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(value.length / 4);
}

export function rebuildManifestHash(manifest: Pick<ContextManifest, 'status' | 'projectRoot' | 'mode' | 'anchor' | 'intent' | 'selected' | 'budget' | 'truncation' | 'recipe' | 'graph'>): string {
  return contentHash({
    schemaVersion: 1,
    compilerVersion: '0.7.7',
    rankingVersion: 'compiler-ranking-v3',
    status: manifest.status,
    projectRoot: manifest.projectRoot,
    mode: manifest.mode,
    anchor: manifest.anchor,
    intent: manifest.intent,
    selectedItemHashes: manifest.selected.map((item) => item.itemHash),
    budget: { usedChars: manifest.budget.usedChars, maxChars: manifest.budget.requested.total },
    truncation: manifest.truncation,
    ...(manifest.recipe ? { recipe: { recipeId: manifest.recipe.recipeId, contentHash: manifest.recipe.contentHash, interpreterVersion: manifest.recipe.interpreterVersion } } : {}),
    ...(manifest.graph ? { graph: manifest.graph } : {}),
  });
}

export function validateManifestIdentity(manifest: ContextManifest): boolean {
  return manifest.identity.manifestHash === rebuildManifestHash(manifest)
    && JSON.stringify(manifest.identity.selectedItemHashes) === JSON.stringify(manifest.selected.map((item) => item.itemHash))
    && manifest.identity.tokenEstimate.input === estimateTokens(manifest.text)
    && manifest.identity.tokenEstimate.output === estimateTokens(manifest.text);
}
