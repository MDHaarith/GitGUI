use gitgui_lib::git::{Backend, RepoInfo};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
}
fn run(root: &Path, args: &[&str]) -> std::process::Output {
    gitgui_lib::platform::command("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap()
}
fn git(root: &Path, args: &[&str]) -> String {
    let result = run(root, args);
    assert!(
        result.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8_lossy(&result.stdout).trim().to_owned()
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        for (key, value) in [
            ("user.name", "GitGUI Test"),
            ("user.email", "test@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            git(&root, &["config", key, value]);
        }
        git(
            &root,
            &[
                "config",
                "core.hooksPath",
                root.join(".git/hooks").to_str().unwrap(),
            ],
        );
        Self { _temp: temp, root }
    }
    fn commit(&self, text: &[u8], message: &str) -> String {
        fs::write(self.root.join("a.txt"), text).unwrap();
        git(&self.root, &["add", "--", "a.txt"]);
        git(&self.root, &["commit", "-m", message]);
        git(&self.root, &["rev-parse", "HEAD"])
    }
    fn conflict(operation: &str) -> Self {
        let f = Self::new();
        f.commit(b"base\n", "base");
        git(&f.root, &["switch", "-c", "topic"]);
        let topic = f.commit(b"my commit\n", "topic");
        git(&f.root, &["switch", "main"]);
        f.commit(b"target\n", "target");
        let result = match operation {
            "merge" => run(&f.root, &["merge", "topic"]),
            "cherry-pick" => run(&f.root, &["cherry-pick", &topic]),
            "revert" => run(&f.root, &["revert", &topic]),
            "rebase" => {
                git(&f.root, &["switch", "topic"]);
                run(&f.root, &["rebase", "main"])
            }
            _ => unreachable!(),
        };
        assert!(!result.status.success());
        f
    }
    fn open(&self) -> (Backend, RepoInfo, String) {
        let mut backend = Backend::default();
        let info = backend.open(self.root.to_str().unwrap()).unwrap();
        let file = info.files.iter().find(|f| f.conflicted).unwrap().id.clone();
        (backend, info, file)
    }
}

#[test]
fn reads_real_index_stages_and_preserves_original_work_before_save() {
    let f = Fixture::conflict("merge");
    let (mut b, info, file) = f.open();
    assert_eq!(info.operation.as_deref(), Some("merge"));
    let versions = b.merge_versions(info.id, &file).unwrap();
    assert_eq!(versions.base.as_deref(), Some("base\n"));
    assert_eq!(versions.ours.as_deref(), Some("target\n"));
    assert_eq!(versions.theirs.as_deref(), Some("my commit\n"));
    assert!(!versions.rebasing);
    assert!(versions.working.contains("<<<<<<<"));
    assert!(b.merge_versions(info.id, "../../outside").is_err());
    assert!(b
        .finish_operation(info.id, false, &info.token)
        .unwrap_err()
        .contains("Resolve every"));
    assert!(b.skip_operation(info.id, &info.token).is_err());
    let info = b
        .save_merge_resolution(
            info.id,
            &file,
            "combined\n",
            &versions.working,
            &versions.token,
        )
        .unwrap();
    assert!(!info.files.iter().any(|f| f.conflicted));
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt")).unwrap(),
        "combined\n"
    );
    let checkpoints = b.checkpoints(info.id).unwrap();
    assert!(!checkpoints.is_empty());
    assert_eq!(
        git(&f.root, &["show", &format!("{}:a.txt", checkpoints[0].oid)]),
        versions.working.trim()
    );
    assert_eq!(
        b.finish_operation(info.id, false, &info.token)
            .unwrap()
            .operation,
        None
    );
}

#[test]
fn rebase_yours_is_the_replayed_commit_and_theirs_is_the_target() {
    for (choice, expected) in [("ours", "my commit\n"), ("theirs", "target\n")] {
        let f = Fixture::conflict("rebase");
        let (mut b, info, file) = f.open();
        assert_eq!(info.operation.as_deref(), Some("rebase"));
        let versions = b.merge_versions(info.id, &file).unwrap();
        assert!(versions.rebasing);
        assert_eq!(versions.ours.as_deref(), Some("target\n"));
        assert_eq!(versions.theirs.as_deref(), Some("my commit\n"));
        let info = b
            .resolve_conflict(info.id, &file, choice, &info.token)
            .unwrap();
        assert_eq!(fs::read_to_string(f.root.join("a.txt")).unwrap(), expected);
        assert!(!b.checkpoints(info.id).unwrap().is_empty());
        if choice == "ours" {
            assert_eq!(
                b.finish_operation(info.id, false, &info.token)
                    .unwrap()
                    .operation,
                None
            );
        }
    }
}

#[test]
fn skip_and_abort_work_for_each_supported_operation_and_save_edits() {
    for operation in ["merge", "rebase", "cherry-pick", "revert"] {
        for skip in [false, true] {
            if operation == "merge" && skip {
                continue;
            }
            let f = Fixture::conflict(operation);
            let (mut b, info, _) = f.open();
            assert_eq!(info.operation.as_deref(), Some(operation));
            fs::write(f.root.join("a.txt"), b"hand edited before action\n").unwrap();
            fs::write(f.root.join("new.txt"), b"new work\n").unwrap();
            let result = if skip {
                b.skip_operation(info.id, &info.token)
            } else {
                b.finish_operation(info.id, true, &info.token)
            };
            let info = result.unwrap();
            assert_eq!(info.operation, None, "{operation}: skip={skip}");
            let checkpoints = b.checkpoints(info.id).unwrap();
            assert!(!checkpoints.is_empty());
            assert_eq!(
                git(&f.root, &["show", &format!("{}:a.txt", checkpoints[0].oid)]),
                "hand edited before action"
            );
            assert_eq!(
                fs::read_to_string(f.root.join("new.txt")).unwrap(),
                "new work\n"
            );
        }
    }
}

#[test]
fn continue_finishes_cherry_pick_and_revert_after_saving() {
    for operation in ["cherry-pick", "revert"] {
        let f = Fixture::conflict(operation);
        let (mut b, info, file) = f.open();
        let info = b
            .save_resolution(info.id, &file, "resolved\n", &info.token)
            .unwrap();
        let info = b.finish_operation(info.id, false, &info.token).unwrap();
        assert_eq!(info.operation, None);
        assert_eq!(
            fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "resolved\n"
        );
    }
}

#[test]
fn external_edits_and_stale_tokens_are_refused_without_overwriting() {
    let f = Fixture::conflict("merge");
    let (mut b, info, file) = f.open();
    let versions = b.merge_versions(info.id, &file).unwrap();
    fs::write(f.root.join("a.txt"), b"external edit\n").unwrap();
    assert!(b
        .save_merge_resolution(info.id, &file, "bad\n", &versions.working, &versions.token)
        .unwrap_err()
        .contains("changed"));
    assert!(b.save_resolution(info.id, &file, "bad\n", "stale").is_err());
    assert!(b
        .save_resolution(info.id, &file, "bad\0", &versions.token)
        .is_err());
    assert!(b
        .save_resolution(info.id, &file, "<<<<<<< side\nbad\n", &versions.token)
        .is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt")).unwrap(),
        "external edit\n"
    );
}

#[test]
fn missing_stages_allow_add_add_and_modify_delete_resolution() {
    let f = Fixture::new();
    f.commit(b"base\n", "base");
    git(&f.root, &["switch", "-c", "topic"]);
    git(&f.root, &["rm", "a.txt"]);
    git(&f.root, &["commit", "-m", "delete"]);
    git(&f.root, &["switch", "main"]);
    f.commit(b"modified\n", "modify");
    assert!(!run(&f.root, &["merge", "topic"]).status.success());
    let (mut b, info, file) = f.open();
    let versions = b.merge_versions(info.id, &file).unwrap();
    assert_eq!(versions.theirs, None);
    let info = b
        .resolve_conflict(info.id, &file, "theirs", &info.token)
        .unwrap();
    assert!(!f.root.join("a.txt").exists());
    assert!(!info.files.iter().any(|f| f.conflicted));

    let f = Fixture::new();
    git(&f.root, &["commit", "--allow-empty", "-m", "base"]);
    git(&f.root, &["switch", "-c", "topic"]);
    f.commit(b"topic\n", "topic");
    git(&f.root, &["switch", "main"]);
    f.commit(b"main\n", "main");
    assert!(!run(&f.root, &["merge", "topic"]).status.success());
    let (mut b, info, file) = f.open();
    assert_eq!(b.merge_versions(info.id, &file).unwrap().base, None);
    b.save_resolution(info.id, &file, "both\n", &info.token)
        .unwrap();
}

#[test]
fn binary_and_oversized_stages_refuse_editor_but_whole_file_choices_work() {
    for large in [false, true] {
        let f = Fixture::new();
        let value = |name: &str| {
            if large {
                format!("{name}\n").repeat(5001).into_bytes()
            } else {
                format!("{name}\0binary").into_bytes()
            }
        };
        f.commit(&value("base"), "base");
        git(&f.root, &["switch", "-c", "topic"]);
        f.commit(&value("topic"), "topic");
        git(&f.root, &["switch", "main"]);
        f.commit(&value("main"), "main");
        assert!(!run(&f.root, &["merge", "topic"]).status.success());
        let (mut b, info, file) = f.open();
        assert!(b.merge_versions(info.id, &file).is_err());
        b.resolve_conflict(info.id, &file, "ours", &info.token)
            .unwrap();
        assert_eq!(fs::read(f.root.join("a.txt")).unwrap(), value("main"));
    }
}

#[cfg(unix)]
#[test]
fn editor_refuses_symlinks_and_does_not_write_outside_the_repo() {
    use std::os::unix::fs::symlink;
    let f = Fixture::conflict("merge");
    let (mut b, info, file) = f.open();
    let outside = f._temp.path().join("outside");
    fs::write(&outside, b"private\n").unwrap();
    fs::remove_file(f.root.join("a.txt")).unwrap();
    symlink(&outside, f.root.join("a.txt")).unwrap();
    assert!(b.merge_versions(info.id, &file).is_err());
    assert!(b
        .save_resolution(info.id, &file, "bad\n", &info.token)
        .is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "private\n");
}

#[test]
fn a_multi_commit_cherry_pick_continues_after_its_first_conflict() {
    let f = Fixture::new();
    f.commit(b"base\n", "base");
    git(&f.root, &["switch", "-c", "topic"]);
    let first = f.commit(b"topic\n", "first");
    fs::write(f.root.join("b.txt"), b"next commit\n").unwrap();
    git(&f.root, &["add", "b.txt"]);
    git(&f.root, &["commit", "-m", "second"]);
    let second = git(&f.root, &["rev-parse", "HEAD"]);
    git(&f.root, &["switch", "main"]);
    f.commit(b"main\n", "main");
    assert!(!run(&f.root, &["cherry-pick", &first, &second])
        .status
        .success());
    let (mut b, info, file) = f.open();
    assert_eq!(info.operation.as_deref(), Some("cherry-pick"));
    let info = b
        .save_resolution(info.id, &file, "resolved\n", &info.token)
        .unwrap();
    let info = b.finish_operation(info.id, false, &info.token).unwrap();
    assert_eq!(info.operation, None);
    assert_eq!(
        fs::read_to_string(f.root.join("b.txt")).unwrap(),
        "next commit\n"
    );
}
