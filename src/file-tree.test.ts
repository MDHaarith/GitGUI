import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folders } from './file-tree.ts';

test('folders count all descendants without treating root files or backslashes as folders', () => {
  assert.deepEqual([...folders(['README.md', 'src/main.ts', 'src/git/process.rs', 'src/git/files.rs', 'tests/a.ts', 'literal\\file'].map(path => ({ path })))], [['src', 3], ['src/git', 2], ['tests', 1]]);
});
