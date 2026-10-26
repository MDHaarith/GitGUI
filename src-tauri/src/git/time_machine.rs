use super::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub oid: String,
    pub selector: String,
    pub timestamp: i64,
    pub action: String,
    pub message: String,
    pub source: String,
}

impl Backend {
    pub fn reflog(&mut self, id: u64) -> Result<Vec<ReflogEntry>> {
        let repo = self.repo(id)?;
        let mut sources = vec!["HEAD".to_owned()];
        if let Some(branch) = optional(&repo.root, &["symbolic-ref", "-q", "HEAD"])? {
            sources.push(text(&branch));
        }
        let mut entries = Vec::new();
        for source in sources {
            if optional(&repo.root, &["rev-parse", "--verify", &source])?.is_none() {
                continue;
            }
            let output = read(
                &repo.root,
                &argv(&[
                    "reflog",
                    "show",
                    "-n",
                    "500",
                    "--date=unix",
                    "--format=%H%x00%gD%x00%gs%x00%s%x00",
                    &source,
                ]),
            )?;
            let fields: Vec<_> = output.split(|b| *b == 0).collect();
            for row in fields.chunks_exact(4) {
                let oid = text(row[0]).trim().to_owned();
                valid_oid(&oid)?;
                let selector = text(row[1]);
                let timestamp = selector
                    .rsplit_once("@{")
                    .and_then(|(_, t)| t.strip_suffix('}'))
                    .and_then(|t| t.parse().ok())
                    .unwrap_or(0);
                entries.push(ReflogEntry {
                    oid,
                    selector: redact(&selector),
                    timestamp,
                    action: redact(&display(row[2])),
                    message: redact(&display(row[3])),
                    source: source.clone(),
                });
            }
        }
        entries.sort_by_key(|e| std::cmp::Reverse(e.timestamp));
        Ok(entries)
    }

    pub fn restore_reflog(&mut self, id: u64, oid: &str, token: &str) -> Result<RepoInfo> {
        valid_oid(oid)?;
        if !self.reflog(id)?.iter().any(|e| e.oid == oid) {
            return Err(
                "Choose a commit still listed in HEAD or the current branch's reflog.".into(),
            );
        }
        // reset_commit validates branch state and published history and saves a checkpoint.
        self.reset_commit(id, oid, "hard", token)
    }

    pub fn line_history(
        &mut self,
        id: u64,
        file_id: &str,
        commit: Option<&str>,
        start: u32,
        end: u32,
    ) -> Result<Preview> {
        if start == 0 || end < start || end > 1_000_000 {
            return Err("Choose a valid line range (1–1,000,000).".into());
        }
        let repo = self.repo(id)?;
        let path = repo.file_path(file_id, commit)?;
        relative_path(raw(&path))?;
        let mut range = OsString::from(format!("-L{start},{end}:"));
        range.push(path);
        let mut args = argv(&[
            "log",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "-n",
            "100",
            "--format=commit %H%nAuthor: %an%nDate: %aI%n%n    %s",
            commit.unwrap_or("HEAD"),
        ]);
        args.push(range);
        let output = execute(
            &repo.root,
            &args,
            None,
            PREVIEW_LIMIT,
            Some(Duration::from_secs(30)),
            None,
        )?;
        if !output.ok {
            return Err(redact(&output.stderr));
        }
        Ok(Preview {
            text: redact(&text(&output.stdout)),
            truncated: output.truncated,
            binary: false,
        })
    }
}
