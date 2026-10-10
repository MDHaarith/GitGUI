import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberDiff } from './diff.ts';

test('unified diffs number both sides, skip metadata, and reset at each hunk', () => {
  const lines = numberDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -8,2 +10,2 @@\n context\n-old\n+new\n\\ No newline at end of file\n@@ -0,0 +1 @@\n+created');
  assert.deepEqual(lines.map(({ oldLine, newLine }) => [oldLine, newLine]), [[null, null], [null, null], [null, null], [null, null], [8, 10], [9, null], [null, 11], [null, null], [null, null], [null, 1]]);
  assert.equal(lines[2].kind, '');
  assert.equal(lines[9].kind, 'added');
});

test('untracked text gets line numbers; binary previews do not', () => {
  assert.deepEqual(numberDiff('first\nsecond').map(line => line.newLine), [1, 2]);
  assert.equal(numberDiff('Binary file preview is unavailable.', true)[0].newLine, null);
  assert.equal(numberDiff('line\n'.repeat(6000)).length, 5001);
});

test('patch content resembling file headers keeps its line numbers', () => {
  const lines = numberDiff('diff --git a/a b/a\n@@ -1 +1 @@\n--- old content\n+++ new content');
  assert.equal(lines[2].oldLine, 1);
  assert.equal(lines[3].newLine, 1);
  assert.equal(numberDiff('--- raw text')[0].newLine, 1);
});
