use super::*;

impl Backend {
    pub fn reword_commit(
        &mut self,
        id: u64,
        oid: &str,
        message: &str,
        allow_published: bool,
        token: &str,
    ) -> Result<RepoInfo> {
        valid_oid(oid)?;
        if message.trim().is_empty() || message.len() > 128 * 1024 || message.contains('\0') {
            return Err("Enter a commit message (up to 128 KiB, without NUL characters).".into());
        }
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
        let output = read(
            &repo.root,
            &argv(&[
                "rev-list",
                "--reverse",
                "--topo-order",
                "--ancestry-path",
                &format!("{oid}..HEAD"),
            ]),
        )?;
        let mut commits = vec![oid.to_owned()];
        commits.extend(text(&output).lines().map(str::to_owned));
        if commits.len() > 10000 {
            return Err("Rewrite at most 10,000 commits at a time.".into());
        }
        let shallow = repo.shallow()?;
        if commits.iter().any(|oid| shallow.contains(oid)) {
            return Err("Fetch more history before rewriting a shallow boundary.".into());
        }
        repo.require_unpublished(&commits, allow_published)?;
        repo.save_history_checkpoint("Before rewording a commit")?;
        let branch = read(&repo.root, &argv(&["symbolic-ref", "HEAD"]))?;
        let mut rewritten: HashMap<String, String> = HashMap::new();
        for old in &commits {
            let object = read(&repo.root, &argv(&["cat-file", "commit", old]))?;
            let boundary = object
                .windows(2)
                .position(|b| b == b"\n\n")
                .ok_or("Invalid commit headers")?;
            let mut updated = Vec::new();
            let mut skip = false;
            // Replay parent links with the original trees, preserving merge resolutions and authors.
            for header in object[..boundary].split(|b| *b == b'\n') {
                if header.first() != Some(&b' ') {
                    skip = header.starts_with(b"gpgsig ")
                        || header.starts_with(b"gpgsig-sha256 ")
                        || header.starts_with(b"mergetag ")
                        || (old == oid && header.starts_with(b"encoding "));
                }
                if skip {
                    continue;
                }
                if let Some(parent) = header
                    .strip_prefix(b"parent ")
                    .and_then(|p| rewritten.get(&text(p)))
                {
                    updated.extend_from_slice(format!("parent {parent}").as_bytes());
                } else {
                    updated.extend_from_slice(header);
                }
                updated.push(b'\n');
            }
            updated.push(b'\n');
            if old == oid {
                updated.extend_from_slice(message.as_bytes());
                if !message.ends_with('\n') {
                    updated.push(b'\n');
                }
            } else {
                updated.extend_from_slice(&object[boundary + 2..]);
            }
            let output = execute(
                &repo.root,
                &argv(&["hash-object", "-t", "commit", "-w", "--stdin"]),
                Some(&updated),
                DATA_LIMIT,
                Some(Duration::from_secs(30)),
                None,
            )?;
            if !output.ok {
                return Err(output.stderr);
            }
            let new = text(line(&output.stdout));
            valid_oid(&new)?;
            rewritten.insert(old.clone(), new);
        }
        repo.checked(token)?;
        let head = info.head.as_deref().ok_or("No commit to reword")?;
        let new = rewritten
            .get(head)
            .ok_or("The current branch changed. Refresh and try again.")?;
        repo.write(
            &[
                os("update-ref"),
                os("-m"),
                os("reword: commit message"),
                from_bytes(line(&branch)),
                os(new),
                os(head),
            ],
            None,
            None,
            None,
        )?;
        repo.info()
    }
}

impl Repository {
    pub(super) fn require_unpublished(
        &self,
        commits: &[String],
        allow_published: bool,
    ) -> Result<()> {
        if !allow_published {
            for oid in commits {
                if !read(
                    &self.root,
                    &argv(&[
                        "for-each-ref",
                        "--format=%(refname)",
                        &format!("--contains={oid}"),
                        "refs/remotes/",
                    ]),
                )?
                .is_empty()
                {
                    return Err(
                        "This range contains commits already published to the remote.".into(),
                    );
                }
            }
        }
        Ok(())
    }
}
