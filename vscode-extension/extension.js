const vscode = require('vscode');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { launchCommand } = require('./launch');
const { activateHistory } = require('./history');
const { revision } = require('./git-data');

async function showMissing() {
  const choice = await vscode.window.showErrorMessage(
    'GitGUI was not found. Install the desktop app or set gitgui.executablePath.',
    'Download GitGUI');
  if (choice === 'Download GitGUI') {
    await vscode.env.openExternal(vscode.Uri.parse('https://github.com/MDHaarith/GitGUI/releases'));
  }
}

function reportSpawnError(error) {
  if (error.code === 'ENOENT') return showMissing();
  return vscode.window.showErrorMessage(`Could not start GitGUI: ${error.message}`);
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('gitgui.open', async (resource, commit) => {
    if (commit !== undefined) {
      try { revision(commit); }
      catch (error) { await vscode.window.showErrorMessage(error.message); return; }
    }
    let folder = resource instanceof vscode.Uri ? resource : undefined;
    if (!folder) {
      const folders = vscode.workspace.workspaceFolders || [];
      if (!folders.length) {
        await vscode.window.showErrorMessage('Open a folder before launching GitGUI.');
        return;
      }
      const editor = vscode.window.activeTextEditor;
      let selected = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!editor && folders.length > 1) {
        const pick = await vscode.window.showQuickPick(folders.map(item => ({
          label: item.name, description: item.uri.fsPath, folder: item
        })), { placeHolder: 'Select a repository to open in GitGUI' });
        if (!pick) return;
        selected = pick.folder;
      }
      folder = (selected || folders[0]).uri;
    }
    if (folder.scheme !== 'file') {
      await vscode.window.showErrorMessage('GitGUI can only open folders on this computer.');
      return;
    }

    const launch = launchCommand(process.platform, folder.fsPath, {
      env: process.env,
      exists: existsSync,
      configured: vscode.workspace.getConfiguration('gitgui').get('executablePath', '')
    });
    if (!launch) return showMissing();
    if (commit) launch.args.push('--commit', commit);

    try {
      const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore' });
      child.once('error', reportSpawnError);
      child.unref();
    } catch (error) {
      await reportSpawnError(error);
    }
  }));
  activateHistory(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
