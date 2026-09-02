import { EVIDENCE_GRAPH_DERIVATION_VERSION, workspaceNodeId } from '../cognition/evidence-graph.js';
import type { EvidenceGraphEdge, EvidenceGraphProjection } from '../cognition/types.js';
import { contentHash } from './identity.js';
import type { ContextAnchor, ContextCandidate, ContextGraphParticipation } from './types.js';

const MAX_VISITED_NODES = 256;
const MAX_TRAVERSED_EDGES = 512;
const MAX_FAN_OUT = 32;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateNodeId(candidate: ContextCandidate): string | null {
  if (candidate.section === 'knowledge') return `knowledge:${candidate.source.entityId}`;
  if (candidate.section === 'deadend') return `deadend:${candidate.source.entityId}`;
  if (candidate.source.kind === 'current-context') return `context:${candidate.source.contextId ?? candidate.source.entityId}`;
  return null;
}

function validGraph(graph: EvidenceGraphProjection): boolean {
  if (graph.schemaVersion !== 1 || graph.derivationVersion !== EVIDENCE_GRAPH_DERIVATION_VERSION || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return false;
  const nodeKinds = new Set(['context', 'snapshot', 'experience', 'proposal', 'knowledge', 'deadend', 'skill', 'recipe', 'path', 'test', 'commit', 'branch-worktree']);
  const edgeTypes = new Set(['derived_from', 'supports', 'contradicts', 'supersedes', 'used_for', 'observed_in', 'changed_in', 'co_changed_with', 'tests']);
  const nodes = new Set<string>();
  for (const node of graph.nodes) {
    if (!node || typeof node.nodeId !== 'string' || node.nodeId.length === 0 || !nodeKinds.has(node.kind) || nodes.has(node.nodeId)) return false;
    nodes.add(node.nodeId);
  }
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.edgeId !== 'string' || edge.edgeId.length === 0 || edges.has(edge.edgeId) || !nodes.has(edge.from) || !nodes.has(edge.to) || !edgeTypes.has(edge.type) || edge.derivationVersion !== EVIDENCE_GRAPH_DERIVATION_VERSION || typeof edge.occurredAt !== 'string' || edge.occurredAt.length === 0 || !Array.isArray(edge.sourceEventIds) || edge.sourceEventIds.some((id) => typeof id !== 'string' || !id) || (edge.confidence !== undefined && (typeof edge.confidence !== 'number' || !Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1))) return false;
    edges.add(edge.edgeId);
  }
  return true;
}

function graphProjectionHash(graph: EvidenceGraphProjection): string {
  return contentHash(graph);
}

export interface GraphOrdering {
  participation: ContextGraphParticipation;
  distanceFor(candidate: ContextCandidate): number | null;
}

export function graphOrdering(graph: EvidenceGraphProjection | null, hops: 0 | 1 | 2, anchor: ContextAnchor, eligible: ContextCandidate[]): GraphOrdering {
  const empty = (fallbackReason: string | null, seedNodeIds: string[] = []): GraphOrdering => ({
    participation: {
      derivationVersion: EVIDENCE_GRAPH_DERIVATION_VERSION,
      projectionHash: null,
      hops,
      seedNodeIds,
      selectedNodeIds: [],
      selectedEdgeIds: [],
      fallbackReason,
    },
    distanceFor: () => null,
  });
  if (!graph) return empty('graph-unavailable');
  if (!validGraph(graph)) return empty('graph-invalid');
  const projectionHash = graphProjectionHash(graph);
  const nodes = new Set(graph.nodes.map((node) => node.nodeId));
  const candidateNodes = new Map(eligible.map((candidate) => [candidate.candidateId, candidateNodeId(candidate)]));
  const seedNodeIds = [...new Set([
    workspaceNodeId(anchor),
    ...eligible.filter((candidate) => candidate.source.kind === 'current-context').map(candidateNodeId).filter((node): node is string => node !== null),
  ].filter((node) => nodes.has(node)))].sort(compare);
  if (seedNodeIds.length === 0) return empty('graph-no-seeds');
  if (hops === 0) {
    const distances = new Map(seedNodeIds.map((node) => [node, 0]));
    return {
      participation: { derivationVersion: EVIDENCE_GRAPH_DERIVATION_VERSION, projectionHash, hops, seedNodeIds, selectedNodeIds: seedNodeIds, selectedEdgeIds: [], fallbackReason: null },
      distanceFor: (candidate) => {
        const node = candidateNodes.get(candidate.candidateId);
        return node ? distances.get(node) ?? null : null;
      },
    };
  }
  const adjacency = new Map<string, EvidenceGraphEdge[]>();
  for (const edge of graph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge]);
  }
  for (const edges of adjacency.values()) edges.sort((left, right) => compare(left.edgeId, right.edgeId));
  const distances = new Map(seedNodeIds.map((node) => [node, 0]));
  const queue = [...seedNodeIds];
  const selectedEdgeIds = new Set<string>();
  while (queue.length > 0 && distances.size < MAX_VISITED_NODES && selectedEdgeIds.size < MAX_TRAVERSED_EDGES) {
    const node = queue.shift()!;
    const distance = distances.get(node)!;
    if (distance >= hops) continue;
    for (const edge of (adjacency.get(node) ?? []).slice(0, MAX_FAN_OUT)) {
      if (selectedEdgeIds.size >= MAX_TRAVERSED_EDGES) break;
      const adjacent = edge.from === node ? edge.to : edge.from;
      selectedEdgeIds.add(edge.edgeId);
      if (!distances.has(adjacent) && distances.size < MAX_VISITED_NODES) {
        distances.set(adjacent, distance + 1);
        queue.push(adjacent);
      }
    }
  }
  return {
    participation: {
      derivationVersion: EVIDENCE_GRAPH_DERIVATION_VERSION,
      projectionHash,
      hops,
      seedNodeIds,
      selectedNodeIds: [...distances.keys()].sort(compare),
      selectedEdgeIds: [...selectedEdgeIds].sort(compare),
      fallbackReason: null,
    },
    distanceFor: (candidate) => {
      const node = candidateNodes.get(candidate.candidateId);
      return node ? distances.get(node) ?? null : null;
    },
  };
}
