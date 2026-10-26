use gitgui_lib::git::{Backend, RepoInfo, SyncRequest, SyncResponse};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", root.join("no-global-config"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}
fn configure(root: &Path) {
    for (key, value) in [
        ("user.name", "Sync Test"),
        ("user.email", "sync@example.invalid"),
        ("commit.gpgsign", "false"),
        ("push.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(root, &["config", key, value]);
    }
    git(
        root,
        &[
            "config",
            "core.hooksPath",
            root.join("no-hooks").to_str().unwrap(),
        ],
    );
}
fn commit(root: &Path, path: &str, text: &str, message: &str) -> String {
    fs::write(root.join(path), text).unwrap();
    git(root, &["add", "--", path]);
    git(root, &["commit", "-m", message]);
    git(root, &["rev-parse", "HEAD"])
}
struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    remote: PathBuf,
    peer: PathBuf,
    b: Backend,
    id: u64,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        configure(&root);
        commit(&root, "one", "base\n", "base");
        let remote = temp.path().join("remote.git");
        git(&root, &["init", "--bare", remote.to_str().unwrap()]);
        git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&root, &["push", "-u", "origin", "main"]);
        let peer = temp.path().join("peer");
        git(
            &root,
            &[
                "clone",
                "-b",
                "main",
                remote.to_str().unwrap(),
                peer.to_str().unwrap(),
            ],
        );
        configure(&peer);
        let mut b = Backend::default();
        let id = b.open(root.to_str().unwrap()).unwrap().id;
        Self {
            _temp: temp,
            root,
            remote,
            peer,
            b,
            id,
        }
    }
    fn info(&mut self) -> RepoInfo {
        self.b.status(self.id).unwrap()
    }
    fn run(&mut self, request: SyncRequest) -> Result<SyncResponse, String> {
        self.b.sync(self.id, request, None)
    }
    fn branch(&mut self, name: &str) -> String {
        self.b
            .graph(self.id, None, 100, None)
            .unwrap()
            .refs
            .into_iter()
            .find(|r| r.kind == "local" && r.name == name)
            .unwrap()
            .id
    }
    fn remote_id(&mut self) -> String {
        self.info().remotes[0].id.clone()
    }
    fn diverge(&mut self) {
        commit(&self.root, "local", "local\n", "local only");
        commit(&self.peer, "remote", "remote\n", "remote only");
        git(&self.peer, &["push"]);
    }
}

#[test]
fn comparison_has_both_exclusive_histories_and_the_three_dot_diff() {
    let mut f = Fixture::new();
    git(&f.root, &["branch", "topic"]);
    commit(&f.root, "local", "A\n", "only A");
    git(&f.root, &["switch", "topic"]);
    commit(&f.root, "topic", "B\n", "only B");
    let a = f.branch("main");
    let b = f.branch("topic");
    let result = f
        .run(SyncRequest::Compare { a: a.clone(), b })
        .unwrap()
        .comparison
        .unwrap();
    assert!(result.only_a.text.contains("only A"));
    assert!(!result.only_a.text.contains("only B"));
    assert!(result.only_b.text.contains("only B"));
    assert!(result.diff.text.contains("+B"));
    assert!(!result.diff.text.contains("-A"));
    let activity = f.run(SyncRequest::Activity).unwrap().activity.unwrap();
    let entry = activity.iter().find(|r| r.id == a).unwrap();
    assert_eq!(entry.author, "Sync Test");
    assert!(entry.timestamp > 0);
    assert!(f
        .run(SyncRequest::Compare {
            a: "--all".into(),
            b: "HEAD".into()
        })
        .is_err());
}

#[test]
fn pull_keeps_fast_forward_default_and_accepts_one_time_merge_or_rebase() {
    for mode in ["merge", "rebase"] {
        let mut f = Fixture::new();
        f.diverge();
        git(&f.root, &["config", "pull.ff", "only"]);
        git(&f.root, &["config", "pull.rebase", "true"]);
        let token = f.info().token;
        assert!(f
            .run(SyncRequest::Pull {
                mode: "ff".into(),
                stash: false,
                token
            })
            .is_err());
        let token = f.info().token;
        f.run(SyncRequest::Pull {
            mode: mode.into(),
            stash: false,
            token,
        })
        .unwrap();
        assert!(f.root.join("local").exists());
        assert!(f.root.join("remote").exists());
        assert_eq!(git(&f.root, &["config", "pull.ff"]), "only");
        assert_eq!(git(&f.root, &["config", "pull.rebase"]), "true");
        let parents = git(&f.root, &["show", "-s", "--format=%P", "HEAD"])
            .split_whitespace()
            .count();
        assert_eq!(parents, if mode == "merge" { 2 } else { 1 });
    }
}

#[test]
fn stash_retry_restores_staged_untracked_changes_and_keeps_a_conflicting_pop() {
    let mut f = Fixture::new();
    git(&f.root, &["branch", "topic"]);
    fs::write(f.root.join("one"), "staged\n").unwrap();
    git(&f.root, &["add", "one"]);
    fs::write(f.root.join("new"), "untracked\n").unwrap();
    let reference_id = f.branch("topic");
    let token = f.info().token;
    let info = f
        .run(SyncRequest::Switch {
            reference_id,
            stash: true,
            token,
        })
        .unwrap()
        .info
        .unwrap();
    assert_eq!(info.branch.as_deref(), Some("topic"));
    assert_eq!(git(&f.root, &["show", ":one"]), "staged");
    assert_eq!(
        fs::read_to_string(f.root.join("new")).unwrap(),
        "untracked\n"
    );
    assert!(git(&f.root, &["stash", "list"]).is_empty());
    git(&f.root, &["reset", "--hard"]);
    fs::remove_file(f.root.join("new")).unwrap();
    commit(&f.root, "one", "topic\n", "topic edits");
    git(&f.root, &["switch", "main"]);
    fs::write(f.root.join("one"), "local edit\n").unwrap();
    let reference_id = f.branch("topic");
    let token = f.info().token;
    let error = f
        .run(SyncRequest::Switch {
            reference_id,
            stash: true,
            token,
        })
        .err()
        .unwrap();
    assert!(error.contains("Stash pop"), "{error}");
    assert!(error.contains("was kept"));
    assert!(!git(&f.root, &["stash", "list"]).is_empty());
    assert!(f.info().files.iter().any(|file| file.conflicted));
    assert!(git(&f.root, &["show", "stash@{0}:one"]).contains("local edit"));
}

#[test]
fn stash_pull_conflicts_keep_the_retry_stash_until_the_merge_is_resolved() {
    let mut f = Fixture::new();
    commit(&f.root, "one", "local\n", "local");
    commit(&f.peer, "one", "remote\n", "remote");
    git(&f.peer, &["push"]);
    fs::write(f.root.join("unfinished"), "keep me\n").unwrap();
    let token = f.info().token;
    let error = f
        .run(SyncRequest::Pull {
            mode: "merge".into(),
            stash: true,
            token,
        })
        .err()
        .unwrap();
    assert!(error.contains("remain in stash"), "{error}");
    assert_eq!(f.info().operation.as_deref(), Some("merge"));
    assert_eq!(git(&f.root, &["show", "stash@{0}^3:unfinished"]), "keep me");
}

#[test]
fn force_push_needs_a_rejection_and_an_unchanged_exact_lease() {
    let mut f = Fixture::new();
    let token = f.info().token;
    assert!(f.run(SyncRequest::ForcePush { token }).is_err());
    f.diverge();
    let token = f.info().token;
    assert!(f
        .run(SyncRequest::Push {
            remote_id: None,
            token
        })
        .is_err());
    let lease = f.run(SyncRequest::Lease).unwrap().lease.unwrap();
    assert_eq!(lease.branch, "main");
    assert_eq!(lease.expected, git(&f.peer, &["rev-parse", "HEAD"]));
    commit(&f.peer, "remote", "new remote\n", "remote moved");
    git(&f.peer, &["push"]);
    let token = f.info().token;
    assert!(f
        .run(SyncRequest::ForcePush { token })
        .err()
        .unwrap()
        .contains("remote branch changed"));
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.peer, &["rev-parse", "HEAD"])
    );
    let token = f.info().token;
    assert!(f
        .run(SyncRequest::Push {
            remote_id: None,
            token
        })
        .is_err());
    let token = f.info().token;
    f.run(SyncRequest::ForcePush { token }).unwrap();
    assert_eq!(
        git(&f.remote, &["rev-parse", "main"]),
        git(&f.root, &["rev-parse", "HEAD"])
    );
    assert!(f.run(SyncRequest::Lease).is_err());
}

#[test]
fn branch_fetch_refuses_divergence_and_reset_preserves_commits_without_checkout() {
    let mut f = Fixture::new();
    git(&f.root, &["branch", "topic"]);
    git(&f.root, &["push", "origin", "topic"]);
    git(&f.peer, &["fetch"]);
    git(&f.peer, &["switch", "topic"]);
    let remote_tip = commit(&f.peer, "topic", "remote\n", "remote topic");
    git(&f.peer, &["push"]);
    let reference_id = f.branch("topic");
    let remote_id = f.remote_id();
    let token = f.info().token;
    f.run(SyncRequest::BranchFetch {
        reference_id: reference_id.clone(),
        remote_id: remote_id.clone(),
        token,
    })
    .unwrap();
    assert_eq!(git(&f.root, &["rev-parse", "topic"]), remote_tip);
    assert_eq!(f.info().branch.as_deref(), Some("main"));
    git(&f.root, &["switch", "topic"]);
    let old = commit(&f.root, "unique", "keep\n", "unique local");
    git(&f.root, &["switch", "main"]);
    commit(&f.peer, "remote-again", "again\n", "remote again");
    git(&f.peer, &["push"]);
    let token = f.info().token;
    assert!(f
        .run(SyncRequest::BranchFetch {
            reference_id: reference_id.clone(),
            remote_id: remote_id.clone(),
            token
        })
        .is_err());
    assert_eq!(git(&f.root, &["rev-parse", "topic"]), old);
    fs::write(f.root.join("one"), "unfinished\n").unwrap();
    let token = f.info().token;
    f.run(SyncRequest::BranchReset {
        reference_id,
        remote_id,
        token,
    })
    .unwrap();
    assert_eq!(
        git(&f.root, &["rev-parse", "topic"]),
        git(&f.peer, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        fs::read_to_string(f.root.join("one")).unwrap(),
        "unfinished\n"
    );
    assert!(git(
        &f.root,
        &[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/gitgui/branch-resets"
        ]
    )
    .contains(&old));
    assert!(!f.b.checkpoints(f.id).unwrap().is_empty());
}

#[test]
fn worktrees_add_open_dirty_remove_and_checked_out_branch_guards() {
    let mut f = Fixture::new();
    let path = f.root.parent().unwrap().join("work tree ü");
    let token = f.info().token;
    let response = f
        .run(SyncRequest::WorktreeAdd {
            path: path.to_str().unwrap().into(),
            branch: "topic".into(),
            new_branch: true,
            token,
        })
        .unwrap();
    let worktree = response
        .worktrees
        .unwrap()
        .into_iter()
        .find(|w| w.path == path.to_str().unwrap())
        .unwrap();
    assert_eq!(worktree.branch.as_deref(), Some("refs/heads/topic"));
    let opened = f.b.open(path.to_str().unwrap()).unwrap();
    assert_ne!(opened.id, f.id);
    f.b.close_repository(opened.id);
    let reference_id = f.branch("topic");
    let remote_id = f.remote_id();
    let token = f.info().token;
    assert!(f
        .run(SyncRequest::BranchFetch {
            reference_id,
            remote_id,
            token
        })
        .err()
        .unwrap()
        .contains("checked out"));
    fs::write(path.join("one"), "dirty tracked\n").unwrap();
    fs::write(path.join("untracked"), "keep untracked\n").unwrap();
    fs::write(path.join(".gitignore"), "ignored\n").unwrap();
    fs::write(path.join("ignored"), "keep ignored\n").unwrap();
    let token = f.info().token;
    assert!(f
        .run(SyncRequest::WorktreeRemove {
            worktree_id: worktree.id.clone(),
            confirmed: false,
            token
        })
        .err()
        .unwrap()
        .contains("dirty"));
    assert!(path.exists());
    let token = f.info().token;
    f.run(SyncRequest::WorktreeRemove {
        worktree_id: worktree.id,
        confirmed: true,
        token,
    })
    .unwrap();
    assert!(!path.exists());
    assert_eq!(git(&f.root, &["show", "stash@{0}:one"]), "dirty tracked");
    assert_eq!(
        git(&f.root, &["show", "stash@{0}^3:ignored"]),
        "keep ignored"
    );
    assert_eq!(
        git(&f.root, &["show", "stash@{0}^3:untracked"]),
        "keep untracked"
    );
    assert!(!git(&f.root, &["rev-parse", "topic"]).is_empty());
    let token = f.info().token;
    f.run(SyncRequest::WorktreeAdd {
        path: path.to_str().unwrap().into(),
        branch: "topic".into(),
        new_branch: false,
        token,
    })
    .unwrap();
    let worktree_id = f
        .run(SyncRequest::Worktrees)
        .unwrap()
        .worktrees
        .unwrap()
        .into_iter()
        .find(|w| w.path == path.to_str().unwrap())
        .unwrap()
        .id;
    let token = f.info().token;
    f.run(SyncRequest::WorktreeRemove {
        worktree_id,
        confirmed: false,
        token,
    })
    .unwrap();
    assert!(!path.exists());
}

#[test]
fn reset_current_branch_saves_edits_and_refuses_to_overwrite_ignored_files() {
    let mut f = Fixture::new();
    let old = commit(&f.root, "local", "unique\n", "local commit");
    fs::write(f.root.join("one"), "unfinished\n").unwrap();
    fs::write(f.root.join("untracked"), "new\n").unwrap();
    let reference_id = f.branch("main");
    let remote_id = f.remote_id();
    let token = f.info().token;
    f.run(SyncRequest::BranchReset {
        reference_id: reference_id.clone(),
        remote_id: remote_id.clone(),
        token,
    })
    .unwrap();
    assert_eq!(
        git(&f.root, &["rev-parse", "HEAD"]),
        git(&f.peer, &["rev-parse", "HEAD"])
    );
    assert!(f.root.join("untracked").exists());
    assert!(!f.b.checkpoints(f.id).unwrap().is_empty());
    assert!(git(
        &f.root,
        &[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/gitgui/branch-resets"
        ]
    )
    .contains(&old));
    fs::write(f.root.join(".gitignore"), "ignored\n").unwrap();
    fs::write(f.root.join("ignored"), "private data\n").unwrap();
    commit(&f.peer, "ignored", "remote tracked\n", "remote tracked");
    git(&f.peer, &["push"]);
    let token = f.info().token;
    assert!(f
        .run(SyncRequest::BranchReset {
            reference_id,
            remote_id,
            token
        })
        .err()
        .unwrap()
        .contains("Ignored files"));
    assert_eq!(
        fs::read_to_string(f.root.join("ignored")).unwrap(),
        "private data\n"
    );
}
