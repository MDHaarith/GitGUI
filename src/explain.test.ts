import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainError, explainState } from './explain.ts';

const clean = { detached: false, operation: null, upstream: 'origin/main', ahead: 0, behind: 0, head: 'abc', branch: 'main' };

test('state notes cover conflicts, detached HEAD, and sync direction', () => {
  assert.deepEqual(explainState(clean), []);
  assert.match(explainState({ ...clean, operation: 'unresolved conflicts' })[0], /^Conflicts/);
  assert.match(explainState({ ...clean, operation: 'rebase' })[0], /git rebase --continue/);
  assert.match(explainState({ ...clean, detached: true, branch: null })[0], /old snapshot/);
  assert.match(explainState({ ...clean, ahead: 2, behind: 1 })[0], /Pull first/);
  assert.match(explainState({ ...clean, behind: 1 })[0], /1 commit you/);
  assert.match(explainState({ ...clean, ahead: 3 })[0], /3 commits are only on this computer/);
  assert.match(explainState({ ...clean, upstream: null })[0], /only on this computer/);
});

test('known Git errors get a plain-English explanation', () => {
  assert.match(explainError('! [rejected] main -> main (non-fast-forward)')!, /Pull first/);
  assert.match(explainError('GitGUI safeguards: a staged line looks like an API key or private key.')!, /Secrets/);
  assert.match(explainError('GitGUI safeguards: tests failed (npm test).')!, /tests fail/);
  assert.match(explainError('fatal: Authentication failed for https://x')!, /login/);
  assert.equal(explainError('something unexpected'), null);
});
