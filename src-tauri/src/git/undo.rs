use super::*;

#[derive(Clone, PartialEq)]
struct Position {
    head: Option<String>,
    branch: Option<String>,
    branches: HashMap<String, String>,
    version_tags: HashMap<String, String>,
    reflog_tip: Option<String>,
}

#[derive(Clone)]
pub(super) struct Undo {
    label: String,
    before: Position,
    after: Position,
    checkpoint: String,
    index: String,
}

impl Repository {
    fn position(&self) -> Result<Position> {
        let branches = text(&read(
            &self.root,
            &argv(&[
                "for-each-ref",
                "--format=%(refname)%09%(objectname)",
                "refs/heads/",
            ]),
        )?)
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(name, oid)| (name.to_owned(), oid.to_owned()))
        .collect();
        let version_tags = text(&read(
            &self.root,
            &argv(&[
                "for-each-ref",
                "--format=%(refname)%09%(objectname)",
                "refs/tags/v*",
            ]),
        )?)
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(name, oid)| (name.to_owned(), oid.to_owned()))
        .collect();
        Ok(Position {
            head: self.head()?,
            branch: optional(&self.root, &["symbolic-ref", "-q", "HEAD"])?.map(|v| text(&v)),
            branches,
            version_tags,
            reflog_tip: optional(&self.root, &["reflog", "show", "-1", "--format=%H", "HEAD"])?
                .map(|v| text(&v)),
        })
    }

    fn undo_snapshot(&self, label: &str, before: Position) -> Result<Undo> {
        let tree = self.snapshot()?;
        let index = self.snapshot_index(false)?;
        let commit = |tree: &str, parents: &[String]| -> Result<String> {
            let mut args = argv(&[
                "-c",
                "user.name=GitGUI",
                "-c",
                "user.email=gitgui@localhost",
                "commit-tree",
                tree,
                "-m",
                label,
            ]);
            for parent in parents {
                args.extend([os("-p"), os(parent)]);
            }
            Ok(text(line(&read(&self.root, &args)?)))
        };
        let index_commit = commit(&index, &[])?;
        let mut parents: Vec<_> = before.head.iter().cloned().collect();
        parents.push(index_commit);
        let checkpoint = commit(&tree, &parents)?;
        // Pin both trees against GC while this repository tab owns the undo record.
        read(
            &self.root,
            &argv(&[
                "update-ref",
                &format!("refs/gitgui/undo/{}", self.id),
                &checkpoint,
            ]),
        )?;
        Ok(Undo {
            label: label.to_owned(),
            after: before.clone(),
            before,
            checkpoint,
            index,
        })
    }

    fn refuse_published_removal(&self, from: &str, to: Option<&str>) -> Result<()> {
        let mut args = argv(&["rev-list", "--count", from]);
        if let Some(to) = to {
            args.push(os(&format!("^{to}")));
        }
        let removed = read(&self.root, &args)?;
        args.extend(argv(&["--not", "--remotes"]));
        if let Some(upstream) = optional(&self.root, &["rev-parse", "--verify", "@{upstream}"])? {
            args.push(from_bytes(&upstream));
        }
        if removed != read(&self.root, &args)? {
            return Err("Cannot undo: these commits were already pushed. Revert them with a new commit instead.".into());
        }
        Ok(())
    }
}

impl Backend {
    /// App actions and their undo record share the same backend lock.
    pub fn with_undo(
        &mut self,
        id: u64,
        label: &str,
        action: impl FnOnce(&mut Self) -> Result<RepoInfo>,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let continuing = repo.in_progress()?.is_some();
        let pending = if continuing {
            let position = repo.position()?;
            match repo.undo.clone().filter(|undo| undo.after == position) {
                Some(undo) => undo,
                None => return action(self),
            }
        } else {
            let before = repo.position()?;
            repo.undo_snapshot(label, before)?
        };
        let result = action(self);
        let repo = self.repo(id)?;
        let after = repo.position()?;
        // Failed commands can still leave a merge/rebase paused for conflict resolution.
        if result.is_ok() || after != pending.before || repo.in_progress()?.is_some() {
            repo.undo = Some(Undo { after, ..pending });
        } else if let Some(previous) = &repo.undo {
            read(
                &repo.root,
                &argv(&[
                    "update-ref",
                    &format!("refs/gitgui/undo/{}", repo.id),
                    &previous.checkpoint,
                ]),
            )?;
        }
        result
    }

    pub fn undo_label(&mut self, id: u64) -> Result<Option<String>> {
        Ok(self.repo(id)?.undo.as_ref().map(|u| u.label.clone()))
    }

    pub fn undo_action(&mut self, id: u64, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        repo.checked(token)?;
        let undo = repo
            .undo
            .clone()
            .ok_or("No GitGUI action to undo in this repository tab.")?;
        if repo.position()? != undo.after {
            return Err("The repository changed outside this action. Undo is no longer safe; use Time machine or Checkpoints.".into());
        }
        if undo.before.head != undo.after.head {
            if let Some(from) = &undo.after.head {
                repo.refuse_published_removal(from, undo.before.head.as_deref())?;
            }
        }
        let operation = repo.in_progress()?;
        if operation == Some("sequencer") {
            return Err("Finish the multi-commit operation in the terminal before Undo.".into());
        }
        repo.save_checkpoint("Before Undo")?;
        // Match Undo last commit: don't leave auto-created version tags on undone commits.
        for (name, oid) in &undo.after.version_tags {
            if !undo.before.version_tags.contains_key(name) {
                repo.write(&argv(&["update-ref", "-d", name, oid]), None, None, None)?;
            }
        }
        for (name, oid) in &undo.before.version_tags {
            if !undo.after.version_tags.contains_key(name) {
                repo.write(
                    &argv(&["update-ref", name, oid, &"0".repeat(oid.len())]),
                    None,
                    None,
                    None,
                )?;
            }
        }
        if let Some(operation) = operation {
            repo.write(&argv(&[operation, "--abort"]), None, None, None)?;
        }
        // A deleted branch is restored only if its name is still unused.
        for (name, oid) in &undo.before.branches {
            if !undo.after.branches.contains_key(name) {
                repo.write(
                    &argv(&["update-ref", name, oid, &"0".repeat(oid.len())]),
                    None,
                    None,
                    None,
                )?;
            }
        }
        if undo.before.head != undo.after.head {
            if let Some(head) = &undo.before.head {
                repo.write(&argv(&["reset", "--soft", head]), None, None, None)?;
            } else if let (Some(branch), Some(head)) = (&undo.before.branch, &undo.after.head) {
                repo.write(&argv(&["update-ref", "-d", branch, head]), None, None, None)?;
            }
        }
        let branch_only =
            undo.before.head == undo.after.head && undo.before.branches != undo.after.branches;
        if !branch_only {
            repo.write(
                &argv(&[
                    "restore",
                    &format!("--source={}", undo.checkpoint),
                    "--staged",
                    "--worktree",
                    "--",
                    ".",
                ]),
                None,
                None,
                None,
            )?;
            repo.write(&argv(&["read-tree", &undo.index]), None, None, None)?;
        }
        repo.undo = None;
        repo.info()
    }
}
