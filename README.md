# GitGUI

A Linux desktop Git client built with Rust, Tauri 2, and TypeScript. The interface
uses a Linear-inspired dark canvas, neutral lifted surfaces, restrained lavender
controls, and Geist fonts bundled offline. A persistent sidebar lists local and
remote branches and tags beside the full-height, scrollable commit graph. Select
a sidebar entry to filter history, or All branches to see their connections.
The graph keeps inline ref labels and opens commit details on demand. Visual
conventions live in `DESIGN.md`.

Open, init, or clone a repository, browse branches and merge parents, inspect
commit or working-tree diffs (unified or side by side, with changed words marked),
stage/unstage whole files or single hunks, discard edits, stash work, create or
amend commits, create, switch, rename, and delete branches, check out remote
branches, merge, revert, cherry-pick, tag, reset, and clean up (rebase) commits,
browse file history and blame, open pull requests, resolve conflicts block by
block, free space taken by ignored build output and caches, keep several repositories open as tabs, and fetch/pull/push. Remotes are
fetched quietly every five minutes, and GitGUI checks GitHub once a day for a
newer published release.

## Install

Install the latest release on Linux (x86-64) or macOS (Apple silicon or Intel):

```sh
curl -fsSL https://raw.githubusercontent.com/MDHaarith/GitGUI/GitGUI/scripts/get.sh | sh
```

On 64-bit Windows, run in PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/MDHaarith/GitGUI/GitGUI/scripts/get.ps1).Content))
```

Both scripts download the latest release and verify its asset against
`SHA256SUMS.txt` before installing; missing or mismatched checksums stop the
installation. Linux uses `~/Applications/GitGUI/<version>/AppDir`, the `current`
symlink and a desktop launcher, keeping the AppImage and checksum beside it.
macOS copies the app from the universal DMG to `/Applications` (requesting sudo
if needed); Windows runs the NSIS installer silently. Git must already be on PATH.

To build and install from source instead:

```sh
npm install
npm run install:app
```

The installer detects the operating system, builds GitGUI, removes every older
installed version, and installs the new one:

- **Linux:** `~/Applications/GitGUI/<version>`, a `current` symlink, and a
  `gitgui.desktop` launcher. AppImageLauncher copies of GitGUI and their launchers
  are removed too. A running GitGUI keeps the old version until you close it.
- **macOS:** `/Applications/GitGUI.app`.
- **Windows (Git Bash):** runs the NSIS installer silently.

Or download an installer from the
[releases page](https://github.com/MDHaarith/GitGUI/releases): an AppImage, RPM,
`.deb` or portable `.tar.gz` for Linux, a universal `.dmg` (Apple silicon and Intel)
for macOS, and a `-setup.exe` for Windows. GitGUI needs Git installed and on PATH
([Git for Windows](https://git-scm.com/download/win) on Windows; on macOS the
Xcode command line tools or Homebrew Git).

The portable archive contains `gitgui` and license files; extract it and run
`./gitgui`. It requires the system WebKitGTK 4.1/GTK 3 libraries as well as Git.
Linux packages built on Fedora may require a newer glibc than older distributions
provide. `SHA256SUMS.txt` covers all uploaded release assets except itself;
checksums for macOS, Windows and the VSIX appear when cross-platform CI finishes.
Homebrew, winget and marketplace submission instructions are in
[`packaging/README.md`](packaging/README.md).

The macOS and Windows builds are not signed with a paid certificate yet:

- **macOS:** the first time, right-click GitGUI in Applications and choose
  Open, or run `xattr -dr com.apple.quarantine /Applications/GitGUI.app`.
- **Windows:** if SmartScreen warns, choose More info, then Run anyway.

## VS Code extension

`vscode-extension/` adds **GitGUI: Open Repository in GitGUI** to VS Code, with a
button in the Source Control title bar and an Explorer folder menu entry. Download
`gitgui-<version>.vsix` from the releases page (or run `npm run package` in
`vscode-extension/`) and install it with
`code --install-extension gitgui-<version>.vsix`. It launches the installed
desktop app; see `vscode-extension/README.md`.

## Run the built app

```sh
./src-tauri/target/release/gitgui
# Or open a repository immediately:
./src-tauri/target/release/gitgui /absolute/path/to/repository
```

The Fedora x86-64 installer is generated at
`src-tauri/target/release/bundle/rpm/GitGUI-0.2.0-1.x86_64.rpm`.
Install it with your package manager, then launch **GitGUI** from the application menu.

The x86-64 AppImage is generated at
`src-tauri/target/release/bundle/appimage/GitGUI_0.2.0_amd64.AppImage`.
Run it without installing:

```sh
chmod +x src-tauri/target/release/bundle/appimage/GitGUI_0.2.0_amd64.AppImage
./src-tauri/target/release/bundle/appimage/GitGUI_0.2.0_amd64.AppImage
```

The AppImage requires system Git 2.43+ and FUSE support. If FUSE is unavailable,
run it with `APPIMAGE_EXTRACT_AND_RUN=1`. This build uses Fedora 44 (glibc 2.43);
compatibility with older distributions is unverified. Build on the oldest target
distribution before distributing a broadly compatible Linux release.

The desktop installation uses `~/Applications/GitGUI/0.2.0`, with a stable
`~/Applications/GitGUI/current` symlink and one `gitgui.desktop` launcher. The
launcher runs the extracted `AppRun` directly, which prevents AppImageLauncher
from creating duplicate installations. The versioned AppImage and its SHA-256
checksum are kept beside the extracted application. The toolbar displays the
native application version. Repository data and saved drafts use the existing
`com.gitgui.app` application profile.

**Init repository** creates a repository with safeguards enabled; **Enable
safeguards** in Changes adds them to an existing one. The hooks block staged `.env`
files and lines that look like API or private keys, and run the test command in
`git config gitgui.testCommand` (set to `npm test` or `cargo test` when detected)
before code commits. GitGUI installs pre-commit and
post-commit hooks and adds `VERSION`, `CHANGELOG.md`, and an `AGENTS.md` section
where missing. Commits that change code (anything but Markdown, `docs/`, and tests)
must bump the version in `package.json`, `Cargo.toml`, or `VERSION` and add a
changelog entry; each new version is tagged `v<version>`. The commit form's version
selector does the bump, lockfile sync, and changelog entry for you, so command-line
agents and GitGUI follow the same rule.

**Checkpoints** save a snapshot of every file, including new ones, without
committing or touching what you staged. GitGUI also saves one when you come back to
the window (at most every 10 minutes, only when files changed) and keeps the latest
100 under `refs/gitgui/checkpoints`. Restoring one saves the current files first and
keeps files created afterwards. A hint bar and error messages explain conflicts,
detached HEAD, and sync problems in plain English.

**Review AI changes** lists every file changed since your last saved checkpoint
(or the last commit), riskiest first: possible secrets, removed tests, deletions,
dependency and config changes, and large edits. Undo one file or all of them; a
checkpoint is saved first. Health warnings in the hint bar flag files over 800
lines, deleted tests, new npm dependencies, three or more new TODOs, commits left
unpushed for a day, and code that exists only on this computer.

**Claude** explains staged changes, the AI session, or a conflicted file, and
**Write message with AI** drafts the commit message. Requests go to
`claude-opus-5-5` through `curl` with server-side fallback enabled
(`fallbacks: "default"`); the key comes from `ANTHROPIC_API_KEY`, the key saved in
the app (`~/.config/com.gitgui.app/anthropic-key`, mode 0600), or `ant auth`.
Changes over about 100k tokens are refused rather than cut. The dialog shows each
answer's tokens and cost and a running total.

**AI settings** switches the provider: DeepSeek, OpenAI, OpenRouter, Groq, Ollama,
or any OpenAI-compatible `/chat/completions` API (address, model, key), or a
command-line agent such as `codex exec -`, `claude -p`, or `opencode run` that reads
the request on stdin. Agents run in an empty temporary folder for up to 10 minutes,
so they cannot edit the project. Settings live in
`~/.config/com.gitgui.app/ai-provider.json` (mode 0600); only Claude answers are priced.

**Try something risky** starts a `try/<name>` branch; **Keep it** merges it back
with a merge commit, **Throw it away** deletes it after saving a checkpoint.
**Publish** (shown instead of Fetch, Pull, and Push until a remote exists) creates a private GitHub repository with `gh` or adds an existing empty repository URL, then pushes the main branch you choose first, so it becomes GitHub's default, followed by the current branch. Conflicted files get
Keep ours, Keep theirs, Mark fixed (refused while markers remain), and Explain;
Continue and Abort finish the merge, rebase, cherry-pick, or revert. **Undo last
commit** moves an unpushed commit's changes back to Staged and deletes its version
tag. **AI rules** edits `AGENTS.md` (with starter rules) and links it from
`CLAUDE.md`. **Run** starts `git config gitgui.runCommand`, else `npm run dev`/
`start`, `cargo run`, or a Python entry point, streams its output, and explains
common crashes. **Help** shows the tour and a glossary; button tooltips explain
Git terms.

The app remembers the last selected repository, offers the eight most recently
opened repositories, and keeps commit drafts locally for each repository.
Git remains responsible for credential helpers, SSH agents, hooks, and signing.
Missing identity/authentication/signing setup produces Git's error message and
keeps the draft. Only open repositories whose local configuration you trust.

Search loaded commit subjects, authors, and hashes with **Ctrl+F**. Enter moves
to the next match; Shift+Enter moves back. Search preserves the full graph and
marks matches. Load more history or choose a branch scope to search older commits.

Named branch tips start separate colored graph paths, including a branch that is
only ahead of another branch. Local and remote labels at the same commit share
a path; tags do not create additional lanes. Lines always follow actual parents.

Open Details to review commits alongside the graph. The pane follows commit
selection and can be resized horizontally. Diffs show old/new line numbers;
**Alt+Up/Down** moves between changed files. Working diffs reload on refresh,
including when the app regains focus, and clear when the selected change is gone.

Fetch, pull, and push display elapsed time and Git's live progress when available.
Messages are bounded and credential-redacted. Disabled action buttons explain
their requirements in tooltips and accessibility descriptions.

## Develop and build

Requirements: Rust 1.88+, Node 20.19+/22.12+ (tested with Node 24), and Git 2.43+.
Linux also needs the GTK 3 and WebKitGTK 4.1 development libraries; macOS needs the
Xcode command line tools; Windows needs the Visual Studio C++ build tools and
WebView2 (included in Windows 10 and 11). Developed on Fedora 44 x86-64; CI tests
every push on Ubuntu, macOS, and Windows (`.github/workflows/cross-platform.yml`).

```sh
npm ci --ignore-scripts
npm run tauri dev
npm run tauri build
```

The release build produces both AppImage and RPM packages. To package an existing
release binary as an AppImage without recompiling:

```sh
npm run tauri -- bundle --bundles appimage
```

The npm dependencies have no install lifecycle scripts. The committed lockfiles
pin the installed dependency graph. Fonts and their OFL licenses are in
`src/assets/fonts`; no Google Fonts request is made by the desktop app.

## MCP server for coding agents

`gitgui-mcp` exposes GitGUI's Git backend over stdio without starting the desktop
app. Build it with `cargo build --manifest-path src-tauri/Cargo.toml --bin gitgui-mcp
--release`, or use the binary shipped with the app. Regular `tauri build` builds
and bundles both Cargo binaries; `default-run` keeps `gitgui` as the desktop entry
point. No separately copied `bundle.externalBin` sidecar is needed
([Tauri's binary discovery](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-cli/src/interface/rust.rs#L861)).
Packaged Linux installs put it beside `gitgui` (inside an extracted AppImage:
`usr/bin/gitgui-mcp`); macOS: `GitGUI.app/Contents/MacOS/gitgui-mcp`; Windows:
`gitgui-mcp.exe` in the installation folder. Use its absolute path in client
configuration, or put it on `PATH`.

The default repository is `--repo <path>` or the current directory. Every tool
also accepts an optional `repo` override. Only use repositories whose Git config
and hooks you trust. Git must be installed, just as for the desktop app.

Read tools are always available: `status`, `log` (limit, branch and literal path),
`show_commit`, `diff` (working, staged, or two refs), `branches`, `tags`, `stashes`,
`blame`, `file_history`, `list_checkpoints`, and `code_search`. Code search needs
`code-review-graph` installed and an index built with
`code-review-graph build --repo /absolute/path/to/repo`.

Permissions are read once at server startup and default to read-only:

- `GITGUI_MCP_ALLOW_WRITE=1` adds `stage`, `unstage`, `commit`, `create_branch`,
  `switch_branch`, `stash_save`, and `save_checkpoint`.
- Independently, `GITGUI_MCP_ALLOW_DESTRUCTIVE=1` adds `discard_files`, `reset`,
  `restore_checkpoint`, and `drop_stash`. These save a checkpoint before changing
  work; unchanged snapshots are deduplicated, as in the desktop app. Dropped
  stashes also retain their full contents at the returned `recoveryRef`, recoverable
  with `git stash apply <recoveryRef>` (including untracked files).

Disabled tools are hidden and calls to them are refused. Stage, unstage, and
discard take the file IDs returned by `status`; drop_stash takes the index and
message returned by `stashes`. Checkpoints exclude ignored files. Tool content is
credential-redacted and capped at 64 KiB with a truncation notice; narrow `limit`,
`path`, or the blame line range for larger results. Requests are limited to 1 MiB.
The server implements newline-delimited JSON-RPC 2.0 initialization, ping, and
tool discovery/calls, with tool failures returned as `isError: true` text results.

**Claude Desktop** — add to `claude_desktop_config.json` (replace both absolute
paths; use escaped backslashes or forward slashes on Windows):

```json
{
  "mcpServers": {
    "gitgui": {
      "command": "/absolute/path/to/gitgui-mcp",
      "args": ["--repo", "/absolute/path/to/repo"]
    }
  }
}
```

**Claude Code** — with `gitgui-mcp` on `PATH`, run from your repository:

```sh
claude mcp add gitgui -- gitgui-mcp --repo .
```

**Cursor** — put the same `mcpServers` JSON shown above in `.cursor/mcp.json`
(project) or `~/.cursor/mcp.json` (user).

**VS Code** — put this in `.vscode/mcp.json`:

```json
{
  "servers": {
    "gitgui": {
      "type": "stdio",
      "command": "/absolute/path/to/gitgui-mcp",
      "args": ["--repo", "${workspaceFolder}"]
    }
  }
}
```

To opt into writes, add `"env": { "GITGUI_MCP_ALLOW_WRITE": "1" }` alongside
`command` and `args` in any of these JSON entries, then restart the server.

## Checks

```sh
npm run version:check
npm test
npm run test:ui   # real UI in headless Chromium against a mocked Tauri bridge
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -p gitgui --check
npm audit
cargo audit --file src-tauri/Cargo.lock
```

Real-repository tests use disposable fixtures and a local bare remote. They cover
partial staging, unborn HEAD, filenames with spaces/newlines/non-UTF-8 bytes,
renames, failed hooks, merge parents, frozen history pages, tags, detached HEAD,
linked worktrees, binary/symlink previews, safe branch switches, mirror-config
protection, fast-forward pull, rejected pushes, and shallow history.

The native desktop smoke test drives the actual release binary and Rust bridge
using [Tauri's native WebDriver workflow](https://v2.tauri.app/develop/tests/webdriver/).
It checks the branch sidebar, graph filtering, keyboard focus, fonts, on-demand
details, selective staging, commits,
retained drafts after failed hooks, branch actions, publishing, and fetch.

With `tauri-driver` and `WebKitWebDriver` installed:

```sh
GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 tauri-driver
python3 scripts/desktop_smoke.py src-tauri/target/release/gitgui
```

Run the driver on an isolated test desktop/data profile if testing alongside normal
app use. The script creates and deletes only its own temporary repository. Its
rendered app DOM is saved to `test-results/desktop.html`. WebKit's screenshot
endpoint can stall on some Linux graphics setups, so it is not part of the workflow assertions.

## Release versions

`package.json` is the version source. Tauri reads it directly; the npm version
hook synchronizes the Rust manifest and lockfile. Builds reject mismatched
versions. Every commit that changes app code gets its own version (Semantic
Versioning: patch for fixes, minor for features, major for breaking changes) and
a `CHANGELOG.md` entry. `npm install` enables `.githooks`: pre-commit rejects
app changes without a bump and changelog entry; post-commit tags `v<version>`.

```sh
npm version minor --no-git-tag-version
# add "## <version> — <date>" to CHANGELOG.md
git add -A && git commit
npm run tauri -- build --bundles appimage
```

Merge the release into the existing `GitGUI` branch. Keep versioned release
filenames and checksums; point the desktop's `current` symlink at the new extracted release after verifying
startup. Retire obsolete launchers and binaries without deleting application
profiles or repository files.

When building inside an AppImage-based IDE, clear its inherited launcher
variables for the build command:

```sh
env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD -u ELECTRON_RUN_AS_NODE \
  -u REDIRECT_APPIMAGE -u TARGET_APPIMAGE -u APPIMAGE_SILENT_INSTALL \
  -u LD_LIBRARY_PATH npm run tauri -- build --bundles appimage
```

## Boundaries

- One active repository. History loads in 200-commit pages, up to 10,000 commits
  per scope. Unloaded parents remain visible as continuation paths.
- Metadata/index reads are limited to 16 MiB. Diff/file previews are limited to
  2 MiB and 5,000 rendered lines, with an explicit truncation notice.
- Pull requires a clean working tree and uses fast-forward only. Push sends only
  the current branch and never force-pushes or mirrors other refs.
- Conflicts are resolved per file or per conflict block (yours, incoming, or both);
  multi-commit sequencer operations must be completed in the terminal.
- Staging works per file, per hunk, or selected changed lines (click or Shift-click).
  History search covers up to 10,000 loaded commits. Amend and undo refuse commits that were already pushed.
- The update check only sees published releases, not drafts.
- Nested submodule operations are outside this release.
- "Install and restart" replaces the Linux AppImage in place; on macOS and Windows,
  Download opens the release page with the new installer.

## Dependency safety

Tauri's GTK 3 stack uses glib 0.18.5. A local override in `vendor/glib` backports
the upstream mutable out-pointer fix for
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429).
Its regression test is also run in an optimized build. The audit exception is
limited to that fixed advisory; the original source and licenses are preserved.

The dependency audit still reports the build-time, unmaintained
[proc-macro-error advisory](https://rustsec.org/advisories/RUSTSEC-2024-0370)
through the GTK tooling. It has no patched upstream version. Track it when
upgrading the Tauri/GTK dependency stack; no audit finding is silently suppressed.
