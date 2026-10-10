# Changelog

## 0.5.0 — 2026-10-11

- Add `npm run install:app`: detects the operating system, builds GitGUI, removes older installed versions, and installs the new one (Linux tested; macOS and Windows untested).

## 0.4.1 — 2026-10-11

- Offer Enable safeguards again in repositories that have older GitGUI hooks, so they get the secret scan and test gate.

## 0.4.0 — 2026-10-11

- Add checkpoints: save restorable snapshots of all files (including new ones) without committing, automatically when you return to GitGUI, and restore them in one click.
- Block commits that stage `.env` files or lines that look like API or private keys, and run the project's tests before code commits.
- Explain the repository state (conflicts, detached HEAD, unpushed or missing commits) and common Git errors in plain English.
- Rename Enable versioning to Enable safeguards; it also adds `.env` to `.gitignore` and sets the test command.

## 0.3.1 — 2026-10-11

- Error /home/mdhaarith/Documents/Projects/GitGUI/.githooks/pre-commit already exists. Remove it or merge it by hand before enabling versioning.

## 0.3.0 — 2026-10-11

- Add Init repository and a per-repository version manager: hooks require a version bump and changelog entry for every code commit and tag each new version.
- Add a version bump selector to the commit form that updates version files, lockfiles, and CHANGELOG.md.

## 0.2.0 — 2026-10-10

- Add a persistent branch sidebar, named branch paths, history search, and commit details alongside the graph.
- Add recent repositories, numbered diffs, Git operation progress, and clearer action states.
- Apply the dark design system, styled repository/scope dropdowns, and segmented status footer.
- Display the installed version and check synchronized release versions before every build.

## 0.1.0 — 2026-10-10

- Initial Linux release with Git history, staging, commits, branch actions, and remote operations.
- Ship AppImage and Fedora RPM packages with bundled offline fonts.
