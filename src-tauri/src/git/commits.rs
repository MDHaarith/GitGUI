use super::*;

impl Backend {
    pub fn merge_ref(&mut self, id: u64, reference_id: &str, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if info.detached {
            return Err("Switch to a branch before merging".into());
        }
        let reference = repo
            .refs()?
            .into_iter()
            .find(|r| {
                r.id == reference_id && matches!(r.kind.as_str(), "local" | "remote") && !r.is_head
            })
            .ok_or("Choose another branch to merge")?;
        let name = from_bytes(&decode_hex(&reference.id)?);
        match repo.write(&[os("merge"), os("--no-edit"), name], None, None, None) {
            Ok(()) => repo.info(),
            Err(_error) if repo.in_progress()?.is_some() => repo.info(),
            Err(error) => Err(error),
        }
    }
    pub fn apply_commit(
        &mut self,
        id: u64,
        oid: &str,
        revert: bool,
        token: &str,
    ) -> Result<RepoInfo> {
        valid_oid(oid)?;
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if info.detached {
            return Err("Switch to a branch before applying a commit".into());
        }
        let parents = repo.details(oid, None)?.parents;
        let mut args = argv(&[if revert { "revert" } else { "cherry-pick" }, "--no-edit"]);
        if parents.len() > 1 {
            args.extend(argv(&["-m", "1"]));
        }
        args.push(os(oid));
        match repo.write(&args, None, None, None) {
            Ok(()) => repo.info(),
            Err(_) if repo.in_progress()?.is_some() => repo.info(),
            Err(error) => Err(error),
        }
    }
    pub fn create_tag(
        &mut self,
        id: u64,
        name: &str,
        message: &str,
        oid: &str,
        token: &str,
    ) -> Result<RepoInfo> {
        valid_oid(oid)?;
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if read(
            &repo.root,
            &argv(&["check-ref-format", &format!("refs/tags/{name}")]),
        )
        .is_err()
        {
            return Err("Enter a valid tag name".into());
        }
        let mut args = argv(&["tag"]);
        if !message.is_empty() {
            args.extend([os("-a"), os("-m"), os(message)]);
        }
        args.extend([os("--"), os(name), os(oid)]);
        repo.write(&args, None, None, None)?;
        repo.info()
    }
    pub fn delete_tag(&mut self, id: u64, reference_id: &str, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let reference = repo
            .refs()?
            .into_iter()
            .find(|r| r.id == reference_id && r.kind == "tag")
            .ok_or("Choose an existing tag")?;
        let name = decode_hex(&reference.id)?;
        let name = name.strip_prefix(b"refs/tags/").ok_or("Invalid tag")?;
        repo.write(&[os("tag"), os("-d"), from_bytes(name)], None, None, None)?;
        repo.info()
    }
    pub fn reset_commit(
        &mut self,
        id: u64,
        oid: &str,
        mode: &str,
        token: &str,
    ) -> Result<RepoInfo> {
        valid_oid(oid)?;
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if info.detached {
            return Err("Switch to a branch before resetting".into());
        }
        if !matches!(mode, "soft" | "mixed" | "hard") {
            return Err("Choose Soft, Mixed or Hard reset".into());
        }
        // Published commits the branch holds must survive: the target has to contain the upstream.
        let holds_upstream = info.upstream.is_some()
            && optional(
                &repo.root,
                &["merge-base", "--is-ancestor", "@{upstream}", "HEAD"],
            )?
            .is_some();
        if holds_upstream {
            let keeps_upstream = optional(
                &repo.root,
                &["merge-base", "--is-ancestor", "@{upstream}", oid],
            )?
            .is_some();
            if !keeps_upstream {
                return Err(
                    "This reset would rewrite commits already published to the upstream branch."
                        .into(),
                );
            }
        }
        if mode == "hard" {
            repo.save_checkpoint("Before hard reset")?;
        }
        repo.write(
            &[os("reset"), os(&format!("--{mode}")), os(oid)],
            None,
            None,
            None,
        )?;
        repo.info()
    }
}
