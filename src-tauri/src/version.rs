//! Per-repository version manager: version files, changelog entries, and the Git hooks that enforce them.
use crate::git::Result;
use std::{fs, path::Path, process::Command};

pub const MARKER: &str = "# GitGUI versioning";
const AGENTS_HEADING: &str = "## Versioning (GitGUI)";
/// API keys and private keys with recognisable prefixes (AWS, GitHub, OpenAI/Anthropic-style, Slack, Google, PEM).
const SECRETS: &str = r"AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----";
const READ_VERSION: &str = r#"version() {
  for f in package.json Cargo.toml VERSION; do
    git cat-file -e "$1$f" 2>/dev/null || continue
    # shortcut: takes the first version-shaped line, which is the project version in standard manifests.
    git show "$1$f" | sed -n -e 's/^ *"version": *"\([^"]*\)".*/\1/p' -e 's/^version *= *"\([^"]*\)".*/\1/p' -e 's/^\([0-9][0-9A-Za-z.+-]*\)$/\1/p' | head -n 1
    return
  done
}
"#;

fn pre_commit() -> String {
    format!(
        r#"#!/bin/sh
{MARKER}: block secrets; code commits need passing tests, a version bump, and a changelog entry.
{READ_VERSION}fail() {{ echo "GitGUI safeguards: $1" >&2; exit 1; }}
git diff --cached --name-only --diff-filter=AR | grep -E '(^|/)\.env(\.[^/]*)?$' | grep -Evq '\.(example|sample|template)$' && fail "a .env file is staged. It usually holds passwords and API keys: unstage it and add it to .gitignore"
git diff --cached -U0 --no-color | grep '^+[^+]' | grep -Eq '{SECRETS}' && fail "a staged line looks like an API key or private key. Move it to an ignored .env file and load it from the environment"
git diff --cached --name-only | grep -Evq '(\.md$|^docs/|(^|/)tests?/|\.test\.|_test\.)' || exit 0
new=$(version :)
[ -n "$new" ] || fail "no version found in package.json, Cargo.toml, or VERSION"
[ "$new" != "$(version HEAD: 2>/dev/null)" ] || fail "code changed but the version is still $new. Bump it (patch: fix, minor: feature, major: breaking change) and stage it"
git show :CHANGELOG.md 2>/dev/null | grep -q "^## $new " || fail "stage a CHANGELOG.md entry headed '## $new — $(date +%F)'"
tests=$(git config gitgui.testCommand)
[ -z "$tests" ] && exit 0
# shortcut: tests run on the working tree, not only the staged content.
log=$(git rev-parse --git-path gitgui-tests.log)
sh -c "$tests" >"$log" 2>&1 || {{ tail -n 20 "$log" >&2; fail "tests failed ($tests). Fix them before committing; full output: $log"; }}
"#
    )
}
fn post_commit() -> String {
    format!(
        r#"#!/bin/sh
{MARKER}: tag the commit that introduces each new version.
{READ_VERSION}v=$(version HEAD:)
[ -n "$v" ] && [ "$v" != "$(version HEAD~1: 2>/dev/null)" ] || exit 0
git rev-parse -q --verify "refs/tags/v$v" >/dev/null || git tag -a "v$v" -m "Version $v"
"#
    )
}

fn read(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}
fn manifest_line(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| {
        l.strip_prefix(key)?
            .trim_start()
            .strip_prefix('=')?
            .trim()
            .strip_prefix('"')?
            .split('"')
            .next()
            .map(str::to_owned)
    })
}
pub fn current(root: &Path) -> Option<String> {
    if let Some(text) = read(&root.join("package.json")) {
        return serde_json::from_str::<serde_json::Value>(&text).ok()?["version"]
            .as_str()
            .map(str::to_owned);
    }
    if let Some(text) = read(&root.join("Cargo.toml")) {
        return manifest_line(&text, "version");
    }
    read(&root.join("VERSION"))
        .and_then(|t| t.lines().next().map(|l| l.trim().to_owned()))
        .filter(|v| !v.is_empty())
}
/// The project's test command, if it has one GitGUI recognises.
pub fn test_command(root: &Path) -> Option<&'static str> {
    if let Some(text) = read(&root.join("package.json")) {
        let script = serde_json::from_str::<serde_json::Value>(&text).ok()?["scripts"]["test"]
            .as_str()?
            .to_owned();
        return (!script.contains("no test specified")).then_some("npm test");
    }
    root.join("Cargo.toml").exists().then_some("cargo test")
}
pub fn enabled(hooks: &Path) -> bool {
    read(&hooks.join("pre-commit")).is_some_and(|t| t.contains(MARKER))
}

pub fn bump(version: &str, level: &str) -> Result<String> {
    let parts: Vec<u64> = version
        .split('.')
        .map(|p| p.parse().ok())
        .collect::<Option<_>>()
        .filter(|p: &Vec<u64>| p.len() == 3)
        .ok_or_else(|| format!("Version {version} is not MAJOR.MINOR.PATCH; bump it by hand."))?;
    let [major, minor, patch] = [parts[0], parts[1], parts[2]];
    Ok(match level {
        "major" => format!("{}.0.0", major + 1),
        "minor" => format!("{major}.{}.0", minor + 1),
        "patch" => format!("{major}.{minor}.{}", patch + 1),
        _ => return Err("Choose a patch, minor, or major version bump.".into()),
    })
}

/// Writes `new` into the version file and the manifests/lockfiles that still hold `old`; returns the changed paths.
pub fn apply(root: &Path, old: &str, new: &str) -> Result<Vec<String>> {
    let mut changed = Vec::new();
    for (path, from, to, count) in [
        (
            "package.json",
            format!("\"version\": \"{old}\""),
            format!("\"version\": \"{new}\""),
            1,
        ),
        // The root entry and packages[""] are the first two versions in npm lockfiles.
        (
            "package-lock.json",
            format!("\"version\": \"{old}\""),
            format!("\"version\": \"{new}\""),
            2,
        ),
        (
            "Cargo.toml",
            format!("\nversion = \"{old}\""),
            format!("\nversion = \"{new}\""),
            1,
        ),
        (
            "src-tauri/Cargo.toml",
            format!("\nversion = \"{old}\""),
            format!("\nversion = \"{new}\""),
            1,
        ),
        ("VERSION", old.to_owned(), new.to_owned(), 1),
    ] {
        let file = root.join(path);
        let Some(text) = read(&file) else { continue };
        let updated = text.replacen(&from, &to, count);
        if updated != text {
            fs::write(&file, updated).map_err(|e| format!("Cannot update {path}: {e}"))?;
            changed.push(path.to_owned());
            if let (Some(dir), Some(name)) = (
                path.strip_suffix("Cargo.toml"),
                manifest_line(&text, "name"),
            ) {
                let lock = format!("{dir}Cargo.lock");
                let entry = |v: &str| format!("name = \"{name}\"\nversion = \"{v}\"");
                if let Some(text) = read(&root.join(&lock)).filter(|t| t.contains(&entry(old))) {
                    fs::write(root.join(&lock), text.replacen(&entry(old), &entry(new), 1))
                        .map_err(|e| format!("Cannot update {lock}: {e}"))?;
                    changed.push(lock);
                }
            }
        }
    }
    if changed.is_empty() {
        return Err(format!(
            "Version {old} was not found in package.json, Cargo.toml, or VERSION."
        ));
    }
    Ok(changed)
}

fn today() -> Result<String> {
    let out = Command::new("date")
        .arg("+%F")
        .output()
        .map_err(|e| format!("Cannot read the date: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
pub fn add_changelog(root: &Path, version: &str, summary: &str) -> Result<()> {
    let mut text = read(&root.join("CHANGELOG.md")).unwrap_or_else(|| "# Changelog\n".into());
    let entry = format!("## {version} — {}\n\n- {summary}\n", today()?);
    match text.find("\n## ") {
        Some(i) => text.insert_str(i + 1, &(entry + "\n")),
        None => text = format!("{}\n\n{entry}", text.trim_end()),
    }
    fs::write(root.join("CHANGELOG.md"), text)
        .map_err(|e| format!("Cannot update CHANGELOG.md: {e}"))
}

/// Installs the hooks and adds VERSION, CHANGELOG.md, and agent instructions where missing.
pub fn enable(root: &Path, hooks: &Path) -> Result<()> {
    for name in ["pre-commit", "post-commit"] {
        if read(&hooks.join(name)).is_some_and(|t| !t.contains(MARKER)) {
            return Err(format!(
                "{} already exists. Remove it or merge it by hand before enabling versioning.",
                hooks.join(name).display()
            ));
        }
    }
    fs::create_dir_all(hooks).map_err(|e| format!("Cannot create the hooks folder: {e}"))?;
    for (name, body) in [("pre-commit", pre_commit()), ("post-commit", post_commit())] {
        let path = hooks.join(name);
        fs::write(&path, body).map_err(|e| format!("Cannot write the {name} hook: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Cannot make the {name} hook executable: {e}"))?;
        }
    }
    if current(root).is_none() {
        fs::write(root.join("VERSION"), "0.1.0\n")
            .map_err(|e| format!("Cannot create VERSION: {e}"))?;
        add_changelog(root, "0.1.0", "Initial version.")?;
    } else if !root.join("CHANGELOG.md").exists() {
        fs::write(root.join("CHANGELOG.md"), "# Changelog\n")
            .map_err(|e| format!("Cannot create CHANGELOG.md: {e}"))?;
    }
    let ignore = read(&root.join(".gitignore")).unwrap_or_default();
    if !ignore.lines().any(|l| l.trim() == ".env") {
        let text = format!(
            "{}{}.env\n",
            ignore,
            if ignore.is_empty() || ignore.ends_with('\n') {
                ""
            } else {
                "\n"
            }
        );
        fs::write(root.join(".gitignore"), text)
            .map_err(|e| format!("Cannot update .gitignore: {e}"))?;
    }
    let agents = read(&root.join("AGENTS.md")).unwrap_or_default();
    if !agents.contains(AGENTS_HEADING) {
        let section = format!("{AGENTS_HEADING}\n\nGit hooks enforce this. Every commit that changes code must:\n\n1. Bump the version in package.json, Cargo.toml, or VERSION (whichever the project uses) and keep lockfiles in sync: patch for fixes, minor for features, major for breaking changes.\n2. Add `## <version> — <YYYY-MM-DD>` with one line per change above the previous entry in CHANGELOG.md.\n3. Commit both with the change. The post-commit hook tags `v<version>`.\n\nThe hook also blocks commits with failing tests (`git config gitgui.testCommand`), staged `.env` files, or lines that look like API keys. Keep secrets in `.env` and read them from the environment. Never use `git commit --no-verify`.\n");
        let text = if agents.trim().is_empty() {
            section
        } else {
            format!("{}\n\n{section}", agents.trim_end())
        };
        fs::write(root.join("AGENTS.md"), text)
            .map_err(|e| format!("Cannot update AGENTS.md: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bumps_semver_levels() {
        assert_eq!(bump("0.2.9", "patch").unwrap(), "0.2.10");
        assert_eq!(bump("0.2.9", "minor").unwrap(), "0.3.0");
        assert_eq!(bump("0.2.9", "major").unwrap(), "1.0.0");
        assert!(bump("1.0", "patch").is_err());
        assert!(bump("1.0.0-rc.1", "patch").is_err());
    }

    #[test]
    fn syncs_manifests_lockfiles_and_changelog() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("package.json"),
            "{\n  \"name\": \"app\",\n  \"version\": \"0.2.0\"\n}\n",
        )
        .unwrap();
        fs::write(root.join("package-lock.json"), "{\n  \"version\": \"0.2.0\",\n  \"packages\": {\"\": {\"version\": \"0.2.0\"}, \"x\": {\"version\": \"0.2.0\"}}\n}\n").unwrap();
        fs::create_dir(root.join("src-tauri")).unwrap();
        fs::write(root.join("src-tauri/Cargo.toml"), "[package]\nname = \"app\"\nversion = \"0.2.0\"\n\n[dependencies]\nx = { version = \"0.2.0\" }\n").unwrap();
        fs::write(root.join("src-tauri/Cargo.lock"), "[[package]]\nname = \"x\"\nversion = \"0.2.0\"\n\n[[package]]\nname = \"app\"\nversion = \"0.2.0\"\n").unwrap();
        fs::write(
            root.join("CHANGELOG.md"),
            "# Changelog\n\n## 0.2.0 — 2026-10-10\n\n- Old.\n",
        )
        .unwrap();
        assert_eq!(current(root).as_deref(), Some("0.2.0"));
        let changed = apply(root, "0.2.0", "0.3.0").unwrap();
        assert_eq!(
            changed,
            [
                "package.json",
                "package-lock.json",
                "src-tauri/Cargo.toml",
                "src-tauri/Cargo.lock"
            ]
        );
        assert_eq!(current(root).as_deref(), Some("0.3.0"));
        assert!(read(&root.join("package-lock.json"))
            .unwrap()
            .contains("\"x\": {\"version\": \"0.2.0\"}"));
        assert!(read(&root.join("src-tauri/Cargo.toml"))
            .unwrap()
            .contains("x = { version = \"0.2.0\" }"));
        assert!(read(&root.join("src-tauri/Cargo.lock"))
            .unwrap()
            .contains("name = \"x\"\nversion = \"0.2.0\""));
        add_changelog(root, "0.3.0", "Add X").unwrap();
        let log = read(&root.join("CHANGELOG.md")).unwrap();
        assert!(
            log.starts_with("# Changelog\n\n## 0.3.0 — ") && log.contains("- Add X\n\n## 0.2.0")
        );
    }

    #[test]
    fn enable_creates_version_files_and_refuses_foreign_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let (root, hooks) = (dir.path(), dir.path().join(".git/hooks"));
        enable(root, &hooks).unwrap();
        assert!(enabled(&hooks));
        assert_eq!(current(root).as_deref(), Some("0.1.0"));
        assert!(read(&root.join("CHANGELOG.md"))
            .unwrap()
            .contains("## 0.1.0 — "));
        enable(root, &hooks).unwrap();
        assert_eq!(
            read(&root.join("AGENTS.md"))
                .unwrap()
                .matches(AGENTS_HEADING)
                .count(),
            1
        );
        fs::write(hooks.join("pre-commit"), "#!/bin/sh\n").unwrap();
        assert!(enable(root, &hooks).is_err());
    }
}
