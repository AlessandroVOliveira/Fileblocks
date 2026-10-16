/**
 * Format-agnostic block model. Every adapter (JSON, YAML, XML, HTML) converts its
 * syntax tree into this shape, and the webview only knows how to render blocks.
 */

export type BlockPath = (string | number)[];
export type ScalarValue = string | number | boolean | null;
export type BlockKind = 'object' | 'array' | 'scalar' | 'element' | 'text';

export interface Block {
  /** Stable id derived from the path, used to keep UI state (e.g. collapsed) across re-renders. */
  id: string;
  kind: BlockKind;
  /** Key in the parent object, index in the parent array, or tag name for elements. */
  label?: string | number;
  path: BlockPath;
  value?: ScalarValue;
  /** Attributes of XML/HTML elements. */
  attributes?: Record<string, string>;
  children?: Block[];
  /** Source range of the block, as offsets into the document text. */
  range?: { offset: number; length: number };
  /** True when the block cannot be edited visually (e.g. YAML aliases). */
  readOnly?: boolean;
}

export function pathToId(path: BlockPath): string {
  return JSON.stringify(path);
}
