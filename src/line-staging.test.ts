import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectLines } from './line-staging.ts';

test('line selection toggles individual lines and extends ranges across hunks, excluding context', () => {
  const available = [5, 6, 9, 15];
  let selected = selectLines(new Set(), available, 6, null, false);
  assert.deepEqual([...selected], [6]);
  assert.deepEqual([...selectLines(selected, available, 6, 6, false)], []);
  selected = selectLines(selected, available, 15, 6, true);
  assert.deepEqual([...selected], [6, 9, 15]);
  assert.deepEqual([...selectLines(new Set(), available, 5, 15, true)], available);
});
