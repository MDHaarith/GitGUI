# GitGUI implementation plan

Status: planning only. No application has been scaffolded or built.

## Goal and decisions

Build a Linux-first desktop Git client for the everyday workflow: open a local repository, inspect changes, stage files, write a commit, inspect history, switch branches, and sync with a remote.

Confirmed choices: Rust backend, Tauri web UI, Linux first. The workspace is empty and is not yet a Git repository. The development machine runs Fedora KDE; Cargo, Rust, Node, npm, and Git are available. Their versions and the required native libraries have not been checked.

Recommended stack:

| Part | Choice | Reason |
| --- | --- | --- |
| Desktop shell | Tauri 2 | Matches the selected Rust backend and web UI. |
| UI | Vanilla TypeScript, HTML, CSS, Vite | One window with a few views; begin with Tauri's maintained vanilla template. |
| Git operations | Installed Git CLI through Rust `std::process::Command` | Keep Git's behavior, configuration, hooks, signing, and credential helpers. |
| UI/backend bridge | Named Tauri commands with Serde request/response types | Keep repository access and validation in Rust. |
| Folder picker | Official Tauri dialog plugin | Select a local repository through a desktop dialog. |
| Tests | Rust tests; `tempfile` as a dev dependency | Test against disposable real repositories. |
| First package | Linux x86-64 RPM for the Fedora development target | Validate a packaged app on the first supported environment. |

Tauri recommends its vanilla template as a starting point and supports TypeScript. Pin dependency versions and commit `Cargo.lock` and the npm lockfile when scaffolding. [Tauri project creation](https://v2.tauri.app/start/create-project/)

Use the Git executable consistently for reads and writes. A second Git implementation would add behavior differences without solving a first-release requirement. Direct argument passing avoids shell interpretation. [Rust Command API](https://doc.rust-lang.org/std/process/struct.Command.html)

## First release scope

The first usable milestone delivers the complete local commit workflow. The first release adds history, branches, and remote sync.

| Capability | First usable milestone | First release |
| --- | --- | --- |
| Open an existing local repository | Yes | Yes |
| Show branch and repository state | Yes | Yes |
| List staged, unstaged, untracked, and conflicted files | Yes | Yes |
| Review a selected file's staged or working-tree diff | Yes | Yes |
| Stage and unstage selected whole files or all displayed files | Yes | Yes |
| Commit the existing index with a summary and optional body | Yes | Yes |
| Browse recent commits and inspect a commit's changed files | — | Yes |
| List, create, and switch local branches | — | Yes |
| Fetch, pull with `--ff-only`, and push the current branch | — | Yes |
| Select an existing remote and publish a branch with no upstream | — | Yes |

Unstaged files stay outside the commit. A file changed in both the index and the working tree appears in both groups, with the appropriate diff in each.

## Interface

Use one desktop window with a Changes view and a History view.

- **Top bar:** repository name, Open repository, current branch, upstream/ahead/behind status, Refresh, Fetch, Pull, and Push. Ahead/behind reflects the most recent fetch; opening a repository does not contact a remote.
- **Changes list:** separate Staged, Unstaged/Untracked, and Conflicts groups. Show filename, change type, selection, and explicit Stage/Unstage actions. Preserve rename source and destination.
- **Diff panel:** unified diff with line numbers, visible addition/deletion markers, selectable text, and a heading identifying staged or working-tree content. Show a clear placeholder for binary data and unsupported previews.
- **Commit composer:** required summary, optional body, staged file count, and a Commit button. Keep the draft on failure. Disable Commit when the summary is blank, the index is empty, or an unsupported repository operation is underway.
- **History:** initially load 100 commits, with Load more. Show subject, author, time, short SHA, and changed files/diff for a selected commit. Skip a custom branch graph in this release.
- **Branch picker:** list local branches, switch, or create a branch from the current HEAD. Let Git refuse switches that would overwrite changes; never automatically stash or discard them.
- **Feedback:** an operation indicator and inline success/error message with bounded, redacted Git details. Distinguish authentication failure, missing identity, hook/signing failure, index lock, dirty branch switch, and rejected push.

Support the system color scheme, keyboard navigation, visible focus, labeled controls, non-color status markers, and copyable diff text. Shortcuts: Ctrl+O to open, Ctrl+R to refresh, and Ctrl+Enter to commit only while the composer has focus and validation passes. Reflow the panels at narrow window widths; preserve scroll and the draft when refreshing.

The accompanying `docs/gitgui-concept.html` uses sample data to illustrate selection, staging, and committing. It performs no Git operations.

Planning validation: checked the concept at 728 px in dark appearance and 320 px in light appearance without horizontal overflow. Its self-check passed staging, unstaging, blank-summary validation, committing only staged files, and adding the sample commit to history. Backend behavior and Linux builds remain untested until implementation.

## Backend and data flow

Keep the initial code layout small:

```text
src/
  main.ts                 UI state, rendering, event handlers
  git.ts                  typed Tauri invocations and response types
  styles.css              application layout and theme
src-tauri/
  src/main.rs             generated desktop entry point
  src/lib.rs              Tauri setup, app state, named commands
  src/git.rs              Git process execution, parsing, shared models
  tests/git_workflow.rs   real-repository integration checks
  capabilities/main.json minimum permissions for the local main window
  tauri.conf.json         window, CSP, and bundle configuration
```

Split a module only when its responsibilities make that necessary. No separate service, database, backend HTTP server, or generic command-execution endpoint is needed.

Data flow: UI action → typed Tauri command → Rust validation → background Git subprocess → typed result → refreshed UI.

1. Rust owns the currently selected repository. Validate it using `git rev-parse`, resolve its worktree root and Git metadata paths, and return a repository ID. Support linked worktrees; do not assume `.git` is a directory. Reject bare repositories for the commit workflow with an explanation.
2. Return a snapshot with repository ID, refresh generation, HEAD/branch/upstream state, operation state, and file entries. Keep original path bytes in Rust; use opaque file IDs and escaped display labels across JSON. A display-only replacement character must never change the path passed to Git.
3. Parse `git status --porcelain=v2 -z --branch --untracked-files=all` as bytes, including rename records and conflicts. Ignore unknown optional headers. [Git status format](https://git-scm.com/docs/git-status)
4. Run blocking processes through Tauri's blocking-task runtime from async commands. Serialize mutations for the active repository, disable duplicate UI actions, and prevent repository switches during a write. Discard obsolete read responses after a newer selection/refresh. An async function alone does not make `Command::output` non-blocking. [Tauri commands](https://v2.tauri.app/develop/calling-rust/)
5. Refresh after every mutation, on window focus, and on explicit Refresh. Rescan before a commit or branch switch; require renewed review if the staged state or HEAD changed since the displayed snapshot. Preserve drafts and selection when possible. Let Git's locks handle external writers; report contention without deleting locks.
6. Bound and drain subprocess output. Cap a displayed diff/file preview at 2 MiB and error details at 64 KiB, with a visible truncation notice. Never treat truncated status output as a complete or clean repository. Give reads/network operations timeouts; reconcile repository state after an interrupted write before retrying.

Named commands cover opening, snapshot/diff/history reads, staging, unstaging, committing, branch listing/creation/switching, and fetch/pull/push. Each validates the repository ID and any selected file, branch, or remote in Rust.

## Git behavior and safety

- Pass arguments directly to `Command`; never construct a shell command. Use `--` before path arguments and `--literal-pathspecs` for filename-based operations so filenames cannot act as options, patterns, or pathspec magic. [Git argument handling](https://git-scm.com/docs/git)
- Use `git add` for staging selected files, including tracked deletions. Unstage through `git restore --staged` when HEAD exists, with a tested unborn-HEAD path using removal from the index only. Never remove a working-tree file to unstage it.
- Compare index versus working tree with `git diff` and index versus HEAD with `git diff --cached`. Disable paging, color, external diff, and textconv for read views. Read untracked previews without following symlinks outside the repository; render a symlink's target text instead. [Git diff options](https://git-scm.com/docs/git-diff)
- Commit only the index, using `git commit -F -` with the message on stdin. Do not use `-a`, `--no-verify`, or disable signing. Keep the draft and report hook/signing errors. Existing Git hooks and filters may execute during deliberate writes. [Git commit behavior](https://git-scm.com/docs/git-commit)
- Validate new branch names through Git's ref-name validation. Display detached HEAD explicitly and require acknowledgment before committing there. An unborn repository must still allow its first commit.
- Show unresolved conflicts and merge/rebase/cherry-pick/revert state. The first release pauses unsupported operation completion and points the user to their terminal; normal commit/sync actions remain disabled until the state is resolved. Display submodule changes but leave nested submodule workflows outside the release.
- Pull only with `--ff-only` and require a clean working tree for the first release. Divergence produces an explanation rather than an automatic merge/rebase. [Git pull behavior](https://git-scm.com/docs/git-pull.html)
- Push only the selected current branch to its upstream. Without an upstream, let the user choose a configured remote and explicitly set upstream for that branch. Do not expose force-push or allow configuration to turn the action into a mirror/all-branches push.
- Reuse existing credential helpers, SSH agent, and signing setup. Set `GIT_TERMINAL_PROMPT=0` so unavailable terminal prompts fail clearly; preserve configured desktop askpass/pinentry behavior. Store no credentials and redact credentials embedded in remote URLs. [Git credentials](https://git-scm.com/docs/gitcredentials)
- Bundle only local frontend content, render repository text with DOM text nodes, use a restrictive production CSP, and allow only required dialog/core capabilities for the main window. Custom commands still need their own Rust validation; capabilities do not automatically validate their arguments. [Tauri capabilities](https://v2.tauri.app/security/capabilities/), [Tauri CSP](https://v2.tauri.app/security/csp/)

## Build order and acceptance

### 1. Desktop foundation

Scaffold Tauri 2's vanilla TypeScript template, configure Linux prerequisites and the folder picker, build the window, and implement repository discovery and error states.

Done when the app opens a real repository or linked worktree on Fedora, rejects an invalid/bare path clearly, and remains usable while discovery runs. A missing Git executable gets a clear setup message.

### 2. Changes and review

Implement status parsing, grouped file lists, selected-file diff, untracked/binary previews, and refresh behavior.

Done when the UI agrees with Git for staged, unstaged, untracked, renamed, deleted, and conflicted files, including a file with both staged and unstaged changes. Filenames with spaces, newlines, leading dashes, pathspec characters, and non-UTF-8 bytes remain addressable. Large previews are bounded and the UI stays responsive.

### 3. Stage and commit — first usable milestone

Implement selected/all-file stage and unstage, composer validation, commit execution, and post-operation refresh.

Done when selecting one of two changed files commits only that file; unstaging preserves its working-tree content; an empty repository supports stage/unstage/first commit; and a failing hook leaves the draft and repository recoverable. Repeated clicks cannot create duplicate mutations.

### 4. History, branches, and sync

Add paged history and commit inspection, local branch creation/switching, fetch, fast-forward pull, and current-branch push/upstream selection.

Done when two disposable clones can exchange a commit through a local bare remote, a dirty branch switch fails safely, a divergent pull refuses to merge, and a rejected push produces actionable feedback. Check missing upstream and authentication/signing failure behavior separately.

### 5. Linux release verification

Check keyboard/focus behavior, theme, narrow layouts, large repositories, and the actual packaged app. Start with Fedora x86-64 RPM, test launch and the commit workflow outside the dev server, and document the supported environment. Tauri requires distribution-specific WebKitGTK and other native dependencies. [Linux prerequisites](https://v2.tauri.app/start/prerequisites/), [RPM packaging](https://v2.tauri.app/distribute/rpm/)

Add an AppImage and Ubuntu/Debian coverage once those environments are tested. Build broader Linux packages on an appropriate oldest-supported base; do not promise compatibility from a Fedora build alone. [AppImage distribution](https://v2.tauri.app/distribute/appimage/)

Release checks: frontend type-check/build, Rust formatting/Clippy/tests, dependency audits, and a packaged-app smoke test. Keep the real-repository tests focused on parsing/path handling, index preservation, commit contents, failed hooks, and safe branch/remote behavior. Do not contact a user's remote or mutate a user's repository during automated tests.

## Deferred work

Clone/init, hunk staging, stash management, amend/reset/rebase/cherry-pick, conflict editing, branch deletion, discard/clean, interactive credential setup, custom commit graphs, multi-repository tabs, hosting-service/PR integrations, auto-updates, and Windows/macOS packaging.

The first implementation task is phase 1, followed immediately by phases 2 and 3 to deliver the local commit workflow. The main release risks are WebKitGTK/package compatibility and user-specific Git authentication/signing environments; validate both on the target desktop before claiming release readiness.
