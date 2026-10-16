import type { Block } from '../../src/model/block';

/** Above this many cards, the first render collapses deeper levels. */
export const MAX_INITIAL_CARDS = 150;

export interface InitialCollapse {
  /** Ids of the containers to collapse. */
  ids: string[];
  /** Deepest level that stays expanded (root is level 0), or undefined when nothing was collapsed. */
  depth?: number;
}

/**
 * For large files, keeps the shallowest levels expanded so that at most `maxCards` cards are
 * shown, and collapses every container one level below. Each card is an object/array; a
 * collapsed container still appears as a row (with its count) in its parent's card.
 */
export function initialCollapse(root: Block, maxCards = MAX_INITIAL_CARDS): InitialCollapse {
  const levels: Block[][] = [];
  const visit = (block: Block, depth: number) => {
    if (block.children === undefined) {
      return;
    }
    (levels[depth] ??= []).push(block);
    block.children.forEach((child) => visit(child, depth + 1));
  };
  visit(root, 0);

  let shown = 0;
  for (let depth = 0; depth < levels.length; depth++) {
    shown += levels[depth].length;
    if (shown > maxCards) {
      // Always keep the root card, even if its level alone is over the budget.
      const keep = Math.max(depth - 1, 0);
      return { ids: (levels[keep + 1] ?? []).map((block) => block.id), depth: keep };
    }
  }
  return { ids: [] };
}
