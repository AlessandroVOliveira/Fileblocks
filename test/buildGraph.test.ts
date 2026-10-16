import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToId } from '../src/model/block';
import { jsonAdapter } from '../src/parsers/jsonAdapter';
import { buildGraph, HEADER_HEIGHT, ROW_HEIGHT } from '../webview/graph/buildGraph';

const { root } = jsonAdapter.parse(`{
  "name": "demo",
  "author": { "name": "Jane" },
  "tags": ["a", "b"],
  "servers": [{ "host": "x" }, { "host": "y" }]
}`);
const measure = (text: string) => text.length * 7;

test('one node per object/array, scalars stay as rows', () => {
  const graph = buildGraph(root!, () => false, measure);
  // root, author, tags, servers, servers[0], servers[1]
  assert.equal(graph.nodes.length, 6);
  assert.equal(graph.edges.length, 5);
  const rootNode = graph.nodes[0];
  assert.equal(rootNode.height, HEADER_HEIGHT + 4 * ROW_HEIGHT + 4);
});

test('edges leave from the row of the child', () => {
  const graph = buildGraph(root!, () => false, measure);
  const author = graph.edges.find((e) => e.target === encodeURIComponent(pathToId(['author'])));
  assert.ok(author);
  assert.equal(author.source, encodeURIComponent(pathToId([])));
  assert.equal(author.sourceHandle, author.target);
});

test('collapsed blocks keep their row but drop their subtree', () => {
  const collapsedId = pathToId(['servers']);
  const graph = buildGraph(root!, (id) => id === collapsedId, measure);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
});

test('ids are safe for DOM selectors', () => {
  const graph = buildGraph(root!, () => false, measure);
  for (const node of graph.nodes) {
    assert.doesNotMatch(node.id, /["[\]]/);
  }
});
