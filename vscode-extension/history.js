const vscode = require('vscode');
const path = require('node:path');
const { repository } = require('./git');
const { revision, filePath } = require('./git-data');
const { activateBlame } = require('./inline-blame');
const { openGraph } = require('./graph-webview');

function activateHistory(context) {
  const repositories = new Map();
  const changed = new vscode.EventEmitter();
  const report = error => vscode.window.showErrorMessage(`GitGUI: ${error.message}`);
  const command = (id, action) => context.subscriptions.push(vscode.commands.registerCommand(id,
    (...args) => Promise.resolve().then(() => action(...args)).catch(report)));

  async function findRepository(resource, pickFolder = false) {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === 'gitgui-rev') return known(JSON.parse(uri.query).root);
    let folder = uri || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (pickFolder && !uri && (vscode.workspace.workspaceFolders?.length || 0) > 1) {
      const pick = await vscode.window.showQuickPick(vscode.workspace.workspaceFolders.map(item => ({
        label: item.name, uri: item.uri
      })), { placeHolder: 'Select a Git repository' });
      if (!pick) return;
      folder = pick.uri;
    }
    if (!folder || folder.scheme !== 'file') throw new Error('Select a file or folder in a local Git repository.');
    const directory = uri ? path.dirname(uri.fsPath) : folder.fsPath;
    const repo = await repository(directory);
    repositories.set(repo.root, repo);
    return repo;
  }

  function known(root) {
    const repo = repositories.get(root);
    if (!repo) throw new Error('This repository is no longer available. Refresh the view.');
    return repo;
  }

  function revisionUri(repo, rev, file) {
    return vscode.Uri.from({ scheme: 'gitgui-rev', path: `/${filePath(file)}`,
      query: JSON.stringify({ root: repo.root, rev, file }) });
  }

  async function showDiff({ root, oid, file }) {
    const repo = known(root);
    const commit = await repo.commit(revision(oid));
    const files = await repo.files(commit);
    const entry = files.find(item => item.path === filePath(file));
    if (!entry) throw new Error('This file was not changed by the selected commit.');
    const before = entry.status === 'A' ? '' : commit.parents[0] || '';
    const after = entry.status === 'D' ? '' : commit.oid;
    await vscode.commands.executeCommand('vscode.diff', revisionUri(repo, before, entry.oldPath),
      revisionUri(repo, after, entry.path), `${entry.path} (${commit.oid.slice(0, 8)})`);
  }

  context.subscriptions.push(changed, vscode.workspace.registerTextDocumentContentProvider('gitgui-rev', {
    async provideTextDocumentContent(uri) {
      const data = JSON.parse(uri.query);
      const repo = known(data.root);
      filePath(data.file);
      if (data.rev === '') return '';
      return repo.show(revision(data.rev), data.file);
    }
  }));

  const treeChanged = new vscode.EventEmitter();
  let limit = 50, generation = 0;
  const tree = {
    onDidChangeTreeData: treeChanged.event,
    getTreeItem(item) {
      if (item.kind === 'more') {
        const node = new vscode.TreeItem('Load more', vscode.TreeItemCollapsibleState.None);
        node.command = { command: 'gitgui.loadMoreCommits', title: 'Load more' };
        return node;
      }
      if (item.kind === 'file') {
        const node = new vscode.TreeItem(item.file.path, vscode.TreeItemCollapsibleState.None);
        node.description = item.file.status;
        node.iconPath = new vscode.ThemeIcon('file');
        node.command = { command: 'gitgui.showDiff', title: 'Show diff',
          arguments: [{ root: item.root, oid: item.oid, file: item.file.path }] };
        return node;
      }
      const node = new vscode.TreeItem(item.subject, vscode.TreeItemCollapsibleState.Collapsed);
      node.id = `${item.root}:${item.oid}`;
      node.description = `${item.author} · ${item.date.slice(0, 10)}`;
      node.tooltip = `${item.oid}\n${item.author} · ${item.date}\n\n${item.message}`;
      node.iconPath = new vscode.ThemeIcon('git-commit');
      return node;
    },
    async getChildren(item) {
      const current = generation;
      try {
        if (item) {
          if (item.kind !== 'commit') return [];
          return (await known(item.root).files(item)).map(file => ({ kind: 'file', file, root: item.root, oid: item.oid }));
        }
        const repo = await findRepository();
        if (!repo) return [];
        const commits = await repo.log({ limit: limit + 1 });
        if (current !== generation) return [];
        return [...commits.slice(0, limit).map(commit => ({ ...commit, root: repo.root, kind: 'commit' })),
          ...(commits.length > limit ? [{ kind: 'more' }] : [])];
      } catch (error) {
        view.message = error.message;
        return [];
      }
    }
  };
  const view = vscode.window.createTreeView('gitgui.commits', { treeDataProvider: tree });
  context.subscriptions.push(treeChanged, view);

  let refreshTimer;
  function refresh(reset = true) {
    if (reset) limit = 50;
    generation++;
    view.message = undefined;
    treeChanged.fire();
    changed.fire();
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(), 300);
  }
  command('gitgui.refreshCommits', () => refresh());
  command('gitgui.loadMoreCommits', () => { limit += 50; refresh(false); });
  command('gitgui.showDiff', showDiff);
  command('gitgui.openCommit', async ({ root, oid }) => {
    const repo = known(root);
    revision(oid);
    await vscode.commands.executeCommand('gitgui.open', vscode.Uri.file(repo.root), oid);
  });
  command('gitgui.showCommitGraph', async () => {
    const repo = await findRepository(undefined, true);
    if (repo) await openGraph(context, repo, showDiff, changed.event, report);
  });
  command('gitgui.fileHistory', async resource => {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!uri) throw new Error('Open or select a file to show its history.');
    const repo = await findRepository(uri);
    const file = repo.relative(uri.fsPath);
    const history = await repo.history(file);
    if (!history.length) { await vscode.window.showInformationMessage('No commits found for this file.'); return; }
    const pick = await vscode.window.showQuickPick(history.map(commit => ({
      label: commit.subject, description: `${commit.author} · ${commit.date.slice(0, 10)}`,
      detail: `${commit.oid.slice(0, 8)} · ${commit.file}`, commit
    })), { placeHolder: 'File history (most recent 200 commits, following renames)', matchOnDescription: true });
    if (pick) await showDiff({ root: repo.root, oid: pick.commit.oid, file: pick.commit.file });
  });

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(scheduleRefresh),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh));
  const watcher = vscode.workspace.createFileSystemWatcher('**');
  context.subscriptions.push(watcher, watcher.onDidChange(scheduleRefresh), watcher.onDidCreate(scheduleRefresh),
    watcher.onDidDelete(scheduleRefresh), { dispose() { clearTimeout(refreshTimer); } });

  // The built-in Git API also reports ref/index changes in linked worktrees and outside workspace watchers.
  let disposed = false;
  context.subscriptions.push({ dispose() { disposed = true; } });
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (gitExtension) gitExtension.activate().then(exports => {
    if (disposed || !exports.enabled) return;
    const api = exports.getAPI(1);
    const watch = repo => context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
    api.repositories.forEach(watch);
    context.subscriptions.push(api.onDidOpenRepository(repo => { watch(repo); scheduleRefresh(); }),
      api.onDidCloseRepository(scheduleRefresh));
  }).catch(() => {});
  activateBlame(context, findRepository, changed.event);
}

module.exports = { activateHistory };
