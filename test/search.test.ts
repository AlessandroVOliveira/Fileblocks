import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToId } from '../src/model/block';
import { jsonAdapter } from '../src/parsers/jsonAdapter';
import { findMatches, idsToReveal } from '../webview/graph/search';

const { root } = jsonAdapter.parse(`{
  "name": "Host demo",
  "servers": [
    { "host": "localhost", "port": 8080 },
    { "host": "api.example.com", "port": 443 }
  ],
  "flags": [1, 10]
}`);

test('matches keys and values case-insensitively, in document order', () => {
  const matches = findMatches(root!, 'HOST');
  assert.deepEqual(
    matches.map((m) => m.block.path),
    [['name'], ['servers', 0, 'host'], ['servers', 1, 'host']],
  );
});

test('reports the card and row that display each match', () => {
  const [match] = findMatches(root!, '443');
  assert.deepEqual(match.card.path, ['servers', 1]);
  assert.equal(match.row, 1);
});

test('does not match array indexes', () => {
  assert.deepEqual(
    findMatches(root!, '1').map((m) => m.block.path),
    [['flags', 0], ['flags', 1]],
  );
});

test('blank queries match nothing', () => {
  assert.deepEqual(findMatches(root!, '   '), []);
});

test('idsToReveal lists the card and all its ancestors', () => {
  const [match] = findMatches(root!, '443');
  assert.deepEqual(idsToReveal(match), [pathToId(['servers']), pathToId(['servers', 1])]);
});
