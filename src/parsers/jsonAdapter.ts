import { modify, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { pathToId, type Block, type BlockPath } from '../model/block';
import type { FormatAdapter } from './types';

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
    if (edit.type === 'setValue') {
      // TODO: detect indentation from the document instead of assuming 2 spaces.
      return modify(text, edit.path, edit.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
    }
    return undefined;
  },
};

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
