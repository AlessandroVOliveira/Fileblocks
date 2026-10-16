/** Message protocol shared by the extension host and the webview. */

import type { Block, BlockPath, ScalarValue } from './block';

export type { ScalarValue };

export interface ParseError {
  message: string;
  offset?: number;
}

/** Value for a newly inserted block: a scalar, or an empty object/array. */
export type InsertValue = ScalarValue | Record<string, never> | never[];

export type BlockEdit =
  /** Replaces a value; an object/array value replaces it with an empty one (used to change types). */
  | { type: 'setValue'; path: BlockPath; value: InsertValue }
  | { type: 'remove'; path: BlockPath }
  | { type: 'rename'; path: BlockPath; newKey: string }
  /** Appends to the parent; `key` is required when the parent is an object. */
  | { type: 'insert'; parentPath: BlockPath; key?: string; value: InsertValue }
  /** Reorders a block within its parent; `toIndex` is its final position. */
  | { type: 'move'; path: BlockPath; toIndex: number };

/** A JSON Schema violation at a block. */
export interface SchemaProblem {
  path: BlockPath;
  message: string;
}

/** What the schema says about one block, for display. */
export interface SchemaHint {
  description?: string;
  /** Allowed values (from `enum` / `const`). */
  enum?: unknown[];
  /** True when the parent object's schema lists this key as required. */
  required?: boolean;
}

export interface SchemaInfo {
  /** Short name for the toolbar (schema title or file name). */
  name: string;
  uri: string;
  loading?: boolean;
  /** Why the schema couldn't be loaded or compiled. */
  error?: string;
  problems: SchemaProblem[];
  /** Hints keyed by block id. */
  hints: Record<string, SchemaHint>;
}

export type HostToWebview =
  | {
      type: 'update';
      format: string;
      root: Block | null;
      errors: ParseError[];
      /** Present when a JSON Schema applies to the file. */
      schema?: SchemaInfo;
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
  /** Asks the host to prompt for a new type, then convert the value. */
  | { type: 'changeType'; path: BlockPath }
  /** Selects the block's source in a text editor beside the graph. */
  | { type: 'reveal'; path: BlockPath }
  | { type: 'openText' };
