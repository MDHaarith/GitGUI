// Production assets under the desktop CSP, following tests/ui.test.mjs's Chromium workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { preview } from 'vite';
import { chromium } from 'playwright-core';

function mock() {
  const callbacks = new Map(); let next = 1; const channels = new Map();
  const root = id => '/tmp/terminal-' + id;
  const repo = id => ({ id, root: root(id), branch: 'main', head: null, detached: false, upstream: null, ahead: 0, behind: 0, operation: null, remotes: [], files: [], token: 't', version: null, versioning: false, refsToken: 'r' });
  localStorage.setItem('onboarded', '1'); localStorage.setItem('updateChecked', String(Date.now()));
  localStorage.setItem('openRepositories', JSON.stringify([root(1), root(2)])); localStorage.setItem('lastRepository', root(1));
  window.isTauri = true; window.calls = []; window.violations = [];
  document.addEventListener('securitypolicyviolation', event => window.violations.push(event.violatedDirective));
  window.emit = (id, message) => { const channel = channels.get(id); callbacks.get(channel.id)({ index: channel.index++, message }); };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    transformCallback: callback => { const id = next++; callbacks.set(id, callback); return id; },
    unregisterCallback: id => callbacks.delete(id), convertFileSrc: path => path,
    invoke: async (cmd, args = {}) => {
      window.calls.push({ cmd, ...args });
      if (cmd === 'startup_path' || cmd === 'latest_release') return null;
      if (cmd === 'plugin:app|version') return '0.20.0';
      if (cmd === 'open_repository') return repo(args.path.endsWith('2') ? 2 : 1);
      if (cmd === 'get_status') return repo(args.repoId);
      if (cmd === 'get_health' || cmd === 'list_checkpoints') return [];
      if (cmd === 'get_graph') return { graphId: 1, commits: [], refs: [], head: null, hasMore: false };
      if (cmd === 'start_terminal') { channels.set(args.repoId, { id: args.onOutput.id, index: 0 }); window.emit(args.repoId, { kind: 'data', value: [...new TextEncoder().encode('Shell ' + args.repoId + '\r\n')] }); }
      if (cmd === 'git_output_log') return [{ time: 1700000000000, root: root(1), args: ['fetch', 'https://[redacted]@host/repo'], durationMs: 12, exitStatus: 128, success: false, stderr: '<img src=x onerror=alert(1)>' }];
      return null;
    },
  };
}

test('terminal works under the unchanged CSP with input, resizing, per-tab state and safe log rendering', { timeout: 90000 }, async () => {
  const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json')).app.security.csp;
  assert.ok(!csp.includes('unsafe-eval'));
  const server = await preview({ preview: { port: 0, strictPort: false, headers: { 'Content-Security-Policy': csp } }, logLevel: 'silent' });
  const cache = join(homedir(), '.cache/ms-playwright');
  const executablePath = process.env.CHROME_PATH ?? (existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse().map(name => join(cache, name, 'chrome-linux64/chrome')).find(existsSync) : undefined);
  let browser;
  try {
    browser = await chromium.launch({ executablePath });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(mock);
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => document.querySelector('#terminal-toggle')?.disabled === false);
    await page.locator('#terminal-toggle').click();
    await page.waitForFunction(() => document.querySelector('.terminal-host')?.textContent.includes('Shell 1'));
    await page.locator('.terminal-host:not([hidden]) .xterm-helper-textarea').press('a');
    await page.waitForFunction(() => window.calls.some(c => c.cmd === 'terminal_input' && c.repoId === 1 && c.data[0] === 97));
    await page.locator('.terminal-host:not([hidden]) .xterm-helper-textarea').press('Control+r');
    await page.waitForFunction(() => window.calls.some(c => c.cmd === 'terminal_input' && c.data[0] === 18));
    await page.keyboard.press('Control+Backquote'); assert.equal(await page.locator('.terminal-panel').isVisible(), false);
    await page.keyboard.press('Control+Backquote'); assert.equal(await page.locator('.terminal-panel').isVisible(), true);
    // A UTF-8 code point split across Channel chunks remains intact.
    await page.evaluate(() => { window.emit(1, { kind: 'data', value: [0xe2] }); window.emit(1, { kind: 'data', value: [0x9c, 0x93] }); });
    await page.waitForFunction(() => document.querySelector('.terminal-host').textContent.includes('✓'));
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.waitForFunction(() => window.calls.some(c => c.cmd === 'resize_terminal' && c.cols < window.calls.find(c => c.cmd === 'start_terminal').cols));
    await page.locator('.repo-tab-name').filter({ hasText: 'terminal-2' }).click();
    await page.waitForFunction(() => document.querySelector('.terminal-host:not([hidden])')?.textContent.includes('Shell 2'));
    await page.evaluate(() => window.emit(1, { kind: 'data', value: [...new TextEncoder().encode('background output\r\n')] }));
    await page.locator('.repo-tab-name').filter({ hasText: 'terminal-1' }).click();
    await page.waitForFunction(() => document.querySelector('.terminal-host:not([hidden])')?.textContent.includes('Shell 1'));
    await page.waitForFunction(() => document.querySelector('.terminal-host:not([hidden])')?.textContent.includes('background output'));
    assert.equal(await page.evaluate(() => window.calls.filter(c => c.cmd === 'start_terminal' && c.repoId === 1).length), 1);
    await page.locator('#output-tab').click();
    await page.waitForFunction(() => document.querySelector('#git-output').textContent.includes('exit 128'));
    assert.equal(await page.locator('#git-output img').count(), 0);
    assert.match(await page.locator('#git-output').textContent(), /12 ms/);
    await page.keyboard.press('Control+Backquote'); assert.equal(await page.locator('.terminal-panel').isVisible(), false);
    await page.keyboard.press('Control+Backquote'); assert.equal(await page.locator('.terminal-panel').isVisible(), true);
    await page.locator('#terminal-tab').click();
    await page.evaluate(() => window.emit(1, { kind: 'exit', value: 'Shell exited.' }));
    await page.locator('#terminal-restart').click();
    await page.waitForFunction(() => window.calls.filter(c => c.cmd === 'start_terminal' && c.repoId === 1).length === 2);
    await page.locator('.repo-tab').filter({ has: page.locator('.repo-tab-name', { hasText: 'terminal-1' }) }).locator('.repo-tab-close').click();
    await page.waitForFunction(() => document.querySelectorAll('.terminal-host').length === 1);
    assert.deepEqual(await page.evaluate(() => window.violations), []);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
});
