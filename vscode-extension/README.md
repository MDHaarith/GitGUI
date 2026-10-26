# GitGUI for VS Code

Browse Git history inside VS Code, with no build step or runtime dependencies. A `git` executable on PATH is required for history features; the desktop app is only needed for **Open in GitGUI**.

- **Inline blame** shows `author, relative time • summary` after the active line. Hover for the full commit message, **Show diff**, and **Open commit in GitGUI**. Updates are debounced and cached by file revision and line. Untracked files, unsaved buffers, and files with staged or unstaged changes are skipped to avoid attributing changed lines. Disable it with `"gitgui.inlineBlame": false`.
- **GitGUI Commits** in Source Control lists the current branch's most recent 50 commits, including author and date. Expand a commit to see its files; select a file to compare the first parent with that commit. **Load more** fetches another 50 commits. The refresh button, workspace file events and the built-in Git extension's repository events refresh history, including linked worktrees. The active editor selects the repository; without one, the first workspace folder is used.
- **GitGUI: Show Commit Graph** draws up to 2,000 commits from all branches in topological order, including merge lanes. Select a commit to see its full message and changed files; select a file for its diff. Dashed lines mark parents outside the loaded history. The webview uses a nonce-based content security policy and loads no remote resources.
- **GitGUI: File History** works on the active file or a file's Explorer context menu. Pick from its latest 200 commits, following renames, to compare the historical file with its first parent.

Revision diffs use read-only `gitgui-rev:` documents backed by `git show`. Added and deleted files compare against an empty document; merge commits compare against their first parent. Git failures appear in the commits view or as command errors. Git commands use argument arrays, literal pathspecs and the repository root as their working directory (after root discovery).

Open a workspace repository in the [GitGUI desktop app](https://github.com/MDHaarith/GitGUI/releases) using **GitGUI: Open Repository in GitGUI**, the Git Source Control title bar button, or a folder's Explorer context menu. With several workspace folders and no active editor, choose a folder from the picker.

The GitGUI desktop app must be installed separately. The extension detects the Linux AppRun installation (then `gitgui` on PATH), `/Applications/GitGUI.app` on macOS, and the per-user Windows installation. Set `gitgui.executablePath` in User Settings to the absolute executable path to override detection (on macOS, use the binary inside the app bundle).

**Open commit in GitGUI** passes the repository path and `--commit <sha>` to the desktop launcher. Selecting the commit requires desktop support for that argument; desktop versions which only accept a repository path open the repository without selecting the commit. **Show diff** works entirely inside VS Code.

Install a downloaded or locally packaged VSIX:

```sh
code --install-extension gitgui-0.1.0.vsix
```

To package from this directory, run `npm run package`. Tests use `node --test` (or `npm test`); Git output is tested with fixtures, without creating repositories. Remove the generated VSIX after verification.

The extension keeps `extensionKind: ["ui"]`: it runs on the UI machine, uses that machine's Git installation and launches its desktop app. Local folders are supported. Remote SSH, WSL, containers and virtual workspace paths are not supported because they cannot be read by the local Git process or passed to the local desktop app.
