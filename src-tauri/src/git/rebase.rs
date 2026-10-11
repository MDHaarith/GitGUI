use super::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub oid: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    pub base: String,
    pub commits: Vec<RebaseCommit>,
}

impl Backend {
    pub fn rebase_plan(&mut self, id: u64, token: &str) -> Result<RebasePlan> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if info.detached {
            return Err("Switch to a branch before cleaning up commits.".into());
        }
        if !info.files.is_empty() {
            return Err(
                "Save, commit, or stash your file changes before cleaning up commits.".into(),
            );
        }
        let base = if info.upstream.is_some() {
            text(line(&read(
                &repo.root,
                &argv(&["rev-parse", "@{upstream}"]),
            )?))
        } else {
            let default = optional(&repo.root, &["symbolic-ref", "refs/remotes/origin/HEAD"])?
                .map(|v| text(line(&v)));
            let default = default
                .filter(|name| name.rsplit('/').next() != info.branch.as_deref())
                .or_else(|| {
                    ["main", "master"]
                        .into_iter()
                        .filter(|name| Some(*name) != info.branch.as_deref())
                        .find(|name| {
                            optional(
                                &repo.root,
                                &[
                                    "show-ref",
                                    "--verify",
                                    "--quiet",
                                    &format!("refs/heads/{name}"),
                                ],
                            )
                            .ok()
                            .flatten()
                            .is_some()
                        })
                        .map(str::to_owned)
                });
            match default {
                Some(name) => text(line(&read(
                    &repo.root,
                    &argv(&["merge-base", &name, "HEAD"]),
                )?)),
                None => {
                    let count: usize = text(line(&read(
                        &repo.root,
                        &argv(&["rev-list", "--count", "HEAD"]),
                    )?))
                    .parse()
                    .unwrap_or(1);
                    let depth = count.saturating_sub(1).min(50);
                    text(line(&read(
                        &repo.root,
                        &argv(&["rev-parse", &format!("HEAD~{depth}")]),
                    )?))
                }
            }
        };
        let rows = read(
            &repo.root,
            &argv(&[
                "rev-list",
                "--reverse",
                &format!("{base}..HEAD"),
                "--parents",
            ]),
        )?;
        if rows
            .split(|b| *b == b'\n')
            .any(|line| line.split(|b| *b == b' ').count() > 2)
        {
            return Err(
                "This range includes a merge commit. Clean it up with Git's merge tools first."
                    .into(),
            );
        }
        let log = read(
            &repo.root,
            &argv(&[
                "log",
                "--reverse",
                "--format=%H%x00%B%x00",
                &format!("{base}..HEAD"),
            ]),
        )?;
        let fields: Vec<_> = log.split(|b| *b == 0).collect();
        let commits = fields
            .chunks_exact(2)
            .filter_map(|pair| {
                let oid = text(pair[0]).trim().to_owned();
                if oid.is_empty() {
                    return None;
                }
                Some(RebaseCommit {
                    oid,
                    message: text(pair[1]).trim_end_matches('\n').to_owned(),
                })
            })
            .collect();
        Ok(RebasePlan { base, commits })
    }

    pub fn clean_commits(
        &mut self,
        id: u64,
        base: &str,
        commits: Vec<RebaseEdit>,
        token: &str,
    ) -> Result<RepoInfo> {
        valid_oid(base)?;
        let plan = self.rebase_plan(id, token)?;
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if info.detached {
            return Err("Switch to a branch before cleaning up commits.".into());
        }
        if !info.files.is_empty() {
            return Err(
                "Save, commit, or stash your file changes before cleaning up commits.".into(),
            );
        }
        let expected: HashSet<_> = plan.commits.iter().map(|c| c.oid.as_str()).collect();
        let got: HashSet<_> = commits.iter().map(|c| c.oid.as_str()).collect();
        if base != plan.base || commits.len() != expected.len() || got != expected {
            return Err("The commit list changed. Close this window and reopen it.".into());
        }
        if commits
            .first()
            .is_some_and(|c| matches!(c.action.as_str(), "squash" | "fixup"))
        {
            return Err("The first commit cannot be combined with an earlier commit.".into());
        }
        for edit in &commits {
            valid_oid(&edit.oid)?;
            if !matches!(
                edit.action.as_str(),
                "pick" | "reword" | "squash" | "fixup" | "drop"
            ) {
                return Err("Choose a valid action for every commit.".into());
            }
            if edit.action == "reword"
                && (edit.message.len() > 128 * 1024
                    || edit.message.trim().is_empty()
                    || edit.message.contains('\0'))
            {
                return Err("Commit messages must be non-empty and under 128 KiB.".into());
            }
        }
        for commit in &plan.commits {
            if !read(
                &repo.root,
                &argv(&[
                    "for-each-ref",
                    "--format=%(refname)",
                    &format!("--contains={}", commit.oid),
                    "refs/remotes/",
                ]),
            )?
            .is_empty()
            {
                return Err("This range contains commits already published to the remote.".into());
            }
        }
        repo.save_checkpoint("Before cleaning up commits")?;
        let dir = std::env::temp_dir();
        let nonce = format!(
            "gitgui-rebase-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let todo_path = dir.join(format!("{nonce}.todo"));
        let mut todo = File::create_new(&todo_path)
            .map_err(|e| format!("Cannot prepare the rebase plan: {e}"))?;
        let mut lines = Vec::new();
        for (n, edit) in commits.iter().enumerate() {
            if edit.action == "reword" {
                // The message file lives in .git so it survives a rebase paused on a conflict.
                let file = repo.metadata(&format!("gitgui-reword-{n}"))?;
                fs::write(&file, &edit.message)
                    .map_err(|e| format!("Cannot prepare the new message: {e}"))?;
                let file = shell_quote(&file);
                lines.push(format!("pick {}", edit.oid));
                lines.push(format!(
                    "exec git -c gitgui.amend=true commit --amend -q -F {file} && rm -f -- {file}"
                ));
            } else {
                lines.push(format!("{} {}", edit.action, edit.oid));
            }
        }
        todo.write_all(lines.join("\n").as_bytes())
            .map_err(|e| e.to_string())?;
        let sequence = format!("cp -- {}", shell_quote(&todo_path));
        let args = vec![
            os("-c"),
            os(&format!("sequence.editor={sequence}")),
            os("-c"),
            os("core.editor=true"),
            os("rebase"),
            os("-i"),
            os(base),
        ];
        let result = repo.write(&args, None, None, None);
        let _ = fs::remove_file(todo_path);
        match result {
            Ok(()) => repo.info(),
            Err(_) if repo.in_progress()?.is_some() => repo.info(),
            Err(e) => Err(e),
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseEdit {
    pub oid: String,
    pub action: String,
    pub message: String,
}

fn shell_quote(path: &Path) -> String {
    shell_quote_str(&path.to_string_lossy())
}

fn shell_quote_str(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
