use serde::Serialize;
#[cfg(unix)]
use std::os::unix::{
    ffi::{OsStrExt, OsStringExt},
    io::{AsRawFd, FromRawFd},
};
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

mod commits;
mod daily;
mod files;
pub mod github;
mod history;
pub mod mcp;
mod process;
mod rebase;
mod share;
mod vibe;
pub use daily::{Junk, Stash};
pub use files::{BlameLine, FileCommit};
pub use process::redact;
use process::*;
pub use rebase::{RebaseCommit, RebaseEdit, RebasePlan};
pub use vibe::{Session, SessionFile};

pub type Result<T> = std::result::Result<T, String>;
pub type Progress = Arc<dyn Fn(String) + Send + Sync>;
const DATA_LIMIT: usize = 16 * 1024 * 1024;
const PREVIEW_LIMIT: usize = 2 * 1024 * 1024;
// The system Git on Linux, so a git bundled beside the AppImage is never picked up; elsewhere Git from PATH.
const GIT: &str = if cfg!(target_os = "linux") {
    "/usr/bin/git"
} else {
    "git"
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    pub id: String,
    pub name: String,
    pub full_name: String,
    pub kind: String,
    pub target: String,
    pub is_head: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub timestamp: i64,
    pub shallow: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub graph_id: u64,
    pub commits: Vec<Commit>,
    pub refs: Vec<RefInfo>,
    pub head: Option<String>,
    pub has_more: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub old_id: Option<String>,
    pub index: String,
    pub worktree: String,
    pub untracked: bool,
    pub conflicted: bool,
    pub submodule: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub id: String,
    pub name: String,
    pub url: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub id: u64,
    pub root: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub operation: Option<String>,
    pub remotes: Vec<RemoteInfo>,
    pub files: Vec<FileInfo>,
    pub token: String,
    pub version: Option<String>,
    pub versioning: bool,
    pub refs_token: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Preview {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub old_id: Option<String>,
    pub status: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub oid: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub message: String,
    pub parent: Option<String>,
    pub files: Vec<CommitFile>,
    pub shallow: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Checkpoint {
    pub oid: String,
    pub timestamp: i64,
    pub label: String,
    pub summary: String,
}
const CHECKPOINTS: &str = "refs/gitgui/checkpoints";
const CHECKPOINT_LIMIT: usize = 100;

/// Plain-English summary of `git diff --numstat` output.
pub fn summarize(numstat: &str) -> String {
    let (mut added, mut deleted, mut files) = (0u64, 0u64, Vec::new());
    for row in numstat.lines() {
        let mut fields = row.splitn(3, '\t');
        if let (Some(a), Some(d), Some(path)) = (fields.next(), fields.next(), fields.next()) {
            added += a.parse().unwrap_or(0);
            deleted += d.parse().unwrap_or(0);
            files.push(path.rsplit('/').next().unwrap_or(path));
        }
    }
    if files.is_empty() {
        return String::new();
    }
    let more = if files.len() > 3 {
        format!(" and {} more", files.len() - 3)
    } else {
        String::new()
    };
    format!(
        "{} file{} changed (+{added} −{deleted}): {}{more}",
        files.len(),
        if files.len() == 1 { "" } else { "s" },
        files[..files.len().min(3)].join(", ")
    )
}

struct GraphCache {
    id: u64,
    scope: Option<String>,
    tips: Vec<String>,
    refs: Vec<RefInfo>,
    head: Option<String>,
}
struct Repository {
    id: u64,
    root: PathBuf,
    paths: HashMap<String, OsString>,
    graph: Option<GraphCache>,
    graph_sequence: u64,
}
#[derive(Default)]
pub struct Backend {
    repos: Vec<Repository>,
    sequence: u64,
}

impl Backend {
    pub fn open(&mut self, path: &str) -> Result<RepoInfo> {
        let chosen = fs::canonicalize(path).map_err(|e| format!("Cannot open this folder: {e}"))?;
        let chosen = if chosen.is_file() {
            chosen.parent().ok_or("Invalid folder")?.to_path_buf()
        } else {
            chosen
        };
        let version = text(&read(&chosen, &argv(&["version"]))?);
        let numbers: Vec<u32> = version
            .split_whitespace()
            .nth(2)
            .unwrap_or("")
            .split('.')
            .take(2)
            .filter_map(|part| part.parse().ok())
            .collect();
        if numbers.len() < 2 || numbers[0] < 2 || (numbers[0] == 2 && numbers[1] < 43) {
            return Err("GitGUI requires system Git 2.43 or newer. Upgrade Git before opening repositories.".into());
        }
        if text(line(&read(
            &chosen,
            &argv(&["rev-parse", "--is-bare-repository"]),
        )?)) == "true"
        {
            return Err(
                "Open a working repository; bare repositories have no working tree.".into(),
            );
        }
        let root = PathBuf::from(from_bytes(line(&read(
            &chosen,
            &argv(&["rev-parse", "--show-toplevel"]),
        )?)));
        if let Some(repository) = self.repos.iter_mut().find(|repo| repo.root == root) {
            return repository.info();
        }
        if self.repos.len() >= 12 {
            return Err(
                "You can open up to 12 repositories at once. Close a tab before opening another."
                    .into(),
            );
        }
        self.sequence += 1;
        let mut repository = Repository {
            id: self.sequence,
            root,
            paths: HashMap::new(),
            graph: None,
            graph_sequence: 0,
        };
        let info = repository.info()?;
        self.repos.push(repository);
        Ok(info)
    }
    pub fn init(&mut self, path: &str) -> Result<RepoInfo> {
        read(Path::new(path), &argv(&["init"]))?;
        let id = self.open(path)?.id;
        self.enable_versioning(id)
    }
    pub fn enable_versioning(&mut self, id: u64) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        crate::version::enable(&repo.root, &repo.metadata("hooks")?)?;
        crate::codemap::index(&repo.root);
        if let Some(tests) = crate::version::test_command(&repo.root) {
            if optional(&repo.root, &["config", "gitgui.testCommand"])?.is_none() {
                repo.write(
                    &argv(&["config", "gitgui.testCommand", tests]),
                    None,
                    None,
                    None,
                )?;
            }
        }
        repo.info()
    }
    pub fn checkpoints(&mut self, id: u64) -> Result<Vec<Checkpoint>> {
        self.repo(id)?.checkpoint_list()
    }
    pub fn checkpoint(&mut self, id: u64, label: &str) -> Result<Vec<Checkpoint>> {
        let label = label.trim();
        if label.is_empty() || label.len() > 200 || label.contains('\0') {
            return Err("Name the checkpoint (up to 200 characters).".into());
        }
        let repo = self.repo(id)?;
        repo.save_checkpoint(label)?;
        repo.checkpoint_list()
    }
    pub fn restore_checkpoint(&mut self, id: u64, oid: &str, token: &str) -> Result<RepoInfo> {
        valid_oid(oid)?;
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if !repo.checkpoint_list()?.iter().any(|c| c.oid == oid) {
            return Err("That checkpoint no longer exists. Refresh the list.".into());
        }
        repo.save_checkpoint("Before restoring a checkpoint")?;
        repo.write(
            &argv(&[
                "restore",
                &format!("--source={oid}"),
                "--staged",
                "--worktree",
                "--",
                ".",
            ]),
            None,
            None,
            None,
        )?;
        repo.info()
    }
    fn repo(&mut self, id: u64) -> Result<&mut Repository> {
        self.repos
            .iter_mut()
            .find(|repo| repo.id == id)
            .ok_or_else(|| "Repository selection changed. Open or refresh the repository.".into())
    }
    pub fn close_repository(&mut self, id: u64) {
        self.repos.retain(|repo| repo.id != id);
    }
    pub fn status(&mut self, id: u64) -> Result<RepoInfo> {
        self.repo(id)?.info()
    }
    pub fn working_diff(&mut self, id: u64, file_id: &str, staged: bool) -> Result<Preview> {
        let repo = self.repo(id)?;
        let info = repo.info()?;
        let file = info
            .files
            .iter()
            .find(|f| f.id == file_id)
            .ok_or("File changed. Refresh the changes list.")?;
        let path = repo.paths.get(file_id).ok_or("Unknown file")?;
        if file.untracked {
            return untracked_preview(&repo.root, path);
        }
        let mut args = argv(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--submodule=short",
        ]);
        if staged {
            args.push(os("--cached"));
        }
        args.push(os("--"));
        args.push(path.clone());
        if let Some(old_id) = &file.old_id {
            args.push(
                repo.paths
                    .get(old_id)
                    .ok_or("Rename source unavailable")?
                    .clone(),
            );
        }
        preview(&repo.root, &args)
    }
    pub fn stage(
        &mut self,
        id: u64,
        files: &[String],
        unstage: bool,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        if files.is_empty() {
            return Err("Select at least one file".into());
        }
        let mut args = if unstage && info.head.is_none() {
            argv(&["rm", "--cached", "-f"])
        } else if unstage {
            argv(&["restore", "--staged"])
        } else {
            argv(&["add"])
        };
        args.push(os("--"));
        for id in files {
            let file = info
                .files
                .iter()
                .find(|f| &f.id == id)
                .ok_or("Selected file changed. Refresh and review it.")?;
            if file.submodule {
                return Err("Open the submodule repository for changes; staging submodules is outside this release.".into());
            }
            if unstage && (file.index == "." || file.untracked) {
                return Err("This file has no staged changes".into());
            }
            args.push(repo.paths.get(id).ok_or("Unknown file")?.clone());
            if let Some(old_id) = &file.old_id {
                args.push(
                    repo.paths
                        .get(old_id)
                        .ok_or("Rename source unavailable")?
                        .clone(),
                );
            }
        }
        repo.write(&args, None, None, None)?;
        repo.info()
    }
    pub fn commit(
        &mut self,
        id: u64,
        message: &str,
        token: &str,
        detached_ok: bool,
        bump: Option<String>,
        amend: bool,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        if message.trim().is_empty() || message.len() > 128 * 1024 || message.contains('\0') {
            return Err("Enter a commit message (up to 128 KiB, without NUL characters).".into());
        }
        repo.require_normal(&info)?;
        if info.detached && !detached_ok {
            return Err("HEAD is detached. Confirm committing without a branch first.".into());
        }
        let old_head = if amend {
            let head = info
                .head
                .clone()
                .ok_or("There is no commit to amend yet.")?;
            if repo.pushed(&info)? {
                return Err("The last commit was already pushed. Amending it would rewrite shared history; make a new commit instead.".into());
            }
            Some(head)
        } else {
            None
        };
        if !amend && !info.files.iter().any(|f| f.index != "." && !f.untracked) {
            return Err("No staged changes to commit".into());
        }
        if let Some(level) = bump {
            let old = info
                .version
                .ok_or("No version found in package.json, Cargo.toml, or VERSION.")?;
            let new = crate::version::bump(&old, &level)?;
            let mut paths = crate::version::apply(&repo.root, &old, &new)?;
            crate::version::add_changelog(
                &repo.root,
                &new,
                message.lines().next().unwrap_or_default().trim(),
            )?;
            paths.push("CHANGELOG.md".into());
            repo.write(
                &[argv(&["add", "--"]), paths.iter().map(|p| os(p)).collect()].concat(),
                None,
                None,
                None,
            )?;
        }
        // gitgui.amend tells the safeguard hook to compare versions with the parent, not the replaced commit.
        let args = if amend {
            argv(&["-c", "gitgui.amend=true", "commit", "--amend", "-F", "-"])
        } else {
            argv(&["commit", "-F", "-"])
        };
        repo.write(&args, Some(message.as_bytes()), None, None)?;
        if let Some(old) = old_head {
            // Version tags still point at the replaced commit: move them by re-running the tagging hook.
            let tags = read(
                &repo.root,
                &argv(&["tag", "--points-at", &old, "--list", "v*"]),
            )?;
            if !tags.is_empty() {
                for tag in text(&tags).lines() {
                    repo.write(&argv(&["tag", "-d", tag]), None, None, None)?;
                }
                repo.write(
                    &argv(&["hook", "run", "--ignore-missing", "post-commit"]),
                    None,
                    None,
                    None,
                )?;
            }
        }
        repo.info()
    }
    pub fn create_branch(
        &mut self,
        id: u64,
        name: &str,
        oid: Option<String>,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        repo.valid_branch_name(name)?;
        let start = oid
            .or(info.head)
            .ok_or("Create the first commit before creating another branch")?;
        valid_oid(&start)?;
        repo.write(&argv(&["branch", name, &start]), None, None, None)?;
        repo.info()
    }
    pub fn switch_branch(&mut self, id: u64, reference_id: &str, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let name = repo.local_branch(reference_id)?;
        let args = vec![os("switch"), os("--no-guess"), os("--"), name];
        repo.write(&args, None, None, None)?;
        repo.info()
    }
    /// Renames a local branch; its upstream setting moves with it.
    pub fn rename_branch(
        &mut self,
        id: u64,
        reference_id: &str,
        name: &str,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let old = repo.local_branch(reference_id)?;
        repo.valid_branch_name(name)?;
        repo.write(
            &[os("branch"), os("-m"), os("--"), old, os(name)],
            None,
            None,
            None,
        )?;
        repo.info()
    }
    /// Deletes a local branch; without `force`, Git refuses when its commits are not merged anywhere.
    pub fn delete_branch(
        &mut self,
        id: u64,
        reference_id: &str,
        force: bool,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let name = repo.local_branch(reference_id)?;
        if info.branch.as_deref().map(OsStr::new) == Some(name.as_os_str()) {
            return Err(
                "You are on this branch. Switch to another branch before deleting it.".into(),
            );
        }
        let flag = if force { "-D" } else { "-d" };
        repo.write(&[os("branch"), os(flag), os("--"), name], None, None, None)
            .map_err(|e| if e.contains("not fully merged") { format!("This branch has commits that exist nowhere else; deleting it would lose them. {e}") } else { e })?;
        repo.info()
    }
    pub fn fetch(
        &mut self,
        id: u64,
        remote_id: &str,
        progress: Option<Progress>,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.info()?;
        repo.require_normal(&info)?;
        let remote = info
            .remotes
            .iter()
            .find(|r| r.id == remote_id)
            .ok_or("Choose a configured remote")?;
        let args = vec![
            os("fetch"),
            os("--progress"),
            os("--prune"),
            os("--"),
            from_bytes(&decode_hex(&remote.id)?),
        ];
        // The loaded history snapshot stays valid (its tips are commit IDs), so "Load more" keeps working.
        let graph = repo.graph.take();
        repo.write(&args, None, Some(Duration::from_secs(120)), progress)?;
        repo.graph = graph;
        repo.info()
    }
    pub fn pull(&mut self, id: u64, token: &str, progress: Option<Progress>) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if !info.files.is_empty() {
            return Err("Commit or otherwise resolve working changes before pulling. Nothing was stashed or discarded.".into());
        }
        let (remote, merge) = repo.upstream_config()?;
        let mut args = argv(&[
            "-c",
            "pull.rebase=false",
            "-c",
            "rebase.autoStash=false",
            "-c",
            "merge.autoStash=false",
            "pull",
            "--progress",
            "--ff-only",
            "--no-rebase",
            "--no-autostash",
            "--",
        ]);
        args.extend([remote, merge]);
        repo.write(&args, None, Some(Duration::from_secs(120)), progress)?;
        repo.info()
    }
    pub fn push(
        &mut self,
        id: u64,
        remote_id: Option<String>,
        token: &str,
        progress: Option<Progress>,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let branch_ref = optional(&repo.root, &["symbolic-ref", "-q", "HEAD"])?
            .ok_or("Switch to a branch before pushing")?;
        let publish = remote_id.is_some();
        let (remote, target) = if let Some(remote_id) = remote_id {
            let remote = info
                .remotes
                .iter()
                .find(|r| r.id == remote_id)
                .ok_or("Choose a configured remote")?;
            (
                from_bytes(&decode_hex(&remote.id)?),
                from_bytes(&branch_ref),
            )
        } else {
            repo.upstream_config()?
        };
        if !raw(&target).starts_with(b"refs/heads/") || raw(&remote) == b"." {
            return Err("Choose a configured remote to publish this branch".into());
        }
        let mut spec = branch_ref;
        spec.push(b':');
        spec.extend_from_slice(raw(&target));
        let mut mirror_setting = b"remote.".to_vec();
        mirror_setting.extend_from_slice(raw(&remote));
        mirror_setting.extend_from_slice(b".mirror=false");
        let mut args = vec![os("-c"), from_bytes(&mirror_setting)];
        args.extend(argv(&[
            "push",
            "--progress",
            "--porcelain",
            "--no-force",
            "--no-mirror",
            "--no-follow-tags",
            "--recurse-submodules=no",
        ]));
        if publish {
            args.push(os("--set-upstream"));
        }
        args.extend([os("--"), remote, from_bytes(&spec)]);
        repo.write(&args, None, Some(Duration::from_secs(120)), progress)?;
        repo.info()
    }
}

impl Repository {
    fn head(&self) -> Result<Option<String>> {
        optional(&self.root, &["rev-parse", "--verify", "HEAD"]).map(|v| v.map(|v| text(&v)))
    }
    fn metadata(&self, name: &str) -> Result<PathBuf> {
        Ok(self.root.join(from_bytes(line(&read(
            &self.root,
            &argv(&["rev-parse", "--git-path", name]),
        )?))))
    }
    /// Tree of the whole working copy (tracked and untracked, minus ignored files) via a throwaway index.
    fn snapshot(&self) -> Result<String> {
        let temp = self.metadata("gitgui-checkpoint-index")?;
        let index = self.metadata("index")?;
        match fs::copy(&index, &temp) {
            // Keep the index time so Git still re-reads files edited in the same second (racy-git check).
            Ok(_) => fs::metadata(&index)
                .and_then(|m| m.modified())
                .and_then(|time| File::options().write(true).open(&temp)?.set_modified(time))
                .map_err(|e| format!("Cannot prepare the checkpoint: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let _ = fs::remove_file(&temp);
            }
            Err(e) => return Err(format!("Cannot prepare the checkpoint: {e}")),
        }
        let git = |args: &[&str]| -> Result<Vec<u8>> {
            let output = crate::platform::command(GIT)
                .current_dir(&self.root)
                .args(["--no-pager", "-c", "core.fsmonitor=false"])
                .args(args)
                .env("GIT_INDEX_FILE", &temp)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("Could not start Git: {e}"))?;
            if output.status.success() {
                Ok(output.stdout)
            } else {
                Err(text(&output.stderr).trim().to_owned())
            }
        };
        let tree = git(&["add", "-A", "--", "."]).and_then(|_| git(&["write-tree"]));
        let _ = fs::remove_file(&temp);
        Ok(text(line(&tree?)))
    }
    /// Saves a checkpoint unless nothing changed since HEAD or the latest checkpoint.
    fn save_checkpoint(&self, label: &str) -> Result<bool> {
        let tree = self.snapshot()?;
        let list = self.checkpoint_refs()?;
        if list.first().is_some_and(|(_, _, latest)| *latest == tree) {
            return Ok(false);
        }
        let head = self.head()?;
        let base = match &head {
            Some(head) => head.clone(),
            None => text(line(&read(&self.root, &argv(&["mktree"]))?)),
        };
        let summary = summarize(&text(&read(
            &self.root,
            &argv(&["diff", "--numstat", &base, &tree]),
        )?));
        if summary.is_empty() {
            return Ok(false);
        }
        let mut args = argv(&[
            "-c",
            "user.name=GitGUI",
            "-c",
            "user.email=gitgui@localhost",
            "commit-tree",
            &tree,
            "-m",
            label,
            "-m",
            &summary,
        ]);
        if let Some(head) = head {
            args.extend([os("-p"), os(&head)]);
        }
        let oid = text(line(&read(&self.root, &args)?));
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        read(
            &self.root,
            &argv(&["update-ref", &format!("{CHECKPOINTS}/{nanos:020}"), &oid]),
        )?;
        for (name, _, _) in list.iter().skip(CHECKPOINT_LIMIT - 1) {
            read(&self.root, &argv(&["update-ref", "-d", name]))?;
        }
        Ok(true)
    }
    /// (ref name, commit, tree), newest first.
    fn checkpoint_refs(&self) -> Result<Vec<(String, String, String)>> {
        let output = read(
            &self.root,
            &argv(&[
                "for-each-ref",
                "--sort=-refname",
                "--format=%(refname) %(objectname) %(tree)",
                CHECKPOINTS,
            ]),
        )?;
        Ok(text(&output)
            .lines()
            .filter_map(|l| {
                let f: Vec<_> = l.split(' ').collect();
                (f.len() == 3).then(|| (f[0].to_owned(), f[1].to_owned(), f[2].to_owned()))
            })
            .collect())
    }
    fn checkpoint_list(&self) -> Result<Vec<Checkpoint>> {
        let output = read(&self.root, &argv(&["for-each-ref", "--sort=-refname", "--format=%(objectname)%00%(committerdate:unix)%00%(contents:subject)%00%(contents:body)%00", CHECKPOINTS]))?;
        Ok(text(&output)
            .split("\0\n")
            .filter_map(|record| {
                let f: Vec<_> = record.split('\0').collect();
                (f.len() >= 4).then(|| Checkpoint {
                    oid: f[0].to_owned(),
                    timestamp: f[1].parse().unwrap_or(0),
                    label: f[2].to_owned(),
                    summary: f[3].trim().to_owned(),
                })
            })
            .collect())
    }
    fn info(&mut self) -> Result<RepoInfo> {
        let output = read(
            &self.root,
            &argv(&[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
            ]),
        )?;
        let (files, paths) = parse_status(&output)?;
        self.paths = paths;
        let head = self.head()?;
        let branch = optional(&self.root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?
            .map(|b| display(&b));
        let upstream = optional(
            &self.root,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )?
        .map(|v| display(&v));
        let (mut ahead, mut behind) = (0, 0);
        if upstream.is_some() && head.is_some() {
            if let Some(count) = optional(
                &self.root,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            )? {
                let fields: Vec<_> = text(&count).split_whitespace().map(str::to_owned).collect();
                if fields.len() == 2 {
                    ahead = fields[0].parse().unwrap_or(0);
                    behind = fields[1].parse().unwrap_or(0);
                }
            }
        }
        let mut operation = self.in_progress()?.map(str::to_owned);
        if files.iter().any(|f| f.conflicted) {
            operation = Some("unresolved conflicts".into());
        }
        let mut remotes = Vec::new();
        for name in read(&self.root, &argv(&["remote"]))?
            .split(|b| *b == b'\n')
            .filter(|n| !n.is_empty())
        {
            let url = read(
                &self.root,
                &[os("remote"), os("get-url"), os("--"), from_bytes(name)],
            )?;
            remotes.push(RemoteInfo {
                id: hex(name),
                name: display(name),
                url: redact(&text(line(&url))),
            });
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        head.hash(&mut hasher);
        branch.hash(&mut hasher);
        operation.hash(&mut hasher);
        let index = self.metadata("index")?;
        match File::open(index) {
            Ok(file) => {
                let (bytes, clipped) = drain(file, DATA_LIMIT, None).map_err(|e| e.to_string())?;
                if clipped {
                    return Err("Repository index exceeds the supported 16 MiB limit".into());
                }
                bytes.hash(&mut hasher);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        // Branch, tag, and remote-tracking moves change history without touching the index.
        let mut refs_hasher = std::collections::hash_map::DefaultHasher::new();
        read(
            &self.root,
            &argv(&[
                "for-each-ref",
                "--format=%(refname)%00%(objectname)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
            ]),
        )?
        .hash(&mut refs_hasher);
        head.hash(&mut refs_hasher);
        Ok(RepoInfo {
            id: self.id,
            root: text(raw(self.root.as_os_str())),
            detached: branch.is_none() && head.is_some(),
            branch,
            head,
            upstream,
            ahead,
            behind,
            operation,
            remotes,
            files,
            token: format!("{:016x}", hasher.finish()),
            version: crate::version::current(&self.root),
            versioning: crate::version::enabled(&self.metadata("hooks")?),
            refs_token: format!("{:016x}", refs_hasher.finish()),
        })
    }
    fn valid_branch_name(&self, name: &str) -> Result<()> {
        if name.is_empty() || name.starts_with('-') || name.len() > 1024 || name.contains('\0') {
            return Err("Enter a valid branch name".into());
        }
        let valid = read(&self.root, &argv(&["check-ref-format", "--branch", name]))?;
        if line(&valid) != name.as_bytes() {
            return Err("Use an exact branch name, not a checkout abbreviation".into());
        }
        Ok(())
    }
    fn local_branch(&self, reference_id: &str) -> Result<OsString> {
        let refs = self.refs()?;
        let reference = refs
            .iter()
            .find(|r| r.id == reference_id && r.kind == "local")
            .ok_or("Choose an existing local branch")?;
        let raw_ref = decode_hex(&reference.id)?;
        let name = raw_ref
            .strip_prefix(b"refs/heads/")
            .ok_or("Invalid branch")?;
        Ok(from_bytes(name))
    }
    fn in_progress(&self) -> Result<Option<&'static str>> {
        for (name, label) in [
            ("MERGE_HEAD", "merge"),
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
            ("sequencer", "sequencer"),
        ] {
            if self.metadata(name)?.exists() {
                return Ok(Some(label));
            }
        }
        Ok(None)
    }
    fn checked(&mut self, token: &str) -> Result<RepoInfo> {
        let info = self.info()?;
        if info.token != token {
            Err("HEAD or staged changes changed since your last review. Refresh and review them before retrying.".into())
        } else {
            Ok(info)
        }
    }
    /// True when HEAD is already on its upstream, so rewriting it would change shared history.
    fn pushed(&self, info: &RepoInfo) -> Result<bool> {
        Ok(info.upstream.is_some()
            && optional(
                &self.root,
                &["merge-base", "--is-ancestor", "HEAD", "@{upstream}"],
            )?
            .is_some())
    }
    fn require_normal(&self, info: &RepoInfo) -> Result<()> {
        if let Some(operation) = &info.operation {
            Err(format!(
                "Finish the {operation} first: Continue or Abort it in Changes."
            ))
        } else {
            Ok(())
        }
    }
    fn write(
        &mut self,
        args: &[OsString],
        input: Option<&[u8]>,
        timeout: Option<Duration>,
        progress: Option<Progress>,
    ) -> Result<()> {
        self.graph = None;
        let output = execute(&self.root, args, input, DATA_LIMIT, timeout, progress)?;
        if output.ok {
            Ok(())
        } else {
            Err(if output.stderr.trim().is_empty() {
                redact(&text(&output.stdout))
            } else {
                output.stderr.trim().to_owned()
            })
        }
    }
    fn upstream_config(&self) -> Result<(OsString, OsString)> {
        let branch = optional(&self.root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?
            .ok_or("Switch to a branch before syncing")?;
        let mut remote_key = b"branch.".to_vec();
        remote_key.extend_from_slice(&branch);
        remote_key.extend_from_slice(b".remote");
        let mut merge_key = b"branch.".to_vec();
        merge_key.extend_from_slice(&branch);
        merge_key.extend_from_slice(b".merge");
        let remote = read(
            &self.root,
            &[os("config"), os("--get"), from_bytes(&remote_key)],
        )
        .map_err(|_| {
            "This branch has no upstream. Use Push and choose a remote to publish it.".to_owned()
        })?;
        let merge = read(
            &self.root,
            &[os("config"), os("--get"), from_bytes(&merge_key)],
        )?;
        let merge = line(&merge);
        if !merge.starts_with(b"refs/heads/") {
            return Err("The upstream must be a branch".into());
        }
        Ok((from_bytes(line(&remote)), from_bytes(merge)))
    }
}

fn parse_status(data: &[u8]) -> Result<(Vec<FileInfo>, HashMap<String, OsString>)> {
    let fields: Vec<_> = data.split(|b| *b == 0).filter(|r| !r.is_empty()).collect();
    let mut i = 0;
    let mut files = Vec::new();
    let mut paths = HashMap::new();
    while i < fields.len() {
        let record = fields[i];
        i += 1;
        if record[0] == b'#' {
            continue;
        }
        let mut old_path = None;
        let mut old_id = None;
        let (path, index, worktree, untracked, conflicted, submodule) = match record[0] {
            b'?' => (
                record.get(2..).ok_or("Malformed untracked status")?,
                ".".into(),
                "?".into(),
                true,
                false,
                false,
            ),
            b'1' | b'2' | b'u' => {
                let count = match record[0] {
                    b'1' => 9,
                    b'2' => 10,
                    _ => 11,
                };
                let parts: Vec<_> = record.splitn(count, |b| *b == b' ').collect();
                if parts.len() != count || parts[1].len() != 2 {
                    return Err("Malformed Git status record".into());
                }
                if record[0] == b'2' {
                    let old = fields.get(i).ok_or("Missing rename source")?;
                    relative_path(old)?;
                    i += 1;
                    old_path = Some(display(old));
                    old_id = Some(hex(old));
                    paths.insert(hex(old), from_bytes(old));
                }
                (
                    parts[count - 1],
                    text(&parts[1][..1]),
                    text(&parts[1][1..]),
                    false,
                    record[0] == b'u',
                    parts[2].first() == Some(&b'S'),
                )
            }
            b'!' => continue,
            _ => return Err("Unrecognized Git status format".into()),
        };
        relative_path(path)?;
        let id = hex(path);
        paths.insert(id.clone(), from_bytes(path));
        files.push(FileInfo {
            id,
            path: display(path),
            old_path,
            old_id,
            index,
            worktree,
            untracked,
            conflicted,
            submodule,
        });
    }
    Ok((files, paths))
}
