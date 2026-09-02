import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { addNote, listNotes } from '../runtime/notes.js';
import { contextCompile, contextExpand, contextOrient, contextUsageReport, inspectRecipe, inspectSkill, listRecipes, listSkills, loadContext, materializeContextRecipe, materializeContextSkill, recordContextSkillInvocation, recordContextSkillOutcome, saveContext, transitionContextRecipe, transitionContextSkill } from '../agent/api.js';
import { ensureRuntimeForSession } from '../cognition/runtime.js';
import { VERSION } from '../version.js';

const orientInput = z.object({
  path: z.string().optional(),
  contextId: z.string().optional(),
  query: z.string().optional(),
  scope: z.string().optional(),
  maxChars: z.int().nonnegative().optional(),
  knowledgeLimit: z.int().nonnegative().optional(),
  deadendLimit: z.int().nonnegative().optional(),
  noteLimit: z.int().nonnegative().optional(),
});

const scenario = z.enum(['resume', 'implementation', 'debugging', 'verification', 'handoff', 'exploration', 'unknown']);
const trigger = z.enum(['session-start', 'prompt', 'manual', 'tool-call']);
const noteKind = z.enum(['problem', 'action', 'observation', 'decision']);
const noteActor = z.enum(['agent', 'human']);
const noteStatus = z.enum(['open', 'resolved']);

const compileOptions = z.object({
  contextId: z.string().optional(),
  recipeId: z.string().optional(),
  query: z.string().optional(),
  scenario: scenario.optional(),
  scope: z.string().optional(),
  paths: z.array(z.string()).optional(),
  maxChars: z.int().nonnegative().optional(),
  knowledgeLimit: z.int().nonnegative().optional(),
  deadendLimit: z.int().nonnegative().optional(),
  noteLimit: z.int().nonnegative().optional(),
  activityLimit: z.int().nonnegative().optional(),
  trigger: trigger.optional(),
  adapter: z.string().optional(),
  sessionId: z.string().optional(),
  eventId: z.string().optional(),
});

const expandInput = z.object({
  path: z.string().optional(),
  manifestHash: z.string(),
  candidateId: z.string().optional(),
  itemHash: z.string().optional(),
  level: z.enum(['structured', 'evidence']),
  maxChars: z.int().nonnegative().optional(),
  compile: compileOptions,
});

const compileInput = z.object({ path: z.string().optional(), ...compileOptions.shape });

const resumeInput = z.object({
  path: z.string().optional(),
  contextId: z.string().optional(),
  maxChars: z.int().nonnegative().optional(),
  includeDetails: z.boolean().optional(),
  query: z.string().optional(),
  scope: z.string().optional(),
});

const noteListInput = z.object({
  path: z.string().optional(),
  contextId: z.string().optional(),
  openOnly: z.boolean().optional(),
  limit: z.int().nonnegative().optional(),
  maxChars: z.int().nonnegative().optional(),
});

const noteAddInput = z.object({
  path: z.string().optional(),
  message: z.string(),
  kind: noteKind.optional(),
  actor: noteActor.optional(),
  contextId: z.string().optional(),
  snapshotId: z.string().optional(),
  relatedFiles: z.array(z.string()).optional(),
  status: noteStatus.optional(),
});

const checkpointInput = z.object({
  path: z.string().optional(),
  contextId: z.string().optional(),
  absorbNotes: z.boolean().optional(),
  title: z.string().optional(),
  progressSummary: z.string().optional(),
  lastError: z.string().nullable().optional(),
  completed: z.array(z.string()).optional(),
  pendingTasks: z.array(z.string()).optional(),
  decisions: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  relatedFiles: z.array(z.string()).optional(),
});

const usageReportInput = z.object({
  path: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  days: z.int().nonnegative().optional(),
  month: z.string().optional(),
  granularity: z.enum(['day', 'week', 'month']).optional(),
  baselineTokens: z.number().nonnegative().optional(),
  baselineSource: z.enum(['manual', 'recorded-control']).optional(),
});

const skillOutcome = z.enum(['success', 'failure', 'partial', 'irrelevant', 'unknown']);
const recipeEntity = z.enum(['knowledge', 'deadend', 'skill', 'compiler-recipe', 'experience', 'proposal']);
const recipeListInput = z.object({ path: z.string().optional() });
const recipeInspectInput = z.object({ path: z.string().optional(), recipeId: z.string() });
const recipeMaterializeInput = z.object({ path: z.string().optional(), proposalId: z.string(), title: z.string(), preferredSources: z.array(z.enum(['context', 'knowledge', 'deadend', 'note'])).optional(), preferredSections: z.array(z.enum(['summary', 'pending', 'decision', 'risk', 'note', 'knowledge', 'deadend', 'activity'])).optional(), sectionBudgets: z.record(z.string(), z.int().nonnegative().max(100_000)).optional() });
const recipeTransitionInput = z.object({ path: z.string().optional(), recipeId: z.string(), to: z.enum(['verified', 'published', 'deprecated', 'superseded']), rationale: z.string(), supersedes: z.object({ entity: recipeEntity, entityId: z.string(), relation: z.literal('supersedes') }).optional() });


const skillEntity = z.enum(['knowledge', 'deadend', 'skill', 'compiler-recipe', 'experience', 'proposal']);
const skillListInput = z.object({ path: z.string().optional() });
const skillInspectInput = z.object({ path: z.string().optional(), skillId: z.string() });
const skillMaterializeInput = z.object({ path: z.string().optional(), proposalId: z.string(), title: z.string(), procedure: z.array(z.string()) });
const skillTransitionInput = z.object({ path: z.string().optional(), skillId: z.string(), to: z.enum(['verified', 'published', 'deprecated', 'superseded']), rationale: z.string(), supersedes: z.object({ entity: skillEntity, entityId: z.string(), relation: z.literal('supersedes') }).optional() });
const skillInvocationInput = z.object({ path: z.string().optional(), skillId: z.string(), invocationId: z.string(), callerEventId: z.string(), inputHash: z.string() });
const skillOutcomeInput = z.object({ path: z.string().optional(), skillId: z.string(), invocationId: z.string(), outcomeId: z.string(), callerEventId: z.string(), outcome: skillOutcome, summary: z.string() });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function successResponse<T>(result: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function failureResponse(tool: string, error: unknown) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `${tool} failed: ${errorMessage(error)}` }],
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'fluffy-context', version: VERSION });
  server.registerTool('context_orient', {
    title: 'Orient context',
    description: 'Load bounded, read-only task context with verified consensus and open notes. Compiler manifests expose deterministic levels, hashes, and estimated tokens through the Agent API and CLI.',
    inputSchema: orientInput,
  }, async ({ path, ...options }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await contextOrient(path, options, 'mcp'));
    } catch (error) {
      return failureResponse('context_orient', error);
    }
  });
  server.registerTool('context_expand', {
    title: 'Expand context candidate',
    description: 'Read a selected compiler candidate at structured or evidence level without writing project state or reading file contents.',
    inputSchema: expandInput,
  }, async ({ path, ...input }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await contextExpand(path, input, 'mcp'));
    } catch (error) {
      return failureResponse('context_expand', error);
    }
  });
  server.registerTool('context_compile', {
    title: 'Compile context manifest',
    description: 'Compile a bounded, deterministic, read-only context manifest without writing project state or reading file contents.',
    inputSchema: compileInput,
  }, async ({ path, ...options }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await contextCompile(path, options, 'mcp'));
    } catch (error) {
      return failureResponse('context_compile', error);
    }
  });
  server.registerTool('context_resume', {
    title: 'Resume context',
    description: 'Resume the selected active context with a bounded summary and optional details. This may update the existing lastUsedAt field.',
    inputSchema: resumeInput,
  }, async ({ path, ...options }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await loadContext(path, options, 'mcp'));
    } catch (error) {
      return failureResponse('context_resume', error);
    }
  });
  server.registerTool('context_note_list', {
    title: 'List context notes',
    description: 'List bounded notes without modifying project state or absorbing or resolving notes.',
    inputSchema: noteListInput,
  }, async ({ path, ...query }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse({ notes: await listNotes(path, query) });
    } catch (error) {
      return failureResponse('context_note_list', error);
    }
  });
  server.registerTool('context_note_add', {
    title: 'Add context note',
    description: 'Append one explicit note to project state. This writes the local context store but does not create a Snapshot.',
    inputSchema: noteAddInput,
  }, async ({ path, message, ...input }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await addNote(path, message, input));
    } catch (error) {
      return failureResponse('context_note_add', error);
    }
  });
  server.registerTool('context_usage_report', {
    title: 'Context usage report',
    description: 'Build a read-only report of context assets, explicit reuse, estimated token investment, and operation metrics.',
    inputSchema: usageReportInput,
  }, async ({ path, ...options }) => {
    try {
      return successResponse(await contextUsageReport(path, options));
    } catch (error) {
      return failureResponse('context_usage_report', error);
    }
  });
  server.registerTool('recipe_list', {
    title: 'List Recipes',
    description: 'List immutable v2 compiler Recipes without modifying project state.',
    inputSchema: recipeListInput,
  }, async ({ path }) => {
    try { return successResponse(await listRecipes(path)); } catch (error) { return failureResponse('recipe_list', error); }
  });
  server.registerTool('recipe_inspect', {
    title: 'Inspect Recipe',
    description: 'Inspect a compiler Recipe and its lifecycle.',
    inputSchema: recipeInspectInput,
  }, async ({ path, recipeId }) => {
    try { return successResponse(await inspectRecipe(path, recipeId)); } catch (error) { return failureResponse('recipe_inspect', error); }
  });
  server.registerTool('recipe_materialize', {
    title: 'Materialize Recipe',
    description: 'Materialize a Recipe from an accepted compiler-recipe proposal.',
    inputSchema: recipeMaterializeInput,
  }, async ({ path, ...input }) => {
    try { return successResponse(await materializeContextRecipe(path, input)); } catch (error) { return failureResponse('recipe_materialize', error); }
  });
  server.registerTool('recipe_transition', {
    title: 'Transition Recipe',
    description: 'Apply an explicit append-only Recipe lifecycle transition.',
    inputSchema: recipeTransitionInput,
  }, async ({ path, ...input }) => {
    try { return successResponse(await transitionContextRecipe(path, input)); } catch (error) { return failureResponse('recipe_transition', error); }
  });
  server.registerTool('skill_list', {
    title: 'List Skills',
    description: 'List immutable v2 Skills without modifying project state.',
    inputSchema: skillListInput,
  }, async ({ path }) => {
    try {
      return successResponse(await listSkills(path));
    } catch (error) {
      return failureResponse('skill_list', error);
    }
  });
  server.registerTool('skill_inspect', {
    title: 'Inspect Skill',
    description: 'Inspect an immutable v2 Skill and its lifecycle without modifying project state.',
    inputSchema: skillInspectInput,
  }, async ({ path, skillId }) => {
    try {
      return successResponse(await inspectSkill(path, skillId));
    } catch (error) {
      return failureResponse('skill_inspect', error);
    }
  });
  server.registerTool('skill_materialize', {
    title: 'Materialize Skill',
    description: 'Materialize a Skill from an accepted candidate Skill proposal.',
    inputSchema: skillMaterializeInput,
  }, async ({ path, ...input }) => {
    try {
      return successResponse(await materializeContextSkill(path, input));
    } catch (error) {
      return failureResponse('skill_materialize', error);
    }
  });
  server.registerTool('skill_transition', {
    title: 'Transition Skill',
    description: 'Apply an explicit append-only Skill lifecycle transition.',
    inputSchema: skillTransitionInput,
  }, async ({ path, ...input }) => {
    try {
      return successResponse(await transitionContextSkill(path, input));
    } catch (error) {
      return failureResponse('skill_transition', error);
    }
  });
  server.registerTool('skill_record_invocation', {
    title: 'Record Skill invocation',
    description: 'Record a published Skill invocation using only an input hash.',
    inputSchema: skillInvocationInput,
  }, async ({ path, ...input }) => {
    try {
      return successResponse(await recordContextSkillInvocation(path, input));
    } catch (error) {
      return failureResponse('skill_record_invocation', error);
    }
  });
  server.registerTool('skill_record_outcome', {
    title: 'Record Skill outcome',
    description: 'Record one explicit terminal outcome for a Skill invocation.',
    inputSchema: skillOutcomeInput,
  }, async ({ path, ...input }) => {
    try {
      return successResponse(await recordContextSkillOutcome(path, input));
    } catch (error) {
      return failureResponse('skill_record_outcome', error);
    }
  });
  server.registerTool('context_checkpoint', {
    title: 'Checkpoint context',
    description: 'Explicitly save context progress and create a Snapshot when changes are present; runtime rate limits remain enforced.',
    inputSchema: checkpointInput,
  }, async ({ path, ...input }) => {
    try {
      await ensureRuntimeForSession(path, { source: 'mcp', timeoutMs: 1_000 }).catch(() => undefined);
      return successResponse(await saveContext(path, input));
    } catch (error) {
      return failureResponse('context_checkpoint', error);
    }
  });
  return server;
}
