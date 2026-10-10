import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutHistory } from './graph.ts';

const commit = (oid: string, parents: string[] = []) => ({ oid, shortOid: oid, parents, subject: oid, author: 'Test', timestamp: 0, shallow: false });

test('forks reconnect to the same ancestor and expose every merge parent', () => {
  const data = [commit('tip', ['merge']), commit('merge', ['main', 'feature']), commit('feature', ['base']), commit('main', ['base']), commit('base')];
  const result = layoutHistory(data);
  assert.equal(result.rows.length, 5);
  assert.equal(result.rows[1].outgoing.length, 2);
  assert.equal(result.rows[2].outgoing[0].lane, result.rows[3].outgoing[0].lane);
  assert.deepEqual(result.pending, []);
});

test('loading another page preserves the layout of the loaded prefix', () => {
  const data = [commit('merge', ['a', 'b', 'c']), commit('a', ['root']), commit('b', ['root']), commit('c', ['root']), commit('root'), commit('unrelated')];
  const first = layoutHistory(data.slice(0, 2)); const next = layoutHistory(data);
  assert.deepEqual(next.rows.slice(0, 2), first.rows);
  assert.equal(first.pending.length, 3);
  assert.equal(next.rows[0].outgoing.length, 3);
  assert.deepEqual(next.pending, []);
});

test('roots, disconnected histories, and shallow boundaries are distinct', () => {
  const result = layoutHistory([commit('other'), { ...commit('shallow'), shallow: true }, commit('root')]);
  assert.equal(result.rows[1].commit.shallow, true);
  assert.equal(result.rows[2].commit.shallow, false);
  assert.equal(result.lanes, 1);
  assert.deepEqual(result.pending, []);
});

test('a pending ancestor remains a continuation rather than an invented root', () => {
  const result = layoutHistory([commit('a', ['older'])]);
  assert.deepEqual(result.pending.map(p => p.parent), ['older']);
  assert.equal(result.rows[0].outgoing[0].parent, 'older');
  assert.throws(() => layoutHistory([commit('root'), commit('a', ['root'])]), /order/);
  assert.throws(() => layoutHistory([commit('a'), commit('a')]), /duplicate/);
});

test('a new branch path gets its own color when it reuses a column', () => {
  const result = layoutHistory([commit('main', ['base']), commit('feature', ['base']), commit('other', ['base']), commit('base')]);
  assert.equal(result.rows[0].color, result.rows[3].color);
  assert.notEqual(result.rows[1].color, result.rows[0].color);
  assert.notEqual(result.rows[2].color, result.rows[1].color);
  assert.deepEqual(result.pending, []);
});
