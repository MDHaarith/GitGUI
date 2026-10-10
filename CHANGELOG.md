# Changelog

## Unreleased

- Returning to the window quietly checks for changes and reloads history only when the status, branches, tags, or remotes moved.
- Drop recent repositories that were moved or deleted instead of failing at startup.
- Show ahead/behind counts only for branches with an upstream.
- Add per-file Stage/Unstage buttons, a 50/72 summary length guide, and a Copy button for commit IDs.

## 0.2.0 — 2026-10-10

- Add a persistent branch sidebar, named branch paths, history search, and commit details alongside the graph.
- Add recent repositories, numbered diffs, Git operation progress, and clearer action states.
- Apply the dark design system, styled repository/scope dropdowns, and segmented status footer.
- Display the installed version and check synchronized release versions before every build.

## 0.1.0 — 2026-10-10

- Initial Linux release with Git history, staging, commits, branch actions, and remote operations.
- Ship AppImage and Fedora RPM packages with bundled offline fonts.
