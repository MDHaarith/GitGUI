use gitgui_lib::git::{Backend, RepoInfo};
#[cfg(unix)]
use std::os::unix::{
    ffi::OsStringExt,
    fs::{symlink, PermissionsExt},
};
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
};
use tempfile::TempDir;

struct Fixture {
    temp: TempDir,
    root: PathBuf,
}
fn git(root: &Path, args: &[&OsStr]) -> String {
    let result = Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "Git failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8_lossy(&result.stdout).trim().to_owned()
}
fn cmd(root: &Path, args: &[&str]) -> String {
    git(root, &args.iter().map(OsStr::new).collect::<Vec<_>>())
}
fn configure(root: &Path) {
    cmd(root, &["config", "user.name", "GitGUI Test"]);
    cmd(root, &["config", "user.email", "test@example.invalid"]);
    cmd(root, &["config", "commit.gpgsign", "false"]);
    cmd(root, &["config", "push.gpgsign", "false"]);
    cmd(root, &["config", "core.autocrlf", "false"]);
    cmd(
        root,
        &[
            "config",
            "core.hooksPath",
            root.join(".git/hooks").to_str().unwrap(),
        ],
    );
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        cmd(&root, &["init", "-b", "main"]);
        configure(&root);
        Self { temp, root }
    }
    fn write(&self, name: impl AsRef<Path>, content: &[u8]) {
        fs::write(self.root.join(name), content).unwrap();
    }
    fn commit(&self, name: &str, content: &str, message: &str) -> String {
        self.write(name, content.as_bytes());
        cmd(&self.root, &["add", "--", name]);
        cmd(&self.root, &["commit", "-m", message]);
        cmd(&self.root, &["rev-parse", "HEAD"])
    }
    fn open(&self) -> (Backend, RepoInfo) {
        let mut backend = Backend::default();
        let info = backend.open(self.root.to_str().unwrap()).unwrap();
        (backend, info)
    }
}

#[test]
fn unborn_unstage_preserves_content_and_first_commit_works() {
    let f = Fixture::new();
    f.write("one", b"original\n");
    let (mut b, info) = f.open();
    assert!(info.head.is_none());
    assert_eq!(info.branch.as_deref(), Some("main"));
    let id = info.files[0].id.clone();
    let staged = b
        .stage(info.id, std::slice::from_ref(&id), false, &info.token)
        .unwrap();
    f.write("one", b"working edit\n");
    let unstaged = b
        .stage(info.id, std::slice::from_ref(&id), true, &staged.token)
        .unwrap();
    assert_eq!(fs::read(f.root.join("one")).unwrap(), b"working edit\n");
    assert!(unstaged.files[0].untracked);
    let staged = b.stage(info.id, &[id], false, &unstaged.token).unwrap();
    let committed = b
        .commit(info.id, "First commit", &staged.token, false)
        .unwrap();
    assert!(committed.head.is_some());
    assert!(committed.files.is_empty());
    let details = b
        .commit_details(info.id, committed.head.as_deref().unwrap(), None)
        .unwrap();
    assert_eq!(details.files[0].path, "one");
    assert!(details.parents.is_empty());
    assert!(b
        .commit_diff(info.id, &details.oid, None, None)
        .unwrap()
        .text
        .contains("+working edit"));
}

#[test]
fn commit_uses_only_index_and_keeps_unstaged_edits() {
    let f = Fixture::new();
    f.commit("one", "base\n", "base");
    f.write("one", b"staged version\n");
    f.write("other", b"leave this\n");
    let (mut b, info) = f.open();
    let id = info
        .files
        .iter()
        .find(|file| file.path == "one")
        .unwrap()
        .id
        .clone();
    let staged = b
        .stage(info.id, std::slice::from_ref(&id), false, &info.token)
        .unwrap();
    f.write("one", b"new working edit\n");
    assert!(b
        .working_diff(info.id, &id, true)
        .unwrap()
        .text
        .contains("+staged version"));
    assert!(b
        .working_diff(info.id, &id, false)
        .unwrap()
        .text
        .contains("+new working edit"));
    let final_info = b
        .commit(info.id, "Only the reviewed index", &staged.token, false)
        .unwrap();
    assert_eq!(cmd(&f.root, &["show", "HEAD:one"]), "staged version");
    assert_eq!(fs::read(f.root.join("one")).unwrap(), b"new working edit\n");
    assert!(final_info
        .files
        .iter()
        .any(|file| file.path == "other" && file.untracked));
    assert!(!cmd(&f.root, &["ls-tree", "--name-only", "HEAD"]).contains("other"));
}

#[test]
fn stale_token_and_invalid_inputs_fail_without_mutation() {
    let f = Fixture::new();
    f.commit("one", "base", "base");
    f.write("one", b"next");
    let (mut b, info) = f.open();
    cmd(&f.root, &["add", "one"]);
    let old_head = info.head.clone();
    assert!(b
        .commit(info.id, "stale", &info.token, false)
        .unwrap_err()
        .contains("changed"));
    assert_eq!(b.status(info.id).unwrap().head, old_head);
    let token = b.status(info.id).unwrap().token;
    assert!(b.stage(info.id, &["a©b".into()], false, &token).is_err());
    assert!(b.commit_details(info.id, "--all", None).is_err());
    assert!(b.status(info.id + 10).is_err());
    let missing = f.temp.path().join("not-a-repo");
    fs::create_dir(&missing).unwrap();
    assert!(b.open(missing.to_str().unwrap()).is_err());
    assert_eq!(b.status(info.id).unwrap().head, old_head);
}

#[test]
fn paths_are_literal_and_non_utf8_names_remain_addressable() {
    let f = Fixture::new();
    let mut names = vec![
        OsString::from("-option"),
        OsString::from(":(glob)*"),
        OsString::from("with space"),
        OsString::from("line\nbreak"),
        OsString::from("a[1]"),
        OsString::from("世界"),
    ];
    #[cfg(unix)]
    names.push(OsString::from_vec(b"invalid-\xff".to_vec()));
    for name in &names {
        f.write(Path::new(name), b"data\n");
    }
    let (mut b, info) = f.open();
    assert_eq!(info.files.len(), names.len());
    let ids: Vec<_> = info.files.iter().map(|file| file.id.clone()).collect();
    for id in &ids {
        assert_eq!(b.working_diff(info.id, id, false).unwrap().text, "data\n");
    }
    let staged = b.stage(info.id, &ids, false, &info.token).unwrap();
    b.commit(info.id, "Literal filenames", &staged.token, false)
        .unwrap();
    assert!(b.status(info.id).unwrap().files.is_empty());
    for name in &names {
        assert_eq!(fs::read(f.root.join(name)).unwrap(), b"data\n");
    }
}

#[test]
fn rename_unstage_keeps_working_tree_and_commit_diff_tracks_both_names() {
    let f = Fixture::new();
    f.commit("old name", "unchanged content\n", "base");
    cmd(&f.root, &["mv", "old name", "new name"]);
    let (mut b, info) = f.open();
    let file = &info.files[0];
    assert_eq!(file.old_path.as_deref(), Some("old name"));
    assert!(b
        .working_diff(info.id, &file.id, true)
        .unwrap()
        .text
        .contains("rename from"));
    let next = b
        .stage(info.id, std::slice::from_ref(&file.id), true, &info.token)
        .unwrap();
    assert_eq!(
        fs::read(f.root.join("new name")).unwrap(),
        b"unchanged content\n"
    );
    assert!(!f.root.join("old name").exists());
    let ids: Vec<_> = next.files.iter().map(|file| file.id.clone()).collect();
    let next = b.stage(info.id, &ids, false, &next.token).unwrap();
    let next = b.commit(info.id, "Rename", &next.token, false).unwrap();
    let details = b
        .commit_details(info.id, next.head.as_deref().unwrap(), None)
        .unwrap();
    assert_eq!(details.files[0].old_path.as_deref(), Some("old name"));
    assert!(b
        .commit_diff(
            info.id,
            &details.oid,
            details.parent.clone(),
            Some(details.files[0].id.clone())
        )
        .unwrap()
        .text
        .contains("rename from"));
}

#[cfg(unix)]
#[test]
fn failed_hook_leaves_staging_and_head_intact() {
    let f = Fixture::new();
    f.write("one", b"staged");
    let (mut b, info) = f.open();
    let info = b
        .stage(info.id, &[info.files[0].id.clone()], false, &info.token)
        .unwrap();
    let hook = f.root.join(".git/hooks/pre-commit");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(
        &hook,
        b"#!/bin/sh\necho fixture-hook-rejected >&2\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let error = b
        .commit(info.id, "Must fail", &info.token, false)
        .unwrap_err();
    assert!(error.contains("fixture-hook-rejected"));
    let current = b.status(info.id).unwrap();
    assert!(current.head.is_none());
    assert_eq!(current.files[0].index, "A");
}

#[test]
fn graph_freezes_tips_and_preserves_merge_parents_tags_and_scopes() {
    let f = Fixture::new();
    let root = f.commit("base", "base", "root");
    cmd(&f.root, &["switch", "-c", "side"]);
    let side = f.commit("side", "side", "side");
    cmd(&f.root, &["switch", "main"]);
    let main = f.commit("main", "main", "main");
    cmd(&f.root, &["merge", "--no-ff", "side", "-m", "merge"]);
    let merge = cmd(&f.root, &["rev-parse", "HEAD"]);
    cmd(&f.root, &["tag", "-a", "v1", "-m", "release"]);
    let (mut b, info) = f.open();
    let first = b.graph(info.id, None, 2, None).unwrap();
    assert!(first.has_more);
    assert_eq!(first.commits[0].oid, merge);
    assert_eq!(first.commits[0].parents, vec![main.clone(), side.clone()]);
    assert!(first
        .refs
        .iter()
        .any(|reference| reference.kind == "tag" && reference.target == merge));
    f.commit("later", "new", "later");
    let old = b.graph(info.id, None, 200, Some(first.graph_id)).unwrap();
    assert_eq!(old.commits.len(), 4);
    assert_eq!(old.commits[0].oid, merge);
    assert_eq!(old.commits.last().unwrap().oid, root);
    let side_ref = old
        .refs
        .iter()
        .find(|reference| reference.name == "side")
        .unwrap()
        .id
        .clone();
    let scoped = b.graph(info.id, Some(side_ref), 200, None).unwrap();
    assert_eq!(scoped.commits.len(), 2);
    assert_eq!(b.status(info.id).unwrap().branch.as_deref(), Some("main"));
    let details = b.commit_details(info.id, &merge, Some(side)).unwrap();
    assert_eq!(details.parents.len(), 2);
    assert!(b
        .commit_diff(info.id, &merge, details.parent.clone(), None)
        .unwrap()
        .text
        .contains("+main"));
    assert!(b.commit_details(info.id, &merge, Some(root)).is_err());
}

#[test]
fn branch_creation_detached_head_and_worktree_switch_are_safe() {
    let f = Fixture::new();
    let root = f.commit("shared", "base", "base");
    let (mut b, info) = f.open();
    b.create_branch(info.id, "feature", Some(root.clone()), &info.token)
        .unwrap();
    let graph = b.graph(info.id, None, 200, None).unwrap();
    assert_eq!(graph.commits.len(), 1);
    let feature = graph
        .refs
        .iter()
        .find(|r| r.name == "feature")
        .unwrap()
        .id
        .clone();
    let current = b.status(info.id).unwrap();
    let current = b.switch_branch(info.id, &feature, &current.token).unwrap();
    assert_eq!(current.branch.as_deref(), Some("feature"));
    f.commit("shared", "feature edit", "feature");
    cmd(&f.root, &["switch", "main"]);
    f.write("shared", b"unsaved");
    let current = b.status(info.id).unwrap();
    assert!(b.switch_branch(info.id, &feature, &current.token).is_err());
    assert_eq!(fs::read(f.root.join("shared")).unwrap(), b"unsaved");
    cmd(&f.root, &["restore", "shared"]);
    cmd(&f.root, &["switch", "--detach", &root]);
    let current = b.status(info.id).unwrap();
    assert!(current.detached);
    f.write("other", b"detached");
    let current = b.status(info.id).unwrap();
    let id = current.files[0].id.clone();
    let current = b.stage(info.id, &[id], false, &current.token).unwrap();
    assert!(b
        .commit(info.id, "no acknowledgment", &current.token, false)
        .is_err());
    let current = b
        .commit(info.id, "detached acknowledgment", &current.token, true)
        .unwrap();
    let graph = b.graph(info.id, None, 200, None).unwrap();
    assert!(graph
        .commits
        .iter()
        .any(|c| Some(&c.oid) == current.head.as_ref()));
    let worktree = f.temp.path().join("worktree");
    cmd(
        &f.root,
        &[
            "worktree",
            "add",
            "-b",
            "linked",
            worktree.to_str().unwrap(),
            &root,
        ],
    );
    assert!(worktree.join(".git").is_file());
    let linked = b.open(worktree.to_str().unwrap()).unwrap();
    assert_eq!(linked.branch.as_deref(), Some("linked"));
}

#[cfg(unix)]
#[test]
fn untracked_symlink_and_binary_previews_do_not_leak_target_contents() {
    let f = Fixture::new();
    let secret = f.temp.path().join("private");
    fs::write(&secret, b"outside-secret-not-for-preview").unwrap();
    symlink(&secret, f.root.join("link")).unwrap();
    f.write("binary", &[0, 255, 1]);
    let (mut b, info) = f.open();
    let link = info.files.iter().find(|file| file.path == "link").unwrap();
    let preview = b.working_diff(info.id, &link.id, false).unwrap();
    assert!(preview.text.starts_with("Symbolic link"));
    assert!(!preview.text.contains("outside-secret-not-for-preview"));
    let binary = info
        .files
        .iter()
        .find(|file| file.path == "binary")
        .unwrap();
    assert!(b.working_diff(info.id, &binary.id, false).unwrap().binary);
}

#[test]
fn local_remote_publish_fetch_ff_pull_and_divergence_preserve_history() {
    let a = Fixture::new();
    a.commit("base", "base", "base");
    let remote = a.temp.path().join("remote.git");
    cmd(a.temp.path(), &["init", "--bare", remote.to_str().unwrap()]);
    cmd(
        &a.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let (mut backend_a, info_a) = a.open();
    let remote_id = info_a.remotes[0].id.clone();
    let messages = Arc::new(Mutex::new(Vec::new()));
    let received = messages.clone();
    let info_a = backend_a
        .push(
            info_a.id,
            Some(remote_id),
            &info_a.token,
            Some(Arc::new(move |message| {
                received.lock().unwrap().push(message)
            })),
        )
        .unwrap();
    assert!(messages
        .lock()
        .unwrap()
        .iter()
        .any(|line: &String| line.contains("objects")));
    assert!(info_a.upstream.is_some());
    let clone = a.temp.path().join("clone");
    cmd(
        a.temp.path(),
        &[
            "clone",
            "-b",
            "main",
            remote.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    configure(&clone);
    let mut backend_b = Backend::default();
    let info_b = backend_b.open(clone.to_str().unwrap()).unwrap();
    cmd(&a.root, &["branch", "private"]);
    cmd(&a.root, &["config", "remote.origin.mirror", "true"]);
    a.commit("upstream", "remote change", "upstream");
    let info_a = backend_a.status(info_a.id).unwrap();
    backend_a
        .push(info_a.id, None, &info_a.token, None)
        .unwrap();
    assert!(cmd(
        &remote,
        &["for-each-ref", "--format=%(refname)", "refs/heads/private"]
    )
    .is_empty());
    let fetched = backend_b
        .fetch(info_b.id, &info_b.remotes[0].id, None)
        .unwrap();
    assert_eq!(fetched.head, info_b.head);
    assert!(fetched.behind > 0);
    let pulled = backend_b.pull(info_b.id, &fetched.token, None).unwrap();
    assert_ne!(pulled.head, info_b.head);
    fs::write(clone.join("local"), b"local").unwrap();
    cmd(&clone, &["add", "local"]);
    cmd(&clone, &["commit", "-m", "local"]);
    a.commit("divergent", "remote", "remote divergent");
    let info_a = backend_a.status(info_a.id).unwrap();
    backend_a
        .push(info_a.id, None, &info_a.token, None)
        .unwrap();
    let info_b = backend_b.status(info_b.id).unwrap();
    let head = info_b.head.clone();
    assert!(backend_b.pull(info_b.id, &info_b.token, None).is_err());
    assert_eq!(backend_b.status(info_b.id).unwrap().head, head);
    let info_b = backend_b.status(info_b.id).unwrap();
    assert!(backend_b
        .push(info_b.id, None, &info_b.token, None)
        .is_err());
    assert_eq!(backend_b.status(info_b.id).unwrap().head, head);
}

#[test]
fn shallow_history_is_not_presented_as_an_ordinary_root() {
    let f = Fixture::new();
    f.commit("one", "one", "one");
    f.commit("two", "two", "two");
    let clone = f.temp.path().join("shallow");
    let url = "file://".to_owned() + f.root.to_str().unwrap();
    cmd(
        f.temp.path(),
        &["clone", "--depth", "1", &url, clone.to_str().unwrap()],
    );
    configure(&clone);
    let mut b = Backend::default();
    let info = b.open(clone.to_str().unwrap()).unwrap();
    let page = b.graph(info.id, None, 200, None).unwrap();
    assert_eq!(page.commits.len(), 1);
    assert!(page.commits[0].shallow);
    let preview = b
        .commit_diff(info.id, &page.commits[0].oid, None, None)
        .unwrap();
    assert!(preview.text.contains("shallow"));
}

#[test]
fn credentials_are_redacted_from_remote_errors_and_labels() {
    assert_eq!(
        gitgui_lib::git::redact("fatal: https://user:secret@example.test/repo"),
        "fatal: https://[redacted]@example.test/repo"
    );
    let f = Fixture::new();
    cmd(
        &f.root,
        &[
            "remote",
            "add",
            "private",
            "https://user:secret@example.test/repo",
        ],
    );
    let (_, info) = f.open();
    assert!(!info.remotes[0].url.contains("secret"));
}
