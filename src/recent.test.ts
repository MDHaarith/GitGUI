import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetRecent, isUnavailable, parseRecent, rememberRecent } from './recent.ts';

test('saved repositories are absolute, unique, and bounded', () => {
  assert.deepEqual(parseRecent(JSON.stringify(['/a', 'relative', '/a', 7, '/b'])), ['/a', '/b']);
  assert.deepEqual(parseRecent('not json'), []);
  assert.deepEqual(parseRecent(null), []);
  assert.equal(parseRecent(JSON.stringify(Array.from({ length: 12 }, (_, i) => '/r' + i))).length, 8);
});

test('opening moves a repository to the front; forgetting removes only that path', () => {
  assert.deepEqual(rememberRecent(['/a', '/b', '/c'], '/c'), ['/c', '/a', '/b']);
  assert.equal(rememberRecent(Array.from({ length: 8 }, (_, i) => '/r' + i), '/new').length, 8);
  assert.deepEqual(forgetRecent(['/a', '/b'], '/a'), ['/b']);
});

test('only missing folders and non-repositories count as unavailable', () => {
  assert.ok(isUnavailable('Cannot open this folder: No such file or directory (os error 2)'));
  assert.ok(isUnavailable('fatal: not a git repository (or any of the parent directories): .git'));
  assert.ok(!isUnavailable('GitGUI requires system Git 2.43 or newer.'));
});
