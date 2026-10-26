const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { layoutGraph } = require('./graph');

function graphHtml(nonce) {
  const script = readFileSync(path.join(__dirname, 'graph-client.js'), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>GitGUI Commit Graph</title><style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    button { font: inherit; color: inherit; background: transparent; border: 0; text-align: left; cursor: pointer; }
    button:hover, button[aria-pressed="true"] { background: var(--vscode-list-hoverBackground); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    #graph { display: flex; overflow: auto; max-height: 65vh; border: 1px solid var(--vscode-panel-border); }
    svg { flex: none; }
    #commits { flex: 1; min-width: 320px; }
    #commits button { display: block; height: 32px; width: 100%; white-space: nowrap; padding: 0 8px; }
    #files button { display: block; padding: 6px; width: 100%; }
    #status { color: var(--vscode-descriptionForeground); }
    #message { white-space: pre-wrap; }
    </style></head><body><h1>Commit Graph</h1>
    <p id="status" role="status">Loading up to 2,000 commits from all branches…</p>
    <div id="graph"><svg id="lanes" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg><div id="commits" aria-label="Commits"></div></div>
    <h2 id="title">Select a commit</h2><pre id="message"></pre><div id="files" aria-label="Changed files"></div>
    <script nonce="${nonce}">${script}</script></body></html>`;
}

async function openGraph(context, repo, showDiff, onChange, report) {
  const panel = vscode.window.createWebviewPanel('gitgui.graph', `GitGUI: ${path.basename(repo.root)}`,
    vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
  let commits = [], selected, files = [], disposed = false, generation = 0, selectionGeneration = 0;
  async function load() {
    const request = ++generation;
    selected = undefined;
    selectionGeneration++;
    files = [];
    try {
      const result = await repo.log({ limit: 2000, all: true });
      if (disposed || request !== generation) return;
      commits = result;
      await panel.webview.postMessage({ type: 'commits', commits, graph: layoutGraph(commits) });
    } catch (error) {
      if (!disposed && request === generation) await panel.webview.postMessage({ type: 'error', message: error.message });
    }
  }
  const messages = panel.webview.onDidReceiveMessage(async data => {
    if (!data || typeof data !== 'object') return;
    try {
      if (data.type === 'ready') return await load();
      if (data.type === 'select') {
        const commit = commits.find(item => item.oid === data.oid);
        if (!commit) throw new Error('Unknown commit selected.');
        selected = commit;
        files = [];
        const request = ++selectionGeneration;
        const result = await repo.files(commit);
        if (disposed || selected !== commit || request !== selectionGeneration) return;
        files = result;
        await panel.webview.postMessage({ type: 'files', commit, files });
      }
      if (data.type === 'diff') {
        if (!selected || data.oid !== selected.oid || !files.some(item => item.path === data.file)) {
          throw new Error('Unknown file selected.');
        }
        await showDiff({ root: repo.root, oid: selected.oid, file: data.file });
      }
    } catch (error) { if (!disposed) report(error); }
  });
  const changes = onChange(load);
  const disposal = panel.onDidDispose(() => {
    disposed = true;
    messages.dispose();
    changes.dispose();
    disposal.dispose();
  });
  context.subscriptions.push(panel);
  panel.webview.html = graphHtml(randomBytes(24).toString('hex'));
  return panel;
}

module.exports = { openGraph, graphHtml };
