import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlock, parseConflicts, resolveConflicts } from './conflict.ts';

test('conflict blocks are parsed and resolved per block', () => {
  const text = 'top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\nmid\n<<<<<<< HEAD\na\n||||||| base\nb\n=======\nc\n>>>>>>> other\nend\n';
  const segments = parseConflicts(text);
  const blocks = segments.filter(isBlock);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { ours: ['ours'], theirs: ['theirs'], oursLabel: 'HEAD', theirsLabel: 'other' });
  assert.deepEqual(blocks[1].ours, ['a']);
  assert.equal(resolveConflicts(segments, ['theirs', 'both']), 'top\ntheirs\nmid\na\nc\nend\n');
  assert.equal(resolveConflicts(segments, ['ours', 'ours']), 'top\nours\nmid\na\nend\n');
});

test('text without complete markers is left alone', () => {
  assert.equal(parseConflicts('a\n<<<<<<< x\nb').filter(isBlock).length, 0);
  assert.equal(resolveConflicts(parseConflicts('a\n<<<<<<< x\nb'), []), 'a\n<<<<<<< x\nb');
});
