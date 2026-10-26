use gitgui_lib::git::{Backend, RebaseEdit, RepoInfo};
use std::{fs, path::Path, process::Command};
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
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
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}
fn fixture() -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Test"),
        ("user.email", "test@example.invalid"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir.path(), &["config", key, value]);
    }
    git(
        dir.path(),
        &[
            "config",
            "core.hooksPath",
            dir.path().join(".git/hooks").to_str().unwrap(),
        ],
    );
    dir
}
fn commit(root: &Path, file: &str, content: &str) -> String {
    fs::write(root.join(file), content).unwrap();
    git(root, &["add", "--", file]);
    git(root, &["commit", "-m", content]);
    git(root, &["rev-parse", "HEAD"])
}
fn open(root: &Path) -> (Backend, RepoInfo) {
    let mut backend = Backend::default();
    let info = backend.open(root.to_str().unwrap()).unwrap();
    (backend, info)
}
fn edits(backend: &mut Backend, info: &RepoInfo, oid: &str) -> (String, Vec<RebaseEdit>) {
    let plan = backend.rebase_plan_from(info.id, oid, &info.token).unwrap();
    (
        plan.base,
        plan.commits
            .into_iter()
            .map(|c| RebaseEdit {
                oid: c.oid,
                action: "pick".into(),
                message: c.message,
            })
            .collect(),
    )
}

#[test]
fn reword_root_replays_descendants_and_checkpoint_restores_history_both_ways() {
    let dir = fixture();
    let root = dir.path();
    let first = commit(root, "a", "first");
    let head = commit(root, "b", "later");
    let (mut b, info) = open(root);
    let (base, mut plan) = edits(&mut b, &info, &first);
    assert!(base.is_empty());
    plan[0].action = "reword".into();
    plan[0].message = "New root\n\nWith details and ' quotes $(literal)".into();
    let rewritten = b
        .rewrite_commits(info.id, &base, plan, false, &info.token)
        .unwrap();
    assert!(rewritten.operation.is_none());
    assert_eq!(git(root, &["log", "-1", "--format=%s"]), "later");
    assert!(git(root, &["log", "--format=%B"]).contains("$(literal)"));
    assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "later");
    let saved = b.checkpoints(info.id).unwrap();
    assert_eq!(saved[0].history_head.as_deref(), Some(head.as_str()));
    let restored = b
        .restore_checkpoint(info.id, &saved[0].oid, &rewritten.token)
        .unwrap();
    assert_eq!(restored.head.as_deref(), Some(head.as_str()));
    let undo_restore = b.checkpoints(info.id).unwrap();
    let restored_again = b
        .restore_checkpoint(info.id, &undo_restore[0].oid, &restored.token)
        .unwrap();
    assert_eq!(restored_again.head, rewritten.head);
}

#[test]
fn published_rewrites_require_consent_and_bad_plans_never_change_head() {
    let dir = fixture();
    let root = dir.path();
    commit(root, "base", "base");
    let oid = commit(root, "a", "first");
    let head = commit(root, "b", "later");
    git(root, &["update-ref", "refs/remotes/origin/main", &head]);
    let (mut b, info) = open(root);
    let (base, mut plan) = edits(&mut b, &info, &oid);
    plan[0].action = "reword".into();
    plan[0].message = "new message".into();
    assert!(b
        .rewrite_commits(info.id, &base, plan.clone(), false, &info.token)
        .unwrap_err()
        .contains("already published"));
    assert!(b.checkpoints(info.id).unwrap().is_empty());
    let mut bad = plan.clone();
    bad[0].action = "exec malicious".into();
    assert!(b
        .rewrite_commits(info.id, &base, bad, true, &info.token)
        .is_err());
    let mut duplicate = plan.clone();
    duplicate[1] = duplicate[0].clone();
    assert!(b
        .rewrite_commits(info.id, &base, duplicate, true, &info.token)
        .is_err());
    assert!(b.rebase_plan_from(info.id, "--all", &info.token).is_err());
    let result = b
        .rewrite_commits(info.id, &base, plan, true, &info.token)
        .unwrap();
    assert_ne!(result.head.as_deref(), Some(head.as_str()));
    assert_eq!(git(root, &["rev-parse", "refs/remotes/origin/main"]), head);
}

#[test]
fn edit_stops_allows_staging_and_amending_then_continues() {
    let dir = fixture();
    let root = dir.path();
    commit(root, "base", "base");
    let oid = commit(root, "a", "first");
    commit(root, "b", "later");
    let (mut b, info) = open(root);
    let (base, mut plan) = edits(&mut b, &info, &oid);
    plan[0].action = "edit".into();
    let paused = b
        .rewrite_commits(info.id, &base, plan, false, &info.token)
        .unwrap();
    assert_eq!(paused.operation.as_deref(), Some("rebase"));
    assert!(paused.rebase_edit);
    fs::write(root.join("a"), "changed during edit").unwrap();
    let status = b.status(info.id).unwrap();
    let staged = b
        .stage(info.id, &[status.files[0].id.clone()], false, &status.token)
        .unwrap();
    let amended = b
        .amend_rebase_commit(info.id, "edited first", &staged.token)
        .unwrap();
    let done = b.finish_operation(info.id, false, &amended.token).unwrap();
    assert!(done.operation.is_none());
    assert!(!done.rebase_edit);
    assert_eq!(
        fs::read_to_string(root.join("a")).unwrap(),
        "changed during edit"
    );
    assert_eq!(
        git(root, &["log", "--format=%s", "-2"]),
        "later\nedited first"
    );
    assert!(b
        .amend_rebase_commit(info.id, "no rebase", &done.token)
        .is_err());
}

#[test]
fn batch_pick_orders_ancestors_first_revert_orders_descendants_first_and_compare_is_directional() {
    let dir = fixture();
    let root = dir.path();
    let base = commit(root, "file", "base");
    git(root, &["switch", "-c", "topic"]);
    let a = commit(root, "file", "first");
    let c = commit(root, "file", "second");
    git(root, &["switch", "main"]);
    let (mut b, info) = open(root);
    assert!(b
        .batch_commits(info.id, vec![a.clone(), a.clone()], false, &info.token)
        .is_err());
    assert!(b
        .batch_commits(info.id, vec!["--all".into()], false, &info.token)
        .is_err());
    let picked = b
        .batch_commits(info.id, vec![c.clone(), a.clone()], false, &info.token)
        .unwrap();
    assert!(picked.operation.is_none());
    assert_eq!(fs::read_to_string(root.join("file")).unwrap(), "second");
    let diff = b.compare_commits(info.id, &base, &c).unwrap();
    assert!(diff.text.contains("+second"));
    assert!(diff.text.contains("-base"));
    assert!(b.compare_commits(info.id, "--help", &c).is_err());
    let reverted = b
        .batch_commits(info.id, vec![a, c], true, &picked.token)
        .unwrap();
    assert!(reverted.operation.is_none());
    assert_eq!(fs::read_to_string(root.join("file")).unwrap(), "base");
    let saves = b.checkpoints(info.id).unwrap();
    assert_eq!(saves.len(), 2);
}

#[test]
fn batch_conflicts_continue_through_multiple_stops_and_abort_restores_the_start() {
    let dir = fixture();
    let root = dir.path();
    commit(root, "file", "base\n");
    commit(root, "other", "base\n");
    git(root, &["switch", "-c", "topic"]);
    let a = commit(root, "file", "topic first\n");
    let c = commit(root, "other", "topic second\n");
    git(root, &["switch", "main"]);
    commit(root, "file", "main first\n");
    let head = commit(root, "other", "main second\n");
    let (mut b, info) = open(root);
    let mut current = b
        .batch_commits(info.id, vec![c.clone(), a.clone()], false, &info.token)
        .unwrap();
    assert!(current.files.iter().any(|f| f.conflicted));
    for _ in 0..2 {
        let file = current
            .files
            .iter()
            .find(|f| f.conflicted)
            .unwrap()
            .id
            .clone();
        current = b
            .resolve_conflict(info.id, &file, "theirs", &current.token)
            .unwrap();
        current = b.finish_operation(info.id, false, &current.token).unwrap();
    }
    assert!(current.operation.is_none());
    assert_eq!(
        fs::read_to_string(root.join("other")).unwrap(),
        "topic second\n"
    );
    let saves = b.checkpoints(info.id).unwrap();
    let saved = saves
        .iter()
        .find(|c| c.history_head.as_deref() == Some(head.as_str()))
        .unwrap();
    let restored = b
        .restore_checkpoint(info.id, &saved.oid, &current.token)
        .unwrap();
    assert_eq!(restored.head.as_deref(), Some(head.as_str()));
    let conflict = b
        .batch_commits(info.id, vec![a, c], false, &restored.token)
        .unwrap();
    let aborted = b.finish_operation(info.id, true, &conflict.token).unwrap();
    assert_eq!(aborted.head.as_deref(), Some(head.as_str()));
    assert!(aborted.operation.is_none());
}

#[test]
fn batch_drop_squash_and_dirty_worktree_guards_preserve_work() {
    let dir = fixture();
    let root = dir.path();
    commit(root, "base", "base");
    let a = commit(root, "a", "one");
    commit(root, "b", "two");
    let head = commit(root, "c", "three");
    let (mut b, info) = open(root);
    let (base, mut plan) = edits(&mut b, &info, &a);
    plan[1].action = "squash".into();
    plan[2].action = "drop".into();
    fs::write(root.join("unsaved"), "user work").unwrap();
    let dirty = b.status(info.id).unwrap();
    assert!(b
        .rewrite_commits(info.id, &base, plan.clone(), false, &dirty.token)
        .is_err());
    assert!(b
        .batch_commits(info.id, vec![a], false, &dirty.token)
        .is_err());
    assert_eq!(git(root, &["rev-parse", "HEAD"]), head);
    fs::remove_file(root.join("unsaved")).unwrap();
    let clean = b.status(info.id).unwrap();
    let result = b
        .rewrite_commits(info.id, &base, plan, false, &clean.token)
        .unwrap();
    assert!(result.operation.is_none());
    assert_eq!(git(root, &["rev-list", "--count", "HEAD"]), "2");
    assert!(root.join("a").exists() && root.join("b").exists());
    assert!(!root.join("c").exists());
    let checkpoint = b.checkpoints(info.id).unwrap().remove(0);
    fs::write(root.join("user-work"), "keep").unwrap();
    let dirty = b.status(info.id).unwrap();
    assert!(b
        .restore_checkpoint(info.id, &checkpoint.oid, &dirty.token)
        .is_err());
    assert_eq!(fs::read_to_string(root.join("user-work")).unwrap(), "keep");
}

#[test]
fn reword_any_commit_preserves_merge_topology_trees_and_authors() {
    let dir = fixture();
    let root = dir.path();
    let first = commit(root, "base", "root");
    git(root, &["switch", "-c", "topic"]);
    let topic = commit(root, "topic", "topic content");
    git(root, &["switch", "main"]);
    commit(root, "main", "main content");
    git(root, &["merge", "--no-ff", "topic", "-m", "merge message"]);
    let merge = git(root, &["rev-parse", "HEAD"]);
    let head = commit(root, "later", "after merge");
    let tree = git(root, &["rev-parse", "HEAD^{tree}"]);
    let authors = git(root, &["log", "--format=%an <%ae> %aI", "--topo-order"]);
    let (mut b, info) = open(root);
    let changed = b
        .reword_commit(
            info.id,
            &topic,
            "new topic message\n\nDetails",
            false,
            &info.token,
        )
        .unwrap();
    assert!(changed.operation.is_none());
    assert_eq!(git(root, &["rev-parse", "HEAD^{tree}"]), tree);
    assert_eq!(
        git(root, &["log", "--format=%an <%ae> %aI", "--topo-order"]),
        authors
    );
    assert_eq!(git(root, &["rev-parse", "topic"]), topic);
    assert_eq!(git(root, &["rev-list", "--count", "--merges", "HEAD"]), "1");
    assert_eq!(
        git(root, &["rev-parse", "HEAD~2"]),
        git(root, &["rev-parse", &format!("{merge}^1")])
    );
    let new_merge = git(root, &["rev-parse", "HEAD~1"]);
    let changed = b
        .reword_commit(
            info.id,
            &new_merge,
            "new merge message",
            false,
            &changed.token,
        )
        .unwrap();
    assert!(git(root, &["log", "--format=%s"]).contains("new merge message"));
    let changed = b
        .reword_commit(info.id, &first, "new root message", false, &changed.token)
        .unwrap();
    assert_eq!(git(root, &["rev-parse", "HEAD^{tree}"]), tree);
    assert_eq!(git(root, &["rev-list", "--count", "HEAD"]), "5");
    let checkpoint = b
        .checkpoints(info.id)
        .unwrap()
        .into_iter()
        .find(|c| c.history_head.as_deref() == Some(head.as_str()))
        .unwrap();
    let restored = b
        .restore_checkpoint(info.id, &checkpoint.oid, &changed.token)
        .unwrap();
    assert_eq!(restored.head.as_deref(), Some(head.as_str()));
}

#[test]
fn reword_published_and_stale_requests_are_refused_without_consent() {
    let dir = fixture();
    let root = dir.path();
    let first = commit(root, "a", "first");
    let head = commit(root, "b", "later");
    git(root, &["update-ref", "refs/remotes/origin/main", &head]);
    let (mut b, info) = open(root);
    assert!(b
        .reword_commit(info.id, &first, "new", false, &info.token)
        .unwrap_err()
        .contains("already published"));
    assert!(b.checkpoints(info.id).unwrap().is_empty());
    assert!(b
        .reword_commit(info.id, "--all", "new", true, &info.token)
        .is_err());
    assert!(b
        .reword_commit(info.id, &first, "\0bad", true, &info.token)
        .is_err());
    assert!(b
        .reword_commit(info.id, &first, "new", true, "stale")
        .is_err());
    let changed = b
        .reword_commit(info.id, &first, "new", true, &info.token)
        .unwrap();
    assert_ne!(changed.head, info.head);
    assert_eq!(git(root, &["rev-parse", "refs/remotes/origin/main"]), head);
}

#[test]
fn ignored_local_files_survive_batch_rebase_and_checkpoint_restoration() {
    let dir = fixture();
    let root = dir.path();
    commit(root, ".gitignore", "secret\n");
    git(root, &["switch", "-c", "topic"]);
    fs::write(root.join("secret"), "tracked content").unwrap();
    git(root, &["add", "-f", "secret"]);
    git(root, &["commit", "-m", "tracked secret"]);
    let target = git(root, &["rev-parse", "HEAD"]);
    git(root, &["switch", "main"]);
    fs::write(root.join("secret"), "user content").unwrap();
    let (mut b, info) = open(root);
    assert!(b
        .batch_commits(info.id, vec![target.clone()], false, &info.token)
        .unwrap_err()
        .contains("ignored local"));
    assert_eq!(
        fs::read_to_string(root.join("secret")).unwrap(),
        "user content"
    );
    fs::remove_file(root.join("secret")).unwrap();
    git(root, &["switch", "topic"]);
    let current = b.status(info.id).unwrap();
    let (base, mut plan) = edits(&mut b, &current, &target);
    plan[0].action = "drop".into();
    let dropped = b
        .rewrite_commits(info.id, &base, plan, false, &current.token)
        .unwrap();
    let checkpoint = b.checkpoints(info.id).unwrap().remove(0);
    fs::write(root.join("secret"), "keep my content").unwrap();
    assert!(b
        .restore_checkpoint(info.id, &checkpoint.oid, &dropped.token)
        .unwrap_err()
        .contains("ignored local"));
    assert_eq!(
        fs::read_to_string(root.join("secret")).unwrap(),
        "keep my content"
    );
    fs::remove_file(root.join("secret")).unwrap();
    let restored = b
        .restore_checkpoint(info.id, &checkpoint.oid, &dropped.token)
        .unwrap();
    git(root, &["rm", "secret"]);
    git(root, &["commit", "-m", "remove tracked secret"]);
    fs::write(root.join("secret"), "protect during replay").unwrap();
    let current = b.status(info.id).unwrap();
    let (base, mut plan) = edits(&mut b, &current, &target);
    plan[0].action = "edit".into();
    assert!(b
        .rewrite_commits(info.id, &base, plan, false, &current.token)
        .unwrap_err()
        .contains("ignored local"));
    assert_eq!(
        fs::read_to_string(root.join("secret")).unwrap(),
        "protect during replay"
    );
    assert!(restored.head.is_some());
}
