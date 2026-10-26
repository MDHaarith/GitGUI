import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blameHeat, isTextField, lineRange } from './history-logic.ts';

test('blame heat uses readable bounded lavender opacity, including a single commit', () => {
  assert.equal(blameHeat(10, 10, 100), 0.04);
  assert.equal(blameHeat(100, 10, 100), 0.22);
  assert.equal(blameHeat(10, 10, 10), 0.22);
  assert.equal(blameHeat(-1, 10, 100), 0.04);
  assert.equal(blameHeat(1000, 10, 100), 0.22);
  assert.equal(blameHeat(NaN, 0, 1), 0.04);
});

test('range selection normalizes backward selections and rejects invalid bounds', () => {
  assert.deepEqual(lineRange(12, 3), [3, 12]);
  assert.deepEqual(lineRange(1, 1_000_000), [1, 1_000_000]);
  for (const bounds of [[0, 2], [1, Infinity], [2.5, 4], [1, 1_000_001]]) assert.equal(lineRange(...bounds as [number, number]), null);
});

test('Git undo leaves text inputs, contenteditable, and textbox widgets alone', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.ok(isTextField(tag, false, null));
  assert.ok(isTextField('SPAN', true, null));
  assert.ok(isTextField('DIV', false, 'textbox'));
  assert.equal(isTextField('BUTTON', false, null), false);
});

test('line history maps index coordinates to HEAD and rejects newly staged lines', async () => {
  const { headLine } = await import('./history-logic.ts');
  const diff = '@@ -1,3 +1,4 @@\n one\n+inserted\n two\n three\n@@ -8,2 +9,1 @@\n-eight\n nine\n';
  assert.equal(headLine(1, diff), 1);
  assert.equal(headLine(2, diff), null);
  assert.equal(headLine(3, diff), 2);
  assert.equal(headLine(8, diff), 7);
  assert.equal(headLine(9, diff), 9);
  assert.equal(headLine(20, diff), 20);
  assert.equal(headLine(3, '@@ -0,0 +1,2 @@\n+first\n+second\n'), 1);
  assert.equal(headLine(1, '@@ -1,1 +0,0 @@\n-first\n'), 2);
  assert.equal(headLine(1, '@@ -2,1 +1,0 @@\n-second\n'), 1);
  assert.equal(headLine(2, '@@ -2,1 +1,0 @@\n-second\n'), 3);
});
