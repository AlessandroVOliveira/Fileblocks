import {
  findNodeAtLocation,
  modify,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { pathToId, type Block, type BlockPath } from '../model/block';
import type { BlockEdit } from '../model/messages';
import type { FormatAdapter, TextChange } from './types';

export const jsonAdapter: FormatAdapter = {
  id: 'json',

  parse(text) {
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, { allowTrailingComma: true });
    return {
      root: tree ? toBlock(tree, [], undefined) : null,
      errors: errors.map((e) => ({ message: printParseErrorCode(e.error), offset: e.offset })),
    };
  },

  applyEdit(text, edit) {
    const tree = parseTree(text, [], { allowTrailingComma: true });
    if (!tree) {
      return undefined;
    }
    return applyJsonEdit(text, tree, edit, detectFormatting(text));
  },
};

function applyJsonEdit(text: string, tree: Node, edit: BlockEdit, formattingOptions: FormattingOptions): TextChange[] | undefined {
  switch (edit.type) {
    case 'setValue':
      return modify(text, edit.path, edit.value, { formattingOptions });

    case 'remove':
      return removeNode(tree, edit.path);

    case 'rename': {
      const keyNode = findPropertyKey(tree, edit.path);
      const parent = findNodeAtLocation(tree, edit.path.slice(0, -1));
      if (!keyNode || !parent || objectKeys(parent).includes(edit.newKey)) {
        return undefined;
      }
      return [{ offset: keyNode.offset, length: keyNode.length, content: JSON.stringify(edit.newKey) }];
    }

    case 'insert': {
      const parent = findNodeAtLocation(tree, edit.parentPath);
      if (parent?.type === 'array') {
        return appendEntry(text, parent, JSON.stringify(edit.value), formattingOptions);
      }
      if (parent?.type === 'object' && edit.key !== undefined && !objectKeys(parent).includes(edit.key)) {
        return appendEntry(text, parent, `${JSON.stringify(edit.key)}: ${JSON.stringify(edit.value)}`, formattingOptions);
      }
      return undefined;
    }

    case 'move':
      return moveNode(text, tree, edit.path, edit.toIndex);
  }
}

// jsonc-parser's modify() reformats the whole container on insert/remove (an inline array
// becomes multi-line), so structural edits are done on the text directly, copying the
// separators the container already uses.

/** Array items are the value nodes; object entries are the property nodes (key + value). */
function entryOf(parent: Node, node: Node): Node {
  return parent.type === 'object' ? node.parent! : node;
}

function endOf(node: Node): number {
  return node.offset + node.length;
}

function removeNode(tree: Node, path: BlockPath): TextChange[] | undefined {
  const node = findNodeAtLocation(tree, path);
  const parent = findNodeAtLocation(tree, path.slice(0, -1));
  if (!node || !parent || path.length === 0) {
    return undefined;
  }
  const siblings = parent.children ?? [];
  const entry = entryOf(parent, node);
  const index = siblings.indexOf(entry);
  if (index < 0) {
    return undefined;
  }
  if (siblings.length === 1) {
    // Only child: empty the container entirely, e.g. `[\n  "a"\n]` -> `[]`.
    return [{ offset: parent.offset + 1, length: parent.length - 2, content: '' }];
  }
  if (index < siblings.length - 1) {
    // Remove the entry and the separator after it.
    return [{ offset: entry.offset, length: siblings[index + 1].offset - entry.offset, content: '' }];
  }
  // Last entry: remove the separator before it.
  const previousEnd = endOf(siblings[index - 1]);
  return [{ offset: previousEnd, length: endOf(entry) - previousEnd, content: '' }];
}

function appendEntry(text: string, parent: Node, entry: string, formatting: FormattingOptions): TextChange[] {
  const siblings = parent.children ?? [];
  const last = siblings[siblings.length - 1];
  const eol = formatting.eol ?? '\n';

  if (siblings.length >= 2) {
    // Reuse the separator between the last two entries.
    const separator = text.slice(endOf(siblings[siblings.length - 2]), last.offset);
    return [{ offset: endOf(last), length: 0, content: separator + entry }];
  }
  if (last) {
    // One entry: multi-line if it sits on its own line, inline otherwise.
    const leading = text.slice(parent.offset + 1, last.offset);
    const lineBreak = leading.lastIndexOf('\n');
    const separator = lineBreak >= 0 ? `,${eol}${leading.slice(lineBreak + 1)}` : ', ';
    return [{ offset: endOf(last), length: 0, content: separator + entry }];
  }
  // Empty container: open it up on its own lines.
  const indent = lineIndentAt(text, parent.offset);
  const unit = formatting.insertSpaces ? ' '.repeat(formatting.tabSize ?? 2) : '\t';
  return [{ offset: parent.offset + 1, length: parent.length - 2, content: `${eol}${indent}${unit}${entry}${eol}${indent}` }];
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/**
 * Moves by rotating the source text of the siblings between the old and new position.
 * Separators (commas, whitespace, line breaks) stay where they are, so the layout of the
 * container is untouched: an inline array stays inline, a multi-line object stays multi-line.
 */
function moveNode(text: string, tree: Node, path: BlockPath, toIndex: number): TextChange[] | undefined {
  const node = findNodeAtLocation(tree, path);
  const parent = findNodeAtLocation(tree, path.slice(0, -1));
  if (!node || !parent || path.length === 0) {
    return undefined;
  }
  const siblings = parent.children ?? [];
  const from = siblings.indexOf(entryOf(parent, node));
  if (from < 0 || toIndex < 0 || toIndex >= siblings.length) {
    return undefined;
  }
  if (from === toIndex) {
    return [];
  }

  const order = siblings.map((_, i) => i);
  order.splice(toIndex, 0, ...order.splice(from, 1));
  const low = Math.min(from, toIndex);
  const high = Math.max(from, toIndex);
  const sourceOf = (n: Node) => text.slice(n.offset, n.offset + n.length);

  let content = '';
  for (let i = low; i <= high; i++) {
    content += sourceOf(siblings[order[i]]);
    if (i < high) {
      content += text.slice(siblings[i].offset + siblings[i].length, siblings[i + 1].offset);
    }
  }
  const startOffset = siblings[low].offset;
  const endOffset = siblings[high].offset + siblings[high].length;
  return [{ offset: startOffset, length: endOffset - startOffset, content }];
}

function findPropertyKey(tree: Node, path: BlockPath): Node | undefined {
  const valueNode = findNodeAtLocation(tree, path);
  const property = valueNode?.parent;
  return property?.type === 'property' ? property.children?.[0] : undefined;
}

function objectKeys(node: Node): string[] {
  return (node.children ?? []).flatMap((property) => {
    const key = property.children?.[0];
    return key ? [String(key.value)] : [];
  });
}

/** Infers indentation from the first indented line; falls back to 2 spaces. */
function detectFormatting(text: string): FormattingOptions {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (indent?.startsWith('\t')) {
    return { insertSpaces: false, tabSize: 1, eol };
  }
  return { insertSpaces: true, tabSize: indent?.length ?? 2, eol };
}

function toBlock(node: Node, path: BlockPath, label: string | number | undefined): Block {
  const base = {
    id: pathToId(path),
    path,
    label,
    range: { offset: node.offset, length: node.length },
  };

  switch (node.type) {
    case 'object':
      return {
        ...base,
        kind: 'object',
        children: (node.children ?? []).flatMap((property) => {
          const [keyNode, valueNode] = property.children ?? [];
          if (!keyNode || !valueNode) {
            return [];
          }
          const key = String(keyNode.value);
          return [toBlock(valueNode, [...path, key], key)];
        }),
      };
    case 'array':
      return {
        ...base,
        kind: 'array',
        children: (node.children ?? []).map((child, i) => toBlock(child, [...path, i], i)),
      };
    default:
      return { ...base, kind: 'scalar', value: node.value ?? null };
  }
}
