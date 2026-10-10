# Versioning (enforced by `.githooks/pre-commit`)

Every commit that changes app code (`src/`, `src-tauri/src/`; tests excluded) must bump the version:

1. `npm version minor --no-git-tag-version` for a feature, `patch` for a fix, `major` for a breaking change. This runs the tests and syncs Cargo; never edit version numbers by hand.
2. Add `## <version> — <YYYY-MM-DD>` with one line per change at the top of `CHANGELOG.md`.
3. Commit everything together. The post-commit hook creates the `v<version>` tag.

Never use `git commit --no-verify`. Before reporting a task done, run `git status` and commit or report anything left over.
