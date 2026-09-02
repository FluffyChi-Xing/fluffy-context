import crypto from 'node:crypto';
import { readGitWorktreeState } from '../git/git-adapter.js';
import { resolveProjectRoot } from '../project/project-resolver.js';
import { inspectEvolutionProposal } from './evolution.js';
import { appendEvent, readJournal } from './journal.js';
import { v2Enabled } from './orient.js';
import { projectEvents, rebuildProjections } from './projections.js';
import type { Applicability, CompilerRecipe, CompilerRecipeSection, CompilerRecipeSource, CompilerRecipeState, EvolutionArtifactStatus, EvolutionLineageReference } from './types.js';

export interface MaterializeRecipeInput {
  proposalId: string;
  title: string;
  preferredSources?: CompilerRecipeSource[];
  preferredSections?: CompilerRecipeSection[];
  sectionBudgets?: Partial<Record<CompilerRecipeSection, number>>;
}

export interface TransitionRecipeInput {
  recipeId: string;
  to: Extract<EvolutionArtifactStatus, 'verified' | 'published' | 'deprecated' | 'superseded'>;
  rationale: string;
  supersedes?: EvolutionLineageReference;
}

const sources = new Set<CompilerRecipeSource>(['context', 'knowledge', 'deadend', 'note']);
const sections = new Set<CompilerRecipeSection>(['summary', 'pending', 'decision', 'risk', 'note', 'knowledge', 'deadend', 'activity']);

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  return text;
}

function preferences<T extends string>(value: T[] | undefined, allowed: Set<T>, label: string): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > allowed.size || value.some((item) => !allowed.has(item)) || new Set(value).size !== value.length) throw new Error(`invalid recipe ${label}`);
  return [...value];
}

function budgets(value: MaterializeRecipeInput['sectionBudgets']): MaterializeRecipeInput['sectionBudgets'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.entries(value).some(([section, budget]) => !sections.has(section as CompilerRecipeSection) || !Number.isSafeInteger(budget) || budget < 0 || budget > 100_000)) throw new Error('invalid recipe section budgets');
  return Object.fromEntries(Object.entries(value).sort()) as MaterializeRecipeInput['sectionBudgets'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eventRecord(event: Awaited<ReturnType<typeof readJournal>>[number]): Record<string, unknown> | null {
  const payload = event.payload as Record<string, unknown>;
  return isRecord(payload.record) ? payload.record : null;
}

function matchingRecord(record: Record<string, unknown>, expected: Record<string, unknown>, ignored: string[] = []): boolean {
  const actual = { ...record };
  for (const field of ignored) delete actual[field];
  return canonical(actual) === canonical(expected);
}

function anchor(git: Awaited<ReturnType<typeof readGitWorktreeState>>) {
  return { worktreeId: git.worktreeId, branch: git.branch, ref: git.ref, head: git.commit };
}

async function enabledProject(startPath: string | undefined): Promise<string> {
  const projectRoot = await resolveProjectRoot(startPath);
  if (!await v2Enabled(projectRoot)) throw new Error('recipes require an enabled v2 runtime');
  return projectRoot;
}

export async function listRecipes(startPath?: string): Promise<CompilerRecipeState[]> {
  const projectRoot = await enabledProject(startPath);
  return Object.values(projectEvents(await readJournal(projectRoot)).recipes).sort((left, right) => left.recipe.recipeId.localeCompare(right.recipe.recipeId));
}

export async function inspectRecipe(startPath: string | undefined, recipeId: string): Promise<CompilerRecipeState> {
  const id = requireText(recipeId, 'recipe ID');
  const recipe = (await listRecipes(startPath)).find((item) => item.recipe.recipeId === id);
  if (!recipe) throw new Error(`recipe not found: ${id}`);
  return recipe;
}

export async function materializeRecipe(startPath: string | undefined, input: MaterializeRecipeInput): Promise<{ materialized: boolean; recipeId: string; eventId: string }> {
  const projectRoot = await enabledProject(startPath);
  const proposalId = requireText(input.proposalId, 'proposal ID');
  const proposalState = await inspectEvolutionProposal(projectRoot, proposalId);
  if (proposalState.proposal.targetKind !== 'compiler-recipe' || proposalState.status !== 'candidate') throw new Error(`recipe materialization requires a candidate compiler-recipe proposal: ${proposalId}`);
  const artifact = proposalState.acceptedArtifact;
  if (!artifact || artifact.kind !== 'compiler-recipe' || artifact.proposalId !== proposalId) throw new Error(`recipe materialization requires an accepted compiler-recipe candidate: ${proposalId}`);
  const title = requireText(input.title, 'recipe title');
  const preferredSources = preferences(input.preferredSources, sources, 'source preferences');
  const preferredSections = preferences(input.preferredSections, sections, 'section preferences');
  const sectionBudgets = budgets(input.sectionBudgets);
  const basis = { proposalId, title, applicability: artifact.applicability, preferredSources, preferredSections, sectionBudgets, lineage: artifact.lineage, proposalContentHash: artifact.contentHash };
  const expected = {
    recipeId: artifact.artifactId,
    schemaVersion: 1 as const,
    proposalId,
    title,
    applicability: artifact.applicability as Applicability,
    ...(preferredSources ? { preferredSources } : {}),
    ...(preferredSections ? { preferredSections } : {}),
    ...(sectionBudgets ? { sectionBudgets } : {}),
    status: 'candidate' as const,
    contentHash: hash(basis),
    lineage: artifact.lineage,
  };
  const existing = (await readJournal(projectRoot)).find((event) => event.type === 'recipe.materialized' && eventRecord(event)?.recipeId === expected.recipeId);
  if (existing) {
    const record = eventRecord(existing)!;
    if (!matchingRecord(record, expected, ['createdAt'])) throw new Error(`Recipe already materialized with conflicting content: ${expected.recipeId}`);
    return { materialized: false, recipeId: expected.recipeId, eventId: existing.eventId };
  }
  const recipe: CompilerRecipe = { ...expected, createdAt: new Date().toISOString() };
  const git = await readGitWorktreeState(projectRoot);
  const result = await appendEvent(projectRoot, {
    type: 'recipe.materialized', source: { kind: 'cli' }, idempotencyKey: `recipe-materialized:${recipe.recipeId}:${recipe.contentHash}`,
    git: anchor(git), payload: { record: recipe },
  });
  if (result.appended) await rebuildProjections(projectRoot);
  return { materialized: result.appended, recipeId: recipe.recipeId, eventId: result.event.eventId };
}

export async function transitionRecipe(startPath: string | undefined, input: TransitionRecipeInput): Promise<{ transitioned: boolean; eventId: string }> {
  const projectRoot = await enabledProject(startPath);
  const recipe = await inspectRecipe(projectRoot, input.recipeId);
  const rationale = requireText(input.rationale, 'recipe rationale');
  if (input.to === 'superseded' && !input.supersedes) throw new Error('superseding a Recipe requires lineage');
  const request = { entity: 'compiler-recipe', entityId: recipe.recipe.recipeId, to: input.to, reason: rationale, ...(input.supersedes ? { supersedes: input.supersedes } : {}) };
  const existing = (await readJournal(projectRoot)).find((event) => {
    if (!event.type.startsWith('evolution.')) return false;
    const transition = (event.payload as Record<string, unknown>).transition;
    return isRecord(transition) && matchingRecord(transition, request, ['from']);
  });
  if (existing) return { transitioned: false, eventId: existing.eventId };
  if (!((recipe.status === 'candidate' && (input.to === 'verified' || input.to === 'deprecated'))
    || (recipe.status === 'verified' && (input.to === 'published' || input.to === 'deprecated' || input.to === 'superseded'))
    || (recipe.status === 'published' && (input.to === 'deprecated' || input.to === 'superseded')))) {
    throw new Error(`invalid Recipe transition: ${recipe.status} to ${input.to}`);
  }
  const git = await readGitWorktreeState(projectRoot);
  const result = await appendEvent(projectRoot, {
    type: `evolution.${input.to}` as 'evolution.verified' | 'evolution.published' | 'evolution.deprecated' | 'evolution.superseded',
    source: { kind: 'cli' },
    idempotencyKey: `recipe-transition:${recipe.recipe.recipeId}:${input.to}:${hash({ rationale, supersedes: input.supersedes }).slice(0, 16)}`,
    git: anchor(git),
    payload: { transition: { ...request, from: recipe.status } },
  });
  if (result.appended) await rebuildProjections(projectRoot);
  return { transitioned: result.appended, eventId: result.event.eventId };
}
