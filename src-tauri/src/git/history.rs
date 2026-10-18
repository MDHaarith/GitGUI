//! History: refs, the commit graph, and commit details and diffs.
use super::*;

impl Backend {
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
        let (details, files) = repo.details_and_paths(oid, parent)?;
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
}

impl Repository {
    pub(super) fn shallow(&self) -> Result<HashSet<String>> {
        let path = self.metadata("shallow")?;
        match fs::read(path) {
            Ok(data) => Ok(text(&data).lines().map(str::to_owned).collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashSet::new()),
            Err(e) => Err(e.to_string()),
        }
    }
    pub(super) fn refs(&self) -> Result<Vec<RefInfo>> {
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
    pub(super) fn details(&self, oid: &str, chosen: Option<String>) -> Result<CommitDetails> {
        Ok(self.details_and_paths(oid, chosen)?.0)
    }
    /// Commit details plus the real paths of its changed files, keyed by file id.
    pub(super) fn details_and_paths(
        &self,
        oid: &str,
        chosen: Option<String>,
    ) -> Result<(CommitDetails, HashMap<String, OsString>)> {
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
        let (files, paths) = if shallow && parents.is_empty() {
            (Vec::new(), HashMap::new())
        } else {
            self.changed_files(oid, parent.as_deref())?
        };
        let details = CommitDetails {
            oid: text(f[0]),
            parents,
            author: display(f[2]),
            email: display(f[3]),
            timestamp: text(f[4]).parse().map_err(|_| "Invalid commit date")?,
            message: text(f[5]).trim_end_matches('\n').into(),
            parent,
            files,
            shallow,
        };
        Ok((details, paths))
    }
    pub(super) fn diff_args(&self, oid: &str, parent: Option<&str>, names: bool) -> Vec<OsString> {
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
    pub(super) fn changed_files(
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
    pub(super) fn commit_paths(
        &self,
        oid: &str,
        parent: Option<&str>,
    ) -> Result<HashMap<String, OsString>> {
        Ok(self.changed_files(oid, parent)?.1)
    }
}
