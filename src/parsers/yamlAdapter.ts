import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { pathToId, type Block, type BlockPath, type ScalarValue } from '../model/block';
import type { FormatAdapter } from './types';

export const yamlAdapter: FormatAdapter = {
  id: 'yaml',

  parse(text) {
    // TODO: multi-document files (---); only the first document is shown for now.
    const doc = parseDocument(text);
    return {
      root: doc.contents ? toBlock(doc.contents, [], undefined) : null,
      errors: doc.errors.map((e) => ({ message: e.message, offset: e.pos[0] })),
    };
  },

  applyEdit(text, edit) {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
      return undefined;
    }
    if (edit.type === 'setValue') {
      // Mutate the existing scalar so its comments and quoting style survive.
      const node = doc.getIn(edit.path, true);
      if (isScalar(node)) {
        node.value = edit.value;
      } else {
        doc.setIn(edit.path, edit.value);
      }
      return [{ offset: 0, length: text.length, content: doc.toString() }];
    }
    return undefined;
  },
};

function toBlock(node: unknown, path: BlockPath, label: string | number | undefined): Block {
  const base = {
    id: pathToId(path),
    path,
    label,
    range:
      isNode(node) && node.range
        ? { offset: node.range[0], length: node.range[1] - node.range[0] }
        : undefined,
  };

  if (isMap(node)) {
    return {
      ...base,
      kind: 'object',
      children: node.items.map((pair) => {
        const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        return toBlock(pair.value, [...path, key], key);
      }),
    };
  }
  if (isSeq(node)) {
    return {
      ...base,
      kind: 'array',
      children: node.items.map((item, i) => toBlock(item, [...path, i], i)),
    };
  }
  if (isAlias(node)) {
    return { ...base, kind: 'scalar', value: `*${node.source}`, readOnly: true };
  }
  if (isScalar(node)) {
    return { ...base, kind: 'scalar', value: toScalarValue(node.value) };
  }
  // A key with no value, e.g. "key:"
  return { ...base, kind: 'scalar', value: null };
}

function toScalarValue(value: unknown): ScalarValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}
