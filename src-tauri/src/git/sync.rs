//! Explicit sync choices and worktree management; ordinary pull/push keep their safe defaults.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SyncRequest {
    Activity,
    Compare {
        a: String,
        b: String,
    },
    Pull {
        mode: String,
        stash: bool,
        token: String,
    },
    Switch {
        reference_id: String,
        stash: bool,
        token: String,
    },
    Push {
        remote_id: Option<String>,
        token: String,
    },
    Lease,
    ForcePush {
        token: String,
    },
    BranchFetch {
        reference_id: String,
        remote_id: String,
        token: String,
    },
    BranchReset {
        reference_id: String,
        remote_id: String,
        token: String,
    },
    Worktrees,
    WorktreeAdd {
        path: String,
        branch: String,
        new_branch: bool,
        token: String,
    },
    WorktreeRemove {
        worktree_id: String,
        confirmed: bool,
        token: String,
    },
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<RepoInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<Vec<BranchActivity>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparison: Option<BranchComparison>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktrees: Option<Vec<WorktreeInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<PushLease>,
}

#[derive(Serialize)]
pub struct BranchActivity {
    pub id: String,
    pub author: String,
    pub timestamp: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchComparison {
    pub only_a: Preview,
    pub only_b: Preview,
    pub diff: Preview,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushLease {
    pub branch: String,
    pub expected: String,
    #[serde(skip)]
    remote: OsString,
    #[serde(skip)]
    target: OsString,
    #[serde(skip)]
    source: String,
    #[serde(skip)]
    head: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub id: String,
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

impl Backend {
    pub fn sync(
        &mut self,
        id: u64,
        request: SyncRequest,
        progress: Option<Progress>,
    ) -> Result<SyncResponse> {
        let mut response = SyncResponse::default();
        // A lease is available only after a normal push was rejected, and is bound to that reviewed HEAD.
        if let SyncRequest::Push { remote_id, token } = request {
            self.sync_leases.remove(&id);
            match self.push(id, remote_id.clone(), &token, progress) {
                Ok(info) => response.info = Some(info),
                Err(error) => {
                    if error.contains("non-fast-forward") || error.contains("fetch first") {
                        let repo = self.repo(id)?;
                        if let Ok(lease) = repo.push_lease(remote_id.as_deref()) {
                            self.sync_leases.insert(id, lease);
                        }
                    }
                    return Err(error);
                }
            }
            return Ok(response);
        }
        if matches!(request, SyncRequest::Lease) {
            response.lease = Some(
                self.sync_leases
                    .get(&id)
                    .ok_or("A normal push must first be rejected as non-fast-forward")?
                    .clone(),
            );
            return Ok(response);
        }
        if let SyncRequest::ForcePush { token } = request {
            let lease = self
                .sync_leases
                .get(&id)
                .ok_or("A normal push must first be rejected as non-fast-forward")?
                .clone();
            let repo = self.repo(id)?;
            let info = repo.checked(&token)?;
            repo.require_normal(&info)?;
            if info.branch.as_deref() != Some(&lease.source)
                || info.head.as_deref() != Some(&lease.head)
            {
                return Err(
                    "The current branch changed. Push normally again before requesting a lease."
                        .into(),
                );
            }
            let current = repo.push_lease_for(lease.remote.clone(), lease.target.clone())?;
            if current.expected != lease.expected {
                return Err("The remote branch changed since the rejected push. Fetch and review before pushing again.".into());
            }
            repo.save_checkpoint("Before force push with lease")?;
            let target = text(raw(&lease.target));
            let setting = format!("remote.{}.mirror=false", text(raw(&lease.remote)));
            repo.write(
                &argv(&[
                    "-c",
                    &setting,
                    "push",
                    "--progress",
                    "--porcelain",
                    "--no-mirror",
                    "--no-follow-tags",
                    "--recurse-submodules=no",
                    &format!("--force-with-lease={target}:{}", lease.expected),
                    "--",
                    &text(raw(&lease.remote)),
                    &format!("refs/heads/{}:{target}", lease.source),
                ]),
                None,
                Some(Duration::from_secs(120)),
                progress,
            )?;
            response.info = Some(repo.info()?);
            self.sync_leases.remove(&id);
            return Ok(response);
        }
        if let SyncRequest::WorktreeRemove { worktree_id, .. } = &request {
            let path = PathBuf::from(from_bytes(&decode_hex(worktree_id)?));
            if let Ok(path) = fs::canonicalize(path) {
                if self
                    .repos
                    .iter()
                    .any(|r| fs::canonicalize(&r.root).ok().as_ref() == Some(&path))
                {
                    return Err("Close this worktree's repository tab before removing it.".into());
                }
            }
        }
        let repo = self.repo(id)?;
        match request {
            SyncRequest::Activity => response.activity = Some(repo.branch_activity()?),
            SyncRequest::Compare { a, b } => {
                let refs = repo.refs()?;
                let tip = |id: &str| {
                    refs.iter()
                        .find(|r| r.id == id && r.kind != "tag")
                        .map(|r| r.target.clone())
                        .ok_or("Choose an existing branch")
                };
                let (a, b) = (tip(&a)?, tip(&b)?);
                let log = |range: &str| {
                    preview(
                        &repo.root,
                        &argv(&["log", "--no-color", "--format=%h %s — %an", range, "--"]),
                    )
                };
                response.comparison = Some(BranchComparison {
                    only_a: log(&format!("{b}..{a}"))?,
                    only_b: log(&format!("{a}..{b}"))?,
                    diff: preview(
                        &repo.root,
                        &argv(&[
                            "diff",
                            "--no-ext-diff",
                            "--no-textconv",
                            "--no-color",
                            "--find-renames",
                            "--submodule=short",
                            &format!("{a}...{b}"),
                            "--",
                        ]),
                    )?,
                });
            }
            SyncRequest::Worktrees => response.worktrees = Some(repo.worktrees()?),
            SyncRequest::Pull { mode, stash, token } => {
                let info = repo.checked(&token)?;
                repo.require_normal(&info)?;
                if !["ff", "merge", "rebase"].contains(&mode.as_str()) {
                    return Err("Choose fast-forward, merge or rebase".into());
                }
                if !stash && !info.files.is_empty() {
                    return Err("Working changes block pull. Use Stash & retry.".into());
                }
                if mode != "ff" {
                    repo.save_checkpoint("Before combining diverged branches")?;
                }
                let (remote, merge) = repo.upstream_config()?;
                let mut args = argv(&[
                    "-c",
                    "rebase.autoStash=false",
                    "-c",
                    "merge.autoStash=false",
                    "pull",
                    "--progress",
                    "--no-autostash",
                ]);
                args.extend(argv(match mode.as_str() {
                    "ff" => &["--ff-only", "--no-rebase"],
                    "merge" => &["--ff", "--no-rebase"],
                    _ => &["--ff", "--rebase"],
                }));
                args.extend([os("--"), remote, merge]);
                repo.stash_retry(stash, |repo| {
                    repo.write(&args, None, Some(Duration::from_secs(120)), progress)
                })?;
                response.info = Some(repo.info()?);
            }
            SyncRequest::Switch {
                reference_id,
                stash,
                token,
            } => {
                let info = repo.checked(&token)?;
                repo.require_normal(&info)?;
                let reference = repo
                    .refs()?
                    .into_iter()
                    .find(|r| r.id == reference_id && r.kind != "tag")
                    .ok_or("Choose an existing branch")?;
                let raw_ref = decode_hex(&reference_id)?;
                let (flag, name) = if reference.kind == "remote" {
                    (
                        "--track",
                        from_bytes(
                            raw_ref
                                .strip_prefix(b"refs/remotes/")
                                .ok_or("Invalid remote branch")?,
                        ),
                    )
                } else {
                    ("--no-guess", repo.local_branch(&reference_id)?)
                };
                repo.stash_retry(stash, |repo| {
                    repo.write(
                        &[
                            os("switch"),
                            os("--no-overwrite-ignore"),
                            os(flag),
                            os("--"),
                            name,
                        ],
                        None,
                        None,
                        None,
                    )
                })?;
                response.info = Some(repo.info()?);
            }
            SyncRequest::BranchFetch {
                reference_id,
                remote_id,
                token,
            } => {
                let info = repo.checked(&token)?;
                repo.require_normal(&info)?;
                let branch = repo.local_branch(&reference_id)?;
                repo.branch_available(&branch)?;
                let remote = repo.configured_remote(&remote_id)?;
                let mut spec = b"refs/heads/".to_vec();
                spec.extend_from_slice(raw(&branch));
                spec.push(b':');
                spec.extend_from_slice(b"refs/heads/");
                spec.extend_from_slice(raw(&branch));
                repo.write(
                    &[
                        os("fetch"),
                        os("--progress"),
                        os("--no-tags"),
                        os("--"),
                        remote,
                        from_bytes(&spec),
                    ],
                    None,
                    Some(Duration::from_secs(120)),
                    progress,
                )?;
                response.info = Some(repo.info()?);
            }
            SyncRequest::BranchReset {
                reference_id,
                remote_id,
                token,
            } => {
                let info = repo.checked(&token)?;
                repo.require_normal(&info)?;
                let branch = repo.local_branch(&reference_id)?;
                let current = info.branch.as_deref().map(OsStr::new) == Some(branch.as_os_str());
                if !current {
                    repo.branch_available(&branch)?;
                }
                let remote = repo.configured_remote(&remote_id)?;
                let old = repo
                    .refs()?
                    .into_iter()
                    .find(|r| r.id == reference_id)
                    .ok_or("Branch disappeared")?
                    .target;
                repo.write(
                    &[
                        os("fetch"),
                        os("--progress"),
                        os("--no-tags"),
                        os("--"),
                        remote,
                        from_bytes(&decode_hex(&reference_id)?),
                    ],
                    None,
                    Some(Duration::from_secs(120)),
                    progress,
                )?;
                let target = text(line(&read(
                    &repo.root,
                    &argv(&["rev-parse", "--verify", "FETCH_HEAD^{commit}"]),
                )?));
                valid_oid(&target)?;
                repo.save_checkpoint("Before reset to remote")?;
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos();
                read(
                    &repo.root,
                    &argv(&[
                        "update-ref",
                        &format!("refs/gitgui/branch-resets/{stamp}"),
                        &old,
                    ]),
                )?;
                if current {
                    let ignored = read(
                        &repo.root,
                        &argv(&[
                            "ls-files",
                            "--others",
                            "--ignored",
                            "--exclude-standard",
                            "-z",
                        ]),
                    )?;
                    let tracked = read(
                        &repo.root,
                        &argv(&["ls-tree", "-r", "--name-only", "-z", &target]),
                    )?;
                    for path in ignored.split(|b| *b == 0).filter(|p| !p.is_empty()) {
                        if tracked.split(|b| *b == 0).any(|p| {
                            p == path
                                || p.strip_prefix(path)
                                    .is_some_and(|rest| rest.starts_with(b"/"))
                                || path
                                    .strip_prefix(p)
                                    .is_some_and(|rest| !p.is_empty() && rest.starts_with(b"/"))
                        }) {
                            return Err("Ignored files would be overwritten by this reset. Move them to a safe folder before retrying.".into());
                        }
                    }
                    repo.write(&argv(&["reset", "--hard", &target]), None, None, None)?;
                } else {
                    repo.write(
                        &[
                            os("update-ref"),
                            from_bytes(&decode_hex(&reference_id)?),
                            os(&target),
                            os(&old),
                        ],
                        None,
                        None,
                        None,
                    )?;
                }
                response.info = Some(repo.info()?);
            }
            SyncRequest::WorktreeAdd {
                path,
                branch,
                new_branch,
                token,
            } => {
                let info = repo.checked(&token)?;
                repo.require_normal(&info)?;
                repo.valid_branch_name(&branch)?;
                let path = PathBuf::from(path);
                if !path.is_absolute()
                    || path.parent().is_none()
                    || path.as_os_str().is_empty()
                    || raw(path.as_os_str()).contains(&0)
                {
                    return Err("Choose an absolute worktree folder".into());
                }
                if path.exists()
                    && (!path.is_dir()
                        || fs::read_dir(&path)
                            .map_err(|e| e.to_string())?
                            .next()
                            .is_some())
                {
                    return Err("Choose a new or empty folder".into());
                }
                let mut args = argv(&["worktree", "add"]);
                if new_branch {
                    args.extend([os("-b"), os(&branch)]);
                } else {
                    let reference = repo
                        .refs()?
                        .into_iter()
                        .find(|r| r.kind == "local" && r.name == branch)
                        .ok_or("Choose an existing local branch")?;
                    repo.local_branch(&reference.id)?;
                }
                args.extend([
                    os("--"),
                    path.into_os_string(),
                    os(if new_branch { "HEAD" } else { &branch }),
                ]);
                repo.write(&args, None, Some(Duration::from_secs(120)), progress)?;
                response.info = Some(repo.info()?);
                response.worktrees = Some(repo.worktrees()?);
            }
            SyncRequest::WorktreeRemove {
                worktree_id,
                confirmed,
                token,
            } => {
                let info = repo.checked(&token)?;
                repo.require_normal(&info)?;
                let worktree = repo
                    .worktrees()?
                    .into_iter()
                    .find(|w| w.id == worktree_id)
                    .ok_or("Choose a registered worktree")?;
                if worktree.bare || worktree.locked || worktree.prunable {
                    return Err("Cannot remove a bare, locked or missing worktree".into());
                }
                let path = PathBuf::from(from_bytes(&decode_hex(&worktree.id)?));
                let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
                if canonical == fs::canonicalize(&repo.root).map_err(|e| e.to_string())?
                    || !canonical.join(".git").is_file()
                {
                    return Err("Cannot remove the current or main worktree".into());
                }
                let mut other = Repository {
                    id: 0,
                    root: canonical,
                    paths: HashMap::new(),
                    graph: None,
                    graph_sequence: 0,
                    undo: None,
                };
                let other_info = other.info()?;
                other.require_normal(&other_info)?;
                let dirty = !read(
                    &other.root,
                    &argv(&[
                        "status",
                        "--porcelain",
                        "--untracked-files=all",
                        "--ignored",
                    ]),
                )?
                .is_empty();
                if dirty && !confirmed {
                    return Err("This worktree is dirty. Confirm removal to save a checkpoint and stash all files first.".into());
                }
                let common = |root: &Path| -> Result<PathBuf> {
                    let value = read(
                        root,
                        &argv(&["rev-parse", "--path-format=absolute", "--git-common-dir"]),
                    )?;
                    fs::canonicalize(PathBuf::from(from_bytes(line(&value))))
                        .map_err(|e| e.to_string())
                };
                if common(&other.root)? != common(&repo.root)? {
                    return Err("The worktree folder now belongs to another repository. Refresh before retrying.".into());
                }
                other.save_checkpoint("Before removing worktree")?;
                if let Some(head) = other_info.head {
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|e| e.to_string())?
                        .as_nanos();
                    read(
                        &repo.root,
                        &argv(&[
                            "update-ref",
                            &format!("refs/gitgui/removed-worktrees/{stamp}"),
                            &head,
                        ]),
                    )?;
                }
                if dirty {
                    other.write(
                        &argv(&[
                            "stash",
                            "push",
                            "--all",
                            "-m",
                            "GitGUI: before removing worktree",
                            "--",
                            ".",
                        ]),
                        None,
                        None,
                        None,
                    )?;
                }
                // Git still refuses submodules, locks and a worktree made dirty concurrently.
                repo.write(
                    &[
                        os("worktree"),
                        os("remove"),
                        os("--"),
                        path.into_os_string(),
                    ],
                    None,
                    Some(Duration::from_secs(120)),
                    progress,
                )?;
                response.info = Some(repo.info()?);
                response.worktrees = Some(repo.worktrees()?);
            }
            SyncRequest::Push { .. } | SyncRequest::Lease | SyncRequest::ForcePush { .. } => {
                unreachable!()
            }
        }
        Ok(response)
    }
}

impl Repository {
    fn configured_remote(&mut self, remote_id: &str) -> Result<OsString> {
        self.info()?
            .remotes
            .iter()
            .find(|r| r.id == remote_id)
            .ok_or("Choose a configured remote")?;
        Ok(from_bytes(&decode_hex(remote_id)?))
    }
    fn branch_available(&self, branch: &OsStr) -> Result<()> {
        let full = format!("refs/heads/{}", text(raw(branch)));
        if self
            .worktrees()?
            .iter()
            .any(|w| w.branch.as_deref() == Some(&full))
        {
            return Err(
                "This branch is checked out in a worktree. Open that worktree to update it.".into(),
            );
        }
        Ok(())
    }
    fn branch_activity(&self) -> Result<Vec<BranchActivity>> {
        let output = read(
            &self.root,
            &argv(&[
                "for-each-ref",
                "--format=%(refname)%00%(authorname)%00%(committerdate:unix)",
                "refs/heads",
                "refs/remotes",
            ]),
        )?;
        output
            .split(|b| *b == b'\n')
            .filter(|r| !r.is_empty())
            .map(|row| {
                let f: Vec<_> = row.split(|b| *b == 0).collect();
                if f.len() != 3 {
                    return Err("Malformed branch activity".into());
                }
                Ok(BranchActivity {
                    id: hex(f[0]),
                    author: display(f[1]),
                    timestamp: text(f[2]).parse().map_err(|_| "Invalid branch date")?,
                })
            })
            .collect()
    }
    fn stash_retry(
        &mut self,
        stash: bool,
        action: impl FnOnce(&mut Self) -> Result<()>,
    ) -> Result<()> {
        let info = self.info()?;
        let saved = if stash && !info.files.is_empty() {
            if info.files.iter().any(|f| f.submodule) {
                return Err("Commit or stash changes inside submodules before retrying.".into());
            }
            let previous = optional(&self.root, &["rev-parse", "--verify", "refs/stash"])?;
            self.save_checkpoint("Before stash & retry")?;
            self.write(
                &argv(&[
                    "stash",
                    "push",
                    "--include-untracked",
                    "-m",
                    "GitGUI: stash & retry",
                    "--",
                    ".",
                ]),
                None,
                None,
                None,
            )?;
            let saved = read(&self.root, &argv(&["rev-parse", "refs/stash"]))?;
            if previous.as_deref() == Some(line(&saved)) || !self.info()?.files.is_empty() {
                return Err("Git could not stash all working changes. Review your files and Stashes before retrying.".into());
            }
            Some(text(line(&saved)))
        } else {
            None
        };
        let result = action(self);
        if let Some(oid) = saved {
            if self.in_progress()?.is_some() {
                return Err(format!("{}\nYour changes remain in stash {oid}. Finish or abort the Git operation, then bring them back from Stashes.", result.err().unwrap_or_else(|| "Git operation needs attention.".into())));
            }
            let entries = read(&self.root, &argv(&["stash", "list", "--format=%H"]))?;
            let index = text(&entries)
                .lines()
                .position(|line| line == oid)
                .ok_or("The retry stash moved. Restore it from Stashes.")?;
            if let Err(error) = self.write(
                &argv(&["stash", "pop", "--index", &format!("stash@{{{index}}}")]),
                None,
                None,
                None,
            ) {
                return Err(format!("{}\nStash pop could not restore all changes; stash {oid} was kept. Resolve conflicts in Changes, then review Stashes.\n{error}", result.err().unwrap_or_else(|| "Operation completed.".into())));
            }
        }
        result
    }
    fn push_lease(&mut self, remote_id: Option<&str>) -> Result<PushLease> {
        let (remote, target) = if let Some(id) = remote_id {
            (
                self.configured_remote(id)?,
                from_bytes(
                    &optional(&self.root, &["symbolic-ref", "-q", "HEAD"])?
                        .ok_or("Switch to a branch")?,
                ),
            )
        } else {
            self.upstream_config()?
        };
        self.push_lease_for(remote, target)
    }
    fn push_lease_for(&mut self, remote: OsString, target: OsString) -> Result<PushLease> {
        if raw(&remote) == b"."
            || !self
                .info()?
                .remotes
                .iter()
                .any(|r| decode_hex(&r.id).ok().as_deref() == Some(raw(&remote)))
            || !raw(&target).starts_with(b"refs/heads/")
        {
            return Err("Choose a configured remote branch".into());
        }
        let output = read(
            &self.root,
            &[
                os("ls-remote"),
                os("--refs"),
                os("--"),
                remote.clone(),
                target.clone(),
            ],
        )?;
        let expected = text(&output)
            .split_whitespace()
            .next()
            .ok_or("Remote branch disappeared")?
            .to_owned();
        valid_oid(&expected)?;
        Ok(PushLease {
            branch: text(raw(&target))
                .trim_start_matches("refs/heads/")
                .to_owned(),
            expected,
            remote,
            target,
            source: self.info()?.branch.ok_or("Switch to a branch")?,
            head: self.head()?.ok_or("Create a commit first")?,
        })
    }
    fn worktrees(&self) -> Result<Vec<WorktreeInfo>> {
        let output = read(
            &self.root,
            &argv(&["worktree", "list", "--porcelain", "-z"]),
        )?;
        let mut list = Vec::new();
        let mut current: Option<WorktreeInfo> = None;
        for field in output.split(|b| *b == 0) {
            if let Some(path) = field.strip_prefix(b"worktree ") {
                if let Some(item) = current.take() {
                    list.push(item);
                }
                current = Some(WorktreeInfo {
                    id: hex(path),
                    path: text(path),
                    branch: None,
                    head: String::new(),
                    bare: false,
                    locked: false,
                    prunable: false,
                });
            } else if let Some(item) = &mut current {
                if let Some(head) = field.strip_prefix(b"HEAD ") {
                    item.head = text(head);
                } else if let Some(branch) = field.strip_prefix(b"branch ") {
                    item.branch = Some(text(branch));
                } else if field == b"bare" {
                    item.bare = true;
                } else if field.starts_with(b"locked") {
                    item.locked = true;
                } else if field.starts_with(b"prunable") {
                    item.prunable = true;
                }
            }
        }
        if let Some(item) = current {
            list.push(item);
        }
        Ok(list)
    }
}
