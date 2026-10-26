//! Everyday actions: stash, clone, checking out remote branches, hunk staging, discarding
//! changes, resolving conflicts block by block, and freeing disk space.
use super::*;

#[derive(Clone, Debug, Serialize)]
pub struct Stash {
    pub index: u32,
    pub timestamp: i64,
    pub message: String,
}

/// An ignored file or folder (build output, dependencies, caches) that can be deleted to free space.
#[derive(Clone, Debug, Serialize)]
pub struct Junk {
    pub id: String,
    pub path: String,
    pub bytes: u64,
}

/// Bytes under `path`, or None when it holds a Git repository; symlinks are not followed.
fn disk_size(path: &Path) -> Option<u64> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_dir() {
        return Some(meta.len());
    }
    let mut total = 0;
    for entry in fs::read_dir(path).ok()?.flatten() {
        // A nested repository has its own history; deleting it could lose commits.
        if entry.file_name() == ".git" {
            return None;
        }
        total += disk_size(&entry.path())?;
    }
    Some(total)
}

/// Ignored top-level entries and their sizes; Git reports wholly ignored folders as one entry.
fn ignored(root: &Path) -> Result<Vec<(Vec<u8>, u64)>> {
    let output = read(
        root,
        &argv(&[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ]),
    )?;
    Ok(output
        .split(|b| *b == 0)
        .map(|p| p.strip_suffix(b"/").unwrap_or(p))
        .filter(|p| relative_path(p).is_ok())
        .filter_map(|p| Some((p.to_vec(), disk_size(&root.join(from_bytes(p)))?)))
        .collect())
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

/// Folder name `git clone` would pick for this URL.
pub fn clone_name(url: &str) -> Option<String> {
    let last = url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()?
        .trim_end_matches(".git");
    let name = last.to_owned();
    (!name.is_empty() && name != "." && name != ".." && !name.starts_with('-')).then_some(name)
}

/// Splits `git diff` output into the file header and its hunks.
pub fn split_hunks(diff: &[u8]) -> (&[u8], Vec<&[u8]>) {
    let mut starts: Vec<usize> = diff
        .windows(4)
        .enumerate()
        .filter(|(i, w)| *w == b"\n@@ " && *i + 1 < diff.len())
        .map(|(i, _)| i + 1)
        .collect();
    if diff.starts_with(b"@@ ") {
        starts.insert(0, 0);
    }
    let Some(&first) = starts.first() else {
        return (diff, Vec::new());
    };
    let mut hunks = Vec::new();
    for (n, &start) in starts.iter().enumerate() {
        hunks.push(&diff[start..starts.get(n + 1).copied().unwrap_or(diff.len())]);
    }
    (&diff[..first], hunks)
}

impl Backend {
    pub fn stashes(&mut self, id: u64) -> Result<Vec<Stash>> {
        let repo = self.repo(id)?;
        let output = read(&repo.root, &argv(&["stash", "list", "--format=%ct%x00%gs"]))?;
        Ok(text(&output)
            .lines()
            .enumerate()
            .filter_map(|(index, row)| {
                let (time, message) = row.split_once('\0')?;
                Some(Stash {
                    index: index as u32,
                    timestamp: time.parse().unwrap_or(0),
                    message: display(message.as_bytes()),
                })
            })
            .collect())
    }
    /// Stash numbers shift when stashes are added or removed; refuse if this one moved.
    pub(super) fn same_stash(&mut self, id: u64, index: u32, message: &str) -> Result<()> {
        if self
            .stashes(id)?
            .get(index as usize)
            .is_some_and(|s| s.message == message)
        {
            Ok(())
        } else {
            Err("The stash list changed. Reopen it and try again.".into())
        }
    }
    pub fn stash_save(&mut self, id: u64, message: &str, token: &str) -> Result<RepoInfo> {
        let message = message.trim();
        if message.len() > 1000 || message.contains('\0') {
            return Err("Keep the stash name under 1000 characters.".into());
        }
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if info.files.is_empty() {
            return Err("There are no changes to put aside.".into());
        }
        let mut args = argv(&["stash", "push", "--include-untracked"]);
        if !message.is_empty() {
            args.extend([os("-m"), os(message)]);
        }
        // Git skips untracked files under --literal-pathspecs unless a pathspec is given.
        args.extend([os("--"), os(".")]);
        repo.write(&args, None, None, None)?;
        repo.info()
    }
    /// Applies a stash; `pop` also removes it when it applied cleanly (Git keeps it on conflicts).
    pub fn stash_apply(
        &mut self,
        id: u64,
        index: u32,
        message: &str,
        pop: bool,
        token: &str,
    ) -> Result<RepoInfo> {
        self.same_stash(id, index, message)?;
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let action = if pop { "pop" } else { "apply" };
        repo.write(
            &argv(&["stash", action, &stash_ref(index)]),
            None,
            None,
            None,
        )?;
        repo.info()
    }
    pub fn stash_drop(
        &mut self,
        id: u64,
        index: u32,
        message: &str,
        token: &str,
    ) -> Result<RepoInfo> {
        self.same_stash(id, index, message)?;
        let repo = self.repo(id)?;
        repo.checked(token)?;
        repo.write(
            &argv(&["stash", "drop", &stash_ref(index)]),
            None,
            None,
            None,
        )?;
        repo.info()
    }

    /// Clones `url` into a new folder inside `parent` and opens it.
    pub fn clone(
        &mut self,
        url: &str,
        parent: &str,
        progress: Option<Progress>,
    ) -> Result<RepoInfo> {
        let url = url.trim();
        if url.is_empty()
            || url.starts_with('-')
            || url.len() > 4096
            || url.chars().any(char::is_control)
        {
            return Err(
                "Enter the repository address, like https://github.com/owner/project.git".into(),
            );
        }
        let name = clone_name(url).ok_or("Cannot tell the folder name from this address.")?;
        let parent =
            fs::canonicalize(parent).map_err(|e| format!("Cannot use this folder: {e}"))?;
        let target = parent.join(&name);
        if target.exists() {
            return Err(format!(
                "{} already exists. Choose another folder.",
                target.display()
            ));
        }
        let output = execute(
            &parent,
            &argv(&["clone", "--progress", "--", url, &name]),
            None,
            DATA_LIMIT,
            Some(Duration::from_secs(30 * 60)),
            progress,
        )?;
        if !output.ok {
            return Err(output.stderr.trim().to_owned());
        }
        self.open(
            target
                .to_str()
                .ok_or("The folder name is not valid UTF-8")?,
        )
    }

    /// Creates a local branch that tracks the chosen remote branch and switches to it.
    pub fn checkout_remote(
        &mut self,
        id: u64,
        reference_id: &str,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let reference = repo
            .refs()?
            .into_iter()
            .find(|r| r.id == reference_id && r.kind == "remote")
            .ok_or("Choose an existing remote branch. Fetch, then try again.")?;
        let raw_ref = decode_hex(&reference.id)?;
        let name = raw_ref
            .strip_prefix(b"refs/remotes/")
            .ok_or("Invalid branch")?;
        let local = name.splitn(2, |b| *b == b'/').nth(1).unwrap_or(name);
        repo.write(
            &[os("switch"), os("--track"), os("--"), from_bytes(name)],
            None,
            None,
            None,
        )
        .map_err(|e| {
            if e.contains("already exists") {
                format!(
                    "A local branch named {} already exists. Switch to it instead.",
                    display(local)
                )
            } else {
                e
            }
        })?;
        repo.info()
    }

    /// Stages (or unstages) one hunk of a file. `header` is the hunk's `@@` line the user saw, so a
    /// file that changed since the preview is refused instead of staging the wrong lines.
    pub fn stage_hunk(
        &mut self,
        id: u64,
        file_id: &str,
        hunk: usize,
        header: &str,
        unstage: bool,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let file = info
            .files
            .iter()
            .find(|f| f.id == file_id)
            .ok_or("File changed. Refresh the changes list.")?;
        if file.untracked || file.submodule || file.conflicted || file.old_id.is_some() {
            return Err("Stage new, renamed, and conflicted files as a whole.".into());
        }
        let path = repo.paths.get(file_id).ok_or("Unknown file")?.clone();
        let mut args = argv(&["diff", "--no-ext-diff", "--no-textconv", "--no-color"]);
        if unstage {
            args.push(os("--cached"));
        }
        args.extend([os("--"), path]);
        let diff = read(&repo.root, &args)?;
        let (head, hunks) = split_hunks(&diff);
        let chosen = hunks
            .get(hunk)
            .filter(|h| {
                line(h.split(|b| *b == b'\n').next().unwrap_or_default()) == header.as_bytes()
            })
            .ok_or("This file changed since you opened it. Review the diff again.")?;
        let patch = [head, chosen].concat();
        let mut apply = argv(&["apply", "--cached", "--recount"]);
        if unstage {
            apply.push(os("--reverse"));
        }
        apply.push(os("-"));
        repo.write(&apply, Some(&patch), None, None)?;
        repo.info()
    }

    /// Throws away unstaged edits and untracked files after saving a checkpoint; staged changes stay.
    pub fn discard(&mut self, id: u64, file_ids: &[String], token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let mut tracked = Vec::new();
        let mut untracked = Vec::new();
        for file_id in file_ids {
            let file = info
                .files
                .iter()
                .find(|f| {
                    &f.id == file_id
                        && !f.conflicted
                        && !f.submodule
                        && (f.untracked || f.worktree != ".")
                })
                .ok_or("Only unstaged changes can be discarded. Refresh and try again.")?;
            let path = repo.paths.get(file_id).ok_or("Unknown file")?.clone();
            relative_path(raw(&path))?;
            if file.untracked {
                untracked.push(path)
            } else {
                tracked.push(path)
            }
        }
        if tracked.is_empty() && untracked.is_empty() {
            return Err("Select at least one file".into());
        }
        repo.save_checkpoint(&match file_ids {
            [_] => "Before discarding a file".to_owned(),
            _ => format!("Before discarding {} files", file_ids.len()),
        })?;
        if !tracked.is_empty() {
            repo.write(
                &[argv(&["restore", "--worktree", "--"]), tracked].concat(),
                None,
                None,
                None,
            )?;
        }
        for path in untracked {
            let full = repo.root.join(&path);
            if fs::symlink_metadata(&full).is_ok_and(|m| m.is_dir()) {
                return Err("Discard files one at a time, not folders.".into());
            }
            if let Err(e) = fs::remove_file(&full) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("Cannot remove {}: {e}", display(raw(&path))));
                }
            }
        }
        repo.info()
    }

    /// Ignored files and folders with their sizes, largest first.
    pub fn junk(&mut self, id: u64) -> Result<Vec<Junk>> {
        let repo = self.repo(id)?;
        let mut list: Vec<Junk> = ignored(&repo.root)?
            .into_iter()
            .map(|(p, bytes)| Junk {
                id: hex(&p),
                path: display(&p),
                bytes,
            })
            .collect();
        list.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        Ok(list)
    }
    /// Permanently deletes chosen ignored entries; only paths Git still reports as ignored are touched.
    pub fn delete_junk(&mut self, id: u64, ids: &[String], token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        repo.checked(token)?;
        let chosen: Vec<Vec<u8>> = ignored(&repo.root)?
            .into_iter()
            .map(|(p, _)| p)
            .filter(|p| ids.contains(&hex(p)))
            .collect();
        if chosen.is_empty() {
            return Err("Select at least one item".into());
        }
        if chosen.len() != ids.len() {
            return Err("The list of ignored files changed. Reopen it and try again.".into());
        }
        for path in chosen {
            let full = repo.root.join(from_bytes(&path));
            let removed = if fs::symlink_metadata(&full).is_ok_and(|m| m.is_dir()) {
                fs::remove_dir_all(&full)
            } else {
                fs::remove_file(&full)
            };
            if let Err(e) = removed {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("Cannot remove {}: {e}", display(&path)));
                }
            }
        }
        repo.info()
    }
    /// Packs Git's own data tighter; unreachable objects younger than two weeks are kept.
    pub fn compact(&mut self, id: u64) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        repo.write(&argv(&["gc", "--quiet"]), None, None, None)?;
        repo.info()
    }

    /// The working-tree text of a conflicted file, markers included.
    pub fn conflict_text(&mut self, id: u64, file_id: &str) -> Result<String> {
        let repo = self.repo(id)?;
        let info = repo.info()?;
        if !info.files.iter().any(|f| f.id == file_id && f.conflicted) {
            return Err("That file has no conflict. Refresh and try again.".into());
        }
        let preview =
            untracked_preview(&repo.root, repo.paths.get(file_id).ok_or("Unknown file")?)?;
        if preview.binary || preview.truncated {
            return Err(
                "This file is binary or too large to resolve here. Use Keep ours or Keep theirs."
                    .into(),
            );
        }
        Ok(preview.text)
    }
    /// Saves the user's resolved text over a conflicted file and marks it resolved.
    pub fn save_resolution(
        &mut self,
        id: u64,
        file_id: &str,
        content: &str,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        if !info.files.iter().any(|f| f.id == file_id && f.conflicted) {
            return Err("That file has no conflict. Refresh and try again.".into());
        }
        if super::merge::has_merge_markers(content.as_bytes()) {
            return Err("Choose a side for every conflict first.".into());
        }
        if content.len() > PREVIEW_LIMIT || content.contains('\0') {
            return Err("The resolution must be text within the 2 MiB limit.".into());
        }
        let path = repo.conflict_path(&info, file_id)?;
        repo.save_checkpoint("Before saving a conflict resolution")?;
        repo.write_merge_result(&path, content)?;
        repo.write(&[os("add"), os("--"), path], None, None, None)?;
        repo.info()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_names_and_hunks() {
        assert_eq!(
            clone_name("https://github.com/a/b.git").as_deref(),
            Some("b")
        );
        assert_eq!(clone_name("git@github.com:a/proj").as_deref(), Some("proj"));
        assert_eq!(clone_name("https://host/x/").as_deref(), Some("x"));
        assert_eq!(clone_name("https://host/.."), None);
        let diff =
            b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n";
        let (head, hunks) = split_hunks(diff);
        assert_eq!(head, b"diff --git a/f b/f\n--- a/f\n+++ b/f\n");
        assert_eq!(
            hunks,
            vec![&b"@@ -1 +1 @@\n-a\n+b\n"[..], &b"@@ -9 +9 @@\n-c\n+d\n"[..]]
        );
        assert!(split_hunks(b"").1.is_empty());
    }
}
