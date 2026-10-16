import { pathToId, type Block } from '../../src/model/block';
import { displayValue } from './buildGraph';

export interface SearchMatch {
  /** The block whose key or value matched. */
  block: Block;
  /** The card that shows it as a row: its parent, or the block itself for a scalar root. */
  card: Block;
  /** Row index of the match inside the card. */
  row: number;
}

/**
 * Case-insensitive search over string keys and scalar values, in document order.
 * Array indexes are not matched: searching "1" would otherwise hit every second item.
 */
export function findMatches(root: Block, query: string): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  const matches: SearchMatch[] = [];
  if (!needle) {
    return matches;
  }

  const visit = (block: Block, parent: Block | undefined, row: number) => {
    const keyHit = typeof block.label === 'string' && block.label.toLowerCase().includes(needle);
    const valueHit = block.kind === 'scalar' && displayValue(block).toLowerCase().includes(needle);
    if (keyHit || valueHit) {
      matches.push({ block, card: parent ?? block, row });
    }
    block.children?.forEach((child, i) => visit(child, block, i));
  };

  visit(root, undefined, 0);
  return matches;
}

/** Ids that must not be collapsed for the match's card to be on the canvas: the card and its ancestors. */
export function idsToReveal(match: SearchMatch): string[] {
  const path = match.card.path;
  return path.map((_, i) => pathToId(path.slice(0, i + 1)));
}
