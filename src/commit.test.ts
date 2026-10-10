import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryHint } from './commit.ts';

test('summary guidance follows the 50/72 convention', () => {
  assert.deepEqual(summaryHint('   '), { text: '', warning: false });
  assert.deepEqual(summaryHint('Fix login'), { text: '9/50', warning: false });
  assert.equal(summaryHint('x'.repeat(60)).text, '60 characters · aim for 50');
  assert.ok(summaryHint('x'.repeat(73)).warning);
});

test('summary length counts characters, not UTF-16 units', () => {
  assert.equal(summaryHint('🙂'.repeat(50)).text, '50/50');
});
