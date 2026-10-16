import type { Block } from '../../src/model/block';
import { blockName, displayValue } from './buildGraph';
import type { GraphTarget } from './targets';

export type SearchMatch = GraphTarget;

/**
 * Case-insensitive search over names (object keys, attribute and tag names) and values, in document order.
 * Array indexes are not matched: searching "1" would otherwise hit every second item.
 */
export function findMatches(root: Block, query: string): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  const matches: SearchMatch[] = [];
  if (!needle) {
    return matches;
  }

  const visit = (block: Block, parent: Block | undefined, row: number) => {
    const keyHit = blockName(block)?.toLowerCase().includes(needle) ?? false;
    // Scalars, attributes and text all carry a value.
    const valueHit = block.children === undefined && displayValue(block).toLowerCase().includes(needle);
    if (keyHit || valueHit) {
      matches.push({ block, card: parent ?? block, row });
    }
    block.children?.forEach((child, i) => visit(child, block, i));
  };

  visit(root, undefined, 0);
  return matches;
}
