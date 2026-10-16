import { parseTOML, type AST } from 'toml-eslint-parser';
import { pathToId, type Block, type BlockPath, type ScalarValue } from '../model/block';
import type { BlockEdit, InsertValue } from '../model/messages';
import { detectEol, lineIndentAt, rotateSpans, type Span } from './textEdits';
import type { FormatAdapter, TextChange } from './types';

type KeyValue = AST.TOMLKeyValue;
type KeyPart = AST.TOMLBare | AST.TOMLQuoted;
type ValueNode = AST.TOMLValue | AST.TOMLArray | AST.TOMLInlineTable;
type Table = AST.TOMLTable | AST.TOMLTopLevelTable;

/**
 * Where a value comes from in the TOML source. The same object can be spread over dotted keys,
 * `[table]` headers and `[[array]]` elements, so edits look at how each node was defined.
 */
interface SourceNode {
  kind: 'object' | 'array' | 'scalar';
  path: BlockPath;
  label: string | number | undefined;
  value?: ScalarValue;
  children: Map<string | number, SourceNode>;
  range?: Span;
  /** `key = value` that defines the node (also inside inline tables). */
  keyValue?: KeyValue;
  /** Last key part of `keyValue` (or of the table header), for renames. */
  keyPart?: KeyPart;
  /** The value node: scalar, inline array or inline table. */
  valueNode?: ValueNode;
  /** `[table]` / `[[array]]` element, or the top-level table for the root. */
  table?: Table;
  /** Array of tables (`[[name]]`), whose elements are tables. */
  arrayOfTables?: boolean;
  /** Original TOML kind of a scalar (to keep dates unquoted). */
  scalarKind?: string;
}

export const tomlAdapter: FormatAdapter = {
  id: 'toml',

  parse(text) {
    try {
      const root = buildTree(text, parseTOML(text));
      return { root: toBlock(root), errors: [] };
    } catch (error) {
      return { root: null, errors: [{ message: errorMessage(error), offset: (error as { index?: number }).index }] };
    }
  },

  instances(text) {
    try {
      return [{ prefix: [], value: toPlain(buildTree(text, parseTOML(text))) }];
    } catch {
      return [];
    }
  },

  applyEdit(text, edit) {
    let root: SourceNode;
    try {
      root = buildTree(text, parseTOML(text));
    } catch {
      return undefined;
    }
    return applyTomlEdit(text, root, edit);
  },
};

// ---------- tree ----------

function newNode(kind: SourceNode['kind'], path: BlockPath, label: string | number | undefined): SourceNode {
  return { kind, path, label, children: new Map() };
}

function buildTree(text: string, program: AST.TOMLProgram): SourceNode {
  const topLevel = program.body[0];
  const root = newNode('object', [], undefined);
  root.table = topLevel;
  root.range = { start: 0, end: text.length };
  for (const item of topLevel.body) {
    if (item.type === 'TOMLKeyValue') {
      addKeyValue(text, root, item);
    } else {
      addTable(text, root, item);
    }
  }
  return root;
}

function child(parent: SourceNode, segment: string | number, kind: SourceNode['kind']): SourceNode {
  let node = parent.children.get(segment);
  if (!node) {
    node = newNode(kind, [...parent.path, segment], segment);
    parent.children.set(segment, node);
  }
  return node;
}

function keyName(part: KeyPart): string {
  return part.type === 'TOMLBare' ? part.name : part.value;
}

function addKeyValue(text: string, container: SourceNode, keyValue: KeyValue): void {
  const parts = keyValue.key.keys;
  let parent = container;
  for (const part of parts.slice(0, -1)) {
    parent = child(parent, keyName(part), 'object');
  }
  const last = parts[parts.length - 1];
  const node = addValue(text, parent, keyName(last), keyValue.value);
  node.keyValue = keyValue;
  node.keyPart = last;
  node.range = { start: keyValue.range[0], end: keyValue.range[1] };
}

function addValue(text: string, parent: SourceNode, segment: string | number, value: ValueNode): SourceNode {
  if (value.type === 'TOMLArray') {
    const node = child(parent, segment, 'array');
    node.valueNode = value;
    value.elements.forEach((element, i) => {
      const item = addValue(text, node, i, element);
      item.range = { start: element.range[0], end: element.range[1] };
    });
    return node;
  }
  if (value.type === 'TOMLInlineTable') {
    const node = child(parent, segment, 'object');
    node.valueNode = value;
    value.body.forEach((keyValue) => addKeyValue(text, node, keyValue));
    return node;
  }
  const node = child(parent, segment, 'scalar');
  node.valueNode = value;
  node.scalarKind = value.kind;
  node.value = scalarValue(text, value);
  return node;
}

function addTable(text: string, root: SourceNode, table: AST.TOMLTable): void {
  const path = table.resolvedKey;
  let parent = root;
  for (const [i, segment] of path.slice(0, -1).entries()) {
    // An index right after a key means that key is an array of tables.
    const nextIsIndex = typeof path[i + 1] === 'number';
    parent = child(parent, segment, nextIsIndex ? 'array' : 'object');
    if (nextIsIndex) {
      parent.arrayOfTables = true;
    }
  }
  const node = child(parent, path[path.length - 1], 'object');
  node.table = table;
  node.keyPart = table.key.keys[table.key.keys.length - 1];
  node.range = { start: table.range[0], end: table.range[1] };
  for (const keyValue of table.body) {
    addKeyValue(text, node, keyValue);
  }
}

function scalarValue(text: string, value: AST.TOMLValue): ScalarValue {
  switch (value.kind) {
    case 'string':
    case 'boolean':
      return value.value;
    case 'integer':
    case 'float':
      return Number(value.value);
    default:
      // Dates and times: shown (and edited) as written.
      return text.slice(value.range[0], value.range[1]);
  }
}

function toBlock(node: SourceNode): Block {
  const base = {
    id: pathToId(node.path),
    path: node.path,
    label: node.label,
    range: node.range ? { offset: node.range.start, length: node.range.end - node.range.start } : undefined,
  };
  if (node.kind === 'scalar') {
    return { ...base, kind: 'scalar', value: node.value ?? null };
  }
  return { ...base, kind: node.kind, children: [...node.children.values()].map(toBlock) };
}

function find(root: SourceNode, path: BlockPath): SourceNode | undefined {
  let node: SourceNode | undefined = root;
  for (const segment of path) {
    node = node?.children.get(segment);
  }
  return node;
}

// ---------- edits ----------

function applyTomlEdit(text: string, root: SourceNode, edit: BlockEdit): TextChange[] | undefined {
  switch (edit.type) {
    case 'setValue': {
      const node = find(root, edit.path);
      const literal = node?.valueNode && toLiteral(edit.value, node.scalarKind);
      return node?.valueNode && literal !== undefined ? [replace(node.valueNode.range[0], node.valueNode.range[1], literal)] : undefined;
    }

    case 'rename': {
      const node = find(root, edit.path);
      const parent = find(root, edit.path.slice(0, -1));
      if (!node?.keyPart || !parent || parent.children.has(edit.newKey) || typeof node.label !== 'string') {
        return undefined;
      }
      // A table header can't be renamed alone if sub-tables ([a.b]) repeat its name.
      if (node.table && [...node.children.values()].some((c) => c.table)) {
        return undefined;
      }
      return [replace(node.keyPart.range[0], node.keyPart.range[1], keyLiteral(edit.newKey))];
    }

    case 'remove': {
      const node = find(root, edit.path);
      const parent = find(root, edit.path.slice(0, -1));
      if (!node || !parent || edit.path.length === 0) {
        return undefined;
      }
      if (parent.valueNode?.type === 'TOMLArray' || parent.valueNode?.type === 'TOMLInlineTable') {
        return removeFromInline(text, siblingSpans(parent), [...parent.children.values()].indexOf(node), parent.valueNode.range);
      }
      if (node.keyValue || node.table) {
        return [removeLines(text, node.range!)];
      }
      return undefined;
    }

    case 'insert': {
      const parent = find(root, edit.parentPath);
      if (!parent) {
        return undefined;
      }
      if (parent.valueNode?.type === 'TOMLArray') {
        const literal = toLiteral(edit.value);
        return literal === undefined ? undefined : [appendInline(text, siblingSpans(parent), parent.valueNode.range, literal)];
      }
      if (edit.key === undefined || parent.children.has(edit.key)) {
        return undefined;
      }
      const literal = toLiteral(edit.value);
      if (literal === undefined) {
        return undefined;
      }
      const entry = `${keyLiteral(edit.key)} = ${literal}`;
      if (parent.valueNode?.type === 'TOMLInlineTable') {
        return [appendInline(text, siblingSpans(parent), parent.valueNode.range, entry)];
      }
      if (parent.table) {
        return [appendToTable(text, parent.table, entry)];
      }
      return undefined;
    }

    case 'move': {
      const node = find(root, edit.path);
      const parent = find(root, edit.path.slice(0, -1));
      if (!node || !parent) {
        return undefined;
      }
      const siblings = [...parent.children.values()];
      // Only reorder siblings that live in one place: an inline array/table, or one table's key/values.
      const sameContainer =
        parent.valueNode !== undefined ||
        siblings.every((sibling) => sibling.keyValue && sibling.keyValue.parent === node.keyValue?.parent);
      return sameContainer ? rotateSpans(text, siblingSpans(parent), siblings.indexOf(node), edit.toIndex) : undefined;
    }
  }
}

function siblingSpans(parent: SourceNode): Span[] {
  return [...parent.children.values()].map((node) => node.range!);
}

/** Removes one item of `[...]` or `{...}` with its separator, keeping the layout. */
function removeFromInline(text: string, spans: Span[], index: number, container: [number, number]): TextChange[] | undefined {
  if (index < 0) {
    return undefined;
  }
  if (spans.length === 1) {
    return [replace(container[0] + 1, container[1] - 1, text[container[0]] === '{' ? ' ' : '')];
  }
  if (index < spans.length - 1) {
    return [replace(spans[index].start, spans[index + 1].start, '')];
  }
  return [replace(spans[index - 1].end, spans[index].end, '')];
}

/** Appends an item to `[...]` or `{...}`, reusing the separator between existing items. */
function appendInline(text: string, spans: Span[], container: [number, number], item: string): TextChange {
  const last = spans[spans.length - 1];
  if (!last) {
    const inner = text[container[0]] === '{' ? ` ${item} ` : item;
    return replace(container[0] + 1, container[1] - 1, inner);
  }
  const separator = spans.length >= 2 ? text.slice(spans[spans.length - 2].end, spans[spans.length - 1].start) : ', ';
  return insertAt(last.end, separator + item);
}

/** Adds `key = value` on its own line after the table's last key/value (or its header). */
function appendToTable(text: string, table: Table, entry: string): TextChange {
  const eol = detectEol(text);
  const last = table.body.filter((item): item is KeyValue => item.type === 'TOMLKeyValue').at(-1);
  if (last) {
    return insertAt(lineEnd(text, last.range[1]), `${eol}${lineIndentAt(text, last.range[0])}${entry}`);
  }
  if (table.type === 'TOMLTable') {
    return insertAt(lineEnd(text, table.key.range[1]), `${eol}${entry}`);
  }
  // Root without key/values: before the first table header.
  const firstTable = table.body.find((item) => item.type === 'TOMLTable');
  return firstTable ? insertAt(firstTable.range[0], `${entry}${eol}${eol}`) : insertAt(text.length, `${text.length > 0 && !text.endsWith('\n') ? eol : ''}${entry}${eol}`);
}

/** End of the line containing `offset`, after any trailing comment. */
function lineEnd(text: string, offset: number): number {
  const newline = text.indexOf('\n', offset);
  const end = newline === -1 ? text.length : newline;
  return text[end - 1] === '\r' ? end - 1 : end;
}

/** Removes a span; if its lines hold nothing else but whitespace or a trailing comment, removes them whole. */
function removeLines(text: string, span: Span): TextChange {
  const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
  const end = lineEnd(text, span.end);
  const before = text.slice(lineStart, span.start);
  const after = text.slice(span.end, end);
  if (/^[ \t]*$/.test(before) && /^[ \t]*(#.*)?$/.test(after)) {
    const next = text.indexOf('\n', end);
    return replace(lineStart, next === -1 ? text.length : next + 1, '');
  }
  return replace(span.start, span.end, '');
}

function toLiteral(value: InsertValue, scalarKind?: string): string | undefined {
  if (value === null) {
    // TOML has no null.
    return undefined;
  }
  if (Array.isArray(value)) {
    return '[]';
  }
  if (typeof value === 'object') {
    return '{}';
  }
  if (typeof value === 'string') {
    // Dates and times stay unquoted while the text still looks like one.
    if (scalarKind && /date|time/i.test(scalarKind) && /^\d/.test(value)) {
      return value;
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return 'nan';
    }
    return Number.isFinite(value) ? String(value) : value > 0 ? 'inf' : '-inf';
  }
  return String(value);
}

function keyLiteral(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function replace(start: number, end: number, content: string): TextChange {
  return { offset: start, length: end - start, content };
}

function insertAt(offset: number, content: string): TextChange {
  return { offset, length: 0, content };
}

/** The data as plain JSON for schema validation; dates and times keep their written form (local dates have no time zone). */
function toPlain(node: SourceNode): unknown {
  if (node.kind === 'scalar') {
    return node.value;
  }
  const children = [...node.children.values()];
  return node.kind === 'array' ? children.map(toPlain) : Object.fromEntries(children.map((c) => [c.label, toPlain(c)]));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
