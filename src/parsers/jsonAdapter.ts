import {
  applyEdits,
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
import { diffText } from './textDiff';
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
      if (edit.path.length === 0 || !findNodeAtLocation(tree, edit.path)) {
        return undefined;
      }
      return modify(text, edit.path, undefined, { formattingOptions });

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
        const index = parent.children?.length ?? 0;
        return modify(text, [...edit.parentPath, index], edit.value, { formattingOptions, isArrayInsertion: true });
      }
      if (parent?.type === 'object' && edit.key !== undefined && !objectKeys(parent).includes(edit.key)) {
        return modify(text, [...edit.parentPath, edit.key], edit.value, { formattingOptions });
      }
      return undefined;
    }

    case 'move':
      return moveNode(text, tree, edit.path, edit.toIndex, formattingOptions);
  }
}

/**
 * jsonc-parser has no move operation, so: remove the node, insert a placeholder at the
 * target index, then swap the placeholder for the node's original source text. This keeps
 * the moved value's inner formatting and comments intact.
 */
function moveNode(text: string, tree: Node, path: BlockPath, toIndex: number, formattingOptions: FormattingOptions): TextChange[] | undefined {
  const node = findNodeAtLocation(tree, path);
  const parent = findNodeAtLocation(tree, path.slice(0, -1));
  const siblingCount = parent?.children?.length ?? 0;
  if (!node || !parent || path.length === 0 || toIndex < 0 || toIndex >= siblingCount) {
    return undefined;
  }

  const source = text.slice(node.offset, node.offset + node.length);
  const placeholder = `__fileblocks_move_${Date.now()}__`;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1];

  const removed = applyEdits(text, modify(text, path, undefined, { formattingOptions }));
  const inserted =
    parent.type === 'array'
      ? applyEdits(removed, modify(removed, [...parentPath, toIndex], placeholder, { formattingOptions, isArrayInsertion: true }))
      : applyEdits(removed, modify(removed, [...parentPath, last], placeholder, { formattingOptions, getInsertionIndex: () => toIndex }));

  return diffText(text, inserted.replace(JSON.stringify(placeholder), () => source));
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
