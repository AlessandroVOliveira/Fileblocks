import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Block } from '../src/model/block';
import { convertValue, typeOf } from '../src/model/convert';

const scalar = (value: Block['value']): Block => ({ id: '[]', kind: 'scalar', path: [], value });

test('typeOf reports the block type', () => {
  assert.equal(typeOf(scalar('a')), 'string');
  assert.equal(typeOf(scalar(1)), 'number');
  assert.equal(typeOf(scalar(null)), 'null');
  assert.equal(typeOf({ id: '[]', kind: 'array', path: [], children: [] }), 'array');
});

test('convertValue keeps what makes sense', () => {
  assert.equal(convertValue(scalar(8080), 'string'), '8080');
  assert.equal(convertValue(scalar('42'), 'number'), 42);
  assert.equal(convertValue(scalar('abc'), 'number'), 0);
  assert.equal(convertValue(scalar(true), 'number'), 1);
  assert.equal(convertValue(scalar(' TRUE '), 'boolean'), true);
  assert.equal(convertValue(scalar('no'), 'boolean'), false);
  assert.equal(convertValue(scalar(0), 'boolean'), false);
  assert.equal(convertValue(scalar(null), 'string'), '');
  assert.deepEqual(convertValue(scalar('x'), 'object'), {});
  assert.deepEqual(convertValue({ id: '[]', kind: 'object', path: [], children: [] }, 'array'), []);
});
