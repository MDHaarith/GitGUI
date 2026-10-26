//! Stage-backed merge previews and sequencer controls.
use super::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeVersions {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub working: String,
    pub rebasing: bool,
    pub token: String,
}

impl Backend {
    pub fn merge_versions(&mut self, id: u64, file_id: &str) -> Result<MergeVersions> {
        let repo = self.repo(id)?;
        let info = repo.info()?;
        let path = repo.conflict_path(&info, file_id)?;
        let mut versions = Vec::new();
        for stage in 1..=3 {
            versions.push(repo.merge_stage(&path, stage)?.map(|(mode, oid)| {
                if !matches!(mode.as_str(), "100644" | "100755") {
                    return Err("Only regular text files can be merged here. Use Accept Yours or Accept Theirs.".into());
                }
                let value = preview(&repo.root, &argv(&["cat-file", "blob", &oid]))?;
                merge_text(value)
            }).transpose()?);
        }
        let working = match fs::symlink_metadata(repo.root.join(&path)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
            Ok(meta) if meta.is_file() => merge_text(untracked_preview(&repo.root, &path)?)?,
            _ => return Err("Only regular text files can be merged here.".into()),
        };
        Ok(MergeVersions {
            base: versions.remove(0),
            ours: versions.remove(0),
            theirs: versions.remove(0),
            working,
            rebasing: repo.in_progress()? == Some("rebase"),
            token: info.token,
        })
    }

    pub fn save_merge_resolution(
        &mut self,
        id: u64,
        file_id: &str,
        content: &str,
        original: &str,
        token: &str,
    ) -> Result<RepoInfo> {
        let versions = self.merge_versions(id, file_id)?;
        if versions.working != original {
            return Err("The working file changed while the merge editor was open. Reopen it and review the new edits.".into());
        }
        self.save_resolution(id, file_id, content, token)
    }

    pub fn skip_operation(&mut self, id: u64, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        repo.checked(token)?;
        let operation = repo.in_progress()?.ok_or("No operation is in progress.")?;
        if !matches!(operation, "rebase" | "cherry-pick" | "revert") {
            return Err("Skip is only supported for a rebase, cherry-pick, or revert.".into());
        }
        repo.save_checkpoint(&format!("Before skipping {operation}"))?;
        repo.write(
            &argv(&["-c", "core.editor=true", operation, "--skip"]),
            None,
            None,
            None,
        )?;
        repo.info()
    }
}

fn merge_text(value: Preview) -> Result<String> {
    if value.binary || value.truncated || value.text.lines().count() > 5000 {
        return Err("This file is binary or exceeds the merge editor's 2 MiB / 5,000 line limit. Use Accept Yours or Accept Theirs.".into());
    }
    Ok(value.text)
}

pub(super) fn has_merge_markers(content: &[u8]) -> bool {
    content.split(|b| *b == b'\n').any(|line| {
        [b'<', b'>'].iter().any(|marker| {
            let length = line.iter().take_while(|b| *b == marker).count();
            length >= 7 && line.get(length).is_none_or(|b| matches!(b, b' ' | b'\r'))
        })
    })
}

impl Repository {
    pub(super) fn conflict_path(&self, info: &RepoInfo, file_id: &str) -> Result<OsString> {
        if !info
            .files
            .iter()
            .any(|f| f.id == file_id && f.conflicted && !f.submodule)
        {
            return Err("That file has no editable conflict. Refresh and try again.".into());
        }
        let path = self.paths.get(file_id).ok_or("Unknown file")?.clone();
        relative_path(raw(&path))?;
        Ok(path)
    }

    pub(super) fn merge_stage(&self, path: &OsStr, stage: u8) -> Result<Option<(String, String)>> {
        let data = read(
            &self.root,
            &[
                os("ls-files"),
                os("--unmerged"),
                os("-z"),
                os("--"),
                path.to_owned(),
            ],
        )?;
        for record in data.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let mut parts = record.splitn(2, |b| *b == b'\t');
            let header = parts.next().ok_or("Invalid index stage")?;
            let name = parts.next().ok_or("Invalid index stage")?;
            if name != raw(path) {
                continue;
            }
            let fields: Vec<_> = header.split(|b| *b == b' ').collect();
            if fields.len() != 3 {
                return Err("Invalid index stage".into());
            }
            if fields[2] == [b'0' + stage] {
                let oid = text(fields[1]);
                valid_oid(&oid)?;
                return Ok(Some((text(fields[0]), oid)));
            }
        }
        Ok(None)
    }

    pub(super) fn write_merge_result(&self, path: &OsStr, content: &str) -> Result<()> {
        relative_path(raw(path))?;
        #[cfg(unix)]
        {
            use std::ffi::CString;
            let mut directory = File::open(&self.root).map_err(|e| e.to_string())?;
            let components: Vec<_> = Path::new(path).components().collect();
            for (index, component) in components.iter().enumerate() {
                let name =
                    CString::new(raw(component.as_os_str())).map_err(|_| "Invalid filename")?;
                let last = index == components.len() - 1;
                let flags = libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | if last {
                        libc::O_WRONLY | libc::O_CREAT | libc::O_NONBLOCK
                    } else {
                        libc::O_RDONLY | libc::O_DIRECTORY
                    };
                let fd =
                    unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags, 0o666) };
                if fd < 0 {
                    return Err(format!(
                        "Cannot safely save the file: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let mut file = unsafe { File::from_raw_fd(fd) };
                if last {
                    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                        return Err("Only regular files can be resolved here.".into());
                    }
                    file.set_len(0)
                        .and_then(|_| file.write_all(content.as_bytes()))
                        .map_err(|e| format!("Cannot save the file: {e}"))?;
                    return Ok(());
                }
                directory = file;
            }
            Err("Invalid filename".into())
        }
        #[cfg(not(unix))]
        {
            // shortcut: Windows has no openat; reject links before writing, upgrade to handle-relative I/O to prevent concurrent swaps.
            let mut full = self.root.clone();
            for component in Path::new(path).components() {
                full.push(component);
                match fs::symlink_metadata(&full) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        return Err("Cannot save through a symbolic link.".into())
                    }
                    Ok(_) => {}
                    Err(e)
                        if e.kind() == std::io::ErrorKind::NotFound
                            && full == self.root.join(path) => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            fs::write(full, content).map_err(|e| format!("Cannot save the file: {e}"))
        }
    }
}
