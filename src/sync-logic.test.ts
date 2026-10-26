import test from 'node:test';
import assert from 'node:assert/strict';
import { changesBlock, pullDiverged, pushRejected, staleBranch } from './sync-logic.ts';

test('sync retries are offered only for their corresponding Git failures', () => {
  assert.equal(pullDiverged('fatal: Not possible to fast-forward, aborting.'), true);
  assert.equal(pullDiverged('fatal: Authentication failed'), false);
  assert.equal(changesBlock('Your local changes would be overwritten by checkout'), true);
  assert.equal(changesBlock('Working changes block pull. Use Stash & retry.'), true);
  assert.equal(changesBlock('not a valid branch'), false);
  assert.equal(pushRejected('[rejected] main -> main (fetch first)'), true);
  assert.equal(pushRejected('[remote rejected] main -> main (pre-receive hook declined)'), false);
});

test('a branch becomes stale at 90 days, including the exact boundary', () => {
  const now = 1800000000000, seconds = now / 1000;
  assert.equal(staleBranch(seconds - 90 * 86400, now), true);
  assert.equal(staleBranch(seconds - 90 * 86400 + 1, now), false);
  assert.equal(staleBranch(seconds + 1, now), false);
  assert.equal(staleBranch(NaN, now), false);
  assert.equal(staleBranch(0, now), false);
});
