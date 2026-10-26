const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const oid = 'a'.repeat(40);

function harness() {
  const calls = { blame: 0, decorations: [], events: {}, enabled: true, fileRevision: 'head:mtime', clean: true };
  const disposable = { dispose() {} };
  const on = event => fn => { calls.events[event] = fn; return disposable; };
  class MarkdownString {
    constructor() { this.text = ''; this.markdown = ''; }
    appendText(value) { this.text += value; }
    appendMarkdown(value) { this.markdown += value; }
  }
  const editor = { document: { uri: { scheme: 'file', fsPath: '/repo/file.js' }, isDirty: false, version: 1,
    lineAt: () => ({ range: 'line-range' }) }, selection: { active: { line: 2 } },
    setDecorations: (_, items) => calls.decorations.push(items) };
  const vscode = { MarkdownString, ThemeColor: class {}, DecorationRangeBehavior: { ClosedClosed: 1 },
    window: { activeTextEditor: editor, visibleTextEditors: [editor], createTextEditorDecorationType: () => disposable,
      onDidChangeActiveTextEditor: on('editor'), onDidChangeTextEditorSelection: on('selection') },
    workspace: { getConfiguration: () => ({ get: () => calls.enabled }),
      onDidChangeTextDocument: on('document'), onDidSaveTextDocument: on('save'), onDidChangeConfiguration: on('config') }
  };
  const repo = { root: '/repo', relative: () => 'file.js', fileRevision: async () => calls.fileRevision,
    clean: async () => calls.clean,
    blame: async (file, line) => { calls.blame++; calls.line = line;
      return { oid, path: calls.path || 'file.js', author: '[evil](command:other)', subject: 'Summary', time: 1000 }; },
    commit: async () => ({ message: 'Subject\n\nFull message <script> & [link](command:other)' }) };
  const subscriptions = [];
  let timer;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/inline-blame.js`, 'utf8'), { module,
    setTimeout: fn => { timer = fn; }, clearTimeout() {},
    require: name => name === 'vscode' ? vscode : require('./git-data')
  });
  module.exports.activateBlame({ subscriptions }, async () => repo, on('repository'));
  return { calls, editor, repo, subscriptions, run: () => timer() };
}

test('inline blame caches a file revision and trusts only its two hover commands', async () => {
  const { calls, run } = harness();
  await run();
  const option = calls.decorations.at(-1)[0];
  assert.match(option.renderOptions.after.contentText, /Summary/);
  assert.equal(calls.line, 3);
  assert.match(option.hoverMessage.text, /Full message/);
  assert.ok(!option.hoverMessage.markdown.includes('command:other'));
  assert.deepEqual(Array.from(option.hoverMessage.isTrusted.enabledCommands), ['gitgui.openCommit', 'gitgui.showDiff']);
  const args = JSON.parse(decodeURIComponent(option.hoverMessage.markdown.match(/openCommit\?([^)]*)/)[1]));
  assert.equal(args[0].oid, oid);
  calls.events.selection(); await run();
  assert.equal(calls.blame, 1);
  calls.fileRevision = 'new-head:mtime'; calls.events.selection(); await run();
  assert.equal(calls.blame, 2);
  calls.events.repository(); await run();
  assert.equal(calls.blame, 3);
});

test('dirty documents, modified/untracked files, disabled settings and remote URIs have no blame', async () => {
  for (const state of ['dirty', 'untracked', 'disabled', 'remote']) {
    const { calls, editor, run } = harness();
    if (state === 'dirty') editor.document.isDirty = true;
    if (state === 'untracked') calls.clean = false;
    if (state === 'disabled') calls.enabled = false;
    if (state === 'remote') editor.document.uri.scheme = 'vscode-remote';
    await run();
    assert.equal(calls.blame, 0);
    assert.equal(calls.decorations.at(-1).length, 0);
  }
});

test('hover links encode parentheses in repository paths and filenames', async () => {
  const { calls, repo, run } = harness();
  repo.root = '/repo(with-parenthesis)';
  calls.path = 'src/file).js';
  await run();
  const markdown = calls.decorations.at(-1)[0].hoverMessage.markdown;
  const encoded = markdown.match(/openCommit\?([^)]*)/)[1];
  const [args] = JSON.parse(decodeURIComponent(encoded));
  assert.equal(args.file, 'src/file).js');
  assert.equal(args.root, repo.root);
  assert.ok(!/[()]/.test(encoded));
});

test('a stale blame response never decorates a different selection or a disposed extension', async () => {
  const { calls, editor, repo, run, subscriptions } = harness();
  const blame = repo.blame;
  let finish;
  repo.blame = async (...args) => { await new Promise(resolve => { finish = resolve; }); return blame(...args); };
  const pending = run();
  await new Promise(resolve => setImmediate(resolve));
  editor.selection.active.line++;
  calls.events.selection();
  finish(); await pending;
  assert.equal(calls.decorations.at(-1).length, 0);
  subscriptions.at(-1).dispose();
  await run();
  assert.equal(calls.decorations.at(-1).length, 0);
});
