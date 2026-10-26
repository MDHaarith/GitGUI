use super::*;

impl Backend {
    pub fn amend_rebase_commit(&mut self, id: u64, message: &str, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        if !info.rebase_edit
            || repo.in_progress()? != Some("rebase")
            || info.files.iter().any(|f| f.conflicted)
        {
            return Err("Stop at an Edit action and resolve conflicts before amending.".into());
        }
        if message.trim().is_empty() || message.len() > 128 * 1024 || message.contains('\0') {
            return Err("Enter a commit message (up to 128 KiB, without NUL characters).".into());
        }
        repo.write(
            &argv(&["-c", "gitgui.amend=true", "commit", "--amend", "-F", "-"]),
            Some(message.as_bytes()),
            None,
            None,
        )?;
        repo.info()
    }

    pub fn rebase_plan_from(&mut self, id: u64, oid: &str, token: &str) -> Result<RebasePlan> {
        valid_oid(oid)?;
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if info.detached || !info.files.is_empty() {
            return Err(
                "Switch to a branch and save, commit, or stash changes before rewriting history."
                    .into(),
            );
        }
        read(
            &repo.root,
            &argv(&["merge-base", "--is-ancestor", oid, "HEAD"]),
        )
        .map_err(|_| "Choose a commit on the current branch.".to_owned())?;
        let details = repo.details(oid, None)?;
        if details.shallow {
            return Err("Fetch more history before rewriting this shallow boundary.".into());
        }
        repo.rewrite_plan(details.parent.as_deref().unwrap_or(""))
    }

    pub fn batch_commits(
        &mut self,
        id: u64,
        oids: Vec<String>,
        revert: bool,
        token: &str,
    ) -> Result<RepoInfo> {
        if oids.is_empty()
            || oids.len() > 10000
            || oids.iter().collect::<HashSet<_>>().len() != oids.len()
        {
            return Err("Select between 1 and 10,000 distinct commits.".into());
        }
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if info.detached || !info.files.is_empty() {
            return Err(
                "Switch to a branch and save, commit, or stash changes before applying commits."
                    .into(),
            );
        }
        let mut paths = Vec::new();
        for oid in &oids {
            valid_oid(oid)?;
            let details = repo.details(oid, None)?;
            if details.shallow {
                return Err("Fetch more history before applying a shallow boundary.".into());
            }
            paths.extend(
                repo.commit_paths(oid, details.parent.as_deref())?
                    .into_values(),
            );
        }
        repo.protect_ignored(&paths)?;
        let output = execute(
            &repo.root,
            &argv(&["rev-list", "--topo-order", "--stdin"]),
            Some(oids.join("\n").as_bytes()),
            DATA_LIMIT,
            Some(Duration::from_secs(30)),
            None,
        )?;
        if !output.ok {
            return Err(output.stderr);
        }
        if output.truncated {
            return Err("History exceeds the supported 16 MiB limit.".into());
        }
        let selected: HashSet<_> = oids.iter().map(String::as_str).collect();
        let mut commits: Vec<_> = text(&output.stdout)
            .lines()
            .filter(|oid| selected.contains(oid))
            .map(str::to_owned)
            .collect();
        if !revert {
            commits.reverse();
        }
        repo.save_history_checkpoint(if revert {
            "Before reverting commits"
        } else {
            "Before cherry-picking commits"
        })?;
        let args = argv(&[
            if revert { "revert" } else { "cherry-pick" },
            "--no-edit",
            "-m",
            "1",
            "--no-walk=unsorted",
            "--stdin",
        ]);
        match repo.write(&args, Some(commits.join("\n").as_bytes()), None, None) {
            Ok(()) => repo.info(),
            Err(_) if repo.in_progress()?.is_some() => repo.info(),
            Err(error) => Err(error),
        }
    }

    pub fn compare_commits(&mut self, id: u64, from: &str, to: &str) -> Result<Preview> {
        valid_oid(from)?;
        valid_oid(to)?;
        let repo = self.repo(id)?;
        for oid in [from, to] {
            read(
                &repo.root,
                &argv(&["cat-file", "-e", &format!("{oid}^{{commit}}")]),
            )?;
        }
        let mut args = repo.diff_args(to, Some(from), false);
        args.push(os("--"));
        preview(&repo.root, &args)
    }
}

impl Repository {
    pub(super) fn protect_ignored(&self, paths: &[OsString]) -> Result<()> {
        let ignored = read(
            &self.root,
            &argv(&[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ]),
        )?;
        for path in ignored.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            let path = PathBuf::from(from_bytes(path));
            if paths
                .iter()
                .any(|target| Path::new(target).starts_with(&path) || path.starts_with(target))
            {
                return Err("This action would overwrite an ignored local file or folder. Move it outside the repository before retrying.".into());
            }
        }
        Ok(())
    }

    pub(super) fn save_history_checkpoint(&self, label: &str) -> Result<()> {
        let head = self.head()?.ok_or("There is no history to save yet.")?;
        let tree = text(line(&read(
            &self.root,
            &argv(&["rev-parse", "HEAD^{tree}"]),
        )?));
        let oid = text(line(&read(
            &self.root,
            &argv(&[
                "-c",
                "user.name=GitGUI",
                "-c",
                "user.email=gitgui@localhost",
                "commit-tree",
                &tree,
                "-p",
                &head,
                "-m",
                label,
                "-m",
                "Restore this checkpoint to undo the history change on the current branch.",
            ]),
        )?));
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        read(
            &self.root,
            &argv(&[
                "update-ref",
                &format!("{CHECKPOINTS}/{nanos:020}-history"),
                &oid,
            ]),
        )?;
        for (name, _, _) in self.checkpoint_refs()?.iter().skip(CHECKPOINT_LIMIT) {
            read(&self.root, &argv(&["update-ref", "-d", name]))?;
        }
        Ok(())
    }
}
