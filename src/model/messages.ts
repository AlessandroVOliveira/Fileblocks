/** Message protocol shared by the extension host and the webview. */

import type { Block, BlockPath, ScalarValue } from './block';

export interface ParseError {
  message: string;
  offset?: number;
}

/** Value for a newly inserted block: a scalar, or an empty object/array. */
export type InsertValue = ScalarValue | Record<string, never> | never[];

export type BlockEdit =
  | { type: 'setValue'; path: BlockPath; value: ScalarValue }
  | { type: 'remove'; path: BlockPath }
  | { type: 'rename'; path: BlockPath; newKey: string }
  /** Appends to the parent; `key` is required when the parent is an object. */
  | { type: 'insert'; parentPath: BlockPath; key?: string; value: InsertValue }
  /** Reorders a block within its parent; `toIndex` is its final position. */
  | { type: 'move'; path: BlockPath; toIndex: number };

export type HostToWebview =
  | {
      type: 'update';
      format: string;
      root: Block | null;
      errors: ParseError[];
    }
  /** The block under the text editor's cursor (null when the cursor is outside every block). */
  | { type: 'selection'; path: BlockPath | null };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'edit'; edit: BlockEdit }
  /** Asks the host to prompt for the new block's key/type, then insert it. */
  | { type: 'add'; parentPath: BlockPath }
  /** Asks the host to prompt for a new key, then rename the block. */
  | { type: 'rename'; path: BlockPath }
  /** Selects the block's source in a text editor beside the graph. */
  | { type: 'reveal'; path: BlockPath }
  | { type: 'openText' };
