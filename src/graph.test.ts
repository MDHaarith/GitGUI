import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCommits, layoutHistory } from './graph.ts';
import type { RefInfo } from './git.ts';

const commit = (oid: string, parents: string[] = []) => ({ oid, shortOid: oid, parents, subject: oid, author: 'Test', timestamp: 0, shallow: false });
const branch = (name: string, target: string, kind: RefInfo['kind'] = 'local'): RefInfo => ({ id: name, name, fullName: 'refs/' + (kind === 'local' ? 'heads/' : kind === 'remote' ? 'remotes/' : 'tags/') + name, kind, target, isHead: false });

test('GUI, review, and master keep distinct colors and the GUI trunk runs straight into master', () => {
  const data = [commit('gui', ['master']), commit('review', ['review-old']), commit('review-old', ['master']), commit('master', ['root']), commit('root')];
  const refs = [branch('GUI-with-DESIGN.md', 'gui'), branch('chore/review-improvements', 'review'), branch('master', 'master')];
  const result = layoutHistory(data, refs);
  const tips = [result.rows[0], result.rows[1], result.rows[3]];
  assert.equal(result.lanes, 2);
  assert.equal(result.rows[0].lane, result.rows[3].lane);
  assert.equal(new Set(tips.map(row => row.color)).size, 3);
  assert.equal(result.rows[0].outgoing[0].lane, result.rows[3].lane);
  assert.equal(result.rows[2].outgoing[0].lane, result.rows[3].lane);
  for (let count = 1; count < data.length; count++) assert.deepEqual(layoutHistory(data.slice(0, count), refs).rows, result.rows.slice(0, count));
  assert.deepEqual(result.pending, []);
});

test('a branch ahead of another branch stays in the same column with its own color', () => {
  const data = [commit('feature', ['main']), commit('main', ['root']), commit('root')];
  const result = layoutHistory(data, [branch('feature', 'feature'), branch('main', 'main')]);
  assert.equal(result.lanes, 1);
  assert.equal(result.rows[0].lane, result.rows[1].lane);
  assert.notEqual(result.rows[0].color, result.rows[1].color);
  assert.equal(result.rows[1].color, result.rows[2].color);
  assert.equal(result.rows[0].outgoing[0].parent, 'main');
  assert.equal(result.rows[0].outgoing[0].lane, result.rows[1].lane);
  assert.deepEqual(result.pending, []);
});

test('branch paths keep their coordinates and colors when the named parent loads on a later page', () => {
  const data = [commit('feature', ['main']), commit('main', ['root']), commit('root')];
  const refs = [branch('feature', 'feature'), branch('main', 'main')];
  const first = layoutHistory(data.slice(0, 1), refs); const next = layoutHistory(data, refs);
  assert.deepEqual(first.rows, next.rows.slice(0, 1));
  assert.equal(first.pending[0].parent, 'main');
  assert.equal(first.pending[0].lane, next.rows[1].lane);
  assert.equal(first.pending[0].color, next.rows[1].color);
});

test('aliases share paths, tags add no lanes, and unseen unrelated refs add no invented history', () => {
  const data = [commit('feature', ['main']), commit('main', ['root']), commit('root')];
  const refs = [branch('feature', 'feature'), branch('main', 'main')];
  const result = layoutHistory(data, refs);
  assert.deepEqual(layoutHistory(data, [...refs, branch('origin/main', 'main', 'remote'), branch('v1', 'root', 'tag')]), result);
  assert.equal(layoutHistory(data, [branch('v1', 'main', 'tag')]).lanes, 1);
  const unrelated = layoutHistory(data, [...refs, branch('unloaded', 'unseen')]);
  assert.equal(unrelated.rows.length, data.length);
  assert.deepEqual(unrelated.pending, []);
  assert.equal(unrelated.lanes, 1);
});

test('named merge parents keep distinct colors and reconnect at their shared ancestor', () => {
  const data = [commit('merge', ['main', 'feature']), commit('feature', ['root']), commit('main', ['root']), commit('root')];
  const result = layoutHistory(data, [branch('feature', 'feature'), branch('main', 'main')]);
  assert.notEqual(result.rows[1].color, result.rows[2].color);
  assert.deepEqual(result.rows[0].outgoing.map(rail => rail.parent), ['main', 'feature']);
  assert.equal(result.rows[1].outgoing[0].lane, result.rows[2].outgoing[0].lane);
  assert.deepEqual(result.pending, []);
});

test('history search matches messages, authors, and full hashes without changing graph order', () => {
  const commits = [{ ...commit('abc123'), subject: 'Fix parser', author: 'Ada' }, { ...commit('def456'), subject: 'Update docs', author: 'Grace' }];
  assert.deepEqual(findCommits(commits, ' FIX '), ['abc123']);
  assert.deepEqual(findCommits(commits, 'grace'), ['def456']);
  assert.deepEqual(findCommits(commits, 'C123'), ['abc123']);
  assert.deepEqual(findCommits(commits, '['), []);
  assert.deepEqual(findCommits(commits, ' '), []);
  assert.equal(commits.length, 2);
});

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
