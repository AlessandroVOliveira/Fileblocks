import { findBlock, pathToId, type Block, type BlockPath } from '../../src/model/block';

/** Where a block appears on the canvas: as a row of a card. */
export interface GraphTarget {
  block: Block;
  /** The card that shows the block as a row: its parent, or the block itself for a scalar root. */
  card: Block;
  /** Row index of the block inside the card. */
  row: number;
}

export function targetFor(root: Block, path: BlockPath): GraphTarget | undefined {
  const block = findBlock(root, path);
  if (!block) {
    return undefined;
  }
  if (path.length === 0) {
    return { block, card: block, row: 0 };
  }
  const card = findBlock(root, path.slice(0, -1))!;
  return { block, card, row: card.children!.indexOf(block) };
}

/** Ids that must not be collapsed for the target's card to be on the canvas: the card and its ancestors. */
export function idsToReveal(target: GraphTarget): string[] {
  const path = target.card.path;
  return path.map((_, i) => pathToId(path.slice(0, i + 1)));
}
