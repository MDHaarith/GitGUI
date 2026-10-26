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
  sync_repository: { activity: page.refs.filter(r => r.kind !== 'tag').map(r => ({ id: r.id, author: 'Last Author', timestamp: 1700000000 })), worktrees: [{ id: '776f726b', path: '/tmp/demo-work', branch: 'refs/heads/feature', head: oid(2), bare: false, locked: false, prunable: false }], comparison: { onlyA: { text: 'local commit', truncated: false, binary: false }, onlyB: { text: 'remote commit', truncated: false, binary: false }, diff: { text: diff, truncated: false, binary: false } } },
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
  for (const name of ['origin/main', 'origin/feature']) {
    await tab.getByRole('button', { name: 'Actions for ' + name, exact: true }).click();
    assert.equal(await tab.getByRole('menuitem', { name: 'Check out', exact: true }).count(), 1);
    await tab.keyboard.press('Escape');
  }
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
  const ids = ['#summary', '#body', '#ai-message', '#ai-explain', '#ai-settings', '#amend', '#signoff', '#commit-author', '#bump', '#commit-button', '#commit-push'];
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

test('changed lines select by click and Shift-click in unified and split diffs', async () => {
  await tab.evaluate(repo => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.stagingCalls = [];
    window.restoreStagingInvoke = () => { window.__TAURI_INTERNALS__.invoke = original; };
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'stage_lines') { window.stagingCalls.push(args); return structuredClone(repo); }
      return original(cmd, args);
    };
  }, repo);
  try {
    for (const split of [false, true]) {
      if (split) await tab.locator('.working-preview .diff-toggle').click();
      await tab.locator('#working-diff [data-diff-line="5"]').click();
      await tab.locator('#working-diff [data-diff-line="6"]').click({ modifiers: ['Shift'] });
      assert.equal(await tab.locator('#working-diff [aria-pressed="true"]').count(), 2);
      await tab.getByRole('button', { name: 'Stage lines (2)', exact: true }).click();
      await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
    }
    const calls = await tab.evaluate(() => window.stagingCalls);
    assert.equal(calls.length, 2);
    for (const call of calls) { assert.deepEqual(call.lines, [5, 6]); assert.equal(call.expected, diff); assert.equal(call.unstage, false); }
    await tab.locator('.working-preview .diff-toggle').click();
    await tab.locator('button.file-name', { hasText: 'src/app.ts' }).click();
    await tab.locator('#working-diff [data-diff-line="6"]').press('Space');
    await tab.getByRole('button', { name: 'Unstage lines (1)', exact: true }).click();
    await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
    assert.equal(await tab.evaluate(() => window.stagingCalls.at(-1).unstage), true);
  } finally { await tab.evaluate(() => window.restoreStagingInvoke()); }
});

test('folder view counts files, collapses folders, and remembers the view choice', async () => {
  await tab.click('#file-tree-toggle');
  assert.equal(await tab.evaluate(() => localStorage.getItem('fileTree')), '1');
  const folder = tab.locator('.file-folder').first();
  assert.equal(await folder.locator('summary').textContent(), 'src · 1');
  assert.equal(await folder.locator('button.file-name').textContent(), '\u200eapp.ts\u200e');
  await folder.locator('summary').click();
  assert.equal(await folder.getAttribute('open'), null);
  await tab.locator('button.file-name', { hasText: 'README.md' }).click();
  assert.equal(await tab.locator('.file-folder').first().getAttribute('open'), null);
  await tab.reload(); await tab.locator('#history-rows tr').first().waitFor();
  await tab.click('#changes-button');
  assert.equal(await tab.locator('#file-tree-toggle').getAttribute('aria-pressed'), 'true');
  await tab.click('#file-tree-toggle');
});

test('Commit & Push sends author and signoff, and never pushes after a failed commit', async () => {
  await tab.evaluate(repo => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.commitCalls = []; window.failCommit = true;
    window.restoreCommitInvoke = () => { window.__TAURI_INTERNALS__.invoke = original; };
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'create_commit' || (cmd === 'sync_repository' && args.request.action === 'push')) {
        window.commitCalls.push([cmd, args]);
        if (cmd === 'create_commit' && window.failCommit) throw new Error('pre-commit hook failed');
        const info = { ...structuredClone(repo), head: '4'.repeat(40), files: [], token: 'committed' };
        return cmd === 'sync_repository' ? { info } : info;
      }
      return original(cmd, args);
    };
  }, repo);
  try {
    await tab.fill('#summary', 'A signed commit'); await tab.fill('#commit-author', 'Other Author <other@example.invalid>'); await tab.check('#signoff');
    await tab.click('#commit-push');
    await tab.locator('#error:not([hidden])').waitFor();
    await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
    assert.deepEqual(await tab.evaluate(() => window.commitCalls.map(([cmd]) => cmd)), ['create_commit']);
    assert.equal(await tab.inputValue('#summary'), 'A signed commit');
    assert.equal(await tab.isChecked('#signoff'), true);
    await tab.evaluate(() => { window.failCommit = false; });
    await tab.click('#commit-push');
    await tab.waitForFunction(() => window.commitCalls.some(([cmd]) => cmd === 'sync_repository'));
    await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
    const calls = await tab.evaluate(() => window.commitCalls);
    assert.deepEqual(calls.map(([cmd]) => cmd), ['create_commit', 'create_commit', 'sync_repository']);
    assert.deepEqual(calls[1][1].options, { signoff: true, author: 'Other Author <other@example.invalid>' });
    assert.equal(calls[2][1].request.action, 'push');
    assert.equal(calls[2][1].request.token, 'committed');
    assert.equal(await tab.inputValue('#summary'), '');
  } finally {
    await tab.evaluate(() => window.restoreCommitInvoke()); await tab.click('#refresh');
    await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
  }
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

test('branch metadata, comparison and worktrees use the existing UI patterns', async () => {
  assert.equal(await tab.locator('.sync-ref-meta').count(), 4);
  assert.ok((await tab.locator('.sync-ref-meta').first().textContent()).includes('Last Author'));
  assert.equal(await tab.locator('.ref-head', { hasText: 'stale' }).count(), 4);
  await tab.click('#tools-button'); await tab.getByRole('menuitem', { name: 'Compare branches…', exact: true }).click();
  await tab.locator('#sync-compare-form button[type=submit], #sync-compare-form button.primary').click();
  await tab.locator('#sync-only-a').getByText('local commit', { exact: true }).waitFor();
  assert.equal(await tab.locator('#sync-only-b').textContent(), 'remote commit');
  assert.ok(await tab.locator('#sync-compare-diff .diff-line').count() > 0);
  await tab.evaluate(() => document.getElementById('sync-compare').close());
  await tab.click('#tools-button'); await tab.getByRole('menuitem', { name: 'Worktrees…', exact: true }).click();
  await tab.locator('#sync-worktree-list').getByText('/tmp/demo-work', { exact: true }).waitFor();
  assert.equal(await tab.locator('#sync-worktree-list').getByRole('button', { name: 'Open in new tab' }).count(), 1);
  await tab.evaluate(() => document.getElementById('sync-worktrees').close());
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

test('assistant runs reads, renders diffs and keeps Git responsive while waiting', async () => {
  await tab.evaluate(({ repo, diff }) => {
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.assistantCalls = [];
    let turns = 0;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'assistant_chat') {
        window.assistantCalls.push({ cmd, args: structuredClone(args) });
        turns++;
        if (turns === 1) await new Promise(resolve => { window.finishAssistant = resolve; });
        return { message: { role: 'assistant', text: turns === 1 ? 'Inspecting changes' : '**Reviewed.**', calls: turns === 1 ? [{ id: 'diff-1', name: 'diff', input: {} }] : [], toolId: null }, inputTokens: 10, outputTokens: 5, provider: 'claude' };
      }
      if (cmd === 'assistant_tool') { window.assistantCalls.push({ cmd, args: structuredClone(args) }); return JSON.stringify({ text: diff, truncated: false, binary: false }); }
      if (cmd === 'get_status') return repo;
      return invoke(cmd, args);
    };
  }, { repo, diff });
  await tab.click('#assistant-button');
  assert.match(await tab.locator('.assistant-context').textContent(), /demo · main/);
  await tab.fill('#assistant-prompt', 'Review\nthese changes');
  await tab.locator('#assistant-prompt').press('Shift+Enter');
  assert.match(await tab.locator('#assistant-prompt').inputValue(), /\n$/);
  await tab.locator('#assistant-prompt').press('Enter');
  await tab.waitForFunction(() => typeof window.finishAssistant === 'function');
  assert.equal(await tab.locator('#refresh').isEnabled(), true);
  await tab.click('#refresh');
  await tab.evaluate(() => window.finishAssistant());
  await tab.getByRole('button', { name: 'Copy Markdown', exact: true }).last().waitFor();
  await tab.waitForFunction(() => !document.querySelector('#assistant-panel [type=submit]').disabled);
  assert.ok(await tab.locator('#assistant-panel .diff .diff-line').count() > 0);
  const calls = await tab.evaluate(() => window.assistantCalls);
  assert.equal(calls[0].args.permission, 'read-only');
  assert.equal(calls.find(c => c.cmd === 'assistant_tool').args.allow, false);
  assert.equal(calls.filter(c => c.cmd === 'assistant_chat')[1].args.messages.at(-1).role, 'tool');
});

test('assistant requires Allow for every write, denies restricted tools and cancels hidden approvals', async () => {
  await tab.click('#assistant-panel [data-new]');
  await tab.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.writeCalls = [];
    let turn = 0;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'assistant_chat') {
        turn++;
        return { message: { role: 'assistant', text: '', calls: turn % 2 ? [{ id: `stage-${turn}`, name: 'stage', input: { fileIds: ['62'] } }] : [], toolId: null }, inputTokens: 0, outputTokens: 0, provider: 'test' };
      }
      if (cmd === 'assistant_tool') { window.writeCalls.push(args); return 'Staged README.md'; }
      return invoke(cmd, args);
    };
  });
  await tab.fill('#assistant-prompt', 'Stage this'); await tab.locator('#assistant-prompt').press('Enter');
  await tab.getByText('Error: Error: Disabled by the selected permission level.', { exact: true }).waitFor();
  assert.equal(await tab.evaluate(() => window.writeCalls.length), 0);
  await tab.waitForFunction(() => !document.querySelector('#assistant-panel [type=submit]').disabled);
  await tab.evaluate(() => { const select = document.getElementById('assistant-permission'); select.value = 'commits'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await tab.fill('#assistant-prompt', 'Stage this'); await tab.locator('#assistant-prompt').press('Enter');
  await tab.getByRole('button', { name: 'Allow', exact: true }).waitFor();
  assert.equal(await tab.evaluate(() => window.writeCalls.length), 0);
  await tab.getByRole('button', { name: 'Allow', exact: true }).click();
  await tab.getByText('Staged README.md', { exact: true }).waitFor();
  const calls = await tab.evaluate(() => window.writeCalls);
  assert.equal(calls.length, 1); assert.equal(calls[0].allow, true); assert.equal(calls[0].permission, 'commits'); assert.equal(calls[0].token, 't');
  await tab.waitForFunction(() => !document.querySelector('#assistant-panel [type=submit]').disabled);
  await tab.fill('#assistant-prompt', 'Stage again'); await tab.locator('#assistant-prompt').press('Enter');
  await tab.getByRole('button', { name: 'Allow', exact: true }).waitFor();
  await tab.click('#assistant-panel [data-close]');
  await tab.waitForFunction(() => !document.querySelector('#assistant-panel [type=submit]').disabled);
  assert.equal(await tab.evaluate(() => window.writeCalls.length), 1);
});

test('assistant copies Markdown and settings show key presence and storage without revealing a key', async () => {
  await tab.click('#assistant-button');
  await tab.click('#assistant-panel [data-new]');
  await tab.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedAnswer = text; } } });
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'assistant_chat') return { message: { role: 'assistant', text: '**Keep this**\n\n- Markdown answer', calls: [], toolId: null }, inputTokens: 0, outputTokens: 0, provider: 'test' };
      if (cmd === 'get_ai_provider') return { kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', command: '', keySet: true, keyStorage: 'private-file' };
      return invoke(cmd, args);
    };
  });
  await tab.fill('#assistant-prompt', 'Explain'); await tab.locator('#assistant-prompt').press('Enter');
  await tab.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
  assert.equal(await tab.evaluate(() => window.copiedAnswer), '**Keep this**\n\n- Markdown answer');
  await tab.click('#assistant-panel [data-settings]');
  await tab.locator('#ai-dialog[open]').waitFor();
  assert.equal(await tab.locator('#api-key').inputValue(), '');
  assert.match(await tab.locator('#ai-key-storage').textContent(), /Key set.*credential store unavailable; using a private file/);
  await tab.evaluate(() => document.getElementById('ai-dialog').close());
  await tab.click('#assistant-panel [data-close]');
});

test('undo notice and shortcuts preserve text editing and call the current repository', async () => {
  await tab.evaluate(repo => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.undoCalls = []; window.undoAvailable = true;
    window.restoreUndoInvoke = () => { window.__TAURI_INTERNALS__.invoke = original; };
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'undo_label') return window.undoAvailable ? 'Commit' : null;
      if (cmd === 'undo_action') { window.undoCalls.push(args); window.undoAvailable = false; return structuredClone(repo); }
      return original(cmd, args);
    };
  }, repo);
  try {
    await tab.click('#refresh'); await tab.locator('#undo-action:not([hidden]):enabled').waitFor();
    assert.equal(await tab.locator('#undo-action-label').textContent(), 'Last action: Commit');
    for (const target of ['#summary', '#body', '#history-search']) {
      await tab.locator(target).focus(); await tab.keyboard.press('Control+z');
    }
    await tab.evaluate(() => {
      const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.id = 'undo-editor'; document.body.append(editor); editor.focus();
    });
    await tab.keyboard.press('Meta+z');
    assert.equal(await tab.evaluate(() => window.undoCalls.length), 0);
    await tab.evaluate(() => document.getElementById('undo-editor').remove());
    await tab.locator('#refresh').focus(); await tab.keyboard.press('Control+z');
    await tab.locator('#undo-action[hidden]').waitFor({ state: 'attached' });
    assert.deepEqual(await tab.evaluate(() => window.undoCalls), [{ repoId: 1, token: 't' }]);
    await tab.evaluate(() => { window.undoAvailable = true; });
    await tab.click('#refresh'); await tab.locator('#undo-action:not([hidden]):enabled').waitFor();
    await tab.keyboard.press('Meta+z');
    await tab.waitForFunction(() => window.undoCalls.length === 2);
    await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
  } finally { await tab.evaluate(() => window.restoreUndoInvoke()); }
});

test('time machine previews the commit and diff and confirms restoration', async () => {
  await tab.evaluate(({ repo, diff }) => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.timeMachineCalls = [];
    window.restoreTimeMachineInvoke = () => { window.__TAURI_INTERNALS__.invoke = original; };
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'get_reflog') return [{ oid: '2'.repeat(40), selector: 'HEAD@{1}', timestamp: 1700000000, action: 'commit: Earlier', message: 'Earlier work', source: 'HEAD' }];
      if (cmd === 'get_commit') return { oid: '2'.repeat(40), parents: ['1'.repeat(40)], parent: '1'.repeat(40), author: 'Dev', timestamp: 1700000000, message: 'Earlier work', files: [], shallow: false };
      if (cmd === 'get_commit_diff') return { text: diff, truncated: false, binary: false };
      if (cmd === 'plugin:dialog|message') { window.timeMachineCalls.push({ cmd, args }); return 'Ok'; }
      if (cmd === 'restore_reflog') { window.timeMachineCalls.push({ cmd, args }); return structuredClone(repo); }
      return original(cmd, args);
    };
  }, { repo, diff });
  try {
    await tab.click('#tools-button'); await tab.click('#time-machine-button');
    await tab.locator('#reflog-list button').click();
    await tab.locator('#reflog-restore:enabled').waitFor();
    assert.match(await tab.locator('#reflog-message').textContent(), /Earlier work/);
    assert.ok(await tab.locator('#reflog-diff .diff-line.added').count() > 0);
    await tab.click('#reflog-restore');
    await tab.waitForFunction(() => window.timeMachineCalls.some(call => call.cmd === 'restore_reflog'));
    const calls = await tab.evaluate(() => window.timeMachineCalls);
    assert.deepEqual(calls.map(call => call.cmd), ['plugin:dialog|message', 'restore_reflog']);
    assert.deepEqual(calls[1].args, { repoId: 1, oid: '2'.repeat(40), token: 't' });
    await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
  } finally { await tab.evaluate(() => { document.getElementById('time-machine-dialog').close(); window.restoreTimeMachineInvoke(); }); }
});

test('line history selects a diff range without disabling line staging', async () => {
  await tab.evaluate(diff => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.lineHistoryCalls = [];
    window.restoreLineHistoryInvoke = () => { window.__TAURI_INTERNALS__.invoke = original; };
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'line_history') { window.lineHistoryCalls.push(args); return { text: 'commit history\n' + diff, truncated: false, binary: false }; }
      return original(cmd, args);
    };
  }, diff);
  try {
    if (!await tab.locator('#changes').isVisible()) await tab.click('#changes-button');
    await tab.locator('button.file-name', { hasText: 'README.md' }).click();
    await tab.locator('#working-diff .hunk-action').waitFor();
    await tab.locator('#working-diff .line-number').filter({ hasText: /^3$/ }).first().click();
    await tab.locator('#working-diff .line-number').filter({ hasText: /^1$/ }).first().click({ modifiers: ['Shift'] });
    const controls = tab.locator('.working-preview .line-history-controls');
    assert.equal(await controls.getByLabel('From line').inputValue(), '3');
    assert.equal(await controls.getByLabel('To line').inputValue(), '1');
    assert.equal(await tab.getByRole('button', { name: 'Stage lines', exact: true }).count(), 1);
    await controls.getByRole('button', { name: 'History of these lines', exact: true }).click();
    await tab.locator('#line-history-diff .diff-line').first().waitFor();
    assert.deepEqual(await tab.evaluate(() => window.lineHistoryCalls), [{ repoId: 1, fileId: '62', commit: null, start: 1, end: 3 }]);
    await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
  } finally { await tab.evaluate(() => { document.getElementById('line-history-dialog').close(); window.restoreLineHistoryInvoke(); }); }
});

test('blame tints commit ages and opens history for the selected lines', async () => {
  await tab.evaluate(diff => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.blameHistoryCalls = [];
    window.restoreBlameInvoke = () => { window.__TAURI_INTERNALS__.invoke = original; };
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'file_history') return [{ oid: '2'.repeat(40), timestamp: 1700000000, author: 'Dev', subject: 'Edit' }];
      if (cmd === 'file_blame') return [1600000000, 1700000000, 1600000000].map((timestamp, index) => ({ oid: String(index + 1).repeat(40), timestamp, author: 'Dev', text: 'Line ' + (index + 1) }));
      if (cmd === 'line_history') { window.blameHistoryCalls.push(args); return { text: 'commit selected lines\n' + diff, truncated: false, binary: false }; }
      return original(cmd, args);
    };
  }, diff);
  try {
    await tab.locator('.file-row', { has: tab.locator('button.file-name', { hasText: 'README.md' }) }).getByRole('button', { name: 'Show history for README.md', exact: true }).click();
    await tab.locator('#file-blame-list .blame-heat').first().waitFor();
    await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
    assert.equal(await tab.locator('.blame-legend').count(), 1);
    const colors = await tab.locator('#file-blame-list .blame-heat').evaluateAll(rows => rows.map(row => row.style.backgroundColor));
    assert.notEqual(colors[0], colors[1]); assert.equal(colors[0], colors[2]);
    await tab.locator('#file-blame-list [data-line="1"]').click();
    await tab.locator('#file-blame-list [data-line="3"]').click({ modifiers: ['Shift'] });
    await tab.locator('#file-history-dialog .line-history-controls').getByRole('button', { name: 'History of these lines', exact: true }).click();
    await tab.waitForFunction(() => window.blameHistoryCalls.length === 1);
    assert.deepEqual(await tab.evaluate(() => window.blameHistoryCalls[0]), { repoId: 1, fileId: '62', commit: null, start: 1, end: 3 });
    await tab.waitForFunction(() => !document.querySelector('#operation-feedback:not([hidden])'));
  } finally { await tab.evaluate(() => { document.getElementById('line-history-dialog').close(); document.getElementById('file-history-dialog').close(); window.restoreBlameInvoke(); }); }
});

test('merge dashboard, rebase side labels, editable result and resolution save work together', async () => {
  const conflictRepo = { ...repo, operation: 'rebase', files: repo.files.map(file => ({ ...file, conflicted: true, index: 'U', worktree: 'U' })) };
  const remaining = { ...conflictRepo, files: [conflictRepo.files[1]] };
  const versions = { base: 'top\nbase\nend\n', ours: 'top\ntarget\nend\n', theirs: 'top\nmy commit\nend\n', working: 'top\n<<<<<<< HEAD\ntarget\n=======\nmy commit\n>>>>>>> topic\nend\n', rebasing: true, token: 'reviewed' };
  const mergeTab = await browser.newPage({ viewport: { width: 800, height: 700 } });
  await mergeTab.addInitScript(mockTauri, { ...responses, open_repository: conflictRepo, get_status: conflictRepo, get_merge_versions: versions, save_resolution: remaining });
  await mergeTab.addInitScript(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.mergeCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => { if (command === 'save_resolution') window.mergeCalls.push(args); return invoke(command, args); };
  });
  try {
    await mergeTab.goto(server.resolvedUrls.local[0]);
    await mergeTab.locator('#conflicts-dashboard').waitFor();
    assert.match(await mergeTab.locator('#conflicts-dashboard h3').textContent(), /2 files left/);
    assert.equal(await mergeTab.locator('#operation-continue').isDisabled(), true);
    assert.equal(await mergeTab.locator('#operation-skip').textContent(), 'Skip rebase');
    await mergeTab.locator('#conflicts-dashboard').getByRole('button', { name: 'Merge… · src/app.ts', exact: true }).click();
    await mergeTab.locator('#conflict-dialog[open]').waitFor();
    assert.deepEqual(await mergeTab.locator('.merge-headings strong').allTextContents(), ['Yours · replayed commit', 'Result · editable', 'Theirs · rebase target']);
    assert.equal(await mergeTab.locator('#conflict-save').isDisabled(), true);
    assert.equal(await mergeTab.locator('.merge-legend .merge-kind').count(), 4);
    assert.equal(await mergeTab.locator('#conflict-dialog').evaluate(dialog => dialog.scrollWidth > dialog.clientWidth), false);
    const block = mergeTab.locator('.merge-block.merge-conflict');
    assert.equal(await block.locator('pre').first().textContent(), 'my commit\n');
    await block.getByRole('button', { name: 'Accept Yours', exact: true }).click();
    await block.locator('textarea').fill('edited replayed commit\n');
    await mergeTab.getByRole('button', { name: 'Resolve simple', exact: true }).click();
    assert.equal(await block.locator('textarea').inputValue(), 'edited replayed commit\n');
    await mergeTab.locator('#conflict-save').click();
    await mergeTab.locator('#conflict-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await mergeTab.evaluate(() => window.mergeCalls), [{ repoId: 1, fileId: '61', content: 'top\nedited replayed commit\nend\n', token: 'reviewed', original: versions.working }]);
    assert.match(await mergeTab.locator('#conflicts-dashboard h3').textContent(), /1 files left/);
    assert.equal(await mergeTab.locator('#file-tree-toggle').count(), 1);
  } finally { await mergeTab.close(); }
});

test('merge automation resolves simple markers and failed saves leave the editable result open', async () => {
  await tab.evaluate(async () => {
    const { openMergeEditor } = await import('/src/merge-editor.ts');
    openMergeEditor({ id: 'a', path: 'example.txt' }, { base: 'top\r\nbase\r\nend\r\n', ours: 'top\r\nchanged\r\nend\r\n', theirs: 'top\r\nbase\r\nend\r\n', working: 'top\r\n<<<<<<< HEAD\r\nchanged\r\n=======\r\nbase\r\n>>>>>>> topic\r\nend\r\n', rebasing: false, token: 't' }, async content => { window.mergeResult = content; throw new Error('Working file changed; reopen it.'); });
  });
  try {
    await tab.getByRole('button', { name: 'Apply non-conflicting changes', exact: true }).click();
    assert.equal(await tab.locator('#conflict-save').isDisabled(), false);
    await tab.locator('#conflict-save').click();
    await tab.locator('#conflict-dialog [role="alert"]').waitFor();
    assert.equal(await tab.evaluate(() => window.mergeResult), 'top\r\nchanged\r\nend\r\n');
    assert.equal(await tab.locator('#conflict-dialog').evaluate(dialog => dialog.open), true);
  } finally { await tab.evaluate(() => document.getElementById('conflict-dialog').close()); }
});

test('graph selection, batch review, copy, comparison, reword and full-width file diffs use the bridge', async () => {
  const graphRepo = { ...repo, files: [] };
  const commit = { oid: oid(3), parents: [oid(2)], parent: oid(2), author: 'Dev', email: 'dev@example.invalid', timestamp: 1700000000, message: 'Commit 3', files: [{ id: '62', path: 'README.md', oldPath: null, oldId: null, status: 'M' }], shallow: false };
  const graphTab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await graphTab.addInitScript(mockTauri, { ...responses, open_repository: graphRepo, get_status: graphRepo, get_commit: commit, get_commit_diff: { text: diff, truncated: false, binary: false }, compare_commits: { text: diff, truncated: false, binary: false }, rebase_plan_from: { base: '', commits: [1, 2, 3].map(n => ({ oid: oid(n), message: 'Commit ' + n })) }, rewrite_commits: graphRepo, reword_commit: graphRepo, batch_commits: graphRepo, 'plugin:dialog|message': 'Ok' });
  await graphTab.addInitScript(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.graphCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => { window.graphCalls.push({ command, args }); return invoke(command, args); };
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.copiedShas = value; } } });
  });
  try {
    await graphTab.goto(server.resolvedUrls.local[0]);
    const row = n => graphTab.locator(`tr[data-oid="${oid(n)}"] .subject`);
    await row(3).waitFor();
    await row(2).click({ modifiers: ['Control'] });
    assert.equal(await graphTab.locator('#graph-selection-count').textContent(), '2 selected');
    await graphTab.locator('#graph-compare').click();
    await graphTab.locator('#commit-full-diff .diff-line').first().waitFor();
    assert.deepEqual(await graphTab.evaluate(() => window.graphCalls.find(c => c.command === 'compare_commits').args), { repoId: 1, from: oid(2), to: oid(3) });
    assert.ok((await graphTab.locator('#commit-diff-dialog').boundingBox()).width >= 1216);
    await graphTab.locator('#commit-diff-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await row(3).click({ button: 'right' });
    await graphTab.getByRole('menuitem', { name: 'Copy 2 SHAs', exact: true }).click();
    assert.equal(await graphTab.evaluate(() => window.copiedShas), oid(3) + '\n' + oid(2));
    await row(3).click(); await row(1).click({ modifiers: ['Shift'] });
    assert.equal(await graphTab.locator('tr.selected').count(), 3);
    await graphTab.locator('#graph-actions-button').click();
    await graphTab.getByRole('menuitem', { name: 'Squash 3 commits into one…', exact: true }).click();
    await graphTab.locator('#rebase-dialog[open]').waitFor();
    assert.deepEqual(await graphTab.locator('#rebase-commits select').evaluateAll(nodes => nodes.map(n => n.value)), ['pick', 'squash', 'squash']);
    assert.match(await graphTab.locator('#rebase-result').textContent(), /1 resulting commit/);
    assert.equal(await graphTab.locator('#rebase-published').isChecked(), false);
    await graphTab.locator('#rebase-apply').click();
    await graphTab.waitForFunction(() => window.graphCalls.some(c => c.command === 'rewrite_commits'));
    assert.equal(await graphTab.evaluate(() => window.graphCalls.find(c => c.command === 'rewrite_commits').args.allowPublished), false);
    await graphTab.waitForFunction(() => document.getElementById('app').getAttribute('aria-busy') === 'false');
    await graphTab.locator('#graph-actions-button').click();
    await graphTab.getByRole('menuitem', { name: 'Cherry-pick 3 commits', exact: true }).click();
    await graphTab.waitForFunction(() => window.graphCalls.some(c => c.command === 'batch_commits'));
    assert.equal(await graphTab.evaluate(() => window.graphCalls.find(c => c.command === 'batch_commits').args.oids.length), 3);
    await graphTab.waitForFunction(() => document.getElementById('app').getAttribute('aria-busy') === 'false');
    await row(3).click();
    await graphTab.locator('#graph-actions-button').click();
    await graphTab.getByRole('menuitem', { name: 'Reword commit…', exact: true }).click();
    await graphTab.locator('#reword-dialog[open]').waitFor();
    assert.equal(await graphTab.locator('#reword-published').isChecked(), false);
    await graphTab.locator('#reword-message').fill('Changed message');
    await graphTab.locator('#reword-dialog').getByRole('button', { name: 'Reword commit', exact: true }).click();
    await graphTab.waitForFunction(() => window.graphCalls.some(c => c.command === 'reword_commit'));
    assert.equal(await graphTab.evaluate(() => window.graphCalls.find(c => c.command === 'reword_commit').args.message), 'Changed message');
    await graphTab.waitForFunction(() => document.getElementById('app').getAttribute('aria-busy') === 'false');
    await graphTab.locator('#details-button').click();
    await graphTab.locator('#detail-file').selectOption('62');
    await graphTab.locator('#detail-file-open').click();
    await graphTab.locator('#commit-full-diff .diff-line').first().waitFor();
    assert.match(await graphTab.locator('#commit-diff-title').textContent(), /README.md/);
    assert.equal(await graphTab.locator('#commit-diff-dialog').evaluate(d => d.scrollWidth > d.clientWidth), false);
    await graphTab.screenshot({ path: 'test-results/ui-graph-file-diff.png' });
  } finally { await graphTab.close(); }
});

test('an interactive rebase Edit stop exposes amend and Continue alongside the merged controls', async () => {
  const paused = { ...repo, branch: null, detached: true, rebaseEdit: true, operation: 'rebase', files: [] };
  const editTab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await editTab.addInitScript(mockTauri, { ...responses, open_repository: paused, get_status: paused, get_commit: { oid: oid(3), message: 'Paused commit', files: [], parents: [oid(2)], parent: oid(2), author: 'Dev', email: 'dev@example.invalid', timestamp: 1700000000, shallow: false }, amend_rebase_commit: paused, finish_operation: { ...repo, files: [] } });
  await editTab.addInitScript(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke; window.editCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args) => { window.editCalls.push({ command, args }); return invoke(command, args); };
  });
  try {
    await editTab.goto(server.resolvedUrls.local[0]);
    await editTab.locator('#rebase-edit-amend').waitFor();
    assert.equal(await editTab.locator('#file-tree-toggle').count(), 1);
    await editTab.locator('#rebase-edit-amend').click();
    await editTab.locator('#rebase-edit-dialog[open]').waitFor();
    await editTab.locator('#rebase-edit-message').fill('Amended paused commit');
    await editTab.locator('#rebase-edit-dialog').getByRole('button', { name: 'Amend commit', exact: true }).click();
    await editTab.waitForFunction(() => window.editCalls.some(c => c.command === 'amend_rebase_commit'));
    await editTab.waitForFunction(() => document.getElementById('app').getAttribute('aria-busy') === 'false');
    await editTab.locator('#operation-continue').click();
    await editTab.waitForFunction(() => window.editCalls.some(c => c.command === 'finish_operation'));
    assert.equal(await editTab.evaluate(() => window.editCalls.find(c => c.command === 'finish_operation').args.abort), false);
  } finally { await editTab.close(); }
});
