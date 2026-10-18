import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryHint, unfence } from './commit.ts';

test('summary guidance follows the 50/72 convention', () => {
  assert.deepEqual(summaryHint('   '), { text: '', warning: false });
  assert.deepEqual(summaryHint('Fix login'), { text: '9/50', warning: false });
  assert.equal(summaryHint('x'.repeat(60)).text, '60 characters · aim for 50');
  assert.ok(summaryHint('x'.repeat(73)).warning);
});

test('summary length counts characters, not UTF-16 units', () => {
  assert.equal(summaryHint('🙂'.repeat(50)).text, '50/50');
});

test('code fences around AI replies are removed', () => {
  assert.equal(unfence('```text\nAdd login\n\n- Form\n```\n'), 'Add login\n\n- Form');
  assert.equal(unfence('```\nAdd login\n```'), 'Add login');
  assert.equal(unfence(' Add `x` support '), 'Add `x` support');
});
