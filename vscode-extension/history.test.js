const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { relativePath } = require('./git-data');
const oid = 'a'.repeat(40), parent = 'b'.repeat(40);
const commit = { oid, parents: [parent], subject: 'Subject', author: 'Author', date: '2026-10-26T00:00:00Z', message: 'Subject\nBody' };

function harness(files = [{ status: 'M', path: 'file.js', oldPath: 'file.js' }]) {
  const commands = new Map(), calls = { diffs: [], errors: [], limits: [], picks: 0, roots: [] };
  const subscriptions = [];
  const noop = () => ({ dispose() {} });
  const events = {};
  class EventEmitter {
    constructor() { this.listeners = []; this.event = fn => { this.listeners.push(fn); return noop(); }; }
    fire(value) { for (const fn of this.listeners) fn(value); }
    dispose() {}
  }
  class Uri {
    constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
    static file(value) { return new Uri(value); }
    static from(value) { return Object.assign(new Uri(value.path), value); }
  }
  const repo = { root: '/repo',
    relative: file => relativePath('/repo', file),
    log: async options => { calls.limits.push(options.limit); return Array.from({ length: 51 }, (_, i) => ({ ...commit, oid: i.toString(16).padStart(40, '0') })); },
    commit: async () => commit, files: async () => files,
    history: async () => [{ ...commit, file: files[0].path }],
    show: async (rev, file) => { calls.show = { rev, file }; return 'revision text'; }
  };
  const vscode = { Uri, EventEmitter,
    TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, ThemeIcon: class {},
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return noop(); },
      executeCommand: async (...args) => { calls.diffs.push(args); }
    },
    window: {
      activeTextEditor: { document: { uri: new Uri('/repo/file.js') } },
      createTreeView: (id, options) => { calls.view = { message: '', ...noop() }; calls.tree = options.treeDataProvider; return calls.view; },
      showQuickPick: async items => { calls.picks++; return items[0]; },
      showErrorMessage: async message => { calls.errors.push(message); }, showInformationMessage: noop,
      onDidChangeActiveTextEditor: fn => { events.editor = fn; return noop(); }
    },
    workspace: {
      workspaceFolders: [{ name: 'repo', uri: new Uri('/repo') }, { name: 'other', uri: new Uri('/other') }],
      registerTextDocumentContentProvider: (scheme, provider) => { calls.provider = provider; assert.equal(scheme, 'gitgui-rev'); return noop(); },
      onDidChangeWorkspaceFolders: noop,
      createFileSystemWatcher: () => ({ ...noop(), onDidChange: fn => { events.change = fn; return noop(); },
        onDidCreate: noop, onDidDelete: noop })
    },
    extensions: { getExtension: () => undefined }
  };
  let timeout;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/history.js`, 'utf8'), { module,
    setTimeout: fn => { timeout = fn; }, clearTimeout() {},
    require: name => ({ vscode, 'node:path': path,
      './git': { repository: async directory => { calls.roots.push(directory); return repo; } },
      './git-data': require('./git-data'), './inline-blame': { activateBlame() {} },
      './graph-webview': { openGraph: async () => { calls.graph = true; } }
    })[name]
  });
  module.exports.activateHistory({ subscriptions });
  return { calls, commands, vscode, repo, commit, files, events, subscriptions, flush: () => timeout() };
}

test('commits tree paginates and expands changed files; background refresh never prompts', async () => {
  const { calls, commands, vscode, events, flush } = harness();
  vscode.window.activeTextEditor = undefined;
  const children = await calls.tree.getChildren();
  assert.equal(children.length, 51);
  assert.equal(calls.picks, 0);
  assert.equal(children.at(-1).kind, 'more');
  assert.equal(calls.tree.getTreeItem(children[0]).description, 'Author · 2026-10-26');
  const files = await calls.tree.getChildren(children[0]);
  assert.equal(calls.tree.getTreeItem(files[0]).command.command, 'gitgui.showDiff');
  await commands.get('gitgui.loadMoreCommits')();
  assert.equal((await calls.tree.getChildren()).length, 51);
  assert.equal(calls.limits.at(-1), 101);
  events.change(); flush();
  await calls.tree.getChildren();
  assert.equal(calls.limits.at(-1), 51);
});

test('diff provider handles edits, additions, deletions, renames and initial commits', async () => {
  for (const [status, before, after] of [['M', parent, oid], ['A', '', oid], ['D', parent, ''], ['R', parent, oid]]) {
    const { calls, commands } = harness([{ status, oldPath: 'old.js', path: 'new.js' }]);
    await calls.tree.getChildren();
    await commands.get('gitgui.showDiff')({ root: '/repo', oid, file: 'new.js' });
    assert.deepEqual(calls.errors, []);
    const [id, left, right] = calls.diffs[0];
    assert.equal(id, 'vscode.diff');
    assert.equal(left.scheme, 'gitgui-rev');
    assert.equal(JSON.parse(left.query).rev, before);
    assert.equal(JSON.parse(right.query).rev, after);
    assert.equal(JSON.parse(left.query).file, 'old.js');
    assert.equal(await calls.provider.provideTextDocumentContent(right), after ? 'revision text' : '');
  }
  const { calls, commands, repo } = harness();
  repo.commit = async () => ({ ...commit, parents: [] });
  await calls.tree.getChildren();
  await commands.get('gitgui.showDiff')({ root: '/repo', oid, file: 'file.js' });
  assert.equal(JSON.parse(calls.diffs[0][1].query).rev, '');
});

test('revision provider rejects traversal, forged repos and flags; Git failures surface', async () => {
  const { calls, commands, repo } = harness();
  await calls.tree.getChildren();
  for (const data of [{ root: '/elsewhere', rev: oid, file: 'file.js' },
    { root: '/repo', rev: '--all', file: 'file.js' }, { root: '/repo', rev: oid, file: '../secret' }]) {
    await assert.rejects(calls.provider.provideTextDocumentContent({ query: JSON.stringify(data) }));
  }
  await commands.get('gitgui.showDiff')({ root: '/repo', oid, file: 'not-changed' });
  assert.match(calls.errors[0], /not changed/);
  repo.show = async () => { throw new Error('missing blob'); };
  await assert.rejects(calls.provider.provideTextDocumentContent({
    query: JSON.stringify({ root: '/repo', rev: oid, file: 'file.js' })
  }), /missing blob/);
});

test('Explorer file history uses historical file name and opens its revision diff', async () => {
  const { calls, commands, vscode } = harness([{ status: 'M', path: 'old.js', oldPath: 'old.js' }]);
  await commands.get('gitgui.fileHistory')(vscode.Uri.file('/repo/new.js'));
  assert.equal(calls.picks, 1);
  assert.equal(calls.diffs[0][0], 'vscode.diff');
  assert.equal(JSON.parse(calls.diffs[0][2].query).file, 'old.js');
  await commands.get('gitgui.openCommit')({ root: '/repo', oid });
  assert.equal(calls.diffs[1][0], 'gitgui.open');
  assert.equal(calls.diffs[1][2], oid);
});
