import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticResolution, chooseBlock, mergeBlocks, mergeFile, mergeSides, operationControls, simpleResolution, workingResults } from './merge.ts';

const changed = (base: string, ours: string, theirs: string) => mergeBlocks(base, ours, theirs).filter(block => block.kind !== 'unchanged');
const simple = (base: string, ours: string, theirs: string) => mergeBlocks(base, ours, theirs).map(simpleResolution).join('');

test('independent replacements, insertions and deletions apply from both sides', () => {
  assert.equal(simple('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'), 'A\nb\nc\nd\nE\n');
  assert.equal(simple('a\nb\nc\nd\n', 'a\nextra\nb\nc\nd\n', 'a\nb\nc\n'), 'a\nextra\nb\nc\n');
  assert.deepEqual(changed('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n').map(block => block.kind), ['ours', 'theirs']);
});

test('simple changes select the changed side or identical changes', () => {
  for (const [ours, theirs, kind, result] of [['new\n', 'old\n', 'ours', 'new\n'], ['old\n', 'new\n', 'theirs', 'new\n'], ['new\n', 'new\n', 'both', 'new\n'], ['', '', 'both', '']]) {
    const block = changed('old\n', ours, theirs)[0];
    assert.equal(block.kind, kind); assert.equal(simpleResolution(block), result);
  }
  assert.equal(simple('same\n', 'same\n', 'same\n'), 'same\n');
});

test('different changes to overlapping base lines stay conflicted', () => {
  const block = changed('base\n', 'mine\n', 'yours\n')[0];
  assert.equal(block.kind, 'conflict'); assert.equal(simpleResolution(block), null);
  assert.equal(chooseBlock(block, 'ours'), 'mine\n');
  assert.equal(chooseBlock(block, 'theirs'), 'yours\n');
  assert.equal(chooseBlock(block, 'both'), 'mine\nyours\n');
  assert.equal(chooseBlock(block, 'ignore'), 'base\n');
});

test('add/add, modify/delete, identical deletion and empty files', () => {
  assert.equal(changed('', 'a\n', 'b\n')[0].kind, 'conflict');
  assert.equal(changed('a\n', '', 'b\n')[0].kind, 'conflict');
  assert.equal(simple('a\n', '', 'a\n'), '');
  assert.equal(simple('', 'a\n', ''), 'a\n');
  assert.equal(simple('', '', ''), '');
});

test('adjacent independent line edits remain separate, boundary insertions are conservative', () => {
  assert.equal(simple('a\nb\n', 'A\nb\n', 'a\nB\n'), 'A\nB\n');
  assert.equal(changed('a\nb\n', 'A\nb\n', 'x\na\nb\n')[0].kind, 'conflict');
  assert.equal(changed('a\nb\n', 'a\nx\nb\n', 'a\ny\nb\n')[0].kind, 'conflict');
});

test('overlapping edit chains form one block and preserve each full side', () => {
  const base = 'a\nb\nc\nd\ne\nf\n';
  const ours = 'a\nB\nC\nd\nE\nf\n', theirs = 'a\nb\nX\nf\n';
  const blocks = mergeBlocks(base, ours, theirs);
  assert.equal(blocks.filter(block => block.kind === 'conflict').length, 1);
  assert.equal(blocks.map(block => block.ours).join(''), ours);
  assert.equal(blocks.map(block => block.theirs).join(''), theirs);
});

test('line endings, Unicode and missing final newlines survive', () => {
  assert.equal(simple('a\r\nb\r\n', 'α\r\nb\r\n', 'a\r\nβ\r\n'), 'α\r\nβ\r\n');
  assert.equal(simple('a\nb', 'A\nb', 'a\nB'), 'A\nB');
  assert.equal(simple('a', 'a\n', 'a'), 'a\n');
  assert.equal(chooseBlock(changed('a', 'b', 'c')[0], 'both'), 'b\nc');
});

test('working-file alignment preserves markers, manual edits, newlines and empty results exactly', () => {
  const blocks = mergeBlocks('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n', 'a\nX\nc\nd\nE\n');
  for (const working of ['a\n<<<<<<< HEAD\nB\n=======\nX\n>>>>>>> incoming\nc\nd\nE\n', 'hand-edited result', '', 'new\r\nlines\r\n', 'a\nB\nc\nd\nE\n']) {
    assert.equal(workingResults(blocks, working).join(''), working);
  }
});

test('rebase uses the replayed commit as Yours and stage 2 as Theirs', () => {
  assert.deepEqual(mergeSides('stage 2', 'stage 3', false), { ours: 'stage 2', theirs: 'stage 3' });
  assert.deepEqual(mergeSides('target', 'my commit', true), { ours: 'my commit', theirs: 'target' });
  assert.deepEqual(mergeSides(null, 'my commit', true), { ours: 'my commit', theirs: '' });
});

test('operation controls keep Continue blocked on conflicts and Skip limited to supported operations', () => {
  for (const operation of ['merge', 'rebase', 'cherry-pick', 'revert']) {
    assert.equal(operationControls(operation, 1).canContinue, false);
    assert.equal(operationControls(operation, 0).canContinue, true);
    assert.equal(operationControls(operation, 1).canSkip, operation !== 'merge');
  }
  assert.deepEqual(operationControls(null, 0), { supported: false, canContinue: false, canSkip: false });
  assert.equal(operationControls('unresolved conflicts', 1).supported, false);
});

test('many repeated-line inputs reconstruct all three versions and retain arbitrary working edits', () => {
  let seed = 17;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const text = () => Array.from({ length: Math.floor(random() * 12) }, () => ['a\n', 'b\n', 'c\n'][Math.floor(random() * 3)]).join('');
  for (let n = 0; n < 500; n++) {
    const base = text(), ours = text(), theirs = text(), working = text();
    const blocks = mergeBlocks(base, ours, theirs);
    assert.equal(blocks.map(block => block.base).join(''), base);
    assert.equal(blocks.map(block => block.ours).join(''), ours);
    assert.equal(blocks.map(block => block.theirs).join(''), theirs);
    assert.equal(workingResults(blocks, working).join(''), working);
    for (const block of blocks) {
      if (block.kind === 'ours') assert.equal(block.theirs, block.base);
      if (block.kind === 'theirs') assert.equal(block.ours, block.base);
      if (block.kind === 'both') assert.equal(block.ours, block.theirs);
    }
  }
});

test('working marker regions stay whole for simple resolution and Git-grouped nearby changes', () => {
  for (const [ours, theirs] of [['new\n', 'base\n'], ['new\n', 'new\n']]) {
    const working = `top\n<<<<<<< HEAD\n${ours}=======\n${theirs}>>>>>>> topic\nend\n`;
    const { blocks, results } = mergeFile('top\nbase\nend\n', 'top\n' + ours + 'end\n', 'top\n' + theirs + 'end\n', working);
    assert.equal(results.join(''), working);
    blocks.forEach((block, i) => { const result = simpleResolution(block); if (result !== null && block.kind !== 'unchanged') results[i] = result; });
    assert.equal(results.join(''), 'top\nnew\nend\n');
  }
  const working = 'a\n<<<<<<< HEAD\nB\nc\nd\n=======\nb\nc\nD\n>>>>>>> topic\ne\n';
  const { blocks, results } = mergeFile('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n', 'a\nb\nc\nD\ne\n', working);
  assert.equal(results.join(''), working);
  const index = results.findIndex(result => result.includes('<<<<<<<'));
  assert.ok(results[index].includes('>>>>>>>'));
  assert.equal(blocks[index].kind, 'conflict');
  results[index] = chooseBlock(blocks[index], 'ours');
  assert.equal(results.join(''), 'a\nB\nc\nd\ne\n');
});

test('automatic changes work inside Git-grouped marker regions without resolving true conflicts', () => {
  const working = 'top\n<<<<<<< HEAD\nA\ncenter\nours\n=======\na\ncenter\ntheirs\n>>>>>>> topic\nend\n';
  const { blocks } = mergeFile('top\na\ncenter\nbase\nend\n', 'top\nA\ncenter\nours\nend\n', 'top\na\ncenter\ntheirs\nend\n', working);
  const block = blocks.find(block => block.kind === 'conflict')!;
  const partial = automaticResolution(block, false)!;
  assert.ok(partial.startsWith('A\ncenter\n'));
  assert.ok(partial.includes('<<<<<<< Yours\nours\n=======\ntheirs\n>>>>>>> Theirs'));
  const disjoint = mergeFile('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n', '<<<<<<< HEAD\nA\nb\nc\n=======\na\nb\nC\n>>>>>>> topic\n');
  assert.equal(automaticResolution(disjoint.blocks[0], false), 'A\nb\nC\n');
  assert.equal(automaticResolution(changed('a\n', 'A\n', 'A\n')[0], false), null);
  assert.equal(automaticResolution(changed('a\n', 'A\n', 'A\n')[0], true), 'A\n');
});
