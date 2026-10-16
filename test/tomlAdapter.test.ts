import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBlock } from '../src/model/block';
import { tomlAdapter } from '../src/parsers/tomlAdapter';
import { edit } from './helpers';

const source = `# Sample
title = "demo" # trailing
owner.name = "Jane"
released = 2026-10-16

[server]
host = "localhost"
ports = [80, 443]
inline = { x = 1, y = 2 }

[[products]]
name = "A"

[[products]]
name = "B"
`;

test('parses tables, dotted keys, inline values and arrays of tables into blocks', () => {
  const { root, errors } = tomlAdapter.parse(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(root?.children?.map((c) => c.label), ['title', 'owner', 'released', 'server', 'products']);
  assert.equal(findBlock(root, ['owner', 'name'])?.value, 'Jane');
  assert.equal(findBlock(root, ['released'])?.value, '2026-10-16');
  assert.deepEqual(findBlock(root, ['server', 'ports'])?.children?.map((c) => c.value), [80, 443]);
  assert.equal(findBlock(root, ['server', 'inline', 'y'])?.value, 2);
  assert.equal(findBlock(root, ['products'])?.kind, 'array');
  assert.equal(findBlock(root, ['products', 1, 'name'])?.value, 'B');
});

test('reports syntax errors', () => {
  const { root, errors } = tomlAdapter.parse('a = \n');
  assert.equal(root, null);
  assert.equal(errors.length, 1);
});

test('setValue replaces just the value, keeping comments and date types', () => {
  assert.equal(edit(tomlAdapter, source, { type: 'setValue', path: ['title'], value: 'new "one"' }), source.replace('"demo"', '"new \\"one\\""'));
  assert.equal(edit(tomlAdapter, source, { type: 'setValue', path: ['server', 'ports', 1], value: 8443 }), source.replace('[80, 443]', '[80, 8443]'));
  assert.equal(edit(tomlAdapter, source, { type: 'setValue', path: ['released'], value: '2027-01-01' }), source.replace('2026-10-16', '2027-01-01'));
  assert.equal(tomlAdapter.applyEdit(source, { type: 'setValue', path: ['title'], value: null }), undefined);
});

test('rename changes keys and table headers', () => {
  assert.equal(edit(tomlAdapter, source, { type: 'rename', path: ['server', 'host'], newKey: 'hostname' }), source.replace('host = "localhost"', 'hostname = "localhost"'));
  assert.equal(edit(tomlAdapter, source, { type: 'rename', path: ['server'], newKey: 'my server' }), source.replace('[server]', '["my server"]'));
  assert.equal(tomlAdapter.applyEdit(source, { type: 'rename', path: ['title'], newKey: 'released' }), undefined);
});

test('remove deletes lines (with trailing comments), inline items and whole tables', () => {
  assert.equal(edit(tomlAdapter, source, { type: 'remove', path: ['title'] }), source.replace('title = "demo" # trailing\n', ''));
  assert.equal(edit(tomlAdapter, source, { type: 'remove', path: ['server', 'ports', 0] }), source.replace('[80, 443]', '[443]'));
  assert.equal(edit(tomlAdapter, source, { type: 'remove', path: ['server', 'inline', 'x'] }), source.replace('{ x = 1, y = 2 }', '{ y = 2 }'));
  assert.equal(edit(tomlAdapter, source, { type: 'remove', path: ['products', 0] }), source.replace('[[products]]\nname = "A"\n', ''));
});

test('insert adds key/values to tables and items to inline arrays/tables', () => {
  assert.equal(
    edit(tomlAdapter, source, { type: 'insert', parentPath: ['server'], key: 'timeout', value: 30 }),
    source.replace('inline = { x = 1, y = 2 }\n', 'inline = { x = 1, y = 2 }\ntimeout = 30\n'),
  );
  assert.equal(edit(tomlAdapter, source, { type: 'insert', parentPath: ['server', 'ports'], value: 8080 }), source.replace('[80, 443]', '[80, 443, 8080]'));
  assert.equal(edit(tomlAdapter, source, { type: 'insert', parentPath: ['server', 'inline'], key: 'z', value: true }), source.replace('y = 2 }', 'y = 2, z = true }'));
  assert.equal(
    edit(tomlAdapter, source, { type: 'insert', parentPath: [], key: 'version', value: '1.0' }),
    source.replace('released = 2026-10-16\n', 'released = 2026-10-16\nversion = "1.0"\n'),
  );
  // Objects that only exist through dotted keys have no single place to write to.
  assert.equal(tomlAdapter.applyEdit(source, { type: 'insert', parentPath: ['owner'], key: 'email', value: '' }), undefined);
});

test('move reorders key/values of one table and inline array items', () => {
  assert.equal(
    edit(tomlAdapter, source, { type: 'move', path: ['server', 'host'], toIndex: 1 }),
    source.replace('host = "localhost"\nports = [80, 443]', 'ports = [80, 443]\nhost = "localhost"'),
  );
  assert.equal(edit(tomlAdapter, source, { type: 'move', path: ['server', 'ports', 1], toIndex: 0 }), source.replace('[80, 443]', '[443, 80]'));
  // Root children come from different places (dotted keys, tables): not reorderable.
  assert.equal(tomlAdapter.applyEdit(source, { type: 'move', path: ['server'], toIndex: 0 }), undefined);
});

test('instances give JSON-compatible values for schema validation', () => {
  const [instance] = tomlAdapter.instances!(source);
  assert.equal((instance.value as { released: string }).released, '2026-10-16');
  assert.deepEqual((instance.value as { products: unknown }).products, [{ name: 'A' }, { name: 'B' }]);
});
