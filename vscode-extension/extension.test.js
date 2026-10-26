const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Uri {
  constructor(fsPath, scheme = 'file') { Object.assign(this, { fsPath, scheme }); }
  static parse(value) { return value; }
}
const first = { name: 'first', uri: new Uri('/repo/first') };
const second = { name: 'second', uri: new Uri('/repo/second') };

function extension(state = {}) {
  const calls = { errors: [], external: [], picks: 0, unrefs: 0, subscriptions: [] };
  const vscode = {
    Uri,
    commands: { registerCommand(id, callback) {
      assert.equal(id, 'gitgui.open');
      calls.open = callback;
      return 'disposable';
    } },
    workspace: {
      workspaceFolders: state.folders,
      getWorkspaceFolder: () => state.editorFolder,
      getConfiguration: () => ({ get: () => state.configured || '' })
    },
    window: {
      activeTextEditor: state.editor ? { document: { uri: new Uri('/editor') } } : undefined,
      showErrorMessage: async (message, ...buttons) => {
        calls.errors.push({ message, buttons });
        return state.download ? 'Download GitGUI' : undefined;
      },
      showQuickPick: async items => {
        calls.picks++;
        return state.cancel ? undefined : items[1];
      }
    },
    env: { openExternal: async uri => { calls.external.push(uri); } }
  };
  const dependencies = {
    vscode,
    'node:fs': fs,
    './launch': { launchCommand(platform, folder, options) {
      calls.folder = folder;
      calls.configured = options.configured;
      return state.missing ? null : { command: 'gitgui', args: [folder] };
    } },
    './history': { activateHistory() {} },
    './git-data': require('./git-data'),
    'node:child_process': { spawn(command, args, options) {
      if (state.spawnError) throw state.spawnError;
      calls.spawn = { command, args, options: { ...options } };
      return {
        once(event, callback) { assert.equal(event, 'error'); calls.onError = callback; },
        unref() { calls.unrefs++; }
      };
    } }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/extension.js`, 'utf8'), {
    module, process, require: name => dependencies[name]
  });
  module.exports.activate({ subscriptions: calls.subscriptions });
  return calls;
}

test('the active editor selects its workspace and launches detached', async () => {
  const calls = extension({ folders: [first, second], editor: true, editorFolder: second, configured: '/custom/app' });
  await calls.open();
  assert.equal(calls.folder, second.uri.fsPath);
  assert.equal(calls.picks, 0);
  assert.equal(calls.configured, '/custom/app');
  assert.deepEqual(calls.spawn, {
    command: 'gitgui', args: [second.uri.fsPath], options: { detached: true, stdio: 'ignore' }
  });
  assert.equal(calls.unrefs, 1);
  assert.deepEqual(calls.subscriptions, ['disposable']);
});

test('one workspace folder opens directly, including SCM title invocation', async () => {
  const calls = extension({ folders: [first] });
  await calls.open({ rootUri: first.uri });
  assert.equal(calls.folder, first.uri.fsPath);
  assert.equal(calls.picks, 0);
});

test('multiple folders without an editor prompt for a folder', async () => {
  const calls = extension({ folders: [first, second] });
  await calls.open();
  assert.equal(calls.folder, second.uri.fsPath);
  assert.equal(calls.picks, 1);
});

test('cancelling the folder picker does not launch', async () => {
  const calls = extension({ folders: [first, second], cancel: true });
  await calls.open();
  assert.equal(calls.spawn, undefined);
  assert.equal(calls.errors.length, 0);
});

test('Explorer opens the clicked folder even without a workspace', async () => {
  const calls = extension();
  await calls.open(new Uri('/clicked/folder'));
  assert.equal(calls.folder, '/clicked/folder');
});

test('no workspace and remote folders report errors without launching', async () => {
  for (const resource of [undefined, new Uri('/remote/repo', 'vscode-remote')]) {
    const calls = extension();
    await calls.open(resource);
    assert.equal(calls.errors.length, 1);
    assert.equal(calls.spawn, undefined);
  }
});

test('missing GitGUI offers a download and opens the releases page', async () => {
  const calls = extension({ folders: [first], missing: true, download: true });
  await calls.open();
  assert.deepEqual(calls.errors[0].buttons, ['Download GitGUI']);
  assert.deepEqual(calls.external, ['https://github.com/MDHaarith/GitGUI/releases']);
  assert.equal(calls.spawn, undefined);
});

test('synchronous and asynchronous spawn errors are reported', async () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const calls = extension({ folders: [first], spawnError: denied });
  await calls.open();
  assert.match(calls.errors[0].message, /permission denied/);

  const asyncCalls = extension({ folders: [first], download: true });
  await asyncCalls.open();
  await asyncCalls.onError(denied);
  assert.match(asyncCalls.errors[0].message, /permission denied/);
  await asyncCalls.onError(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  assert.deepEqual(asyncCalls.external, ['https://github.com/MDHaarith/GitGUI/releases']);
});

test('commit links pass a validated revision without changing normal launch arguments', async () => {
  const calls = extension();
  const oid = 'a'.repeat(40);
  await calls.open(first.uri, oid);
  assert.deepEqual(calls.spawn.args, [first.uri.fsPath, '--commit', oid]);
  const invalid = extension();
  await invalid.open(first.uri, '--help');
  assert.equal(invalid.spawn, undefined);
  assert.match(invalid.errors[0].message, /revision/);
});
