import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToId } from '../src/model/block';
import { jsonAdapter } from '../src/parsers/jsonAdapter';
import { initialCollapse } from '../webview/graph/collapse';

// root -> 3 users -> each with an address object -> each with a geo object
const users = Array.from({ length: 3 }, (_, i) => ({ id: i, address: { city: 'x', geo: { lat: 0, lng: 0 } } }));
const { root } = jsonAdapter.parse(JSON.stringify({ users }));

test('small files are left fully expanded', () => {
  assert.deepEqual(initialCollapse(root!, 100), { ids: [] });
});

test('collapses the first level that would go over the card budget', () => {
  // Levels (cards): root 1, users 1, user objects 3, addresses 3, geos 3 -> cumulative 1, 2, 5, 8, 11
  const result = initialCollapse(root!, 6);
  assert.equal(result.depth, 2);
  assert.deepEqual(result.ids, [0, 1, 2].map((i) => pathToId(['users', i, 'address'])));
});

test('always keeps the root card', () => {
  const result = initialCollapse(root!, 0);
  assert.equal(result.depth, 0);
  assert.deepEqual(result.ids, [pathToId(['users'])]);
});
