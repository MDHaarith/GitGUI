import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPending, checkSummary, type ReviewComment } from './github-model.ts';
import { numberDiff } from './diff.ts';
import { readFileSync } from 'node:fs';

test('GitHub check fixtures cover checks, legacy statuses, and empty rollups', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/github-checks.json', import.meta.url), 'utf8'));
  assert.equal(checkSummary(fixture), 'Build: SUCCESS\nci/legacy: FAILURE\nTest: IN_PROGRESS');
  assert.equal(checkSummary(null), 'No checks reported.');
  assert.equal(checkSummary([]), 'No checks reported.');
});

test('pending comments stay local, replace the same line, and keep file and side distinct', () => {
  const first: ReviewComment = { path: 'file.ts', line: 2, side: 'RIGHT', body: 'First' };
  const comments = [first];
  const replaced = addPending(comments, { ...first, body: 'Edited' });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].body, 'Edited');
  assert.equal(comments[0].body, 'First');
  const left = addPending(replaced, { ...first, side: 'LEFT' });
  assert.equal(left.length, 2);
  assert.equal(addPending(left, { ...first, path: 'other.ts' }).length, 3);
});

test('GitHub patch fixtures use the existing diff line numbers for both review sides', () => {
  const [file] = JSON.parse(readFileSync(new URL('../src-tauri/tests/fixtures/github-files.json', import.meta.url), 'utf8'));
  const lines = numberDiff(`--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}`);
  assert.deepEqual(lines.filter(line => line.oldLine !== null).map(line => line.oldLine), [1, 2, 3]);
  assert.deepEqual(lines.filter(line => line.newLine !== null).map(line => line.newLine), [1, 2, 3, 4]);
  assert.equal(lines.find(line => line.newLine === 4)?.kind, 'added');
});
