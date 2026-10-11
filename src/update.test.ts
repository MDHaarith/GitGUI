import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from './update.ts';

test('versions compare numerically', () => {
  assert.ok(isNewer('0.12.0', '0.11.9'));
  assert.ok(isNewer('1.0.10', '1.0.9'));
  assert.ok(!isNewer('0.11.1', '0.11.1'));
  assert.ok(!isNewer('0.9.0', '0.10.0'));
});
