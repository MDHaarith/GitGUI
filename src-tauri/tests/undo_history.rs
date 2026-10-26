use gitgui_lib::{
    git::{Backend, RepoInfo},
    platform,
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> String {
    let output = platform::command("git")
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
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}
struct Repo {
    _temp: TempDir,
    root: PathBuf,
}
impl Repo {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        for (name, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("core.hooksPath", ".git/hooks"),
        ] {
            git(&root, &["config", name, value]);
        }
        Self { _temp: temp, root }
    }
    fn write(&self, name: &str, text: &str) {
        fs::write(self.root.join(name), text).unwrap();
    }
    fn commit(&self, name: &str, text: &str) -> String {
        self.write(name, text);
        git(&self.root, &["add", "--", name]);
        git(&self.root, &["commit", "-m", text]);
        git(&self.root, &["rev-parse", "HEAD"])
    }
    fn open(&self) -> (Backend, RepoInfo) {
        let mut backend = Backend::default();
        let info = backend.open(self.root.to_str().unwrap()).unwrap();
        (backend, info)
    }
}

#[test]
fn undo_commit_and_amend_restore_head_index_and_worktree() {
    for amend in [false, true] {
        let f = Repo::new();
        f.commit("file", "base\n");
        let tip = f.commit("file", "second\n");
        f.write("file", "staged\n");
        git(&f.root, &["add", "file"]);
        f.write("file", "working\n");
        f.write("untracked", "keep me\n");
        let (mut b, info) = f.open();
        let committed = b
            .with_undo(info.id, "Commit", |b| {
                b.commit(info.id, "message", &info.token, false, None, amend)
            })
            .unwrap();
        f.write("later", "new work after commit\n");
        let restored = b.undo_action(info.id, &committed.token).unwrap();
        assert_eq!(restored.head.as_deref(), Some(tip.as_str()));
        assert_eq!(git(&f.root, &["show", ":file"]), "staged");
        assert_eq!(
            fs::read_to_string(f.root.join("file")).unwrap(),
            "working\n"
        );
        assert!(restored
            .files
            .iter()
            .any(|file| file.path == "untracked" && file.untracked));
        assert_eq!(
            fs::read_to_string(f.root.join("later")).unwrap(),
            "new work after commit\n"
        );
        assert!(b.undo_label(info.id).unwrap().is_none());
        assert!(b
            .checkpoints(info.id)
            .unwrap()
            .iter()
            .any(|c| c.label == "Before Undo"));
    }
}

#[test]
fn undo_first_commit_returns_to_unborn_branch() {
    let f = Repo::new();
    f.write("new", "first\n");
    git(&f.root, &["add", "new"]);
    let (mut b, info) = f.open();
    let committed = b
        .with_undo(info.id, "Commit", |b| {
            b.commit(info.id, "initial", &info.token, false, None, false)
        })
        .unwrap();
    let restored = b.undo_action(info.id, &committed.token).unwrap();
    assert!(restored.head.is_none());
    assert_eq!(restored.branch.as_deref(), Some("main"));
    assert_eq!(git(&f.root, &["show", ":new"]), "first");
}

#[test]
fn undo_deleted_branch_is_per_repository_and_never_overwrites_recreated_branch() {
    let f = Repo::new();
    let tip = f.commit("file", "base\n");
    git(&f.root, &["branch", "topic"]);
    let other = Repo::new();
    other.commit("other", "base\n");
    let (mut b, info) = f.open();
    let other_info = b.open(other.root.to_str().unwrap()).unwrap();
    let reference = b
        .graph(info.id, None, 200, None)
        .unwrap()
        .refs
        .into_iter()
        .find(|r| r.name == "topic")
        .unwrap();
    let deleted = b
        .with_undo(info.id, "Delete branch", |b| {
            b.delete_branch(info.id, &reference.id, false, &info.token)
        })
        .unwrap();
    assert!(b.undo_label(other_info.id).unwrap().is_none());
    f.write("file", "work after deleting branch\n");
    b.undo_action(info.id, &deleted.token).unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("file")).unwrap(),
        "work after deleting branch\n"
    );
    assert_eq!(git(&f.root, &["rev-parse", "topic"]), tip);
    let info = b.status(info.id).unwrap();
    let deleted = b
        .with_undo(info.id, "Delete branch", |b| {
            b.delete_branch(info.id, &reference.id, false, &info.token)
        })
        .unwrap();
    git(&f.root, &["branch", "topic"]);
    assert!(b
        .undo_action(info.id, &deleted.token)
        .unwrap_err()
        .contains("changed outside"));
}

#[test]
fn undo_refuses_commits_pushed_after_the_action() {
    let f = Repo::new();
    f.commit("file", "base\n");
    f.write("file", "new\n");
    git(&f.root, &["add", "file"]);
    let remote = f._temp.path().join("remote.git");
    git(&f.root, &["init", "--bare", remote.to_str().unwrap()]);
    git(
        &f.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let (mut b, info) = f.open();
    b.with_undo(info.id, "Commit", |b| {
        b.commit(info.id, "message", &info.token, false, None, false)
    })
    .unwrap();
    git(&f.root, &["push", "-u", "origin", "main"]);
    let info = b.status(info.id).unwrap();
    let tip = info.head.clone();
    assert!(b
        .undo_action(info.id, &info.token)
        .unwrap_err()
        .contains("already pushed"));
    assert_eq!(b.status(info.id).unwrap().head, tip);
}

#[test]
fn undo_discard_and_reset_restore_deleted_untracked_files_and_staging() {
    let f = Repo::new();
    let base = f.commit("file", "base\n");
    let tip = f.commit("file", "second\n");
    f.write("file", "staged\n");
    git(&f.root, &["add", "file"]);
    f.write("file", "unstaged\n");
    f.write("new", "untracked\n");
    let (mut b, info) = f.open();
    let ids = info.files.iter().map(|f| f.id.clone()).collect::<Vec<_>>();
    let discarded = b
        .with_undo(info.id, "Discard", |b| {
            b.discard(info.id, &ids, &info.token)
        })
        .unwrap();
    assert!(!f.root.join("new").exists());
    let restored = b.undo_action(info.id, &discarded.token).unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("file")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(git(&f.root, &["show", ":file"]), "staged");
    assert!(restored
        .files
        .iter()
        .any(|f| f.path == "new" && f.untracked));
    let reset = b
        .with_undo(info.id, "Reset", |b| {
            b.reset_commit(info.id, &base, "hard", &restored.token)
        })
        .unwrap();
    let restored = b.undo_action(info.id, &reset.token).unwrap();
    assert_eq!(restored.head.as_deref(), Some(tip.as_str()));
    assert_eq!(
        fs::read_to_string(f.root.join("file")).unwrap(),
        "unstaged\n"
    );
    assert_eq!(git(&f.root, &["show", ":file"]), "staged");
}

#[test]
fn reflog_preview_restore_and_line_history_validate_input() {
    let f = Repo::new();
    let first = f.commit("file name", "one\ntwo\nthree\n");
    let second = f.commit("file name", "one\nchanged\nthree\n");
    let (mut b, info) = f.open();
    let entries = b.reflog(info.id).unwrap();
    assert!(entries
        .iter()
        .any(|e| e.oid == first && e.source == "HEAD" && e.timestamp > 0));
    assert!(entries
        .iter()
        .any(|e| e.oid == second && e.source == "refs/heads/main"));
    assert!(b.restore_reflog(info.id, "HEAD~1", &info.token).is_err());
    assert!(b
        .restore_reflog(info.id, &"f".repeat(40), &info.token)
        .is_err());
    let file = b.commit_details(info.id, &second, None).unwrap().files[0]
        .id
        .clone();
    let lines = b.line_history(info.id, &file, Some(&second), 2, 2).unwrap();
    assert!(lines.text.contains(&second));
    assert!(lines.text.contains("+changed"));
    assert!(lines.text.contains(&first));
    assert!(!lines.truncated);
    assert!(b.line_history(info.id, &file, Some(&second), 0, 1).is_err());
    assert!(b.line_history(info.id, &file, Some(&second), 3, 2).is_err());
    assert!(b
        .line_history(info.id, "2e2e2f736563726574", Some(&second), 1, 2)
        .is_err());
    f.write("draft", "save me\n");
    let restored = b
        .with_undo(info.id, "Time machine", |b| {
            b.restore_reflog(info.id, &first, &info.token)
        })
        .unwrap();
    assert_eq!(restored.head.as_deref(), Some(first.as_str()));
    assert!(!b.checkpoints(info.id).unwrap().is_empty());
    let undone = b.undo_action(info.id, &restored.token).unwrap();
    assert_eq!(undone.head.as_deref(), Some(second.as_str()));
    assert_eq!(
        fs::read_to_string(f.root.join("draft")).unwrap(),
        "save me\n"
    );
}

#[test]
fn undo_merge_cherry_pick_revert_and_rebase() {
    use gitgui_lib::git::RebaseEdit;
    for action in ["merge", "cherry-pick", "revert", "rebase"] {
        let f = Repo::new();
        f.commit("base", "base\n");
        git(&f.root, &["switch", "-c", "topic"]);
        let incoming = f.commit("topic", "topic\n");
        git(&f.root, &["switch", "main"]);
        let tip = f.commit("local", "local\n");
        let (mut b, info) = f.open();
        let changed = b
            .with_undo(info.id, action, |b| match action {
                "merge" => {
                    let reference = b
                        .graph(info.id, None, 200, None)?
                        .refs
                        .into_iter()
                        .find(|r| r.name == "topic")
                        .unwrap();
                    b.merge_ref(info.id, &reference.id, &info.token)
                }
                "cherry-pick" => b.apply_commit(info.id, &incoming, false, &info.token),
                "revert" => b.apply_commit(info.id, &tip, true, &info.token),
                _ => {
                    let plan = b.rebase_plan(info.id, &info.token)?;
                    let edits = plan
                        .commits
                        .into_iter()
                        .map(|c| RebaseEdit {
                            oid: c.oid,
                            message: c.message,
                            action: "drop".into(),
                        })
                        .collect();
                    b.clean_commits(info.id, &plan.base, edits, &info.token)
                }
            })
            .unwrap();
        let restored = b.undo_action(info.id, &changed.token).unwrap();
        assert_eq!(restored.head.as_deref(), Some(tip.as_str()), "{action}");
        assert_eq!(fs::read_to_string(f.root.join("local")).unwrap(), "local\n");
        assert!(restored.files.is_empty(), "{action}");
    }
}

#[test]
fn undo_paused_merge_saves_conflicts_and_restores_original_work() {
    let f = Repo::new();
    f.commit("file", "base\n");
    git(&f.root, &["switch", "-c", "topic"]);
    f.commit("file", "topic\n");
    git(&f.root, &["switch", "main"]);
    let tip = f.commit("file", "main\n");
    f.write("untracked", "keep\n");
    let (mut b, info) = f.open();
    let reference = b
        .graph(info.id, None, 200, None)
        .unwrap()
        .refs
        .into_iter()
        .find(|r| r.name == "topic")
        .unwrap();
    let conflict = b
        .with_undo(info.id, "Merge", |b| {
            b.merge_ref(info.id, &reference.id, &info.token)
        })
        .unwrap();
    assert!(conflict.operation.is_some());
    let restored = b.undo_action(info.id, &conflict.token).unwrap();
    assert!(restored.operation.is_none());
    assert_eq!(restored.head.as_deref(), Some(tip.as_str()));
    assert_eq!(fs::read_to_string(f.root.join("file")).unwrap(), "main\n");
    assert_eq!(
        fs::read_to_string(f.root.join("untracked")).unwrap(),
        "keep\n"
    );
    assert!(b
        .checkpoints(info.id)
        .unwrap()
        .iter()
        .any(|c| c.label == "Before Undo"));
}

#[test]
fn continuing_an_external_merge_does_not_require_an_undo_record() {
    let f = Repo::new();
    f.commit("file", "base\n");
    git(&f.root, &["switch", "-c", "topic"]);
    f.commit("file", "topic\n");
    git(&f.root, &["switch", "main"]);
    f.commit("file", "main\n");
    let output = platform::command("git")
        .current_dir(&f.root)
        .args(["merge", "topic"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let (mut b, info) = f.open();
    let restored = b
        .with_undo(info.id, "Abort", |b| {
            b.finish_operation(info.id, true, &info.token)
        })
        .unwrap();
    assert!(restored.operation.is_none());
    assert!(b.undo_label(info.id).unwrap().is_none());
}

#[test]
fn undo_assistant_commits_uses_the_same_recording_path() {
    use gitgui_lib::assist::chat::{Permission, ToolCall};
    let f = Repo::new();
    let tip = f.commit("file", "base\n");
    f.write("file", "staged\n");
    git(&f.root, &["add", "file"]);
    let (mut b, info) = f.open();
    b.assistant_tool(
        info.id,
        &ToolCall {
            id: "test".into(),
            name: "commit".into(),
            input: serde_json::json!({"message":"Assistant edit"}),
        },
        Permission::Commits,
        true,
        &info.token,
    )
    .unwrap();
    let current = b.status(info.id).unwrap();
    let restored = b.undo_action(info.id, &current.token).unwrap();
    assert_eq!(restored.head.as_deref(), Some(tip.as_str()));
    assert_eq!(git(&f.root, &["show", ":file"]), "staged");
}

#[test]
fn undo_keeps_version_tags_in_step_with_commits() {
    let f = Repo::new();
    let base = f.commit("file", "base\n");
    f.write("file", "staged\n");
    git(&f.root, &["add", "file"]);
    let (mut b, info) = f.open();
    let committed = b
        .with_undo(info.id, "Commit", |b| {
            let committed = b.commit(info.id, "message", &info.token, false, None, false)?;
            git(&f.root, &["tag", "-a", "v1", "-m", "Version 1"]);
            Ok(committed)
        })
        .unwrap();
    let restored = b.undo_action(info.id, &committed.token).unwrap();
    assert_eq!(restored.head.as_deref(), Some(base.as_str()));
    assert!(git(&f.root, &["tag", "--list"]).is_empty());
    let tip = f.commit("file", "another\n");
    git(&f.root, &["tag", "-a", "v2", "-m", "Version 2"]);
    let info = b.status(info.id).unwrap();
    let undone = b
        .with_undo(info.id, "Undo commit", |b| {
            b.undo_commit(info.id, &info.token)
        })
        .unwrap();
    assert!(git(&f.root, &["tag", "--list"]).is_empty());
    let restored = b.undo_action(info.id, &undone.token).unwrap();
    assert_eq!(restored.head.as_deref(), Some(tip.as_str()));
    assert_eq!(git(&f.root, &["rev-parse", "v2^{}"]), tip);
}
