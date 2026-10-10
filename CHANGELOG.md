# Changelog

## 0.11.0 — 2026-10-11
- Replace the native title bar with built-in window controls in the toolbar.
- Reload the changes list instead of showing "File changed" when a selected file went stale.
- Show the actual error in the status line instead of a generic "Operation failed".
- Style the error banner like the tip cards.

## 0.10.2 — 2026-10-11
- Keep toolbar actions on the same row; a long status message truncates instead of pushing them down.

## 0.10.1 — 2026-10-11
- Keep the history graph trunk in one straight column; branches that are only ahead change color instead of shifting right.

## 0.10.0 — 2026-10-11

- Returning to the window quietly checks for changes and reloads history only when the status, branches, tags, or remotes moved.
- Drop recent repositories that were moved or deleted instead of failing at startup.
- Show ahead/behind counts only for branches with an upstream.
- Add per-file Stage/Unstage buttons, a 50/72 summary length guide, and a Copy button for commit IDs.

## 0.9.0 — 2026-10-11

- Fix Publish making the current branch GitHub's default: you choose the main branch, which is pushed first, then the current branch.
- Publish can also use an existing empty repository URL instead of the GitHub CLI.
- Show Publish instead of Fetch, Pull, and Push when the repository has no remote; Pull and Push show waiting commit counts.
- Remove the footer and the repository name bar; status and progress move to the toolbar.
- Move Review AI changes, experiments, Run, AI rules, AI settings, and Help into a Tools menu so the bar no longer overflows.
- Tips appear as dismissible cards; lockfiles and build output no longer count as large files.

## 0.8.0 — 2026-10-11

- AI settings: choose Claude, DeepSeek, OpenAI, OpenRouter, Groq, Ollama, any OpenAI-compatible API, or a command-line agent (Codex, Claude Code, opencode, or any command).

## 0.7.0 — 2026-10-11

- Rename and delete local branches from the Branches dialog; unmerged branches need a second confirmation.
- Fix Fetch, Pull, Push, and other toolbar buttons disappearing off the right edge in narrower windows: the toolbar and scope bar now wrap.

## 0.6.0 — 2026-10-11

- Review AI changes: every file changed since your last checkpoint or commit, riskiest first, with per-file Undo, Undo all, and diffs.
- Claude (claude-opus-5-5) explains changes and conflicts and writes commit messages; usage and cost are logged.
- Health warnings for huge files, deleted tests, new dependencies, piles of TODOs, unpushed work, and missing backups.
- Experiments: Try something risky, then Keep it or Throw it away.
- Publish to GitHub (private repository through the GitHub CLI).
- Guided conflicts: Keep ours, Keep theirs, Mark fixed, Explain, then Continue or Abort.
- AI rules editor for AGENTS.md with starter rules, linked from CLAUDE.md.
- Run the project from GitGUI with live output and crash hints.
- Undo last commit, Git jargon tooltips, a first-run tour and glossary, and a GitHub release workflow.
- Fix checkpoints missing same-size edits made within a second of the last index update.

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
