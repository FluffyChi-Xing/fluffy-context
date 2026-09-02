import crypto from 'node:crypto';
import type { CognitionEvent, CognitionGitAnchor, EvidenceGraphEdge, EvidenceGraphNode, EvidenceGraphProjection, EvolutionLineageReference, WorkspacePathsChangedPayload } from './types.js';

export const EVIDENCE_GRAPH_DERIVATION_VERSION = 'evidence-graph-v1' as const;

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function record(event: CognitionEvent): Record<string, unknown> | null {
  const value = (event.payload as Record<string, unknown>).record;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizePath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/');
  return normalized.length > 0 && !normalized.startsWith('/') && !normalized.includes('\0') && !normalized.split('/').includes('..') ? normalized : null;
}

function entityKind(entity: string): EvidenceGraphNode['kind'] | null {
  if (entity === 'compiler-recipe') return 'recipe';
  if (entity === 'knowledge' || entity === 'deadend' || entity === 'skill' || entity === 'experience' || entity === 'proposal') return entity;
  return null;
}

function entityNodeId(entity: string, entityId: string): string | null {
  const kind = entityKind(entity);
  return kind && entityId.trim().length > 0 ? `${kind}:${entityId}` : null;
}

export function workspaceNodeId(anchor: Pick<CognitionGitAnchor, 'worktreeId' | 'branch' | 'ref'>): string {
  return `branch-worktree:${hash({ worktreeId: anchor.worktreeId, branch: anchor.branch, ref: anchor.ref }).slice(0, 16)}`;
}

function addNode(nodes: Map<string, EvidenceGraphNode>, nodeId: string, kind: EvidenceGraphNode['kind']): void {
  nodes.set(nodeId, { nodeId, kind });
}

function addEntityNode(nodes: Map<string, EvidenceGraphNode>, entity: string, entityId: string): string | null {
  const nodeId = entityNodeId(entity, entityId);
  const kind = entityKind(entity);
  if (nodeId && kind) addNode(nodes, nodeId, kind);
  return nodeId;
}

function addEdge(edges: Map<string, EvidenceGraphEdge>, input: Omit<EvidenceGraphEdge, 'edgeId' | 'derivationVersion'>): void {
  const sourceEventIds = [...new Set(input.sourceEventIds)].sort();
  const basis = { from: input.from, to: input.to, type: input.type, sourceEventIds, occurredAt: input.occurredAt, confidence: input.confidence };
  const edgeId = `edge:${hash(basis).slice(0, 24)}`;
  edges.set(edgeId, { ...input, edgeId, sourceEventIds, derivationVersion: EVIDENCE_GRAPH_DERIVATION_VERSION });
}

function anchorNodes(event: CognitionEvent, nodes: Map<string, EvidenceGraphNode>): string {
  const workspace = workspaceNodeId(event.git);
  addNode(nodes, workspace, 'branch-worktree');
  if (event.git.head) addNode(nodes, `commit:${event.git.head}`, 'commit');
  return workspace;
}

function lineageEdge(edges: Map<string, EvidenceGraphEdge>, nodes: Map<string, EvidenceGraphNode>, from: string, lineage: EvolutionLineageReference, event: CognitionEvent): void {
  const target = addEntityNode(nodes, lineage.entity, lineage.entityId);
  if (!target) return;
  addEdge(edges, { from, to: target, type: lineage.relation, sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
}

function sourceLinks(edges: Map<string, EvidenceGraphEdge>, nodes: Map<string, EvidenceGraphNode>, from: string, contextIds: unknown, snapshotIds: unknown, event: CognitionEvent): void {
  if (Array.isArray(contextIds)) for (const contextId of contextIds) if (typeof contextId === 'string' && contextId.trim()) {
    const target = `context:${contextId}`;
    addNode(nodes, target, 'context');
    addEdge(edges, { from, to: target, type: 'derived_from', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
  }
  if (Array.isArray(snapshotIds)) for (const snapshotId of snapshotIds) if (typeof snapshotId === 'string' && snapshotId.trim()) {
    const target = `snapshot:${snapshotId}`;
    addNode(nodes, target, 'snapshot');
    addEdge(edges, { from, to: target, type: 'derived_from', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
  }
}

export function buildEvidenceGraph(events: CognitionEvent[]): EvidenceGraphProjection {
  const nodes = new Map<string, EvidenceGraphNode>();
  const edges = new Map<string, EvidenceGraphEdge>();
  for (const event of events) {
    const workspace = anchorNodes(event, nodes);
    if (event.git.head) addEdge(edges, { from: workspace, to: `commit:${event.git.head}`, type: 'changed_in', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
    const value = record(event);
    if (event.type === 'context.checkpoint.imported' || event.type === 'context.state.recorded') {
      const snapshot = value?.snapshot as Record<string, unknown> | undefined;
      if (snapshot && typeof snapshot.contextId === 'string' && typeof snapshot.snapshotId === 'string') {
        const context = `context:${snapshot.contextId}`;
        const snap = `snapshot:${snapshot.snapshotId}`;
        addNode(nodes, context, 'context');
        addNode(nodes, snap, 'snapshot');
        addEdge(edges, { from: context, to: snap, type: 'derived_from', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
      }
    }
    if (event.type === 'experience.recorded' && typeof value?.experienceId === 'string') {
      const id = addEntityNode(nodes, 'experience', value.experienceId)!;
      sourceLinks(edges, nodes, id, value.sourceContextIds, value.sourceSnapshotIds, event);
      if (Array.isArray(value.paths)) for (const item of value.paths) if (typeof item === 'string') {
        const path = normalizePath(item);
        if (!path) continue;
        const target = `path:${path}`;
        addNode(nodes, target, 'path');
        addEdge(edges, { from: id, to: target, type: 'observed_in', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
      }
    }
    if (event.type === 'evolution.proposed' && typeof value?.proposalId === 'string') {
      const id = addEntityNode(nodes, 'proposal', value.proposalId)!;
      if (Array.isArray(value.sourceExperienceIds)) for (const source of value.sourceExperienceIds) if (typeof source === 'string') {
        const target = addEntityNode(nodes, 'experience', source);
        if (target) addEdge(edges, { from: id, to: target, type: 'derived_from', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
      }
      if (Array.isArray(value.lineage)) for (const item of value.lineage) if (item && typeof item === 'object') lineageEdge(edges, nodes, id, item as EvolutionLineageReference, event);
    }
    if (['knowledge.proposed', 'knowledge.verified', 'knowledge.deprecated', 'knowledge.rejected'].includes(event.type) && typeof value?.knowledgeId === 'string') {
      const id = addEntityNode(nodes, 'knowledge', value.knowledgeId)!;
      sourceLinks(edges, nodes, id, value.sourceContextIds, value.sourceSnapshotIds, event);
    }
    if (['deadend.proposed', 'deadend.verified', 'deadend.obsoleted', 'deadend.rejected'].includes(event.type) && typeof value?.deadendId === 'string') {
      const id = addEntityNode(nodes, 'deadend', value.deadendId)!;
      sourceLinks(edges, nodes, id, value.sourceContextId === null ? [] : [value.sourceContextId], value.sourceSnapshotId === null ? [] : [value.sourceSnapshotId], event);
    }
    if (event.type === 'skill.materialized' && typeof value?.skillId === 'string') {
      const id = addEntityNode(nodes, 'skill', value.skillId)!;
      const proposal = typeof value.proposalId === 'string' ? addEntityNode(nodes, 'proposal', value.proposalId) : null;
      if (proposal) addEdge(edges, { from: id, to: proposal, type: 'derived_from', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
      if (Array.isArray(value.lineage)) for (const item of value.lineage) if (item && typeof item === 'object') lineageEdge(edges, nodes, id, item as EvolutionLineageReference, event);
    }
    if (event.type === 'recipe.materialized' && typeof value?.recipeId === 'string') {
      const id = addEntityNode(nodes, 'compiler-recipe', value.recipeId)!;
      const proposal = typeof value.proposalId === 'string' ? addEntityNode(nodes, 'proposal', value.proposalId) : null;
      if (proposal) addEdge(edges, { from: id, to: proposal, type: 'derived_from', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
      if (Array.isArray(value.lineage)) for (const item of value.lineage) if (item && typeof item === 'object') lineageEdge(edges, nodes, id, item as EvolutionLineageReference, event);
    }
    if (event.type === 'evolution.superseded') {
      const transition = (event.payload as Record<string, unknown>).transition;
      if (transition && typeof transition === 'object' && !Array.isArray(transition)) {
        const value = transition as Record<string, unknown>;
        const from = typeof value.entity === 'string' && typeof value.entityId === 'string' ? addEntityNode(nodes, value.entity, value.entityId) : null;
        const supersedes = value.supersedes;
        if (from && supersedes && typeof supersedes === 'object' && !Array.isArray(supersedes)) {
          const reference = supersedes as EvolutionLineageReference;
          lineageEdge(edges, nodes, from, reference, event);
        }
      }
    }
    if (event.type === 'workspace.paths.changed') {
      const payload = event.payload as Partial<WorkspacePathsChangedPayload>;
      if (Array.isArray(payload.paths)) for (const item of payload.paths) if (typeof item === 'string') {
        const path = normalizePath(item);
        if (!path) continue;
        const target = `path:${path}`;
        addNode(nodes, target, 'path');
        addEdge(edges, { from: workspace, to: target, type: 'observed_in', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
      }
    }
    if (event.type === 'record.used') {
      const used = event.payload as { entity?: string; entityId?: string };
      if (typeof used.entity === 'string' && typeof used.entityId === 'string') {
        const from = addEntityNode(nodes, used.entity, used.entityId);
        if (from) addEdge(edges, { from, to: workspace, type: 'used_for', sourceEventIds: [event.eventId], occurredAt: event.occurredAt });
      }
    }
  }
  return {
    schemaVersion: 1,
    derivationVersion: EVIDENCE_GRAPH_DERIVATION_VERSION,
    nodes: [...nodes.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    edges: [...edges.values()].sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
  };
}
