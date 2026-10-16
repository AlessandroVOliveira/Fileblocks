import type { Block, BlockPath } from '../model/block';
import type { BlockEdit, ParseError } from '../model/messages';

/** A replacement in the document text. Kept independent of the vscode API so adapters stay testable. */
export interface TextChange {
  offset: number;
  length: number;
  content: string;
}

export interface ParseResult {
  root: Block | null;
  errors: ParseError[];
}

/** A data value to validate against a JSON Schema, and the block path it lives at. */
export interface SchemaInstance {
  /** Path of the value's block: [] normally, [documentIndex] in multi-document YAML. */
  prefix: BlockPath;
  value: unknown;
}

export interface FormatAdapter {
  readonly id: string;
  parse(text: string): ParseResult;
  /** Returns the text changes that apply the edit, or undefined if the edit is not supported. */
  applyEdit(text: string, edit: BlockEdit): TextChange[] | undefined;
  /** The data values JSON Schema validation applies to; absent for formats without JSON Schema support. */
  instances?(text: string): SchemaInstance[];
}
