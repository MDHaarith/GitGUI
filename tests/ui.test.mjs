// Renders the real UI in headless Chromium with a fake repository behind a mocked Tauri bridge,
// and checks the layout problems users reported: overlaps, cramped rows, and overflowing dialogs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const oid = n => String(n).repeat(40);
const repo = {
  id: 1, root: '/tmp/demo', branch: 'main', head: oid(3), detached: false, upstream: 'origin/main', ahead: 1, behind: 0, operation: null,
  remotes: [{ id: '6f726967696e', name: 'origin', url: 'https://example.invalid/demo.git' }],
  files: [
    { id: '61', path: 'src/app.ts', oldPath: null, oldId: null, index: 'M', worktree: '.', untracked: false, conflicted: false, submodule: false },
    { id: '62', path: 'README.md', oldPath: null, oldId: null, index: '.', worktree: 'M', untracked: false, conflicted: false, submodule: false },
  ],
  token: 't', version: '0.3.0', versioning: true, refsToken: 'r',
};
const ref = (name, kind, target, isHead = false) => ({ id: Buffer.from(name).toString('hex'), name, fullName: name, kind, target, isHead });
const page = {
  graphId: 1, head: oid(3), hasMore: false,
  commits: [3, 2, 1].map(n => ({ oid: oid(n), shortOid: oid(n).slice(0, 7), parents: n > 1 ? [oid(n - 1)] : [], subject: 'Commit ' + n, author: 'Dev', timestamp: 1_700_000_000 + n, shallow: false })),
  refs: [ref('main', 'local', oid(3), true), ref('feature', 'local', oid(2)), ref('origin/main', 'remote', oid(2)), ref('origin/feature', 'remote', oid(2))],
};
const diff = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # Demo\n-Old words here\n+New words here\n end\n';
const responses = {
  startup_path: null, 'plugin:app|version': '0.12.0', latest_release: null, open_repository: repo, get_status: repo,
  get_graph: page, get_health: [], get_working_diff: { text: diff, truncated: false, binary: false }, list_stashes: [], list_checkpoints: [],
};
function mockTauri(responses) {
  let next = 1;
  localStorage.setItem('onboarded', '1'); localStorage.setItem('lastRepository', '/tmp/demo'); localStorage.setItem('updateChecked', String(Date.now()));
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    transformCallback: () => next++, unregisterCallback() {}, convertFileSrc: path => path,
    invoke: async cmd => (cmd in responses ? structuredClone(responses[cmd]) : null),
  };
}
function chrome() {
  const cache = join(homedir(), '.cache/ms-playwright');
  const found = existsSync(cache) && readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()
    .map(name => join(cache, name, 'chrome-linux64/chrome')).find(existsSync);
  return process.env.CHROME_PATH ?? found ?? undefined;
}
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

let server, browser, tab;
before(async () => {
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({ executablePath: chrome() });
  tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await tab.addInitScript(mockTauri, responses);
  await tab.goto(server.resolvedUrls.local[0]);
  await tab.locator('#history-rows tr').first().waitFor();
});
after(async () => { await browser?.close(); await server?.close(); });

test('the fake repository renders with branches, remote actions, and three commits', async () => {
  assert.equal(await tab.locator('#history-rows tr').count(), 3);
  assert.equal(await tab.locator('.ref-action', { hasText: 'Check out' }).count(), 2);
});

test('the progress bar never covers the repository picker', async () => {
  await tab.evaluate(() => { document.getElementById('operation-feedback').hidden = false; });
  const [bar, picker] = await Promise.all([tab.locator('#operation-feedback').boundingBox(), tab.locator('.toolbar .select-control').boundingBox()]);
  assert.ok(!overlap(bar, picker), JSON.stringify({ bar, picker }));
  await tab.evaluate(() => { document.getElementById('operation-feedback').hidden = true; });
});

test('tips sit apart from the workspace', async () => {
  await tab.evaluate(() => { const h = document.getElementById('git-hint'); h.hidden = false; h.innerHTML = '<li class="hint"><span>Tip</span><button>×</button></li>'; });
  const [hints, work] = await Promise.all([tab.locator('#git-hint').boundingBox(), tab.locator('#branch-sidebar').boundingBox()]);
  assert.ok(work.y - (hints.y + hints.height) >= 8, `gap ${work.y - hints.y - hints.height}`);
});

test('commit form controls do not overlap', async () => {
  await tab.click('#changes-button');
  const ids = ['#summary', '#body', '#ai-message', '#ai-explain', '#ai-settings', '#amend', '#bump', '#commit-button'];
  const boxes = await Promise.all(ids.map(id => tab.locator(id).boundingBox()));
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (boxes[i] && boxes[j]) assert.ok(!overlap(boxes[i], boxes[j]), `${ids[i]} overlaps ${ids[j]}`);
  }
});

test('working diffs offer hunk staging, word highlights, and a side-by-side view', async () => {
  await tab.locator('button.file-name', { hasText: 'README.md' }).click();
  await tab.locator('#working-diff .hunk-action').waitFor();
  assert.equal(await tab.locator('#working-diff mark').count(), 2);
  await tab.locator('.working-preview .diff-toggle').click();
  assert.ok(await tab.locator('#working-diff.split .diff-line.pair').count() >= 2);
  mkdirSync('test-results', { recursive: true });
  await tab.screenshot({ path: 'test-results/ui-changes.png' });
  await tab.locator('.working-preview .diff-toggle').click();
});

test('every dialog fits the window without sideways scrolling', async () => {
  const ids = await tab.evaluate(() => [...document.querySelectorAll('dialog')].map(d => d.id));
  for (const id of ids) {
    const fits = await tab.evaluate(id => {
      const d = document.getElementById(id); d.showModal();
      const box = d.getBoundingClientRect(); const ok = d.scrollWidth <= d.clientWidth + 1 && box.right <= innerWidth && box.bottom <= innerHeight;
      if (id === 'help-dialog') return ok; d.close(); return ok;
    }, id);
    assert.ok(fits, id + ' overflows');
  }
  await tab.screenshot({ path: 'test-results/ui-help.png' });
});
