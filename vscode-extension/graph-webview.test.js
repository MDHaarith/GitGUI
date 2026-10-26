const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const oid = 'a'.repeat(40);

function harness() {
  const calls = { messages: [], errors: [], diffs: [] };
  let listener, onChange, dispose;
  const noop = () => ({ dispose() {} });
  const panel = { ...noop(), webview: { postMessage: async data => { calls.messages.push(data); },
    onDidReceiveMessage: fn => { listener = fn; return noop(); } },
    onDidDispose: fn => { dispose = fn; return noop(); } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/graph-webview.js`, 'utf8'), { module, __dirname,
    require: name => name === 'vscode' ? { window: { createWebviewPanel: (type, title, column, options) => {
      calls.options = options; return panel;
    } }, ViewColumn: { Active: 1 } } : require(name)
  });
  const commit = { oid, parents: [], subject: '<img src=x onerror=alert(1)>', author: 'Author', date: '2026-10-26', message: 'Body' };
  const repo = { root: '/repo', log: async options => { calls.logOptions = options; return [commit]; },
    files: async () => [{ path: 'file.js', oldPath: 'file.js', status: 'A' }] };
  return { ...module.exports, calls, repo, panel,
    start: () => module.exports.openGraph({ subscriptions: [] }, repo, async data => calls.diffs.push(data),
      fn => { onChange = fn; return noop(); }, error => calls.errors.push(error.message)),
    receive: data => listener(data), refresh: () => onChange(), dispose: () => dispose() };
}

test('webview CSP uses nonces with no remote or local resource access', async () => {
  const { start, panel, calls } = harness();
  await start();
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /script-src 'nonce-[a-f0-9]+'/);
  assert.match(panel.webview.html, /style-src 'nonce-[a-f0-9]+'/);
  assert.ok(!panel.webview.html.includes('unsafe-inline'));
  assert.ok(!panel.webview.html.includes('innerHTML'));
  assert.equal(calls.options.localResourceRoots.length, 0);
  assert.equal(calls.options.enableScripts, true);
  assert.ok(!panel.webview.html.includes('<img src=x'));
});

test('graph messages only accept loaded commits and changed files, then refresh', async () => {
  const h = harness();
  await h.start();
  await h.receive({ type: 'ready' });
  assert.equal(h.calls.logOptions.limit, 2000);
  assert.equal(h.calls.logOptions.all, true);
  assert.equal(h.calls.messages[0].graph.nodes.length, 1);
  await h.receive({ type: 'select', oid: '--all' });
  await h.receive({ type: 'diff', oid, file: 'file.js' });
  assert.equal(h.calls.errors.length, 2);
  await h.receive({ type: 'select', oid });
  await h.receive({ type: 'diff', oid, file: '../secret' });
  assert.equal(h.calls.diffs.length, 0);
  await h.receive({ type: 'diff', oid, file: 'file.js' });
  assert.equal(h.calls.diffs.length, 1);
  await h.refresh();
  assert.equal(h.calls.messages.at(-1).type, 'commits');
  h.dispose();
});

test('graph client renders repository text as text and supports keyboard-native buttons', () => {
  const elements = new Map();
  class Element {
    constructor() { this.children = []; this.attributes = {}; this.listeners = {}; }
    setAttribute(key, value) { this.attributes[key] = value; }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
  }
  let receive;
  const messages = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'graph-client.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: data => messages.push(data) }),
    window: { addEventListener: (_, fn) => { receive = fn; } },
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
      createElement: tag => { assert.equal(tag, 'button'); return new Element(); },
      createElementNS: () => new Element() }
  });
  const subject = '<img src=x onerror=alert(1)>';
  receive({ data: { type: 'commits', commits: [{ oid, subject, author: 'Author', date: '2026-10-26' }],
    graph: { nodes: [{ oid, lane: 0, row: 0 }], edges: [], width: 1 } } });
  const button = elements.get('commits').children[0];
  assert.ok(button.textContent.includes(subject));
  button.listeners.click();
  assert.equal(messages.at(-1).type, 'select');
  assert.equal(button.attributes['aria-pressed'], 'true');
});
