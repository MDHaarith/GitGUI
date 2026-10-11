use super::*;

impl Backend {
    pub fn branch_text(&mut self, id: u64, ref_id: &str) -> Result<String> {
        let repo = self.repo(id)?;
        let reference = repo
            .refs()?
            .into_iter()
            .find(|r| r.id == ref_id && r.kind != "tag")
            .ok_or("Choose a branch from the current repository.")?;
        let info = repo.info()?;
        let current = repo
            .refs()?
            .into_iter()
            .find(|r| r.kind == "local" && r.is_head);
        let base_ref = if reference.is_head {
            let tracking = info.upstream.clone();
            let default_ref = tracking
                .as_deref()
                .and_then(|upstream| upstream.split_once('/'))
                .map(|(remote, _)| format!("refs/remotes/{remote}/HEAD"))
                .or_else(|| Some("refs/remotes/origin/HEAD".to_owned()));
            default_ref
                .and_then(|name| {
                    optional(&repo.root, &["symbolic-ref", "-q", &name])
                        .ok()
                        .flatten()
                        .map(|value| text(line(&value)))
                })
                .or(tracking)
        } else {
            current.map(|r| r.full_name)
        }
        .ok_or(
            "No comparison branch is available. Set an upstream or add origin's default branch.",
        )?;
        let base = read(
            &repo.root,
            &argv(&["merge-base", &base_ref, &reference.full_name]),
        )?;
        let base = text(line(&base));
        let diff = read(
            &repo.root,
            &argv(&["diff", "--no-color", &base, &reference.target]),
        )?;
        if diff.is_empty() {
            return Err(
                "This branch has no changes compared with the current branch's base.".into(),
            );
        }
        let log = read(
            &repo.root,
            &argv(&[
                "log",
                "--format=%s",
                &format!("{base}..{}", reference.target),
            ]),
        )?;
        Ok(format!(
            "Commits:\n{}\n\nChanges:\n{}",
            text(&log),
            text(&diff)
        ))
    }

    pub fn pr_base(&mut self, id: u64) -> Result<String> {
        let repo = self.repo(id)?;
        let info = repo.info()?;
        if info.upstream.is_none() || info.ahead != 0 {
            return Err("Push this branch and make sure it has no unpushed commits before creating a pull request.".into());
        }
        let out = Command::new("gh")
            .args([
                "repo",
                "view",
                "--json",
                "defaultBranchRef",
                "--jq",
                ".defaultBranchRef.name",
            ])
            .current_dir(&repo.root)
            .env("GH_PROMPT_DISABLED", "1")
            .env_remove("LD_LIBRARY_PATH")
            .stdin(Stdio::null())
            .output()
            .map_err(|_| {
                "Install GitHub CLI (gh) and sign in with gh auth login to create pull requests."
                    .to_owned()
            })?;
        if !out.status.success() {
            return Err("GitHub CLI could not read this repository. Check gh auth status and confirm the remote is a GitHub repository.".into());
        }
        let base = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if base.is_empty() {
            return Err("Could not find the repository's default branch on GitHub.".into());
        }
        if info.branch.as_deref() == Some(base.as_str()) {
            return Err("The current branch is already the repository's default branch.".into());
        }
        Ok(base)
    }

    pub fn create_pr(&mut self, id: u64, title: &str, body: &str, base: &str) -> Result<String> {
        let repo = self.repo(id)?;
        let info = repo.info()?;
        let branch = info
            .branch
            .as_deref()
            .ok_or("Switch to a local branch before creating a pull request.")?;
        if info.upstream.is_none() || info.ahead != 0 {
            return Err("Push this branch before creating a pull request.".into());
        }
        if title.trim().is_empty() || title.len() > 256 || body.len() > 64_000 {
            return Err("Enter a pull request title and keep its description under 64 KiB.".into());
        }
        if !repo
            .info()?
            .remotes
            .iter()
            .any(|remote| remote.url.contains("github.com:") || remote.url.contains("github.com/"))
        {
            return Err("Add a GitHub remote before creating a pull request.".into());
        }
        if base == branch
            || read(&repo.root, &argv(&["check-ref-format", "--branch", base])).is_err()
        {
            return Err("Choose a valid base branch name.".into());
        }
        let mut child = Command::new("gh")
            .args([
                "pr",
                "create",
                "--title",
                title.trim(),
                "--body-file",
                "-",
                "--base",
                base,
                "--head",
                branch,
            ])
            .current_dir(&repo.root)
            .env("GH_PROMPT_DISABLED", "1")
            .env_remove("LD_LIBRARY_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| {
                "Install GitHub CLI (gh) and sign in with gh auth login to create pull requests."
                    .to_owned()
            })?;
        child
            .stdin
            .take()
            .ok_or("Could not send the pull request description to GitHub CLI.")?
            .write_all(body.as_bytes())
            .map_err(|e| e.to_string())?;
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            let error = redact(&String::from_utf8_lossy(&output.stderr));
            if error.to_lowercase().contains("auth") || error.to_lowercase().contains("not logged")
            {
                return Err(
                    "GitHub CLI is not signed in. Run gh auth login, then try again.".into(),
                );
            }
            return Err(error);
        }
        let url = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !url.starts_with("https://github.com/")
            || url.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err("GitHub CLI returned an invalid pull request URL.".into());
        }
        Ok(url)
    }
}
