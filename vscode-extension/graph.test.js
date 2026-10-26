const { test } = require('node:test');
const assert = require('node:assert/strict');
const { layoutGraph } = require('./graph');
const commit = (oid, parents = []) => ({ oid, parents });

test('empty and linear histories use one lane', () => {
  assert.deepEqual(layoutGraph([]), { nodes: [], edges: [], width: 1 });
  const graph = layoutGraph([commit('a', ['b']), commit('b', ['c']), commit('c')]);
  assert.deepEqual(graph.nodes.map(node => node.lane), [0, 0, 0]);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.width, 1);
});

test('a merge reserves separate lanes until the shared ancestor', () => {
  const input = [commit('merge', ['left', 'right']), commit('left', ['base']), commit('right', ['base']), commit('base')];
  const snapshot = JSON.stringify(input);
  const graph = layoutGraph(input);
  assert.deepEqual(graph.nodes.map(node => node.lane), [0, 0, 1, 0]);
  assert.equal(graph.edges.length, 4);
  assert.equal(graph.width, 2);
  for (const edge of graph.edges) {
    assert.ok(edge.to > edge.from);
    assert.equal(graph.nodes[edge.to].lane, edge.toLane);
  }
  assert.equal(JSON.stringify(input), snapshot);
});

test('octopus merges, disconnected roots and truncated parents keep valid targets', () => {
  const graph = layoutGraph([commit('m', ['a', 'b', 'c']), commit('a', ['x']), commit('b', ['x']),
    commit('c', ['x']), commit('x'), commit('unrelated', ['outside'])]);
  assert.equal(graph.width, 3);
  const boundary = graph.edges.find(edge => edge.boundary);
  assert.equal(boundary.parent, 'outside');
  assert.equal(boundary.to, graph.nodes.length);
  assert.equal(graph.nodes.at(-1).lane, 0);
  for (const edge of graph.edges.filter(edge => !edge.boundary)) {
    assert.equal(graph.nodes[edge.to].lane, edge.toLane);
  }
});

test('2,000 commits retain every node and edge', () => {
  const commits = Array.from({ length: 2000 }, (_, i) => commit(String(i), [String(i + 1)]));
  const graph = layoutGraph(commits);
  assert.equal(graph.nodes.length, 2000);
  assert.equal(graph.edges.length, 2000);
  assert.equal(graph.edges.at(-1).boundary, true);
  assert.equal(graph.width, 1);
});
