import assert from 'node:assert/strict';
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

test('move rejects out-of-range targets', () => {
  assert.equal(jsonAdapter.applyEdit(source, { type: 'move', path: ['tags', 0], toIndex: 3 }), undefined);
});

function stripComment(text: string): string {
  return text.replace(/^\s*\/\/.*$/m, '');
}
