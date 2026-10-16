import assert from 'node:assert/strict';
import { findBlock } from '../src/model/block';
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

test('block ranges cover key and value, without trailing comments', () => {
  const { root } = yamlAdapter.parse(source);
  const slice = (path: (string | number)[]) => {
    const block = findBlock(root, path)!;
    return source.slice(block.range!.offset, block.range!.offset + block.range!.length);
  };
  assert.equal(slice(['name']), 'name: demo');
  assert.equal(slice(['tags', 2]), 'c');
  assert.equal(slice(['nested']), 'nested:\n  x: 1\n');
  // A key with no value still selects the key.
  const empty = yamlAdapter.parse('a:\nb: 1\n').root?.children?.[0].range;
  assert.equal('a:\nb: 1\n'.slice(empty!.offset, empty!.offset + empty!.length), 'a:');
});

test('setValue can change a value type, re-quoting as needed', () => {
  assert.equal(edit(yamlAdapter, 'p: "8080"\nq: x\n', { type: 'setValue', path: ['p'], value: 8080 }), 'p: 8080\nq: x\n');
  assert.equal(edit(yamlAdapter, 'p: x\n', { type: 'setValue', path: ['p'], value: 'true' }), 'p: "true"\n');
  assert.deepEqual(parse(edit(yamlAdapter, source, { type: 'setValue', path: ['nested'], value: [] })).nested, []);
});

test('edits keep the flow collection style of the file', () => {
  const tight = 'a: [1, 2]\nb: 1\n';
  assert.equal(edit(yamlAdapter, tight, { type: 'setValue', path: ['b'], value: 2 }), 'a: [1, 2]\nb: 2\n');
  const padded = 'a: [ 1, 2 ]\nb: 1\n';
  assert.equal(edit(yamlAdapter, padded, { type: 'setValue', path: ['b'], value: 2 }), 'a: [ 1, 2 ]\nb: 2\n');
});

const multi = 'a: 1 # first\n---\nb: [1, 2]\n...\n---\n# lead\nc:\n  d: x\n';

test('multi-document files show one row per document', () => {
  const { root, errors } = yamlAdapter.parse(multi);
  assert.deepEqual(errors, []);
  assert.equal(root?.readOnly, true);
  assert.deepEqual(root?.children?.map((c) => c.caption), ['document 1', 'document 2', 'document 3']);
  assert.deepEqual(root?.children?.[2].children?.[0].children?.[0].path, [2, 'c', 'd']);
  const d = findBlock(root, [2, 'c', 'd'])!;
  assert.equal(multi.slice(d.range!.offset, d.range!.offset + d.range!.length), 'd: x');
});

test('multi-document edits rewrite only the edited document', () => {
  assert.equal(edit(yamlAdapter, multi, { type: 'setValue', path: [2, 'c', 'd'], value: 'y' }), multi.replace('d: x', 'd: y'));
  assert.equal(
    edit(yamlAdapter, multi, { type: 'insert', parentPath: [1, 'b'], value: 3 }),
    multi.replace('b: [1, 2]', 'b: [1, 2, 3]'),
  );
  assert.equal(edit(yamlAdapter, multi, { type: 'rename', path: [0, 'a'], newKey: 'z' }), multi.replace('a: 1', 'z: 1'));
});

test('documents themselves cannot be removed or moved', () => {
  assert.equal(yamlAdapter.applyEdit(multi, { type: 'remove', path: [1] }), undefined);
  assert.equal(yamlAdapter.applyEdit(multi, { type: 'move', path: [1], toIndex: 0 }), undefined);
});
