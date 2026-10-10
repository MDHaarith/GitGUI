# GitGUI

A Linux desktop Git client built with Rust, Tauri 2, and TypeScript. The interface
uses the supplied Busy History theme: a compact dark graph, Geist fonts bundled
offline, inline branch/tag labels, and commit details opened on demand.

Open an existing repository or linked worktree, browse branches and merge parents,
inspect commit or working-tree diffs, stage/unstage whole files, create commits,
create/switch local branches, and fetch/pull/push.

## Run the built app

```sh
./src-tauri/target/release/gitgui
# Or open a repository immediately:
./src-tauri/target/release/gitgui /absolute/path/to/repository
```

The Fedora x86-64 installer is generated at
`src-tauri/target/release/bundle/rpm/GitGUI-0.1.0-1.x86_64.rpm`.
Install it with your package manager, then launch **GitGUI** from the application menu.

The x86-64 AppImage is generated at
`src-tauri/target/release/bundle/appimage/GitGUI_0.1.0_amd64.AppImage`.
Run it without installing:

```sh
chmod +x src-tauri/target/release/bundle/appimage/GitGUI_0.1.0_amd64.AppImage
./src-tauri/target/release/bundle/appimage/GitGUI_0.1.0_amd64.AppImage
```

The AppImage requires system Git 2.43+ and FUSE support. If FUSE is unavailable,
run it with `APPIMAGE_EXTRACT_AND_RUN=1`. This build uses Fedora 44 (glibc 2.43);
compatibility with older distributions is unverified. Build on the oldest target
distribution before distributing a broadly compatible Linux release.

On this desktop, AppImageLauncher also placed a copy in `~/Applications` and added
GitGUI to the application menu. Its integration breaks native WebDriver's
automation environment, so the packaged workflow check launches `AppRun` from
the mounted AppImage directly. Graph, staging, commits, failed-hook recovery,
branch actions, publishing, and fetch all passed.

The app remembers the last selected repository and keeps commit drafts locally.
Git remains responsible for credential helpers, SSH agents, hooks, and signing.
Missing identity/authentication/signing setup produces Git's error message and
keeps the draft. Only open repositories whose local configuration you trust.

## Develop and build

Requirements: Rust 1.88+, Node 20.19+/22.12+ (tested with Node 24), system Git 2.43+,
GTK 3 and WebKitGTK 4.1 development libraries. Tested on Fedora 44 x86-64.

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

## Checks

```sh
npm test
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
It checks the graph, fonts, on-demand details, selective staging, commits,
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

## Boundaries

- One active repository. History loads in 200-commit pages, up to 10,000 commits
  per scope. Unloaded parents remain visible as continuation paths.
- Metadata/index reads are limited to 16 MiB. Diff/file previews are limited to
  2 MiB and 5,000 rendered lines, with an explicit truncation notice.
- Pull requires a clean working tree and uses fast-forward only. Push sends only
  the current branch and never force-pushes or mirrors other refs.
- Existing merge/rebase/cherry-pick/revert/conflict workflows must be completed
  in the terminal. The app displays their state and prevents ordinary mutations.
- Clone/init, hunk staging, stash management, history rewriting, conflict editing,
  nested submodule operations, and Windows/macOS packaging are outside this release.

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
