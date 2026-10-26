const vscode = require('vscode');
const { relativeTime } = require('./git-data');

function activateBlame(context, findRepository, onRepositoryChange) {
  const decoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  const cache = new Map();
  let timer, generation = 0, disposed = false;
  const enabled = () => vscode.workspace.getConfiguration('gitgui').get('inlineBlame', true);

  function schedule() {
    generation++;
    clearTimeout(timer);
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(decoration, []);
    timer = setTimeout(update, 250);
  }
  async function update() {
    const request = generation;
    const editor = vscode.window.activeTextEditor;
    if (disposed || !editor || !enabled() || editor.document.uri.scheme !== 'file' || editor.document.isDirty) return;
    const document = editor.document, version = document.version, line = editor.selection.active.line;
    try {
      const repo = await findRepository(document.uri);
      const file = repo.relative(document.uri.fsPath);
      const key = JSON.stringify([repo.root, file, await repo.fileRevision(file), version, line]);
      let blame = cache.get(key);
      if (blame === undefined) {
        blame = null;
        if (await repo.clean(file)) {
          blame = await repo.blame(file, line + 1);
          if (blame) blame.message = (await repo.commit(blame.oid)).message;
        }
        if (cache.size >= 200) cache.delete(cache.keys().next().value);
        cache.set(key, blame);
      }
      if (!blame || disposed || request !== generation || document.version !== version || document.isDirty ||
          editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) return;
      const hover = new vscode.MarkdownString();
      hover.appendText(`${blame.author} · ${new Date(blame.time).toLocaleString()}\n\n${blame.message}`);
      const args = encodeURIComponent(JSON.stringify([{ root: repo.root, oid: blame.oid, file: blame.path }]))
        .replace(/[()]/g, character => `%${character.charCodeAt(0).toString(16)}`);
      hover.appendMarkdown(`\n\n[Open commit in GitGUI](command:gitgui.openCommit?${args}) · [Show diff](command:gitgui.showDiff?${args})`);
      hover.isTrusted = { enabledCommands: ['gitgui.openCommit', 'gitgui.showDiff'] };
      editor.setDecorations(decoration, [{ range: document.lineAt(line).range,
        hoverMessage: hover, renderOptions: { after: {
          contentText: `${blame.author}, ${relativeTime(blame.time)} • ${blame.subject}`.replace(/[\r\n\t]/g, ' ')
        } } }]);
    } catch {
      // No blame for untracked files, unborn branches, unavailable Git or files removed during the request.
    }
  }

  context.subscriptions.push(decoration, vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.window.onDidChangeTextEditorSelection(schedule), vscode.workspace.onDidChangeTextDocument(schedule),
    vscode.workspace.onDidSaveTextDocument(schedule), vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('gitgui.inlineBlame')) schedule();
    }), onRepositoryChange(() => { cache.clear(); schedule(); }),
    { dispose() { disposed = true; generation++; clearTimeout(timer); cache.clear(); } });
  schedule();
}

module.exports = { activateBlame };
