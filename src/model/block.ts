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
  /**
   * Source span to reveal, as offsets into the document text: the whole entry (key and value)
   * for object members, the value itself otherwise.
   */
  range?: { offset: number; length: number };
  /** True when the block cannot be edited visually (e.g. YAML aliases, the list of YAML documents). */
  readOnly?: boolean;
  /** Display name overriding the label (e.g. "document 1" in multi-document YAML). */
  caption?: string;
}

export function pathToId(path: BlockPath): string {
  return JSON.stringify(path);
}

/** Deepest block whose source range contains the offset (range ends are inclusive, so a cursor right after a value still counts). */
export function findBlockAt(root: Block | null, offset: number): Block | undefined {
  const contains = (block: Block) =>
    block.range !== undefined && offset >= block.range.offset && offset <= block.range.offset + block.range.length;
  if (!root || !contains(root)) {
    return undefined;
  }
  let current = root;
  for (let next = current.children?.find(contains); next; next = next.children?.find(contains)) {
    current = next;
  }
  return current;
}

export function findBlock(root: Block | null, path: BlockPath): Block | undefined {
  let current: Block | undefined = root ?? undefined;
  for (const segment of path) {
    current = current?.children?.find((child) => child.label === segment);
  }
  return current;
}
