import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { BlockNodeData, Graph } from './buildGraph';

export type BlockFlowNode = Node<BlockNodeData, 'block'>;

/** Left-to-right tree layout. dagre positions node centers; React Flow wants top-left corners. */
export function layoutGraph(graph: Graph): { nodes: BlockFlowNode[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    g.setNode(node.id, { width: node.width, height: node.height });
  }
  for (const edge of graph.edges) {
    g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);

  return {
    nodes: graph.nodes.map((node) => {
      const { x, y } = g.node(node.id);
      return {
        id: node.id,
        type: 'block',
        position: { x: x - node.width / 2, y: y - node.height / 2 },
        data: node.data,
        width: node.width,
        height: node.height,
      };
    }),
    edges: graph.edges.map((edge) => ({ ...edge, type: 'default' })),
  };
}
