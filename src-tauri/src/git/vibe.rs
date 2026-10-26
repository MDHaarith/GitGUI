//! Features for people who build with AI agents: change review, health warnings, experiments,
//! guided conflicts, undo, publishing, and the agent rules file.
use super::*;

#[derive(Clone, Debug, Serialize)]
pub struct SessionFile {
    pub path: String,
    pub status: String,
    pub added: u64,
    pub deleted: u64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Session {
    pub checkpoint: Option<Checkpoint>,
    pub files: Vec<SessionFile>,
}

const TEST_PATH: [&str; 5] = ["test/", "tests/", "__tests__/", ".test.", "_test."];
const BIG_FILE_LINES: usize = 800;

fn is_test(path: &str) -> bool {
    TEST_PATH.iter().any(|p| path.contains(p)) || path.starts_with("test")
}
/// Lockfiles and build output are large by nature; nobody should split them.
fn is_generated(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.ends_with(".lock")
        || name.ends_with("-lock.json")
        || name.ends_with("-lock.yaml")
        || name.ends_with(".min.js")
        || name.ends_with(".map")
        || ["dist", "target", "build", "node_modules"]
            .iter()
            .any(|d| path.starts_with(&format!("{d}/")) || path.contains(&format!("/{d}/")))
}
// Long lists would flood the summary panel; show a few and count the rest.
fn first_few(items: &[String]) -> String {
    match items.len() {
        n if n > 5 => format!("{} and {} more", items[..5].join(", "), n - 5),
        _ => items.join(", "),
    }
}
fn slug(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = slug.chars().take(40).collect();
    if slug.is_empty() {
        "experiment".into()
    } else {
        slug
    }
}
fn dependencies(package: Option<&str>) -> HashSet<String> {
    let Some(value) = package.and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
    else {
        return HashSet::new();
    };
    ["dependencies", "devDependencies"]
        .iter()
        .filter_map(|k| value[k].as_object())
        .flat_map(|o| o.keys().cloned())
        .collect()
}

impl Backend {
    pub fn root(&mut self, id: u64) -> Result<PathBuf> {
        Ok(self.repo(id)?.root.clone())
    }

    /// Everything that changed since the session base; risk ordering is left to the UI.
    pub fn session(&mut self, id: u64) -> Result<Session> {
        let repo = self.repo(id)?;
        let (checkpoint, base) = repo.session_base()?;
        let tree = repo.snapshot()?;
        let names = read(
            &repo.root,
            &argv(&["diff", "--no-renames", "--name-status", "-z", &base, &tree]),
        )?;
        let stats = read(
            &repo.root,
            &argv(&["diff", "--no-renames", "--numstat", "-z", &base, &tree]),
        )?;
        let mut counts = HashMap::new();
        for record in stats.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let mut f = record.splitn(3, |b| *b == b'\t');
            if let (Some(a), Some(d), Some(p)) = (f.next(), f.next(), f.next()) {
                counts.insert(
                    display(p),
                    (text(a).parse().unwrap_or(0), text(d).parse().unwrap_or(0)),
                );
            }
        }
        let fields: Vec<_> = names.split(|b| *b == 0).filter(|r| !r.is_empty()).collect();
        let files = fields
            .chunks(2)
            .filter(|c| c.len() == 2)
            .map(|c| {
                let path = display(c[1]);
                let (added, deleted) = counts.get(&path).copied().unwrap_or((0, 0));
                SessionFile {
                    status: text(c[0]),
                    path,
                    added,
                    deleted,
                }
            })
            .collect();
        Ok(Session { checkpoint, files })
    }
    pub fn session_diff(&mut self, id: u64, path: &str) -> Result<Preview> {
        relative_path(path.as_bytes())?;
        let repo = self.repo(id)?;
        let (_, base) = repo.session_base()?;
        let tree = repo.snapshot()?;
        preview(
            &repo.root,
            &argv(&["diff", "--no-renames", &base, &tree, "--", path]),
        )
    }
    /// Puts one file back as it was at the session base; files created since are deleted.
    pub fn undo_files(&mut self, id: u64, paths: &[String], token: &str) -> Result<RepoInfo> {
        for path in paths {
            relative_path(path.as_bytes())?;
        }
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let (_, base) = repo.session_base()?;
        let label = match paths {
            [path] => format!("Before undoing {path}"),
            _ => format!("Before undoing {} files", paths.len()),
        };
        repo.save_checkpoint(&label)?;
        for path in paths {
            if optional(&repo.root, &["cat-file", "-e", &format!("{base}:{path}")])?.is_some() {
                let source = format!("--source={base}");
                repo.write(
                    &argv(&["restore", &source, "--staged", "--worktree", "--", path]),
                    None,
                    None,
                    None,
                )?;
            } else {
                repo.write(
                    &argv(&["rm", "-q", "--cached", "--ignore-unmatch", "--", path]),
                    None,
                    None,
                    None,
                )?;
                match fs::remove_file(repo.root.join(path)) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                        return Err(format!("Cannot remove {path}: {e}"))
                    }
                    _ => {}
                }
            }
        }
        repo.info()
    }

    /// Plain-English warnings about slow damage: huge files, deleted tests, new dependencies, TODOs, old unpushed work.
    pub fn health(&mut self, id: u64) -> Result<Vec<String>> {
        let repo = self.repo(id)?;
        let Some(head) = repo.head()? else {
            return Ok(Vec::new());
        };
        let tree = repo.snapshot()?;
        let mut notes = Vec::new();
        let names = read(
            &repo.root,
            &argv(&[
                "diff",
                "--no-renames",
                "--name-status",
                "-z",
                "HEAD~1",
                &tree,
            ]),
        )
        .or_else(|_| {
            read(
                &repo.root,
                &argv(&["diff", "--no-renames", "--name-status", "-z", &head, &tree]),
            )
        })?;
        let fields: Vec<_> = names.split(|b| *b == 0).filter(|r| !r.is_empty()).collect();
        let (mut big, mut deleted_tests) = (Vec::new(), Vec::new());
        for c in fields.chunks(2).filter(|c| c.len() == 2) {
            let path = display(c[1]);
            if c[0] == b"D" {
                if is_test(&path) {
                    deleted_tests.push(path);
                }
            } else if let Ok(meta) = fs::metadata(repo.root.join(&path)) {
                // shortcut: only files changed in the last commit or since; a full-repo scan would be slow on big repos.
                if meta.len() < 2 * 1024 * 1024 && !is_generated(&path) {
                    let lines = fs::read(repo.root.join(&path))
                        .map(|d| d.iter().filter(|b| **b == b'\n').count())
                        .unwrap_or(0);
                    if lines > BIG_FILE_LINES {
                        big.push(format!("{path} ({lines} lines)"));
                    }
                }
            }
        }
        if !big.is_empty() {
            notes.push(format!("Very large files: {}. AI edits big files less reliably; ask it to split them into smaller modules.", first_few(&big)));
        }
        if !deleted_tests.is_empty() {
            notes.push(format!(
                "Tests were deleted: {}. Check the AI didn't remove tests just to make them pass.",
                first_few(&deleted_tests)
            ));
        }
        let old = optional(&repo.root, &["show", "HEAD:package.json"])?.map(|v| text(&v));
        let new = fs::read_to_string(repo.root.join("package.json")).ok();
        let old_deps = dependencies(old.as_deref());
        let mut added: Vec<_> = dependencies(new.as_deref())
            .into_iter()
            .filter(|d| !old_deps.contains(d))
            .collect();
        added.sort();
        if !added.is_empty() {
            notes.push(format!("New dependencies: {}. Check each is a real, maintained package; AI sometimes invents package names.", added.join(", ")));
        }
        let diff = text(&read(&repo.root, &argv(&["diff", "-U0", &head, &tree]))?);
        let todos = diff
            .lines()
            .filter(|l| {
                l.starts_with('+')
                    && !l.starts_with("+++")
                    && ["TODO", "FIXME", "XXX"].iter().any(|t| l.contains(t))
            })
            .count();
        if todos >= 3 {
            notes.push(format!(
                "{todos} new TODO/FIXME notes: the AI left work unfinished."
            ));
        }
        if let Some(times) = optional(&repo.root, &["log", "--format=%ct", "@{upstream}..HEAD"])? {
            let oldest = text(&times)
                .lines()
                .last()
                .and_then(|t| t.parse::<u64>().ok());
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs();
            if oldest.is_some_and(|t| now.saturating_sub(t) > 24 * 3600) {
                notes.push(
                    "Some commits have waited more than a day to be pushed. Push to back them up."
                        .into(),
                );
            }
        }
        Ok(notes)
    }

    pub fn start_experiment(&mut self, id: u64, name: &str, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let base = info
            .branch
            .clone()
            .ok_or("Switch to a branch before starting an experiment.")?;
        if info.head.is_none() {
            return Err("Create the first commit before starting an experiment.".into());
        }
        if base.starts_with("try/") {
            return Err("You are already in an experiment. Keep it or throw it away first.".into());
        }
        let branch = format!("try/{}", slug(name));
        repo.write(&argv(&["switch", "-c", &branch]), None, None, None)?;
        repo.write(
            &argv(&["config", &format!("branch.{branch}.gitguiBase"), &base]),
            None,
            None,
            None,
        )?;
        repo.info()
    }
    /// Keep merges the experiment into the branch it started from; throw away returns there and deletes it.
    pub fn finish_experiment(&mut self, id: u64, keep: bool, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let branch = info
            .branch
            .clone()
            .filter(|b| b.starts_with("try/"))
            .ok_or("You are not in an experiment.")?;
        let base = optional(
            &repo.root,
            &["config", &format!("branch.{branch}.gitguiBase")],
        )?
        .map(|v| text(&v))
        .ok_or("The branch this experiment started from is unknown.")?;
        if keep {
            if info.files.iter().any(|f| !f.untracked) {
                return Err("Commit the experiment's changes first, then keep it.".into());
            }
            repo.write(&argv(&["switch", &base]), None, None, None)?;
            let name = branch.trim_start_matches("try/");
            repo.write(
                &argv(&[
                    "merge",
                    "--no-ff",
                    "-m",
                    &format!("Keep experiment {name}"),
                    &branch,
                ]),
                None,
                None,
                None,
            )?;
            repo.write(&argv(&["branch", "-d", &branch]), None, None, None)?;
        } else {
            repo.save_checkpoint(&format!("Before throwing away {branch}"))?;
            repo.write(&argv(&["reset", "-q", "--hard"]), None, None, None)?;
            repo.write(&argv(&["clean", "-q", "-fd"]), None, None, None)?;
            repo.write(&argv(&["switch", &base]), None, None, None)?;
            repo.write(&argv(&["branch", "-D", &branch]), None, None, None)?;
        }
        repo.info()
    }

    /// Resolves one conflicted file: `ours`, `theirs`, or `resolved` after editing it by hand.
    pub fn resolve_conflict(
        &mut self,
        id: u64,
        file_id: &str,
        choice: &str,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        if !info.files.iter().any(|f| f.id == file_id && f.conflicted) {
            return Err("That file has no conflict. Refresh and try again.".into());
        }
        let path = repo.paths.get(file_id).ok_or("Unknown file")?.clone();
        match choice {
            "ours" | "theirs" => repo.write(
                &[
                    os("checkout"),
                    os(&format!("--{choice}")),
                    os("--"),
                    path.clone(),
                ],
                None,
                None,
                None,
            )?,
            "resolved" => {
                let content = fs::read(repo.root.join(&path)).map_err(|e| e.to_string())?;
                if content
                    .split(|b| *b == b'\n')
                    .any(|l| l.starts_with(b"<<<<<<< ") || l.starts_with(b">>>>>>> "))
                {
                    return Err("The file still has <<<<<<< or >>>>>>> conflict markers. Remove them first.".into());
                }
            }
            _ => return Err("Choose ours, theirs, or resolved.".into()),
        }
        repo.write(&[os("add"), os("--"), path], None, None, None)?;
        repo.info()
    }
    /// Continues or aborts the merge, rebase, cherry-pick, or revert in progress.
    pub fn finish_operation(&mut self, id: u64, abort: bool, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        repo.checked(token)?;
        let operation = repo
            .in_progress()?
            .ok_or("No merge, rebase, cherry-pick, or revert is in progress.")?;
        if operation == "sequencer" {
            return Err("Finish this multi-commit operation in the terminal.".into());
        }
        repo.write(
            &argv(&[
                "-c",
                "core.editor=true",
                operation,
                if abort { "--abort" } else { "--continue" },
            ]),
            None,
            None,
            None,
        )?;
        repo.info()
    }

    /// Moves the last commit's changes back to staged, unless it was already pushed.
    pub fn undo_commit(&mut self, id: u64, token: &str) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        if optional(&repo.root, &["rev-parse", "--verify", "-q", "HEAD~1"])?.is_none() {
            return Err("The first commit can't be undone here.".into());
        }
        if repo.pushed(&info)? {
            return Err("This commit was already pushed. Undoing it would rewrite shared history; make a new commit that fixes it instead.".into());
        }
        // Version tags made by the post-commit hook would point at a commit that no longer exists.
        for tag in text(&read(
            &repo.root,
            &argv(&["tag", "--points-at", "HEAD", "--list", "v*"]),
        )?)
        .lines()
        {
            repo.write(&argv(&["tag", "-d", tag]), None, None, None)?;
        }
        repo.write(
            &argv(&["reset", "-q", "--soft", "HEAD~1"]),
            None,
            None,
            None,
        )?;
        repo.info()
    }

    /// Creates a private GitHub repository with the GitHub CLI and pushes to it.
    /// Puts the project online: a new private GitHub repository (through the GitHub CLI) or an existing
    /// empty repository URL. The main branch is pushed first so GitHub makes it the default branch.
    pub fn publish(
        &mut self,
        id: u64,
        main: &str,
        url: Option<&str>,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        if !info.remotes.is_empty() {
            return Err("This repository already has a remote. Use Push.".into());
        }
        if info.head.is_none() {
            return Err("Create the first commit before publishing.".into());
        }
        repo.valid_branch_name(main)?;
        if optional(
            &repo.root,
            &["rev-parse", "--verify", "-q", &format!("refs/heads/{main}")],
        )?
        .is_none()
        {
            return Err(format!("There is no local branch named {main}."));
        }
        let mut credentials = Vec::new();
        match url.map(str::trim) {
            Some(url) => {
                if url.is_empty()
                    || url.starts_with('-')
                    || url.chars().any(|c| c.is_whitespace() || c.is_control())
                {
                    return Err("Enter the repository address, for example https://github.com/you/project.git".into());
                }
                repo.write(&argv(&["remote", "add", "origin", url]), None, None, None)?;
            }
            None => {
                let name = repo
                    .root
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .ok_or("Invalid folder name")?;
                let output = crate::platform::command("gh")
                    .current_dir(&repo.root)
                    .args([
                        "repo",
                        "create",
                        &name,
                        "--private",
                        "--source",
                        ".",
                        "--remote",
                        "origin",
                    ])
                    .env("GH_PROMPT_DISABLED", "1")
                    .stdin(Stdio::null())
                    .output()
                    .map_err(|_| {
                        "Install the GitHub CLI (gh) and run `gh auth login` once, then try again."
                            .to_owned()
                    })?;
                if !output.status.success() {
                    return Err(redact(&text(&output.stderr)).trim().to_owned());
                }
                // Push with the GitHub CLI's login, as `gh repo create --push` would.
                credentials = vec![
                    "-c",
                    "credential.helper=",
                    "-c",
                    "credential.helper=!gh auth git-credential",
                ];
            }
        }
        let mut branches = vec![main.to_owned()];
        branches.extend(info.branch.filter(|b| b != main));
        for branch in branches {
            let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
            let mut args = credentials.clone();
            args.extend(["push", "-u", "origin", &refspec]);
            repo.write(&argv(&args), None, Some(Duration::from_secs(300)), None)?;
        }
        repo.info()
    }

    pub fn agent_rules(&mut self, id: u64) -> Result<String> {
        Ok(fs::read_to_string(self.repo(id)?.root.join("AGENTS.md")).unwrap_or_default())
    }
    /// Saves AGENTS.md and makes sure Claude Code reads it through CLAUDE.md.
    pub fn save_agent_rules(&mut self, id: u64, rules: &str) -> Result<()> {
        if rules.len() > 256 * 1024 || rules.contains('\0') {
            return Err("Rules must be text under 256 KiB.".into());
        }
        let root = self.repo(id)?.root.clone();
        fs::write(root.join("AGENTS.md"), rules)
            .map_err(|e| format!("Cannot save AGENTS.md: {e}"))?;
        let claude = root.join("CLAUDE.md");
        let current = fs::read_to_string(&claude).unwrap_or_default();
        if !current.contains("@AGENTS.md") {
            let text = if current.trim().is_empty() {
                "@AGENTS.md\n".to_owned()
            } else {
                format!("@AGENTS.md\n\n{current}")
            };
            fs::write(claude, text).map_err(|e| format!("Cannot update CLAUDE.md: {e}"))?;
        }
        Ok(())
    }

    /// Text sent to Claude for an explanation: staged changes, the AI session, a commit, or a conflicted file.
    pub fn change_text(&mut self, id: u64, scope: &str) -> Result<String> {
        if let Some(ref_id) = scope.strip_prefix("branch:") {
            return self.branch_text(id, ref_id);
        }
        let repo = self.repo(id)?;
        let data = match scope {
            "staged" => read(&repo.root, &argv(&["diff", "--cached", "--no-color"]))?,
            "session" => {
                let (_, base) = repo.session_base()?;
                let tree = repo.snapshot()?;
                read(&repo.root, &argv(&["diff", "--no-color", &base, &tree]))?
            }
            _ => {
                if let Some(oid) = scope.strip_prefix("commit:") {
                    valid_oid(oid)?;
                    read(
                        &repo.root,
                        &argv(&["show", "--no-color", "--format=%B", oid]),
                    )?
                } else if let Some(file_id) = scope.strip_prefix("conflict:") {
                    let path = repo.paths.get(file_id).ok_or("Unknown file")?;
                    fs::read(repo.root.join(path)).map_err(|e| e.to_string())?
                } else {
                    return Err("Unknown change scope".into());
                }
            }
        };
        if data.is_empty() {
            return Err("There are no changes to explain.".into());
        }
        Ok(text(&data))
    }
}

// Checkpoints GitGUI saves on its own; they would hide the AI's work from the session review.
const AUTOMATIC: [&str; 4] = [
    "Automatic checkpoint",
    "Before undoing ",
    "Before restoring ",
    "Before throwing away ",
];

impl Repository {
    /// The session starts at the latest checkpoint you saved after the last commit, else at HEAD.
    fn session_base(&self) -> Result<(Option<Checkpoint>, String)> {
        let head = self.head()?;
        let committed = match &head {
            Some(h) => text(line(&read(
                &self.root,
                &argv(&["show", "-s", "--format=%ct", h]),
            )?))
            .parse()
            .unwrap_or(0),
            None => 0,
        };
        let checkpoint = self
            .checkpoint_list()?
            .into_iter()
            .find(|c| !AUTOMATIC.iter().any(|p| c.label.starts_with(p)))
            .filter(|c| c.timestamp >= committed);
        let base = match (&checkpoint, head) {
            (Some(c), _) => c.oid.clone(),
            (None, Some(head)) => head,
            (None, None) => text(line(&read(&self.root, &argv(&["mktree"]))?)),
        };
        Ok((checkpoint, base))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers_classify_tests_slugs_and_dependencies() {
        assert!(
            is_test("src/app.test.ts")
                && is_test("tests/a.rs")
                && is_test("pkg/x_test.go")
                && !is_test("src/contest.ts")
        );
        assert_eq!(slug("  Try New Login!! "), "try-new-login");
        assert_eq!(slug("???"), "experiment");
        assert!(
            is_generated("package-lock.json")
                && is_generated("src-tauri/Cargo.lock")
                && is_generated("server/target/debug/deps/liba.rlib")
                && is_generated("node_modules/x/index.js")
                && !is_generated("src/main.ts")
        );
        let many: Vec<String> = (0..8).map(|i| i.to_string()).collect();
        assert_eq!(first_few(&many), "0, 1, 2, 3, 4 and 3 more");
        assert_eq!(first_few(&many[..2]), "0, 1");
        let deps = dependencies(Some(
            r#"{"dependencies":{"a":"1"},"devDependencies":{"b":"2"}}"#,
        ));
        assert!(deps.contains("a") && deps.contains("b") && deps.len() == 2);
        assert!(dependencies(Some("not json")).is_empty());
    }
}
