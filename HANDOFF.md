# Further work

`chore/review-improvements` was merged into `GUI-with-DESIGN.md` with a merge
commit. The design branch keeps its theme and sidebar, and now includes commit
search, recent repositories, numbered diffs, the details pane, live Git progress,
fresh working previews, and separate columns for named branches.

The review branch remains at `3534888`, with its worktree at
`/home/mdhaarith/.t3/worktrees/GitGUI/t3-7935a695`. Before continuing there, bring
in the combined design and review changes:

```sh
rtk proxy git -C /home/mdhaarith/.t3/worktrees/GitGUI/t3-7935a695 merge --ff-only GUI-with-DESIGN.md
```

Validation: 14 frontend tests, 15 Rust tests, TypeScript/production build, Rust
formatting and linting, and browser interaction checks passed. Browser checks
cover the three real branch tips, parent edges, sidebar filtering/focus, stale
previews, preview/write coordination, drafts, progress, and 10,000-commit history.
The npm audit is clean. Cargo audit retains the documented unmaintained
`proc-macro-error` warning; vendored GLib still produces its existing lint warnings.

Next check: run `scripts/desktop_smoke.py` against the packaged app on an isolated
desktop/profile after installing WebKitWebDriver. Native UI automation was not
available during this merge. Search covers loaded commit subjects, authors, and
hashes; load more history or select a branch scope to search older commits.

The installed design AppImage is
`~/Applications/GitGUI_0.1.0_amd64_0c257a2280ae8cf50e2435409254a842.AppImage`
(`GitGUI (1)` in the application menu). Its pre-update backup and update metadata
are kept under this repository's ignored `artifacts` directory. Other GitGUI
AppImages and shortcuts were left alone; open windows keep their old binary
until closed. No changes were pushed to a remote.

## Packaging on this desktop

AppImageLauncher's binfmt handler can intercept packaging tools launched from
T3. A normal `tauri bundle` can report success without producing a file: always
check that the output exists. The working fallback uses the already-installed
bypass and cached linuxdeploy after `tauri build` has produced the release binary.
Run from `src-tauri/target/release/bundle/appimage`:

```sh
rtk proxy env -u APPIMAGE -u APPDIR -u ARGV0 -u OWD \
  -u ELECTRON_RUN_AS_NODE -u LD_LIBRARY_PATH \
  LD_PRELOAD=/opt/appimagelauncher.AppDir/usr/lib/x86_64-linux-gnu/appimagelauncher/libbinfmt-bypass-preload.so \
  /opt/appimagelauncher.AppDir/usr/lib/x86_64-linux-gnu/appimagelauncher/binfmt-bypass \
  /home/mdhaarith/.cache/tauri/linuxdeploy-07333c6-x86_64.AppImage \
  --appdir "$PWD/GitGUI.AppDir" --plugin gtk --output appimage
```

This produces `GitGUI-x86_64.AppImage`; rename it to the README's standard
`GitGUI_0.1.0_amd64.AppImage` before updating the installed copy. Deployment logs,
SHA-256 checks, backup location, and the launched PID are recorded in
`artifacts/linuxdeploy-direct.log` and `artifacts/appimage-update.json`.
