import assert from 'node:assert/strict';
import { findBlock } from '../src/model/block';
import { test } from 'node:test';
import { jsonAdapter } from '../src/parsers/jsonAdapter';
import { edit } from './helpers';

const source = `{
  // comment survives
  "name": "demo",
  "count": 1,
  "tags": ["a", "b", "c"],
  "nested": {
    "x": 1,
    "y": [1, 2]
  }
}
`;

test('parses into blocks', () => {
  const { root, errors } = jsonAdapter.parse(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(root?.children?.map((c) => c.label), ['name', 'count', 'tags', 'nested']);
  assert.deepEqual(root?.children?.[2].children?.map((c) => c.value), ['a', 'b', 'c']);
});

test('setValue keeps comments and formatting', () => {
  const result = edit(jsonAdapter, source, { type: 'setValue', path: ['count'], value: 42 });
  assert.equal(result, source.replace('"count": 1', '"count": 42'));
});

test('remove deletes an entry', () => {
  const result = edit(jsonAdapter, source, { type: 'remove', path: ['tags', 1] });
  assert.deepEqual(JSON.parse(stripComment(result)).tags, ['a', 'c']);
});

test('rename changes only the key', () => {
  const result = edit(jsonAdapter, source, { type: 'rename', path: ['name'], newKey: 'title' });
  assert.equal(result, source.replace('"name"', '"title"'));
});

test('rename rejects duplicate keys', () => {
  assert.equal(jsonAdapter.applyEdit(source, { type: 'rename', path: ['name'], newKey: 'count' }), undefined);
});

test('insert appends to arrays and objects', () => {
  const withItem = edit(jsonAdapter, source, { type: 'insert', parentPath: ['tags'], value: 'd' });
  assert.deepEqual(JSON.parse(stripComment(withItem)).tags, ['a', 'b', 'c', 'd']);

  const withKey = edit(jsonAdapter, source, { type: 'insert', parentPath: ['nested'], key: 'z', value: {} });
  assert.deepEqual(JSON.parse(stripComment(withKey)).nested, { x: 1, y: [1, 2], z: {} });
});

test('move reorders array items', () => {
  const result = edit(jsonAdapter, source, { type: 'move', path: ['tags', 0], toIndex: 2 });
  assert.deepEqual(JSON.parse(stripComment(result)).tags, ['b', 'c', 'a']);
});

test('move reorders object entries and keeps the value source', () => {
  const result = edit(jsonAdapter, source, { type: 'move', path: ['nested'], toIndex: 0 });
  const parsed = JSON.parse(stripComment(result));
  assert.deepEqual(Object.keys(parsed), ['nested', 'name', 'count', 'tags']);
  assert.ok(result.includes('"nested": {\n    "x": 1,\n    "y": [1, 2]\n  }'), result);
  assert.ok(result.includes('// comment survives'));
});

test('move keeps an inline array inline', () => {
  const result = edit(jsonAdapter, source, { type: 'move', path: ['tags', 0], toIndex: 1 });
  assert.equal(result, source.replace('["a", "b", "c"]', '["b", "a", "c"]'));
});

test('move swaps whole entries and leaves separators in place', () => {
  const result = edit(jsonAdapter, source, { type: 'move', path: ['count'], toIndex: 0 });
  assert.equal(result, source.replace('"name": "demo",\n  "count": 1,', '"count": 1,\n  "name": "demo",'));
});

test('move rejects out-of-range targets', () => {
  assert.equal(jsonAdapter.applyEdit(source, { type: 'move', path: ['tags', 0], toIndex: 3 }), undefined);
});

function stripComment(text: string): string {
  return text.replace(/^\s*\/\/.*$/m, '');
}

const compact = '{\n  "tags": ["a", "b", "c"],\n  "obj": { "x": 1 },\n  "empty": {}\n}\n';

test('insert and remove keep inline containers inline', () => {
  assert.equal(
    edit(jsonAdapter, compact, { type: 'insert', parentPath: ['tags'], value: 'd' }),
    compact.replace('["a", "b", "c"]', '["a", "b", "c", "d"]'),
  );
  assert.equal(
    edit(jsonAdapter, compact, { type: 'insert', parentPath: ['obj'], key: 'y', value: 2 }),
    compact.replace('{ "x": 1 }', '{ "x": 1, "y": 2 }'),
  );
  assert.equal(edit(jsonAdapter, compact, { type: 'remove', path: ['tags', 1] }), compact.replace('["a", "b", "c"]', '["a", "c"]'));
  assert.equal(edit(jsonAdapter, compact, { type: 'remove', path: ['tags', 2] }), compact.replace('["a", "b", "c"]', '["a", "b"]'));
  assert.equal(edit(jsonAdapter, compact, { type: 'remove', path: ['obj', 'x'] }), compact.replace('{ "x": 1 }', '{}'));
});

test('insert follows multi-line layout and opens empty containers', () => {
  assert.equal(
    edit(jsonAdapter, compact, { type: 'insert', parentPath: [], key: 'new', value: null }),
    compact.replace('"empty": {}\n', '"empty": {},\n  "new": null\n'),
  );
  assert.equal(
    edit(jsonAdapter, compact, { type: 'insert', parentPath: ['empty'], key: 'k', value: 'v' }),
    compact.replace('"empty": {}', '"empty": {\n    "k": "v"\n  }'),
  );
});

test('block ranges cover whole entries for object members and values for array items', () => {
  const { root } = jsonAdapter.parse(compact);
  const slice = (path: (string | number)[]) => {
    const block = findBlock(root, path)!;
    return compact.slice(block.range!.offset, block.range!.offset + block.range!.length);
  };
  assert.equal(slice(['tags']), '"tags": ["a", "b", "c"]');
  assert.equal(slice(['tags', 1]), '"b"');
  assert.equal(slice(['obj', 'x']), '"x": 1');
});

test('setValue can change a value type', () => {
  assert.equal(edit(jsonAdapter, compact, { type: 'setValue', path: ['obj', 'x'], value: '1' }), compact.replace('"x": 1', '"x": "1"'));
  assert.equal(edit(jsonAdapter, compact, { type: 'setValue', path: ['tags'], value: {} }), compact.replace('["a", "b", "c"]', '{}'));
});
