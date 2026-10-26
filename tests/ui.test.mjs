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
const symbol = (kind, file, name) => ({ kind, name, qualified_name: kind === 'File' ? `/tmp/demo/${file}` : `/tmp/demo/${file}::${name}`, file_path: `/tmp/demo/${file}`, line_start: 3, language: 'typescript' });
const codeMap = JSON.stringify({
  nodes: [symbol('File', 'src/app.ts', 'app'), symbol('Function', 'src/app.ts', 'start'), symbol('File', 'src/git.ts', 'git'), symbol('Function', 'src/git.ts', 'openRepo'), symbol('Function', 'src/git.ts', 'readStatus')],
  edges: [{ kind: 'CALLS', source: '/tmp/demo/src/app.ts::start', target: '/tmp/demo/src/git.ts::openRepo' }],
});
const responses = {
  startup_path: null, 'plugin:app|version': '0.12.0', latest_release: null, open_repository: repo, get_status: repo,
  get_graph: page, get_health: [], get_working_diff: { text: diff, truncated: false, binary: false }, list_stashes: [], list_checkpoints: [], code_map: codeMap,
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
  assert.equal(await tab.locator('#ref-list .ref-item[data-kind="remote"]').count(), 2);
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

test('the code map draws files, links them, and searches symbols', async () => {
  await tab.click('#tools-button'); await tab.click('#codemap-button');
  await tab.locator('#codemap-dialog[open] #codemap-graph circle').first().waitFor();
  assert.equal(await tab.locator('#codemap-graph circle').count(), 2);
  assert.equal(await tab.locator('#codemap-graph .links path').count(), 1);
  await tab.fill('#codemap-search', 'open');
  assert.equal(await tab.locator('#codemap-results li').count(), 1);
  assert.equal(await tab.locator('#codemap-graph .nodes g.on').count(), 1);
  await tab.screenshot({ path: 'test-results/ui-codemap.png' });
  await tab.evaluate(() => document.getElementById('codemap-dialog').close());
});

test('GitHub hub keeps review drafts local and routes explicit writes through the bridge', async () => {
  await tab.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const pull = { number: 7, title: 'Keyboard navigation', state: 'OPEN', author: { login: 'dev' }, body: '<script>window.githubUnsafe = true</script>', headRefOid: 'a'.repeat(40), headRefName: 'feature', baseRefName: 'main', changedFiles: 1, files: [{ path: 'src/file.ts' }], statusCheckRollup: [{ name: 'Build', conclusion: 'SUCCESS' }], reviewRequests: [{ login: 'reviewer' }], latestReviews: [] };
    window.githubWrites = []; window.githubWriteFail = false;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'plugin:dialog|message') return 'Ok';
      if (cmd === 'github_write') {
        window.githubWrites.push(structuredClone(args.request));
        if (window.githubWriteFail) throw new Error('Offline fixture failure');
        return null;
      }
      if (cmd === 'get_graph' && window.githubRefreshFail) throw new Error('Local refresh fixture failure');
      if (cmd !== 'github_read') return original(cmd, args);
      switch (args.request.kind) {
        case 'repository': return { name: 'example/demo' };
        case 'pulls': return [pull];
        case 'pull': return pull;
        case 'diff': return { text: '--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+new', binary: false, truncated: false };
        case 'issues': return [{ number: 8, title: 'Bug report', state: 'OPEN' }];
        case 'issue': return { number: 8, title: 'Bug report', state: 'OPEN', body: 'Details', comments: [{ author: { login: 'dev' }, body: 'Existing comment', createdAt: '2026-10-26' }] };
        case 'runs': return [{ databaseId: 10, displayTitle: 'CI', status: 'completed', conclusion: 'failure', headBranch: 'main' }];
        case 'run': return { databaseId: 10, displayTitle: 'CI', status: 'completed', conclusion: 'failure', headBranch: 'main', jobs: [{ name: 'Test', status: 'completed', conclusion: 'failure' }] };
        case 'log': return { text: 'failed test fixture', binary: false, truncated: true };
        case 'releases': return [{ id: 1, name: 'Version 1', tag_name: 'v1', body: 'Release notes fixture', published_at: '2026-10-26', draft: false, prerelease: false }];
        case 'notifications': return [{ id: '123', unread: true, repository: { full_name: 'example/demo' }, subject: { title: 'Review requested', type: 'PullRequest' }, reason: 'review_requested' }];
        case 'readme': return { text: '# README fixture', truncated: false };
        case 'branches': return [{ name: 'main', protected: true }];
        case 'commits': return [{ sha: 'b'.repeat(40), commit: { message: 'Recent commit fixture', author: { name: 'Dev', date: '2026-10-26' } } }];
        default: throw new Error('Unexpected GitHub read: ' + args.request.kind);
      }
    };
  });
  await tab.click('#tools-button'); await tab.click('#github-button');
  await tab.locator('#github-list button', { hasText: '#7' }).click();
  assert.equal(await tab.evaluate(() => window.githubUnsafe), undefined);
  assert.equal(await tab.locator('#github-detail script').count(), 0);
  await tab.locator('#github-detail select[aria-label="Pull request file"]').selectOption('src/file.ts', { force: true });
  await tab.getByRole('button', { name: 'Comment on new line 2', exact: true }).click();
  await tab.getByRole('textbox', { name: 'Inline review comment', exact: true }).fill('Check this line');
  await tab.getByRole('button', { name: 'Add to pending review', exact: true }).click();
  assert.equal(await tab.evaluate(() => window.githubWrites.length), 0);
  await tab.getByRole('textbox', { name: 'Review summary', exact: true }).fill('Summary fixture');
  await tab.evaluate(() => { window.githubWriteFail = true; });
  await tab.getByRole('button', { name: 'Submit review', exact: true }).click();
  await tab.locator('#github-error', { hasText: 'Offline fixture failure' }).waitFor();
  assert.equal(await tab.getByRole('textbox', { name: 'Review summary', exact: true }).inputValue(), 'Summary fixture');
  assert.ok((await tab.locator('#github-detail').textContent()).includes('Check this line'));
  await tab.evaluate(() => { window.githubWriteFail = false; window.githubRefreshFail = true; });
  await tab.getByRole('button', { name: 'Submit review', exact: true }).click();
  await tab.waitForFunction(() => document.querySelector('[aria-label="Review summary"]').value === '');
  const writes = await tab.evaluate(() => window.githubWrites);
  assert.deepEqual(writes.at(-1).comments, [{ path: 'src/file.ts', line: 2, side: 'RIGHT', body: 'Check this line' }]);
  assert.equal(writes.at(-1).event, 'COMMENT');
  assert.equal(writes.at(-1).head, 'a'.repeat(40));
  await tab.evaluate(() => { window.githubRefreshFail = false; });
  for (const method of ['merge', 'squash', 'rebase']) {
    await tab.locator('#github-detail select[aria-label="Merge method"]').selectOption(method, { force: true });
    await tab.getByRole('button', { name: 'Merge…', exact: true }).click();
    await tab.waitForFunction(method => window.githubWrites.at(-1)?.kind === 'merge' && window.githubWrites.at(-1)?.method === method, method);
    await tab.locator('#github-dialog[aria-busy="false"]').waitFor();
    assert.equal((await tab.evaluate(() => window.githubWrites.at(-1))).head, 'a'.repeat(40));
  }
  await tab.getByRole('button', { name: 'Check out PR (detached)', exact: true }).click();
  await tab.waitForFunction(() => window.githubWrites.at(-1)?.kind === 'checkout');
  await tab.locator('#github-dialog[aria-busy="false"]').waitFor();

  await tab.locator('#github-tabs').getByRole('button', { name: 'Issues', exact: true }).click();
  await tab.locator('#github-list button', { hasText: '#8' }).click();
  await tab.getByRole('textbox', { name: 'Issue comment', exact: true }).fill('Issue comment fixture');
  await tab.getByRole('button', { name: 'Add comment', exact: true }).click();
  await tab.waitForFunction(() => window.githubWrites.at(-1)?.kind === 'comment');
  await tab.getByRole('button', { name: 'Close issue…', exact: true }).click();
  await tab.waitForFunction(() => window.githubWrites.at(-1)?.kind === 'issue_state');
  await tab.locator('#github-tabs').getByRole('button', { name: 'Actions', exact: true }).click();
  await tab.locator('#github-list button', { hasText: 'CI' }).click();
  await tab.getByRole('button', { name: 'Failed jobs log', exact: true }).click();
  await tab.locator('#github-diff .note').waitFor();
  await tab.getByRole('button', { name: 'Re-run…', exact: true }).click();
  await tab.waitForFunction(() => window.githubWrites.at(-1)?.kind === 'rerun');
  await tab.locator('#github-tabs').getByRole('button', { name: 'Releases', exact: true }).click();
  await tab.locator('#github-list button', { hasText: 'Version 1' }).click();
  assert.ok((await tab.locator('#github-detail').textContent()).includes('Release notes fixture'));
  await tab.locator('#github-tabs').getByRole('button', { name: 'Inbox', exact: true }).click();
  await tab.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await tab.waitForFunction(() => window.githubWrites.at(-1)?.kind === 'read_notification');
  await tab.fill('#github-repository', 'another/repo');
  await tab.getByRole('button', { name: 'Browse read-only', exact: true }).click();
  await tab.locator('#github-detail', { hasText: '# README fixture' }).waitFor();
  await tab.locator('#github-controls select[aria-label="Repository content"]').selectOption('branches', { force: true });
  await tab.locator('#github-list', { hasText: 'Protected' }).waitFor();
  await tab.locator('#github-controls select[aria-label="Repository content"]').selectOption('commits', { force: true });
  await tab.locator('#github-list', { hasText: 'Recent commit fixture' }).waitFor();
  await tab.locator('#github-controls select[aria-label="Repository content"]').selectOption('pulls', { force: true });
  await tab.locator('#github-list button', { hasText: '#7' }).click();
  assert.equal(await tab.getByRole('button', { name: 'Submit review', exact: true }).count(), 0);
  assert.equal(await tab.getByRole('button', { name: 'Merge…', exact: true }).count(), 0);
  assert.equal(await tab.getByRole('button', { name: 'Check out PR (detached)', exact: true }).count(), 0);
  await tab.screenshot({ path: 'test-results/ui-github.png' });
  await tab.click('#github-close');
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

test('window controls stay inside a 1366px window', async () => {
  await tab.setViewportSize({ width: 1366, height: 768 });
  await tab.evaluate(() => { document.getElementById('publish').hidden = false; document.getElementById('window-controls').hidden = false; });
  const box = await tab.locator('#window-close').boundingBox();
  assert.ok(box && box.x + box.width <= 1366, JSON.stringify(box));
});
