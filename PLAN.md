# GitGUI implementation plan

Status: implemented as a Linux-first Tauri application. Source is in src/ and src-tauri/; the release executable and Fedora RPM are built under src-tauri/target/release/. See README.md for launch, development, verification, and release boundaries.

## Goal and decisions

Build a Linux-first Git client whose main workspace is a visual branch and commit graph, following the supplied reference image. The graph must make divergence, shared ancestry, and merges immediately visible. Reviewing changes and committing are companion workflows within this workspace.

Confirmed choices: Rust backend, Tauri web UI, Linux first. Implemented and built on Fedora 44 KDE using Rust 1.92, Node 24, Git 2.56, GTK 3, and WebKitGTK 4.1. Existing user reference files and repository changes are preserved.

Recommended stack:

| Part | Choice | Reason |
| --- | --- | --- |
| Desktop shell | Tauri 2 | Matches the selected Rust backend and web UI. |
| UI | Vanilla TypeScript, HTML, CSS, Vite | One window with a few views; begin with Tauri's maintained vanilla template. |
| Branch graph | SVG paths/nodes with aligned HTML commit rows | Render real parent connections and keep metadata aligned with the graph. |
| Git operations | Installed Git CLI through Rust `std::process::Command` | Keep Git's behavior, configuration, hooks, signing, and credential helpers. |
| UI/backend bridge | Named Tauri commands with Serde request/response types | Keep repository access and validation in Rust. |
| Folder picker | Official Tauri dialog plugin | Select a local repository through a desktop dialog. |
| Tests | Rust tests; `tempfile` as a dev dependency | Test against disposable real repositories. |
| First package | Linux x86-64 RPM for the Fedora development target | Validate a packaged app on the first supported environment. |

Tauri recommends its vanilla template as a starting point and supports TypeScript. Pin dependency versions and commit `Cargo.lock` and the npm lockfile when scaffolding. [Tauri project creation](https://v2.tauri.app/start/create-project/)

Use the Git executable consistently for reads and writes. A second Git implementation would add behavior differences without solving a first-release requirement. Direct argument passing avoids shell interpretation. [Rust Command API](https://doc.rust-lang.org/std/process/struct.Command.html)

## First release scope

The first usable milestone is **open a repository → see its branches and merge history → select and inspect a commit**. The first release adds branch actions, staging/committing, and remote sync. The graph is required from the first milestone.

| Capability | First usable milestone | First release |
| --- | --- | --- |
| Open an existing local repository | Yes | Yes |
| Show branch and repository state | Yes | Yes |
| Visual commit graph with forks and all merge-parent connections | Yes | Yes |
| Local/remote branch labels, tags, and HEAD at their exact commits | Yes | Yes |
| Select a commit and inspect metadata, parents, changed files, and diff | Yes | Yes |
| All-branches view or selected branch's ancestry | Yes | Yes |
| Load additional history without breaking graph lanes | Yes | Yes |
| List staged, unstaged, untracked, and conflicted files | — | Yes |
| Review a selected file's staged or working-tree diff | — | Yes |
| Stage and unstage selected whole files or all displayed files | — | Yes |
| Commit the existing index with a summary and optional body | — | Yes |
| List, create, and switch local branches | — | Yes |
| Fetch, pull with `--ff-only`, and push the current branch | — | Yes |
| Select an existing remote and publish a branch with no upstream | — | Yes |

Unstaged files stay outside the commit. A file changed in both the index and the working tree appears in both groups, with the appropriate diff in each.

## Interface

Use one desktop window following the supplied Busy History HTML: a narrow graph gutter followed by **Description | Author | Date | Commit**. Put branch/tag labels inline before the description of their exact target commit. Rows represent commits in topological order, with descendants above ancestors. Keep graph nodes, labels, selection, and metadata vertically aligned during scrolling.

- **Top bar:** repository name, Open repository, current checkout, upstream/ahead/behind state, history scope, Refresh, Fetch, Pull, Push, and Working changes. Scope selects all branches or one branch's ancestry; it does not change checkout. Opening a repository does not contact a remote.
- **Graph:** colored lanes, commit dots, curved split/join connections, and every parent edge for a merge. Preserve unmerged branches alongside main history. Prefer the current checkout's first-parent path as the main lane where possible.
- **Branch/tag labels:** attach local branches, remote-tracking branches, and tags to their exact commits. Show multiple labels at shared tips and identify HEAD/current checkout. Distinguish local, remote, and tag labels through text/shape as well as color. Click a label to select its tip.
- **Commit details:** selecting a row highlights the commit. An explicit Details button opens its full message, author/date, full copyable object ID, parent links, changed files, and diff in a compact closable dialog. Keep details hidden by default; they must not occupy a permanent block beneath the graph. Support keyboard dismissal and restore focus to the Details button. For merge commits, default to a first-parent comparison and offer other parents explicitly. For root commits, show initial additions.
- **Working changes panel:** a companion lower panel with staged/unstaged/untracked/conflict groups, selected-file unified diff, and a required commit summary plus optional body. Keep the draft on failure and preserve graph selection/scroll when opening or closing it. Disable Commit when the summary is blank, the index is empty, or an unsupported operation is underway. After commit, refresh the graph and select the new HEAD.
- **Branch actions:** create a local branch at HEAD or the selected commit, or explicitly switch to an existing branch. Creating a branch adds a ref label, not an invented commit node. Let Git refuse switches that would overwrite changes; never automatically stash or discard them.
- **Feedback:** an operation indicator and inline success/error message with bounded, redacted Git details. Distinguish authentication failure, missing identity, hook/signing failure, index lock, dirty branch switch, and rejected push.

Match Busy History's dense desktop layout and fixed dark theme. Use its flat toolbar, Scope control row, quiet metadata, small outlined monospace ref labels, and restrained selection across the full row. Keep paths thin and reserve branch colors for graph paths and local refs. Support keyboard navigation, visible focus, labeled controls, non-color status markers, and copyable text. Arrow keys move commit selection. Shortcuts: Ctrl+O to open, Ctrl+R to refresh, and Ctrl+Enter to commit only while the composer has focus and validation passes. Keep one synchronized vertical scroll region for graph and rows. At narrow widths retain the graph and description with ref labels; move author/date/SHA into the details dialog.

An unborn repository gets an empty graph and a working-changes action for its first commit. Detached HEAD remains visible even without a branch label. Remote-tracking refs reflect the latest locally fetched state.

The accompanying `docs/gitgui-concept.html` illustrates branch histories and merges with sample data. It performs no Git operations.

## Theme source of truth

Use [Busy History](</home/mdhaarith/Documents/Projects/GitGUI/Busy history-html/Busy.dc.html>) for visual values and [its README](</home/mdhaarith/Documents/Projects/GitGUI/Busy history-html/README.md>) for how to interpret the export. Implement its styling in the application's own frontend components. The exported React/support runtime is reference tooling.

| Element | Reference value |
| --- | --- |
| Main canvas | `#141518` |
| Toolbar/status surfaces | `#18191d` |
| Scope surface | `#16171b` |
| Main text | `#d9dade` |
| Secondary text | `#9195a1` |
| Controls | `#b4b7c0` |
| Dividers | `#26282e` |
| Selection | `#232a3b`, with a 2 px `#7aa2f7` leading edge |
| Typography | Geist 13 px; Geist Mono for refs and object IDs |
| Lane colors | `#7aa2f7`, `#8bc58a`, `#5ec4c0`, `#d98fb0`, `#a98be0` |
| Main toolbar / scope row / column header | 44 px / 36 px / 24 px |
| Commit rows / status bar | 28 px / 24 px |
| Paths / ordinary nodes / merge rings | 1.75 px / 4 px radius / 5.5 px radius |
| Ref tags | 11 px mono, 1 px outline, 3 px radius |

Design for the confirmed 1366 × 768 display at 100% scaling. Keep the approved on-demand details dialog. The reference's Focus/collapsed-run behaviors are separate features and are not implied by adopting its theme. The production app bundles Geist/Geist Mono locally with their OFL licenses and makes no font-service requests.

Planning validation: previewed the concept at 1024/728 px in dark appearance and 360/320 px in light appearance without horizontal overflow. Its sample-data checks passed 17 nodes, 19 parent connections, merge-parent inspection, parent navigation, branch-tip selection, and scoped ancestry retaining merged histories. Live Git traversal, automatic lane allocation, and pagination remain implementation work.

UI refinement: removed the permanent bottom commit-details block. Details now open through an explicit button in a native closable dialog; the graph remains the default workspace. Verified hidden-by-default behavior, dialog open/close, and narrow-screen fit.

Busy History theme validation: compared against the supplied artboard at 1366 px; confirmed `#141518`, loaded Geist/Geist Mono, approximately 28 px commit rows, and a 632 px concept height that fits the 768 px display. Rechecked 728/320 px layouts, ref/parent navigation, graph connections, and hidden-by-default dialog behavior.

## Graph data and layout

Rust returns commit/ref data; TypeScript assigns lanes and renders SVG. Do not parse Git's terminal ASCII graph or infer connections from timestamps, row adjacency, or branch names.

1. Read `refs/heads`, `refs/remotes`, and `refs/tags` with `git for-each-ref`. Resolve annotated tags to commits and omit symbolic remote HEAD aliases from the branch list. Resolve HEAD separately and include it when detached. Keep full object IDs as identity and Git-generated abbreviations for display. [Git refs](https://git-scm.com/docs/git-for-each-ref)
2. Freeze resolved tip object IDs for the current graph generation. Traverse those tips with `git log --topo-order` and an explicit machine-readable format containing object ID, all ordered parent IDs, subject, author, and timestamp. Use byte-aware framing and report malformed output. Topological ordering prevents clock skew from placing parents above descendants. [Git log](https://git-scm.com/docs/git-log)
3. Return `Commit { oid, parents, subject, author, timestamp }` and `Ref { name, kind, target, is_head }`. Attach every ref to its exact target. Load full messages and diffs on selection.
4. Use a deterministic lane allocator: maintain active lanes keyed by expected commit ID, reuse an expected lane, continue toward the first parent, allocate/reuse lanes for additional parents, and join at shared ancestors. Reuse vacant columns without shifting every existing path. Preserve every parent edge, including octopus merges and disconnected roots.
5. Generate node coordinates and parent-edge segments from this DAG. Distinguish a crossing from a connected dot. Keep lane colors stable within the loaded generation. Shared commits appear once; a lane color does not mean exclusive branch ownership.
6. Initially load 200 commits with Load more. Keep frozen tips and lane state across pages. Show continuation markers for parents outside the loaded page rather than false roots. Shallow/unavailable parents have distinct boundary states. If refs change, begin a new generation and preserve selection by object ID when possible. [Git traversal](https://git-scm.com/docs/git-rev-list)
7. Selected-branch scope includes its full ancestry and merged parents. Do not remove intermediate rows and then draw connections implying invented parent relationships.

Start with HTML/SVG and no graph library. A force-directed layout does not match ordered Git history. Add virtualization only if measured loaded-history sizes need it; correctness and stable pagination come first.

## Backend and data flow

Keep the initial code layout small:

```text
src/
  main.ts                 UI state, rendering, event handlers
  graph.ts                lane allocation, edge geometry, SVG rendering
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

Named commands cover opening, graph pages/ref metadata, commit details/parent comparisons, snapshot/diff reads, staging, unstaging, committing, branch creation/switching, and fetch/pull/push. Each validates repository ID and selected commit, file, branch, or remote in Rust.

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

### 2. Branch graph — first usable milestone

Read refs/HEAD and the commit DAG, implement lane allocation and aligned commit rows, attach labels, add selection/inspector, history scope, and Load more. Match the reference's visible branching and merge behavior.

Done when every loaded parent edge reaches its correct ancestor or an explicit boundary, multiple refs on one commit do not duplicate the node, and commit inspection matches Git. Check linear, divergent, merged, octopus, disconnected, shallow, detached-HEAD, annotated-tag, and page-boundary histories with disposable repositories. Include clock skew. Validate row/node alignment at different window widths.

### 3. Branch actions and the commit workflow

Implement create/switch actions and the companion working-changes panel: status parsing, grouped file lists, selected-file diff, untracked/binary previews, stage/unstage, composer validation, commit execution, and graph/ref refresh.

Done when the UI agrees with Git for staged/unstaged/untracked/renamed/deleted/conflicted files, including partially staged files and unusual/non-UTF-8 filenames. Selecting one of two changed files commits only that file; unstaging preserves working-tree content; an empty repository supports its first commit; and a failing hook leaves the draft recoverable. Repeated clicks cannot create duplicate mutations. A new commit appears at the correct graph tip; a branch created at an existing commit adds a label without fabricating a node. Dirty branch switches fail safely.

### 4. Remote synchronization

Add fetch, fast-forward pull, and current-branch push/upstream selection.

Done when two disposable clones exchange commits through a local bare remote; fetch updates remote ref labels/topology without changing checkout; divergent pull refuses to merge; and rejected push produces actionable feedback. Check missing upstream and authentication/signing failure behavior separately.

### 5. Linux release verification

Check keyboard/focus behavior, theme, narrow layouts, large repositories, and the actual packaged app. Start with Fedora x86-64 RPM, test launch and the commit workflow outside the dev server, and document the supported environment. Tauri requires distribution-specific WebKitGTK and other native dependencies. [Linux prerequisites](https://v2.tauri.app/start/prerequisites/), [RPM packaging](https://v2.tauri.app/distribute/rpm/)

Ship an x86-64 AppImage alongside the Fedora RPM. Verify both on Fedora; Ubuntu/Debian coverage remains pending. Build broader Linux packages on an appropriate oldest-supported base; do not promise compatibility from a Fedora build alone. [AppImage distribution](https://v2.tauri.app/distribute/appimage/)

Release checks: frontend type-check/build, Rust formatting/Clippy/tests, dependency audits, and a packaged-app smoke test. Include deterministic graph layout checks and real-repository fixtures for DAG/ref parsing, pagination, path handling, index preservation, failed hooks, and safe branch/remote behavior. Do not contact a user's remote or mutate a user's repository during automated tests.

## Deferred work

Clone/init, hunk staging, stash management, amend/reset/rebase/cherry-pick, conflict editing, branch deletion, discard/clean, interactive credential setup, subject search, avatars, multi-repository tabs, hosting-service/PR integrations, auto-updates, and Windows/macOS packaging. Visual branch history and merge connections are required in the first milestone.

Implementation now includes the graph, repository discovery, commit inspection, working changes, branch actions, and remote sync. Automated checks cover graph layouts and disposable real repositories; native WebKit WebDriver verifies the packaged UI and Rust bridge. The Fedora RPM includes the required native-library dependencies and font licenses. GTK's string-iterator advisory is fixed by a minimal local backport in vendor/glib, with a dedicated optimized regression check. Other platforms and live SSH/GPG setups are not verified; see README.md for the remaining build-time dependency warning and explicit scope limits.
