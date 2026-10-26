const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const data = require('./git-data');
const oid = 'a'.repeat(40), parent = 'b'.repeat(40);
const log = [oid, parent, 'Author', '2026-10-26T00:00:00Z', 'Subject', 'Subject\n\nBody\n'].join('\0') + '\0\n';

function git(respond = () => '') {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/git.js`, 'utf8'), { module, process,
    require: name => ({
      'node:child_process': { execFile(command, args, options, callback) {
        calls.push({ command, args: Array.from(args), options });
        const output = respond(args, options);
        if (output instanceof Error) callback(output, '', output.message);
        else callback(null, output, '');
      } },
      'node:path': path, 'node:fs/promises': { stat: async () => ({ mtimeMs: 3, ctimeMs: 4, size: 5 }) },
      './git-data': data
    })[name]
  });
  return { ...module.exports, calls };
}

test('discovery finds root; every subsequent Git call uses that root and argument arrays', async () => {
  const { repository, calls } = git(args => args.includes('--show-toplevel') ? '/repo\n' : log);
  const repo = await repository('/repo/nested');
  await repo.log();
  assert.equal(calls[0].options.cwd, '/repo/nested');
  assert.equal(calls[1].options.cwd, '/repo');
  for (const call of calls) {
    assert.equal(call.command, 'git');
    assert.equal(call.options.shell, undefined);
    assert.ok(call.args.includes('--literal-pathspecs'));
    assert.equal(call.options.timeout, 15000);
  }
});

test('revision reads and file diffs disable external tools and preserve path arguments', async () => {
  const { Repository, calls } = git(args => args.includes('diff-tree') ? 'R100\0old\0new\0' : 'contents');
  const repo = new Repository('/repo');
  assert.equal(await repo.show(oid, ':(glob)*;$(echo hello)'), 'contents');
  assert.ok(calls[0].args.includes(`${oid}::(glob)*;$(echo hello)`));
  assert.equal((await repo.files({ oid, parents: [parent] }))[0].path, 'new');
  assert.deepEqual(calls[1].args.slice(-3), [parent, oid, '--']);
  await repo.files({ oid, parents: [] });
  assert.ok(calls[2].args.includes('--root'));
  assert.throws(() => repo.show('--all', 'file'), /revision/);
  await assert.rejects(repo.blame('../secret', 1), /file path/);
  await assert.rejects(repo.blame('file', -1), /blame line/);
  await assert.rejects(repo.log({ limit: NaN }), /limit/);
  assert.equal(calls.length, 3);
});

test('blame uses porcelain and a single line; dirty and untracked files are skipped', async () => {
  const { Repository, calls } = git(args => {
    if (args.includes('blame')) return `${oid} 1 2 1\nauthor Author\nauthor-time 1000\nsummary Subject\nfilename file\n\ttext\n`;
    if (args.includes('diff')) return Object.assign(new Error('modified'), { code: 1 });
    return '';
  });
  const repo = new Repository('/repo');
  assert.equal(await repo.clean('file'), false);
  assert.ok(calls[1].args.includes('HEAD'));
  assert.equal((await repo.blame('file', 2)).author, 'Author');
  assert.deepEqual(calls[2].args.slice(-7), ['blame', '--porcelain', '-L', '2,2', 'HEAD', '--', 'file']);
});

test('graph is capped by the caller and file history follows names literally', async () => {
  const { Repository, calls } = git(() => log);
  const repo = new Repository('/repo');
  assert.equal((await repo.log({ limit: 2000, all: true })).length, 1);
  assert.ok(calls[0].args.includes('--all'));
  assert.ok(calls[0].args.includes('--topo-order'));
  assert.ok(calls[0].args.includes('--max-count=2000'));
  await repo.history('-file');
  assert.ok(calls[1].args.includes('--follow'));
  assert.deepEqual(calls[1].args.slice(-2), ['--', '-file']);
});
