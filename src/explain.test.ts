import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiCost, explainCrash, explainError, explainState, sortByRisk } from './explain.ts';

const clean = { detached: false, operation: null, upstream: 'origin/main', ahead: 0, behind: 0, head: 'abc', branch: 'main', remotes: [{ id: '6f', name: 'origin', url: 'x' }] };

test('state notes cover conflicts, detached HEAD, and sync direction', () => {
  assert.deepEqual(explainState(clean), []);
  assert.match(explainState({ ...clean, operation: 'unresolved conflicts' })[0], /^Conflicts/);
  assert.match(explainState({ ...clean, operation: 'rebase' })[0], /Continue or Abort/);
  assert.match(explainState({ ...clean, detached: true, branch: null })[0], /old snapshot/);
  assert.match(explainState({ ...clean, ahead: 2, behind: 1 })[0], /Pull first/);
  assert.match(explainState({ ...clean, behind: 1 })[0], /1 commit you/);
  assert.match(explainState({ ...clean, ahead: 3 })[0], /3 commits are only on this computer/);
  assert.match(explainState({ ...clean, upstream: null })[0], /only on this computer/);
  assert.match(explainState({ ...clean, upstream: null, remotes: [] })[0], /Publish to GitHub/);
});

test('known Git errors get a plain-English explanation', () => {
  assert.match(explainError('! [rejected] main -> main (non-fast-forward)')!, /Pull first/);
  assert.match(explainError('GitGUI safeguards: a staged line looks like an API key or private key.')!, /Secrets/);
  assert.match(explainError('GitGUI safeguards: tests failed (npm test).')!, /tests fail/);
  assert.match(explainError('fatal: Authentication failed for https://x')!, /login/);
  assert.equal(explainError('something unexpected'), null);
});

test('risky AI changes sort first with a reason', () => {
  const files = sortByRisk([
    { path: 'src/a.ts', status: 'M', added: 5, deleted: 1 },
    { path: 'src/big.ts', status: 'M', added: 400, deleted: 0 },
    { path: 'tests/login.test.ts', status: 'D', added: 0, deleted: 30 },
    { path: '.env', status: 'A', added: 1, deleted: 0 },
    { path: 'package.json', status: 'M', added: 1, deleted: 0 },
  ]);
  assert.deepEqual(files.map(f => f.risk), ['Large change', 'Tests removed', 'May contain secrets', 'Dependencies changed', null]);
});

test('crash output and AI cost are explained', () => {
  assert.match(explainCrash('Error: listen EADDRINUSE: address already in use :::3000')!, /port/);
  assert.match(explainCrash("Error: Cannot find module 'react'")!, /npm install/);
  assert.equal(explainCrash('all good'), null);
  assert.equal(aiCost(1_000_000, 100_000), 6);
});
