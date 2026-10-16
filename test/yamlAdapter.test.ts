import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { yamlAdapter } from '../src/parsers/yamlAdapter';
import { edit } from './helpers';

const source = `# header comment
name: demo # trailing comment
count: 1
1: numeric key
tags:
  - a
  - b
  - c
nested:
  x: 1
`;

test('parses into blocks', () => {
  const { root, errors } = yamlAdapter.parse(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(root?.children?.map((c) => c.label), ['name', 'count', '1', 'tags', 'nested']);
});

test('setValue keeps comments', () => {
  const result = edit(yamlAdapter, source, { type: 'setValue', path: ['name'], value: 'renamed' });
  assert.equal(result, source.replace('name: demo', 'name: renamed'));
});

test('setValue works on numeric keys', () => {
  const result = edit(yamlAdapter, source, { type: 'setValue', path: ['1'], value: 'changed' });
  assert.equal(parse(result)[1], 'changed');
});

test('remove deletes a sequence item', () => {
  const result = edit(yamlAdapter, source, { type: 'remove', path: ['tags', 1] });
  assert.deepEqual(parse(result).tags, ['a', 'c']);
});

test('rename keeps the value and comment', () => {
  const result = edit(yamlAdapter, source, { type: 'rename', path: ['name'], newKey: 'title' });
  assert.equal(result, source.replace('name: demo', 'title: demo'));
});

test('rename rejects duplicate keys', () => {
  assert.equal(yamlAdapter.applyEdit(source, { type: 'rename', path: ['name'], newKey: 'count' }), undefined);
});

test('insert appends in block style', () => {
  const withItem = edit(yamlAdapter, source, { type: 'insert', parentPath: ['tags'], value: 'd' });
  assert.deepEqual(parse(withItem).tags, ['a', 'b', 'c', 'd']);

  const withMap = edit(yamlAdapter, source, { type: 'insert', parentPath: [], key: 'extra', value: {} });
  const withChild = edit(yamlAdapter, withMap, { type: 'insert', parentPath: ['extra'], key: 'k', value: 'v' });
  assert.ok(withChild.endsWith('extra:\n  k: v\n'), withChild);
});

test('move reorders sequence items and map entries', () => {
  const items = edit(yamlAdapter, source, { type: 'move', path: ['tags', 2], toIndex: 0 });
  assert.deepEqual(parse(items).tags, ['c', 'a', 'b']);

  const entries = edit(yamlAdapter, source, { type: 'move', path: ['name'], toIndex: 4 });
  assert.deepEqual(Object.keys(parse(entries)), ['1', 'count', 'tags', 'nested', 'name']);
  assert.ok(entries.includes('name: demo # trailing comment'), entries);
});
