import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandText } from './terminal-api.ts';

test('Git log arguments stay unambiguous for spaces, quotes, newlines and HTML', () => {
  assert.equal(commandText(['status', '--short']), 'git status --short');
  assert.equal(commandText(['commit', '-m', 'two words\n"quoted"']), 'git commit -m "two words\\n\\"quoted\\""');
  assert.equal(commandText(['add', '--', '<img src=x onerror=alert(1)>', '']), 'git add -- "<img src=x onerror=alert(1)>" ""');
});
