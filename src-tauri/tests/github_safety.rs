use gitgui_lib::{
    git::{
        github::{ReadRequest, WriteRequest},
        Backend,
    },
    platform,
};
use std::{fs, path::Path};

fn git(root: &Path, args: &[&str]) {
    let result = platform::command("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn checkout_rejects_dirty_worktrees_and_stale_tokens_before_contacting_github() {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-b", "main"]);
    git(dir.path(), &["config", "user.name", "GitGUI Test"]);
    git(
        dir.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    git(dir.path(), &["config", "commit.gpgsign", "false"]);
    fs::write(dir.path().join("work.txt"), "original\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-m", "initial"]);
    let mut backend = Backend::default();
    let original = backend.open(dir.path().to_str().unwrap()).unwrap();
    fs::write(dir.path().join("work.txt"), "unsaved work\n").unwrap();
    fs::write(dir.path().join("untracked.txt"), "keep me\n").unwrap();
    let dirty = backend.status(original.id).unwrap();
    let error = backend
        .github_write(
            original.id,
            "owner/repo",
            WriteRequest::Checkout {
                number: 12,
                token: dirty.token,
            },
        )
        .unwrap_err();
    assert!(error.contains("Commit or stash"), "{error}");
    assert_eq!(
        fs::read_to_string(dir.path().join("work.txt")).unwrap(),
        "unsaved work\n"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("untracked.txt")).unwrap(),
        "keep me\n"
    );
    assert!(backend
        .github_write(
            original.id,
            "owner/repo",
            WriteRequest::Checkout {
                number: 12,
                token: "stale".into()
            }
        )
        .unwrap_err()
        .contains("changed since"));
    assert!(backend
        .github_read(None, Some("owner/repo?endpoint=bad"), ReadRequest::Issues)
        .unwrap_err()
        .contains("owner/repo"));
}
