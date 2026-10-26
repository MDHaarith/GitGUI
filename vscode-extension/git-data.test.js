const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { revision, filePath, relativePath, parseLog, parseFiles, parseHistory, parseBlame, relativeTime } = require('./git-data');
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const date = '2026-10-26T12:00:00+05:30';
const record = (oid, parents, subject, message = subject + '\n') =>
  [oid, parents, 'A. Author', date, subject, message].join('\0') + '\0';

test('log fixtures preserve merge parents, Unicode, tabs and full multiline messages', () => {
  const commits = parseLog(record(a, `${b} ${c}`, 'Merge <script> café', 'Title\n\nBody\twith separators\x1e\n') +
    '\n' + record(b, '', 'Root'));
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0].parents, [b, c]);
  assert.equal(commits[0].message, 'Title\n\nBody\twith separators\x1e\n');
  assert.equal(commits[0].subject, 'Merge <script> café');
  assert.deepEqual(commits[1].parents, []);
  assert.deepEqual(parseLog(''), []);
});

test('NUL-delimited files include additions, deletions, renames and unusual names', () => {
  const files = parseFiles('A\0new\0D\0gone\0R100\0old name\0new\tname\0M\0line\nbreak\0C075\0source\0copy\0');
  assert.deepEqual(files, [
    { status: 'A', path: 'new', oldPath: 'new' },
    { status: 'D', path: 'gone', oldPath: 'gone' },
    { status: 'R', path: 'new\tname', oldPath: 'old name' },
    { status: 'M', path: 'line\nbreak', oldPath: 'line\nbreak' },
    { status: 'C', path: 'copy', oldPath: 'source' }
  ]);
  assert.throws(() => parseFiles('R100\0old\0'), /file path/);
});

test('follow history tracks the historical path across renames', () => {
  const fixture = record(a, b, 'Latest') + '\0\nM\0src/new.js\0\0' +
    record(b, c, 'Rename') + '\0\nR100\0src/old.js\0src/new.js\0\0' +
    record(c, '', 'Initial') + '\0\nA\0src/old.js\0';
  const commits = parseHistory(fixture, 'src/new.js');
  assert.deepEqual(commits.map(item => [item.oid, item.file]), [[a, 'src/new.js'], [b, 'src/new.js'], [c, 'src/old.js']]);
  assert.deepEqual(parseHistory('', 'src/new.js'), []);
});

test('porcelain blame fixture decodes quoted paths and ignores source text', () => {
  const fixture = `${a} 1 4 1\nauthor A. Author\nauthor-time 1700000000\n` +
    'summary Change café\nboundary\nfilename "src/caf\\303\\251\\tfile.js"\n\tauthor NOT THE AUTHOR\n';
  assert.deepEqual(parseBlame(fixture), { oid: a, author: 'A. Author', time: 1700000000000,
    subject: 'Change café', path: 'src/café\tfile.js' });
  assert.equal(parseBlame(fixture.replace(a, '0'.repeat(40))), null);
  assert.equal(parseBlame('not blame output'), null);
  assert.equal(parseBlame(fixture.replace('src/caf\\303\\251\\tfile.js', 'src/😀\\tfile.js')).path, 'src/😀\tfile.js');
});

test('only supported refs and repository-relative paths reach Git', () => {
  for (const value of ['HEAD', a, 'b'.repeat(64)]) assert.equal(revision(value), value);
  for (const value of ['', '--all', 'main', 'HEAD~1', a + ':file', 'abc\0def', null]) assert.throws(() => revision(value));
  for (const value of ['../secret', '/etc/passwd', 'C:\\secret', 'C:/secret', 'x/../y', './a', 'x//y', 'x\0y', 'x\\y']) {
    assert.throws(() => filePath(value));
  }
  for (const value of ['-option', ':(glob)*', 'src/a b;$(echo x).js', 'src/line\nbreak']) assert.equal(filePath(value), value);
  assert.equal(relativePath(path.resolve('/repo'), path.resolve('/repo/src/file')), 'src/file');
  assert.throws(() => relativePath(path.resolve('/repo'), path.resolve('/other/file')));
});

test('relative time handles singular, plural and future timestamps', () => {
  const now = 2000000000000;
  assert.equal(relativeTime(now + 1000, now), 'just now');
  assert.equal(relativeTime(now - 60000, now), '1 minute ago');
  assert.equal(relativeTime(now - 7200000, now), '2 hours ago');
  assert.equal(relativeTime(now - 86400000, now), '1 day ago');
});
