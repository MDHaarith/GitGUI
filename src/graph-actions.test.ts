import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCommits, batchRebase, resultingCommits } from './graph-actions.ts';
import type { RebaseEdit } from './git.ts';

const order = ['d', 'c', 'b', 'a'];
const commits: RebaseEdit[] = [...order].reverse().map(oid => ({ oid, message: oid, action: 'pick' }));

test('graph selection supports replace, Ctrl/Cmd toggle, and anchored Shift ranges', () => {
  let selected = selectCommits(order, new Set(), null, 'c', false, false);
  assert.deepEqual([...selected], ['c']);
  selected = selectCommits(order, selected, 'c', 'a', true, false);
  assert.deepEqual([...selected], ['c', 'a']);
  selected = selectCommits(order, selected, 'a', 'c', true, false);
  assert.deepEqual([...selected], ['a']);
  assert.deepEqual([...selectCommits(order, selected, 'c', 'a', false, true)], ['c', 'b', 'a']);
  assert.deepEqual([...selectCommits(order, new Set(['d']), 'c', 'a', true, true)], ['d', 'c', 'b', 'a']);
  assert.deepEqual([...selectCommits(order, selected, 'unloaded', 'b', false, true)], ['b']);
});

test('batch squash groups selected commits in original order and keeps intervening commits', () => {
  const plan = batchRebase(commits, new Set(['a', 'c']), 'squash');
  assert.deepEqual(plan.map(c => [c.oid, c.action]), [['a', 'pick'], ['c', 'squash'], ['b', 'pick'], ['d', 'pick']]);
  assert.equal(resultingCommits(plan), 3);
  assert.equal(resultingCommits(batchRebase(commits, new Set(['b', 'd']), 'drop')), 2);
  assert.deepEqual(commits.map(c => c.action), ['pick', 'pick', 'pick', 'pick']);
  assert.equal(resultingCommits([{ ...commits[0], action: 'edit' }, { ...commits[1], action: 'fixup' }]), 1);
});
