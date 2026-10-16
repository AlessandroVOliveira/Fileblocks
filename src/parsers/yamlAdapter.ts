import {
  isAlias,
  isCollection,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { pathToId, type Block, type BlockPath, type ScalarValue } from '../model/block';
import type { BlockEdit } from '../model/messages';
import { diffText } from './textDiff';
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
    if (doc.errors.length > 0 || !applyYamlEdit(doc, edit)) {
      return undefined;
    }
    return diffText(text, doc.toString());
  },
};

/** Mutates the document in place, reusing existing nodes so comments, anchors and quoting survive. */
function applyYamlEdit(doc: Document, edit: BlockEdit): boolean {
  switch (edit.type) {
    case 'setValue': {
      if (edit.path.length === 0) {
        if (!isScalar(doc.contents)) {
          return false;
        }
        doc.contents.value = edit.value;
        return true;
      }
      const slot = locate(doc, edit.path);
      if (!slot) {
        return false;
      }
      const current = slotValue(slot);
      if (isScalar(current)) {
        current.value = edit.value;
      } else {
        setSlotValue(slot, doc.createNode(edit.value));
      }
      return true;
    }

    case 'remove': {
      const slot = locate(doc, edit.path);
      if (!slot) {
        return false;
      }
      slot.parent.items.splice(slot.index, 1);
      return true;
    }

    case 'rename': {
      const slot = locate(doc, edit.path);
      if (!slot || !isMap(slot.parent) || mapKeys(slot.parent).includes(edit.newKey)) {
        return false;
      }
      const pair = slot.parent.items[slot.index];
      if (isScalar(pair.key)) {
        pair.key.value = edit.newKey;
      } else {
        pair.key = doc.createNode(edit.newKey);
      }
      return true;
    }

    case 'insert': {
      const parent = edit.parentPath.length === 0 ? doc.contents : slotValueAt(doc, edit.parentPath);
      if (isCollection(parent) && parent.items.length === 0) {
        // An empty collection is written as `{}`/`[]` and parses back as flow style;
        // switch to block style so the first child goes on its own line.
        parent.flow = false;
      }
      if (isSeq(parent)) {
        parent.items.push(doc.createNode(edit.value));
        return true;
      }
      if (isMap(parent) && edit.key !== undefined && !mapKeys(parent).includes(edit.key)) {
        parent.items.push(doc.createPair(edit.key, doc.createNode(edit.value)));
        return true;
      }
      return false;
    }

    case 'move': {
      const slot = locate(doc, edit.path);
      const items: unknown[] | undefined = slot?.parent.items;
      if (!slot || !items || edit.toIndex < 0 || edit.toIndex >= items.length) {
        return false;
      }
      const [item] = items.splice(slot.index, 1);
      items.splice(edit.toIndex, 0, item);
      return true;
    }
  }
}

/** Position of a path's last segment inside its parent collection. */
interface Slot {
  parent: YAMLMap<unknown, unknown> | YAMLSeq<unknown>;
  index: number;
}

function locate(doc: Document, path: BlockPath): Slot | undefined {
  if (path.length === 0) {
    return undefined;
  }
  const parent = path.length === 1 ? doc.contents : slotValueAt(doc, path.slice(0, -1));
  const segment = path[path.length - 1];
  if (isMap(parent)) {
    const index = parent.items.findIndex((pair) => keyToString(pair.key) === String(segment));
    return index >= 0 ? { parent, index } : undefined;
  }
  if (isSeq(parent) && typeof segment === 'number' && segment >= 0 && segment < parent.items.length) {
    return { parent, index: segment };
  }
  return undefined;
}

function slotValueAt(doc: Document, path: BlockPath): unknown {
  const slot = locate(doc, path);
  return slot ? slotValue(slot) : undefined;
}

function slotValue(slot: Slot): unknown {
  const item = slot.parent.items[slot.index];
  return isPair(item) ? item.value : item;
}

function setSlotValue(slot: Slot, value: unknown): void {
  const item = slot.parent.items[slot.index];
  if (isPair(item)) {
    (item as Pair<unknown, unknown>).value = value;
  } else {
    slot.parent.items[slot.index] = value;
  }
}

function mapKeys(map: YAMLMap<unknown, unknown>): string[] {
  return map.items.map((pair) => keyToString(pair.key));
}

function keyToString(key: unknown): string {
  return isScalar(key) ? String(key.value) : String(key);
}

/** `range` overrides the node's own range; map entries pass one covering key and value. */
function toBlock(node: unknown, path: BlockPath, label: string | number | undefined, range = sourceRange(node, node)): Block {
  const base = { id: pathToId(path), path, label, range };

  if (isMap(node)) {
    return {
      ...base,
      kind: 'object',
      children: node.items.map((pair) => {
        const key = keyToString(pair.key);
        return toBlock(pair.value, [...path, key], key, sourceRange(pair.key, pair.value));
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

/**
 * Span from the start of `first` to the end of `last`'s value, excluding trailing comments
 * (yaml's range is [start, valueEnd, nodeEnd]). Falls back to whichever node has a range.
 */
function sourceRange(first: unknown, last: unknown): Block['range'] {
  const start = isNode(first) && first.range ? first.range : isNode(last) ? last.range : undefined;
  const end = isNode(last) && last.range ? last.range : start;
  return start && end ? { offset: start[0], length: end[1] - start[0] } : undefined;
}

function toScalarValue(value: unknown): ScalarValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}
