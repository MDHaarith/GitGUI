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
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;
pub type Progress = Arc<dyn Fn(String) + Send + Sync>;
const DATA_LIMIT: usize = 16 * 1024 * 1024;
const PREVIEW_LIMIT: usize = 2 * 1024 * 1024;

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

struct Output {
    stdout: Vec<u8>,
    stderr: String,
    ok: bool,
    truncated: bool,
}
fn os(s: &str) -> OsString {
    OsString::from(s)
}
fn argv(s: &[&str]) -> Vec<OsString> {
    s.iter().map(|v| os(v)).collect()
}
fn raw(s: &OsStr) -> &[u8] {
    #[cfg(unix)]
    {
        s.as_bytes()
    }
    #[cfg(not(unix))]
    {
        s.as_encoded_bytes()
    }
}
fn from_bytes(s: &[u8]) -> OsString {
    #[cfg(unix)]
    {
        OsString::from_vec(s.to_vec())
    }
    #[cfg(not(unix))]
    {
        OsString::from(String::from_utf8_lossy(s).into_owned())
    }
}
fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
fn line(data: &[u8]) -> &[u8] {
    data.strip_suffix(b"\n").unwrap_or(data)
}
fn text(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}
fn display(data: &[u8]) -> String {
    if let Ok(value) = std::str::from_utf8(data) {
        value
            .chars()
            .flat_map(|c| {
                if c.is_control() {
                    c.escape_default().collect::<Vec<_>>()
                } else {
                    vec![c]
                }
            })
            .collect()
    } else {
        data.iter()
            .map(|b| {
                if b.is_ascii_graphic() || *b == b' ' {
                    char::from(*b).to_string()
                } else {
                    format!("\\x{b:02x}")
                }
            })
            .collect()
    }
}
pub fn redact(message: &str) -> String {
    let mut out = message.to_owned();
    let mut offset = 0;
    while let Some(found) = out[offset..].find("://") {
        let start = offset + found + 3;
        let end = out[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '\'' | '"'))
            .map_or(out.len(), |i| start + i);
        if let Some(at) = out[start..end].rfind('@') {
            out.replace_range(start..start + at, "[redacted]");
            offset = start + 10;
        } else {
            offset = end;
        }
        if offset >= out.len() {
            break;
        }
    }
    out
}
fn report_progress(progress: &Option<Progress>, line: &[u8], sent: &mut usize) {
    if let Some(progress) = progress {
        let message = display(redact(&text(line)).as_bytes());
        if !message.trim().is_empty() && *sent + message.len() <= 64 * 1024 {
            *sent += message.len();
            progress(message);
        }
    }
}
fn drain(
    mut reader: impl Read,
    limit: usize,
    progress: Option<Progress>,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut saved = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    let mut pending = Vec::new();
    let mut oversized = false;
    let mut sent = 0;
    loop {
        match reader.read(&mut buffer)? {
            0 => break,
            n => {
                let keep = n.min(limit.saturating_sub(saved.len()));
                saved.extend_from_slice(&buffer[..keep]);
                truncated |= keep < n;
                if progress.is_some() && sent < 64 * 1024 {
                    for &byte in &buffer[..n] {
                        if matches!(byte, b'\r' | b'\n') {
                            if !oversized {
                                report_progress(&progress, &pending, &mut sent);
                            }
                            pending.clear();
                            oversized = false;
                        } else if pending.len() < 4096 {
                            pending.push(byte);
                        } else {
                            // Drop oversized lines entirely so truncated credentials cannot be exposed.
                            oversized = true;
                        }
                    }
                }
            }
        }
    }
    if !oversized {
        report_progress(&progress, &pending, &mut sent);
    }
    Ok((saved, truncated))
}
fn execute(
    root: &Path,
    args: &[OsString],
    input: Option<&[u8]>,
    limit: usize,
    timeout: Option<Duration>,
    progress: Option<Progress>,
) -> Result<Output> {
    let mut command = Command::new(if cfg!(target_os = "linux") {
        "/usr/bin/git"
    } else {
        "git"
    });
    command
        .current_dir(root)
        .args([
            "--no-pager",
            "--no-replace-objects",
            "--literal-pathspecs",
            "-c",
            "color.ui=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "log.showSignature=false",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for variable in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_TRACE",
        "GIT_TRACE_CURL",
        "GIT_CURL_VERBOSE",
        "GIT_TRACE_PACKET",
    ] {
        command.env_remove(variable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Git: {e}. Install Git and ensure it is on PATH."))?;
    let stdout = child.stdout.take().ok_or("Git stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Git stderr unavailable")?;
    let out_reader = thread::spawn(move || drain(stdout, limit, None));
    let err_reader = thread::spawn(move || drain(stderr, 64 * 1024, progress));
    if let Some(data) = input {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(data);
        }
    }
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if timeout.is_some_and(|duration| start.elapsed() > duration) {
            timed_out = true;
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            break child.wait().map_err(|e| e.to_string())?;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let capture_deadline = Instant::now() + Duration::from_secs(2);
    while (!out_reader.is_finished() || !err_reader.is_finished())
        && Instant::now() < capture_deadline
    {
        thread::sleep(Duration::from_millis(10));
    }
    if !out_reader.is_finished() || !err_reader.is_finished() {
        return Err("Git exited but a hook or helper kept its output stream open. The action may have completed; refresh before retrying.".into());
    }
    let (stdout, truncated) = out_reader
        .join()
        .map_err(|_| "Git output reader failed")?
        .map_err(|e| e.to_string())?;
    let (stderr, _) = err_reader
        .join()
        .map_err(|_| "Git error reader failed")?
        .map_err(|e| e.to_string())?;
    if timed_out {
        return Err("Git timed out. Refresh repository state before retrying; check credentials or the remote connection.".into());
    }
    Ok(Output {
        stdout,
        stderr: redact(&text(&stderr)),
        ok: status.success(),
        truncated,
    })
}
fn read(root: &Path, args: &[OsString]) -> Result<Vec<u8>> {
    let output = execute(
        root,
        args,
        None,
        DATA_LIMIT,
        Some(Duration::from_secs(30)),
        None,
    )?;
    if !output.ok {
        return Err(if output.stderr.trim().is_empty() {
            "Git command failed".into()
        } else {
            output.stderr.trim().to_owned()
        });
    }
    if output.truncated {
        return Err("Git output exceeds the supported limit. Narrow the history scope or reduce the file list.".into());
    }
    Ok(output.stdout)
}
fn optional(root: &Path, args: &[&str]) -> Result<Option<Vec<u8>>> {
    let output = execute(
        root,
        &argv(args),
        None,
        DATA_LIMIT,
        Some(Duration::from_secs(30)),
        None,
    )?;
    if output.truncated {
        return Err("Git output exceeds the supported limit".into());
    }
    Ok(output.ok.then(|| line(&output.stdout).to_vec()))
}
fn valid_oid(oid: &str) -> Result<()> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Invalid commit object ID".into())
    }
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
    repo: Option<Repository>,
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
        self.sequence += 1;
        let mut repository = Repository {
            id: self.sequence,
            root,
            paths: HashMap::new(),
            graph: None,
            graph_sequence: 0,
        };
        let info = repository.info()?;
        self.repo = Some(repository);
        Ok(info)
    }
    fn repo(&mut self, id: u64) -> Result<&mut Repository> {
        self.repo
            .as_mut()
            .filter(|repo| repo.id == id)
            .ok_or_else(|| "Repository selection changed. Open or refresh the repository.".into())
    }
    pub fn status(&mut self, id: u64) -> Result<RepoInfo> {
        self.repo(id)?.info()
    }
    pub fn graph(
        &mut self,
        id: u64,
        scope: Option<String>,
        limit: u32,
        graph_id: Option<u64>,
    ) -> Result<GraphPage> {
        let repo = self.repo(id)?;
        let limit = limit.clamp(1, 10_000);
        if let Some(graph_id) = graph_id {
            if !repo
                .graph
                .as_ref()
                .is_some_and(|g| g.id == graph_id && g.scope == scope)
            {
                return Err("History changed. Refresh before loading more commits.".into());
            }
        } else {
            let refs = repo.refs()?;
            let head = repo.head()?;
            let mut tips = Vec::new();
            if let Some(scope) = &scope {
                tips.push(
                    refs.iter()
                        .find(|r| &r.id == scope)
                        .ok_or("Unknown history scope")?
                        .target
                        .clone(),
                );
            } else {
                if let Some(head) = &head {
                    tips.push(head.clone());
                }
                for reference in &refs {
                    if !tips.contains(&reference.target) {
                        tips.push(reference.target.clone());
                    }
                }
            }
            repo.graph_sequence += 1;
            repo.graph = Some(GraphCache {
                id: repo.graph_sequence,
                scope: scope.clone(),
                tips,
                refs,
                head,
            });
        }
        let cache = repo.graph.as_ref().ok_or("History not initialized")?;
        let mut commits = Vec::new();
        if !cache.tips.is_empty() {
            let mut args = argv(&[
                "log",
                "--topo-order",
                "--encoding=UTF-8",
                "--format=%H%x00%h%x00%P%x00%an%x00%at%x00%s%x00",
                &format!("--max-count={}", limit + 1),
            ]);
            args.extend(cache.tips.iter().map(|s| os(s)));
            args.push(os("--"));
            let shallow = repo.shallow()?;
            let output = read(&repo.root, &args)?;
            for record in output.split(|b| *b == b'\n').filter(|r| !r.is_empty()) {
                let fields: Vec<_> = record.split(|b| *b == 0).collect();
                if fields.len() != 7 {
                    return Err("Malformed Git history output".into());
                }
                let oid = text(fields[0]);
                valid_oid(&oid)?;
                commits.push(Commit {
                    shallow: shallow.contains(&oid),
                    oid,
                    short_oid: text(fields[1]),
                    parents: text(fields[2])
                        .split_whitespace()
                        .map(str::to_owned)
                        .collect(),
                    author: display(fields[3]),
                    timestamp: text(fields[4])
                        .parse()
                        .map_err(|_| "Invalid commit timestamp")?,
                    subject: display(fields[5]),
                });
            }
        }
        let has_more = commits.len() > limit as usize;
        commits.truncate(limit as usize);
        Ok(GraphPage {
            graph_id: cache.id,
            commits,
            refs: cache.refs.clone(),
            head: cache.head.clone(),
            has_more,
        })
    }
    pub fn commit_details(
        &mut self,
        id: u64,
        oid: &str,
        parent: Option<String>,
    ) -> Result<CommitDetails> {
        self.repo(id)?.details(oid, parent)
    }
    pub fn commit_diff(
        &mut self,
        id: u64,
        oid: &str,
        parent: Option<String>,
        file_id: Option<String>,
    ) -> Result<Preview> {
        let repo = self.repo(id)?;
        let details = repo.details(oid, parent)?;
        if details.shallow && details.parents.is_empty() {
            return Ok(Preview { text: "Parent history is unavailable in this shallow clone. Fetch more history to view the diff.".into(), truncated: false, binary: false });
        }
        let mut args = repo.diff_args(oid, details.parent.as_deref(), false);
        args.push(os("--"));
        if let Some(file_id) = file_id {
            let file = details
                .files
                .iter()
                .find(|f| f.id == file_id)
                .ok_or("File is not part of this commit")?;
            let files = repo.commit_paths(oid, details.parent.as_deref())?;
            let path = files
                .get(&file_id)
                .ok_or("File is not part of this commit")?;
            args.push(path.clone());
            if let Some(old_id) = &file.old_id {
                args.push(
                    files
                        .get(old_id)
                        .ok_or("Rename source unavailable")?
                        .clone(),
                );
            }
        }
        preview(&repo.root, &args)
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
        if !info.files.iter().any(|f| f.index != "." && !f.untracked) {
            return Err("No staged changes to commit".into());
        }
        repo.write(
            &argv(&["commit", "-F", "-"]),
            Some(message.as_bytes()),
            None,
            None,
        )?;
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
        if name.is_empty() || name.starts_with('-') || name.len() > 1024 || name.contains('\0') {
            return Err("Enter a valid branch name".into());
        }
        let valid = read(&repo.root, &argv(&["check-ref-format", "--branch", name]))?;
        if line(&valid) != name.as_bytes() {
            return Err("Use an exact branch name, not a checkout abbreviation".into());
        }
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
        let refs = repo.refs()?;
        let reference = refs
            .iter()
            .find(|r| r.id == reference_id && r.kind == "local")
            .ok_or("Choose an existing local branch")?;
        let raw_ref = decode_hex(&reference.id)?;
        let name = raw_ref
            .strip_prefix(b"refs/heads/")
            .ok_or("Invalid branch")?;
        let args = vec![os("switch"), os("--no-guess"), os("--"), from_bytes(name)];
        repo.write(&args, None, None, None)?;
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
            os("--no-prune"),
            os("--"),
            from_bytes(&decode_hex(&remote.id)?),
        ];
        repo.write(&args, None, Some(Duration::from_secs(120)), progress)?;
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
    fn shallow(&self) -> Result<HashSet<String>> {
        let path = self.metadata("shallow")?;
        match fs::read(path) {
            Ok(data) => Ok(text(&data).lines().map(str::to_owned).collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashSet::new()),
            Err(e) => Err(e.to_string()),
        }
    }
    fn refs(&self) -> Result<Vec<RefInfo>> {
        let head_ref = optional(&self.root, &["symbolic-ref", "-q", "HEAD"])?;
        let output = read(&self.root, &argv(&["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(symref)%00", "refs/heads", "refs/remotes", "refs/tags"]))?;
        let mut refs = Vec::new();
        for record in output.split(|b| *b == b'\n').filter(|r| !r.is_empty()) {
            let f: Vec<_> = record.split(|b| *b == 0).collect();
            if f.len() != 7 {
                return Err("Malformed Git refs output".into());
            }
            if !f[5].is_empty() {
                continue;
            }
            let target = if f[3] == b"commit" {
                text(f[1])
            } else if f[4] == b"commit" {
                text(f[2])
            } else if f[3] == b"tag" {
                let mut expression = f[0].to_vec();
                expression.extend_from_slice(b"^{commit}");
                let args = vec![
                    os("rev-parse"),
                    os("--verify"),
                    os("--end-of-options"),
                    from_bytes(&expression),
                ];
                match read(&self.root, &args) {
                    Ok(data) => text(line(&data)),
                    Err(_) => continue,
                }
            } else {
                continue;
            };
            valid_oid(&target)?;
            let (kind, name) = if let Some(n) = f[0].strip_prefix(b"refs/heads/") {
                ("local", n)
            } else if let Some(n) = f[0].strip_prefix(b"refs/remotes/") {
                ("remote", n)
            } else {
                (
                    "tag",
                    f[0].strip_prefix(b"refs/tags/").ok_or("Unknown ref kind")?,
                )
            };
            refs.push(RefInfo {
                id: hex(f[0]),
                name: display(name),
                full_name: display(f[0]),
                kind: kind.into(),
                target,
                is_head: head_ref.as_deref() == Some(f[0]),
            });
        }
        Ok(refs)
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
        let mut operation = None;
        for (name, label) in [
            ("MERGE_HEAD", "merge"),
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
            ("sequencer", "sequencer"),
        ] {
            if self.metadata(name)?.exists() {
                operation = Some(label.into());
                break;
            }
        }
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
            refs_token: format!("{:016x}", refs_hasher.finish()),
        })
    }
    fn checked(&mut self, token: &str) -> Result<RepoInfo> {
        let info = self.info()?;
        if info.token != token {
            Err("HEAD or staged changes changed since your last review. Refresh and review them before retrying.".into())
        } else {
            Ok(info)
        }
    }
    fn require_normal(&self, info: &RepoInfo) -> Result<()> {
        if let Some(operation) = &info.operation {
            Err(format!("Finish the {operation} in your terminal, then refresh. This operation is not completed automatically."))
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
    fn details(&self, oid: &str, chosen: Option<String>) -> Result<CommitDetails> {
        valid_oid(oid)?;
        let output = read(
            &self.root,
            &argv(&[
                "show",
                "-s",
                "--encoding=UTF-8",
                "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%B",
                oid,
            ]),
        )?;
        let f: Vec<_> = output.splitn(6, |b| *b == 0).collect();
        if f.len() != 6 {
            return Err("Malformed commit metadata".into());
        }
        let parents: Vec<String> = text(f[1]).split_whitespace().map(str::to_owned).collect();
        let parent = match chosen {
            Some(parent) => {
                valid_oid(&parent)?;
                if !parents.contains(&parent) {
                    return Err("Selected comparison is not a parent of this commit".into());
                }
                Some(parent)
            }
            None => parents.first().cloned(),
        };
        let shallow = self.shallow()?.contains(oid);
        let files = if shallow && parents.is_empty() {
            Vec::new()
        } else {
            self.changed_files(oid, parent.as_deref())?.0
        };
        Ok(CommitDetails {
            oid: text(f[0]),
            parents,
            author: display(f[2]),
            email: display(f[3]),
            timestamp: text(f[4]).parse().map_err(|_| "Invalid commit date")?,
            message: text(f[5]).trim_end_matches('\n').into(),
            parent,
            files,
            shallow,
        })
    }
    fn diff_args(&self, oid: &str, parent: Option<&str>, names: bool) -> Vec<OsString> {
        let mut args = if let Some(parent) = parent {
            argv(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--find-renames",
                "--submodule=short",
                parent,
                oid,
            ])
        } else {
            argv(&[
                "show",
                "--root",
                "--format=",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--find-renames",
                "--submodule=short",
                oid,
            ])
        };
        if names {
            args.extend(argv(&["--name-status", "-z"]));
        }
        args
    }
    fn changed_files(
        &self,
        oid: &str,
        parent: Option<&str>,
    ) -> Result<(Vec<CommitFile>, HashMap<String, OsString>)> {
        let mut args = self.diff_args(oid, parent, true);
        args.push(os("--"));
        let output = read(&self.root, &args)?;
        let fields: Vec<_> = output
            .split(|b| *b == 0)
            .filter(|v| !v.is_empty())
            .collect();
        let mut i = 0;
        let mut files = Vec::new();
        let mut paths = HashMap::new();
        while i < fields.len() {
            let status = text(fields[i]).trim().to_owned();
            i += 1;
            let mut old_path = None;
            let mut old_id = None;
            if status.starts_with(['R', 'C']) {
                let old = fields.get(i).ok_or("Malformed renamed file")?;
                old_path = Some(display(old));
                old_id = Some(hex(old));
                paths.insert(hex(old), from_bytes(old));
                i += 1;
            }
            let path = fields.get(i).ok_or("Malformed commit file list")?;
            i += 1;
            let id = hex(path);
            paths.insert(id.clone(), from_bytes(path));
            files.push(CommitFile {
                id,
                path: display(path),
                old_path,
                old_id,
                status,
            });
        }
        Ok((files, paths))
    }
    fn commit_paths(&self, oid: &str, parent: Option<&str>) -> Result<HashMap<String, OsString>> {
        Ok(self.changed_files(oid, parent)?.1)
    }
}

fn preview(root: &Path, args: &[OsString]) -> Result<Preview> {
    let output = execute(
        root,
        args,
        None,
        PREVIEW_LIMIT,
        Some(Duration::from_secs(30)),
        None,
    )?;
    if !output.ok {
        return Err(output.stderr.trim().to_owned());
    }
    let binary = output.stdout.contains(&0) || std::str::from_utf8(&output.stdout).is_err();
    Ok(Preview {
        text: if binary {
            "Binary file preview is unavailable.".into()
        } else {
            text(&output.stdout)
        },
        truncated: output.truncated,
        binary,
    })
}
fn decode_hex(id: &str) -> Result<Vec<u8>> {
    if id.len() > 32768 || !id.len().is_multiple_of(2) || !id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid file or ref ID".into());
    }
    (0..id.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&id[i..i + 2], 16).map_err(|_| "Invalid file or ref ID".into()))
        .collect()
}
fn relative_path(path: &[u8]) -> Result<()> {
    let name = from_bytes(path);
    if path.is_empty()
        || path.contains(&0)
        || Path::new(&name)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        Err("Git returned an invalid repository-relative filename".into())
    } else {
        Ok(())
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
fn untracked_preview(root: &Path, path: &OsStr) -> Result<Preview> {
    let path = Path::new(path);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid repository-relative filename".into());
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        let mut directory = File::open(root).map_err(|e| e.to_string())?;
        let components: Vec<_> = path.components().collect();
        for (index, component) in components.iter().enumerate() {
            let name = CString::new(raw(component.as_os_str())).map_err(|_| "Invalid filename")?;
            let last = index == components.len() - 1;
            let flags = libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | if last {
                    libc::O_NONBLOCK
                } else {
                    libc::O_DIRECTORY
                };
            let descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if descriptor < 0 {
                if last && std::io::Error::last_os_error().raw_os_error() == Some(libc::ELOOP) {
                    let mut target = vec![0u8; 4096];
                    let length = unsafe {
                        libc::readlinkat(
                            directory.as_raw_fd(),
                            name.as_ptr(),
                            target.as_mut_ptr().cast(),
                            target.len(),
                        )
                    };
                    if length >= 0 {
                        target.truncate(length as usize);
                        return Ok(Preview {
                            text: format!("Symbolic link → {}", display(&target)),
                            truncated: false,
                            binary: false,
                        });
                    }
                }
                return Err(format!(
                    "Cannot safely preview this file: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let file = unsafe { File::from_raw_fd(descriptor) };
            if last {
                if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                    return Err("Only regular files and symbolic links can be previewed".into());
                }
                let (bytes, truncated) =
                    drain(file, PREVIEW_LIMIT, None).map_err(|e| e.to_string())?;
                let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
                return Ok(Preview {
                    text: if binary {
                        "Binary file preview is unavailable.".into()
                    } else {
                        text(&bytes)
                    },
                    truncated,
                    binary,
                });
            }
            directory = file;
        }
    }
    Err("This platform cannot safely preview this untracked file".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn progress_redacts_complete_lines_across_reads_and_drops_oversized_lines() {
        let input = format!(
            "Receiving objects: 50%\r\n{}\nhttps://user:secret@example.invalid/path\n{}\nfinal\x1b",
            "x".repeat(8140),
            "https://user:".to_owned() + &"password".repeat(2000) + "@example.invalid"
        );
        let messages = Arc::new(Mutex::new(Vec::new()));
        let received = messages.clone();
        let (saved, truncated) = drain(
            input.as_bytes(),
            32,
            Some(Arc::new(move |line| received.lock().unwrap().push(line))),
        )
        .unwrap();
        assert_eq!(saved, input.as_bytes()[..32]);
        assert!(truncated);
        assert_eq!(
            *messages.lock().unwrap(),
            vec![
                "Receiving objects: 50%",
                "https://[redacted]@example.invalid/path",
                "final\\u{1b}"
            ]
        );
    }

    #[test]
    fn progress_is_bounded_while_the_entire_pipe_is_drained() {
        let input = "Receiving objects: 50%\n".repeat(10_000);
        let mut reader = std::io::Cursor::new(input.as_bytes());
        let messages = Arc::new(Mutex::new(Vec::new()));
        let received = messages.clone();
        drain(
            &mut reader,
            0,
            Some(Arc::new(move |line| received.lock().unwrap().push(line))),
        )
        .unwrap();
        assert_eq!(reader.position(), input.len() as u64);
        let messages = messages.lock().unwrap();
        assert!(!messages.is_empty());
        assert!(messages.iter().map(String::len).sum::<usize>() <= 64 * 1024);
    }
}
