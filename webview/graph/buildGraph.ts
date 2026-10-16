import type { Block } from '../../src/model/block';

/** Fixed sizes so node heights and handle positions are known before React renders anything. */
export const HEADER_HEIGHT = 32;
export const ROW_HEIGHT = 28;
const NODE_PADDING = 4;
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const MAX_VALUE_WIDTH = 220;
/** Room for row padding, drag handle, gaps and input padding (row actions float over the row). */
const ROW_CHROME = 64;
const HEADER_CHROME = 120;

export type BlockNodeData = {
  block: Block;
  parent?: Block;
  width: number;
  height: number;
};

/** Measures text in the UI font ('label') or the editor font used for values ('value'). */
export type Measure = (text: string, font: 'label' | 'value') => number;

export interface GraphNode {
  id: string;
  data: BlockNodeData;
  width: number;
  height: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * One node per object/array (plus a lone node for a scalar root). Scalar children are
 * rows inside their parent's node; object/array children are rows linked by an edge
 * to their own node. Collapsed blocks keep their row but their subtree is not built.
 */
export function buildGraph(root: Block, isCollapsed: (id: string) => boolean, measure: Measure): Graph {
  const graph: Graph = { nodes: [], edges: [] };

  const visit = (block: Block, parent: Block | undefined) => {
    const rows = block.children ?? [];
    const width = nodeWidth(block, measure);
    const height = HEADER_HEIGHT + Math.max(rows.length, 1) * ROW_HEIGHT + NODE_PADDING;
    graph.nodes.push({ id: nodeId(block), data: { block, parent, width, height }, width, height });

    for (const child of rows) {
      if (child.children !== undefined && !isCollapsed(child.id)) {
        graph.edges.push({ id: `${nodeId(block)}->${nodeId(child)}`, source: nodeId(block), sourceHandle: nodeId(child), target: nodeId(child) });
        visit(child, block);
      }
    }
  };

  visit(root, undefined);
  return graph;
}

/** Block ids are JSON paths (with quotes and brackets); encode them so they are safe as DOM/selector ids. */
export function nodeId(block: Block): string {
  return encodeURIComponent(block.id);
}

export function nodeTitle(block: Block): string {
  if (block.caption !== undefined) {
    return captionText(block);
  }
  if (block.label === undefined) {
    return 'root';
  }
  return typeof block.label === 'number' ? `[${block.label}]` : block.label;
}

/** Text shown for a block as a row of its parent card. */
export function rowLabel(block: Block): string {
  return block.caption !== undefined ? captionText(block) : String(block.label ?? '');
}

/** Elements show their tag name as `<tag>`. */
function captionText(block: Block): string {
  return block.kind === 'element' ? `<${block.caption}>` : block.caption!;
}

/** The name the user searches and renames: object keys, attribute names (with @) and tag names. */
export function blockName(block: Block): string | undefined {
  if (block.kind === 'element') {
    return block.caption;
  }
  return typeof block.label === 'string' ? block.label : undefined;
}

export function summary(block: Block): string {
  const count = block.children?.length ?? 0;
  return block.kind === 'array' ? `[${count}]` : `{${count}}`;
}

export function displayValue(block: Block): string {
  return block.value === null || block.value === undefined ? 'null' : String(block.value);
}

function nodeWidth(block: Block, measure: Measure): number {
  let width = measure(nodeTitle(block), 'label') + measure(summary(block), 'value') + HEADER_CHROME;
  const rows = block.children ?? [block];
  for (const row of rows) {
    const key = row === block ? '' : rowLabel(row);
    const value = row.children !== undefined ? summary(row) : displayValue(row);
    width = Math.max(width, measure(key, 'label') + Math.min(measure(value, 'value'), MAX_VALUE_WIDTH) + ROW_CHROME);
  }
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH));
}
