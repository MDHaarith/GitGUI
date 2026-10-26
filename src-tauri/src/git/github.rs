//! GitHub hub: fixed gh operations, bounded captures, and no interactive prompts.
use super::*;
use serde::Deserialize;
use serde_json::{json, Value};

const LOGIN: &str = "Install gh and run gh auth login, then try again.";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReadRequest {
    Repository,
    Pulls { filter: String },
    Pull { number: u32 },
    Diff { number: u32, path: Option<String> },
    Issues,
    Issue { number: u32 },
    Runs { branch: Option<String> },
    Run { number: u64 },
    Log { number: u64 },
    Releases,
    Notifications,
    Readme,
    Branches,
    Commits,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WriteRequest {
    Checkout {
        number: u32,
        token: String,
    },
    Merge {
        number: u32,
        method: String,
        head: String,
    },
    Review {
        number: u32,
        head: String,
        event: String,
        body: String,
        comments: Vec<ReviewComment>,
    },
    Comment {
        number: u32,
        body: String,
    },
    IssueState {
        number: u32,
        state: String,
    },
    Rerun {
        number: u64,
    },
    ReadNotification {
        thread: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewComment {
    pub path: String,
    pub line: u32,
    pub side: String,
    pub body: String,
}

#[derive(Deserialize)]
struct PullFile {
    filename: String,
    patch: Option<String>,
}

fn repository_name(name: &str) -> Result<&str> {
    let parts: Vec<_> = name.split('/').collect();
    if parts.len() != 2
        || name.len() > 240
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.starts_with('-')
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("Enter a GitHub repository as owner/repo.".into());
    }
    Ok(name)
}

fn positive(number: u64) -> Result<String> {
    if number == 0 || number > i64::MAX as u64 {
        return Err("Choose a valid GitHub item number.".into());
    }
    Ok(number.to_string())
}

fn body_text(body: &str) -> Result<()> {
    if body.trim().is_empty() || body.len() > 64_000 || body.contains('\0') {
        return Err("Enter a comment under 64 KiB.".into());
    }
    Ok(())
}

fn head_oid(head: &str) -> Result<()> {
    if head.len() != 40 || !head.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Refresh the pull request to load its current commit.".into());
    }
    Ok(())
}

// JSON input stays out of argv and stdin; create_new and mode 0600 protect review drafts.
struct InputFile(PathBuf);
impl InputFile {
    fn new(value: &Value) -> Result<Self> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("gitgui-gh-{}-{stamp}.json", std::process::id()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|e| format!("Cannot prepare GitHub request: {e}"))?;
        let input = Self(path);
        file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Ok(input)
    }
}
impl Drop for InputFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn capture(mut command: std::process::Command, limit: usize, timeout: Duration) -> Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| LOGIN.to_owned())?;
    let stdout = child.stdout.take().ok_or("GitHub stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("GitHub stderr unavailable")?;
    let out = thread::spawn(move || drain(stdout, limit, None));
    let err = thread::spawn(move || drain(stderr, 64 * 1024, None));
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if start.elapsed() >= timeout {
            timed_out = true;
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            crate::platform::kill_tree(child.id());
            let _ = child.kill();
            break child.wait().map_err(|e| e.to_string())?;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    while (!out.is_finished() || !err.is_finished()) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    if !out.is_finished() || !err.is_finished() {
        return Err("GitHub CLI left an output stream open. Refresh before retrying; the action may have completed.".into());
    }
    let (stdout, truncated) = out
        .join()
        .map_err(|_| "GitHub output reader failed")?
        .map_err(|e| e.to_string())?;
    let (stderr, _) = err
        .join()
        .map_err(|_| "GitHub error reader failed")?
        .map_err(|e| e.to_string())?;
    if timed_out {
        return Err(
            "GitHub CLI timed out. Refresh before retrying; the action may have completed.".into(),
        );
    }
    let stderr = redact(&text(&stderr));
    if !status.success() {
        return Err(format!("{}\n{LOGIN}", stderr.trim()));
    }
    Ok(Output {
        stdout,
        stderr,
        ok: true,
        truncated,
    })
}

fn gh(root: &Path, args: &[&str], limit: usize) -> Result<Output> {
    let mut command = crate::platform::command("gh");
    command
        .current_dir(root)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_HOST", "github.com")
        .env("GH_PAGER", "")
        .env("GH_COLOR_LABELS", "0")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    for variable in [
        "GH_REPO",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_TRACE",
        "GIT_TRACE_CURL",
        "GIT_CURL_VERBOSE",
        "GIT_TRACE_PACKET",
    ] {
        command.env_remove(variable);
    }
    capture(command, limit, Duration::from_secs(90))
}

fn parse_json(output: Output, array: bool) -> Result<Value> {
    if output.truncated {
        return Err("GitHub response exceeds 16 MiB. Narrow your selection.".into());
    }
    let mut value: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "GitHub CLI returned invalid JSON")?;
    if (array && !value.is_array()) || (!array && !value.is_object()) {
        return Err("GitHub CLI returned an unexpected JSON response.".into());
    }
    redact_json(&mut value);
    Ok(value)
}

fn redact_json(value: &mut Value) {
    match value {
        Value::String(text) => *text = redact(text),
        Value::Array(items) => items.iter_mut().for_each(redact_json),
        Value::Object(fields) => fields.values_mut().for_each(redact_json),
        _ => (),
    }
}

fn gh_json(root: &Path, args: &[&str], array: bool) -> Result<Value> {
    parse_json(gh(root, args, DATA_LIMIT)?, array)
}

fn api(root: &Path, endpoint: &str, method: &str, payload: Option<Value>) -> Result<Value> {
    let input = payload.as_ref().map(InputFile::new).transpose()?;
    let mut args = vec![
        "api",
        "--hostname",
        "github.com",
        "--method",
        method,
        endpoint,
    ];
    let path = input
        .as_ref()
        .map(|file| file.0.to_str().ok_or("GitHub request path is not UTF-8"))
        .transpose()?;
    if let Some(path) = path {
        args.extend(["--input", path]);
    }
    let out = gh(root, &args, DATA_LIMIT)?;
    if out.truncated {
        return Err("GitHub response exceeds 16 MiB.".into());
    }
    if out.stdout.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&out.stdout).map_err(|_| "GitHub CLI returned invalid JSON".into())
}

fn local_name(root: &Path) -> Result<String> {
    let value = gh_json(
        root,
        &["repo", "view", "--json", "nameWithOwner,url"],
        false,
    )?;
    if !value["url"]
        .as_str()
        .is_some_and(|url| url.starts_with("https://github.com/"))
    {
        return Err("Choose a repository hosted on github.com.".into());
    }
    Ok(repository_name(
        value["nameWithOwner"]
            .as_str()
            .ok_or("GitHub repository name is missing")?,
    )?
    .to_owned())
}

fn files(root: &Path, name: &str, number: u32) -> Result<Vec<PullFile>> {
    let number = positive(number.into())?;
    // shortcut: review at most 100 files; add pagination when reviewing larger pull requests.
    let value = gh_json(
        root,
        &[
            "api",
            "--hostname",
            "github.com",
            &format!("repos/{name}/pulls/{number}/files?per_page=100"),
        ],
        true,
    )?;
    serde_json::from_value(value).map_err(|_| "GitHub returned invalid pull request files.".into())
}

fn patch_line(patch: &str, line: u32, side: &str) -> bool {
    let (mut left, mut right) = (0, 0);
    let mut in_hunk = false;
    for text in patch.lines() {
        if text.starts_with("@@ ") {
            let mut parts = text.split_whitespace().skip(1);
            left = parts
                .next()
                .and_then(|p| p.strip_prefix('-'))
                .and_then(|p| p.split(',').next())
                .and_then(|p| p.parse::<u32>().ok())
                .unwrap_or(0);
            right = parts
                .next()
                .and_then(|p| p.strip_prefix('+'))
                .and_then(|p| p.split(',').next())
                .and_then(|p| p.parse::<u32>().ok())
                .unwrap_or(0);
            in_hunk = true;
        } else if in_hunk {
            let old = text.starts_with('-') || text.starts_with(' ');
            let new = text.starts_with('+') || text.starts_with(' ');
            if (side == "LEFT" && old && left == line) || (side == "RIGHT" && new && right == line)
            {
                return true;
            }
            if old {
                left = left.saturating_add(1);
            }
            if new {
                right = right.saturating_add(1);
            }
        }
    }
    false
}

fn review_payload(
    head: &str,
    event: &str,
    body: &str,
    comments: &[ReviewComment],
    files: &[PullFile],
) -> Result<Value> {
    head_oid(head)?;
    if !["COMMENT", "APPROVE", "REQUEST_CHANGES"].contains(&event) || comments.len() > 100 {
        return Err("Choose a review verdict and at most 100 inline comments.".into());
    }
    if !body.is_empty() {
        body_text(body)?;
    }
    if (event == "REQUEST_CHANGES" || (event == "COMMENT" && comments.is_empty()))
        && body.trim().is_empty()
    {
        return Err("Add a review summary for this verdict.".into());
    }
    for comment in comments {
        relative_path(comment.path.as_bytes())?;
        body_text(&comment.body)?;
        if comment.line == 0
            || !["LEFT", "RIGHT"].contains(&comment.side.as_str())
            || !files.iter().any(|file| {
                file.filename == comment.path
                    && file
                        .patch
                        .as_deref()
                        .is_some_and(|patch| patch_line(patch, comment.line, &comment.side))
            })
        {
            return Err(
                "A comment is outside the current diff. Refresh and review its line.".into(),
            );
        }
    }
    Ok(json!({ "commit_id": head, "event": event, "body": body, "comments": comments }))
}

// gh has no --no-overwrite-ignore. Use our own worktree, then switch safely here.
fn checkout_pr(repo: &mut Repository, checkout: impl FnOnce(&Path) -> Result<()>) -> Result<()> {
    repo.save_checkpoint("Before checking out a GitHub pull request")?;
    let marker = InputFile::new(&json!({}))?;
    let directory = marker.0.with_extension("worktree");
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory).map_err(|e| e.to_string())?;
    let temporary = directory.join("repo");
    let path = temporary
        .to_str()
        .ok_or("Temporary worktree path is not UTF-8")?;
    let result = (|| {
        read(
            &repo.root,
            &argv(&["worktree", "add", "--detach", path, "HEAD"]),
        )?;
        checkout(&temporary)?;
        let head = text(line(&read(&temporary, &argv(&["rev-parse", "HEAD"]))?));
        repo.write(
            &argv(&["checkout", "--detach", "--no-overwrite-ignore", &head]),
            None,
            Some(Duration::from_secs(30)),
            None,
        )
    })();
    let cleanup = read(&repo.root, &argv(&["worktree", "remove", "--force", path]));
    let _ = fs::remove_dir(&directory);
    result?;
    cleanup.map_err(|_| "PR checked out, but temporary worktree cleanup failed. Inspect git worktree list before removing the temporary worktree.".to_owned())?;
    Ok(())
}

impl Backend {
    pub fn github_read(
        &mut self,
        id: Option<u64>,
        repository: Option<&str>,
        request: ReadRequest,
    ) -> Result<Value> {
        let root = match id {
            Some(id) => self.repo(id)?.root.clone(),
            None => std::env::temp_dir(),
        };
        if matches!(request, ReadRequest::Notifications) {
            return gh_json(
                &root,
                &[
                    "api",
                    "--hostname",
                    "github.com",
                    "notifications?per_page=50",
                ],
                true,
            );
        }
        let name = match repository {
            Some(name) => repository_name(name)?.to_owned(),
            None => {
                if id.is_none() {
                    return Err(
                        "Open a local repository or enter owner/repo to browse GitHub.".into(),
                    );
                }
                local_name(&root)?
            }
        };
        let target = format!("github.com/{name}");
        let base = format!("repos/{name}");
        let pr_fields = "number,title,body,state,headRefOid,headRefName,baseRefName,author,url,statusCheckRollup,reviewRequests,latestReviews,files,changedFiles";
        match request {
            ReadRequest::Repository => Ok(json!({ "name": name })),
            ReadRequest::Pulls { filter } => {
                let mut args = vec![
                    "pr",
                    "list",
                    "--repo",
                    &target,
                    "--state",
                    "open",
                    "--limit",
                    "50",
                    "--json",
                    "number,title,state,author,headRefName,url",
                ];
                match filter.as_str() {
                    "open" => (),
                    "mine" => args.extend(["--author", "@me"]),
                    "review" => args.extend(["--search", "review-requested:@me"]),
                    _ => return Err("Choose Open, Mine, or Review requested.".into()),
                }
                gh_json(&root, &args, true)
            }
            ReadRequest::Pull { number } => gh_json(
                &root,
                &[
                    "pr",
                    "view",
                    &positive(number.into())?,
                    "--repo",
                    &target,
                    "--json",
                    pr_fields,
                ],
                false,
            ),
            ReadRequest::Diff { number, path } => {
                if let Some(path) = path {
                    relative_path(path.as_bytes())?;
                    let file = files(&root, &name, number)?
                        .into_iter()
                        .find(|f| f.filename == path)
                        .ok_or("File is not in the first 100 pull request files.")?;
                    let binary = file.patch.is_none();
                    let patch = file.patch.map(|patch| redact(&patch)).unwrap_or_else(|| {
                        "Binary file or patch unavailable; inline review is unavailable.".into()
                    });
                    let truncated = patch.len() > PREVIEW_LIMIT;
                    let patch = String::from_utf8_lossy(
                        &patch.as_bytes()[..patch.len().min(PREVIEW_LIMIT)],
                    )
                    .into_owned();
                    Ok(
                        json!({"text": format!("--- a/{path}\n+++ b/{path}\n{patch}"), "binary": binary, "truncated": truncated}),
                    )
                } else {
                    let out = gh(
                        &root,
                        &[
                            "pr",
                            "diff",
                            &positive(number.into())?,
                            "--repo",
                            &target,
                            "--color",
                            "never",
                        ],
                        PREVIEW_LIMIT,
                    )?;
                    Ok(
                        json!({"text": redact(&text(&out.stdout)), "binary": false, "truncated": out.truncated}),
                    )
                }
            }
            ReadRequest::Issues => gh_json(
                &root,
                &[
                    "issue",
                    "list",
                    "--repo",
                    &target,
                    "--state",
                    "all",
                    "--limit",
                    "50",
                    "--json",
                    "number,title,state,author,url",
                ],
                true,
            ),
            ReadRequest::Issue { number } => gh_json(
                &root,
                &[
                    "issue",
                    "view",
                    &positive(number.into())?,
                    "--repo",
                    &target,
                    "--json",
                    "number,title,body,state,comments,author,url",
                ],
                false,
            ),
            ReadRequest::Runs { branch } => {
                let mut args = vec!["run", "list", "--repo", &target, "--limit", "50", "--json", "databaseId,workflowName,displayTitle,status,conclusion,headBranch,createdAt,url,headSha"];
                if let Some(branch) = &branch {
                    if branch.is_empty()
                        || branch.len() > 1024
                        || branch.starts_with('-')
                        || branch.chars().any(char::is_control)
                    {
                        return Err("Enter a valid branch name.".into());
                    }
                    let checked = read(&root, &argv(&["check-ref-format", "--branch", branch]))?;
                    if line(&checked) != branch.as_bytes() {
                        return Err("Use an exact branch name.".into());
                    }
                    args.extend(["--branch", branch]);
                }
                gh_json(&root, &args, true)
            }
            ReadRequest::Run { number } => gh_json(
                &root,
                &[
                    "run",
                    "view",
                    &positive(number)?,
                    "--repo",
                    &target,
                    "--json",
                    "databaseId,displayTitle,status,conclusion,jobs,headBranch,url",
                ],
                false,
            ),
            ReadRequest::Log { number } => {
                let out = gh(
                    &root,
                    &[
                        "run",
                        "view",
                        &positive(number)?,
                        "--repo",
                        &target,
                        "--log-failed",
                    ],
                    PREVIEW_LIMIT,
                )?;
                Ok(
                    json!({"text": redact(&text(&out.stdout)), "binary": false, "truncated": out.truncated}),
                )
            }
            ReadRequest::Releases => gh_json(
                &root,
                &[
                    "api",
                    "--hostname",
                    "github.com",
                    &format!("{base}/releases?per_page=50"),
                ],
                true,
            ),
            ReadRequest::Readme => {
                let out = gh(
                    &root,
                    &[
                        "api",
                        "--hostname",
                        "github.com",
                        "-H",
                        "Accept: application/vnd.github.raw+json",
                        &format!("{base}/readme"),
                    ],
                    PREVIEW_LIMIT,
                )?;
                Ok(json!({"text": redact(&text(&out.stdout)), "truncated": out.truncated}))
            }
            ReadRequest::Branches => gh_json(
                &root,
                &[
                    "api",
                    "--hostname",
                    "github.com",
                    &format!("{base}/branches?per_page=50"),
                ],
                true,
            ),
            ReadRequest::Commits => gh_json(
                &root,
                &[
                    "api",
                    "--hostname",
                    "github.com",
                    &format!("{base}/commits?per_page=50"),
                ],
                true,
            ),
            ReadRequest::Notifications => unreachable!(),
        }
    }

    pub fn github_write(&mut self, id: u64, repository: &str, request: WriteRequest) -> Result<()> {
        repository_name(repository)?;
        let repo = self.repo(id)?;
        if let WriteRequest::Checkout { token, .. } = &request {
            let info = repo.checked(token)?;
            repo.require_normal(&info)?;
            if !info.files.is_empty() {
                return Err(
                    "Commit or stash local changes before checking out a pull request.".into(),
                );
            }
        }
        let name = local_name(&repo.root)?;
        if !name.eq_ignore_ascii_case(repository) {
            return Err("Repository changed. Reopen the GitHub panel before writing.".into());
        }
        let target = format!("github.com/{name}");
        let base = format!("repos/{name}");
        match request {
            WriteRequest::Checkout { number, .. } => {
                let number = positive(number.into())?;
                checkout_pr(repo, |root| {
                    gh(
                        root,
                        &["pr", "checkout", &number, "--repo", &target, "--detach"],
                        DATA_LIMIT,
                    )
                    .map(|_| ())
                })?;
            }
            WriteRequest::Merge {
                number,
                method,
                head,
            } => {
                head_oid(&head)?;
                let flag = match method.as_str() {
                    "merge" => "--merge",
                    "squash" => "--squash",
                    "rebase" => "--rebase",
                    _ => return Err("Choose merge, squash, or rebase.".into()),
                };
                repo.save_checkpoint("Before merging a GitHub pull request")?;
                gh(
                    &repo.root,
                    &[
                        "pr",
                        "merge",
                        &positive(number.into())?,
                        "--repo",
                        &target,
                        flag,
                        "--match-head-commit",
                        &head,
                    ],
                    DATA_LIMIT,
                )?;
            }
            WriteRequest::Review {
                number,
                head,
                event,
                body,
                comments,
            } => {
                let n = positive(number.into())?;
                let current = gh_json(
                    &repo.root,
                    &["pr", "view", &n, "--repo", &target, "--json", "headRefOid"],
                    false,
                )?;
                if current["headRefOid"].as_str() != Some(&head) {
                    return Err(
                        "The pull request changed. Refresh before submitting your review.".into(),
                    );
                }
                let payload = review_payload(
                    &head,
                    &event,
                    &body,
                    &comments,
                    &files(&repo.root, &name, number)?,
                )?;
                api(
                    &repo.root,
                    &format!("{base}/pulls/{n}/reviews"),
                    "POST",
                    Some(payload),
                )?;
            }
            WriteRequest::Comment { number, body } => {
                body_text(&body)?;
                api(
                    &repo.root,
                    &format!("{base}/issues/{}/comments", positive(number.into())?),
                    "POST",
                    Some(json!({"body": body})),
                )?;
            }
            WriteRequest::IssueState { number, state } => {
                if !["open", "closed"].contains(&state.as_str()) {
                    return Err("Choose open or closed.".into());
                }
                api(
                    &repo.root,
                    &format!("{base}/issues/{}", positive(number.into())?),
                    "PATCH",
                    Some(json!({"state": state})),
                )?;
            }
            WriteRequest::Rerun { number } => {
                gh(
                    &repo.root,
                    &["run", "rerun", &positive(number)?, "--repo", &target],
                    DATA_LIMIT,
                )?;
            }
            WriteRequest::ReadNotification { thread } => {
                if thread.is_empty()
                    || thread.len() > 30
                    || !thread.bytes().all(|b| b.is_ascii_digit())
                {
                    return Err("Choose a notification from your inbox.".into());
                }
                api(
                    &repo.root,
                    &format!("notifications/threads/{thread}"),
                    "PATCH",
                    None,
                )?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(text: &str) -> Output {
        Output {
            stdout: text.as_bytes().to_vec(),
            stderr: String::new(),
            ok: true,
            truncated: false,
        }
    }
    #[test]
    fn json_fixtures_and_review_payload() {
        let files: Vec<PullFile> = serde_json::from_value(
            parse_json(
                fixture(include_str!("../../tests/fixtures/github-files.json")),
                true,
            )
            .unwrap(),
        )
        .unwrap();
        let head = "a".repeat(40);
        let mut comments = vec![ReviewComment {
            path: "src/file.ts".into(),
            line: 4,
            side: "RIGHT".into(),
            body: "Please check this.".into(),
        }];
        let payload = review_payload(&head, "COMMENT", "", &comments, &files).unwrap();
        assert_eq!(payload["comments"][0]["line"], 4);
        assert_eq!(payload["commit_id"], head);
        comments[0].side = "LEFT".into();
        assert!(review_payload(&head, "APPROVE", "", &comments, &files).is_err());
        comments[0].line = 2;
        assert!(review_payload(&head, "REQUEST_CHANGES", "Fix this", &comments, &files).is_ok());
        comments[0].path = "../secret".into();
        assert!(review_payload(&head, "COMMENT", "Summary", &comments, &files).is_err());
        assert!(review_payload(&head, "REQUEST_CHANGES", "", &[], &files).is_err());
        assert!(review_payload(&head, "APPROVE", "", &[], &files).is_ok());
        assert!(parse_json(fixture("not json"), true).is_err());
        assert!(parse_json(fixture("{}"), true).is_err());
        let mut clipped = fixture("[]");
        clipped.truncated = true;
        assert!(parse_json(clipped, true).is_err());
        let redacted = parse_json(
            fixture(r#"{"body":"https://user:password@example.invalid/path"}"#),
            false,
        )
        .unwrap();
        assert_eq!(redacted["body"], "https://[redacted]@example.invalid/path");
    }
    #[test]
    fn inputs_cannot_select_commands_or_endpoints() {
        for invalid in [
            "-x/repo",
            "a/../b",
            "a/b?x",
            "https://github.com/a/b",
            "a/..",
            "a/b\n",
        ] {
            assert!(repository_name(invalid).is_err());
        }
        assert!(repository_name("owner/repo.name-1").is_ok());
        assert!(positive(0).is_err());
        assert!(head_oid("--help").is_err());
        assert!(
            serde_json::from_str::<ReadRequest>(r#"{"kind":"shell","command":"whoami"}"#).is_err()
        );
    }
    #[test]
    fn private_request_file_is_removed_and_capture_is_bounded() {
        let file = InputFile::new(&json!({"body": "hello"})).unwrap();
        let path = file.0.clone();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"body":"hello"}"#);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(file);
        assert!(!path.exists());
        let output = capture(
            crate::platform::shell("echo hello"),
            3,
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(output.truncated);
        assert_eq!(&output.stdout, b"hel");
        assert!(capture(
            crate::platform::command("gitgui-nonexistent-gh-test"),
            32,
            Duration::from_secs(1)
        )
        .err()
        .unwrap()
        .contains(LOGIN));
    }
    #[test]
    fn checkout_keeps_the_original_branch_and_refuses_ignored_file_collisions() {
        for protect_ignored in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            let git = |args: &[&str]| read(root, &argv(args)).unwrap();
            git(&["init", "-b", "main"]);
            git(&["config", "user.name", "GitGUI Test"]);
            git(&["config", "user.email", "test@example.invalid"]);
            git(&["config", "commit.gpgsign", "false"]);
            git(&[
                "config",
                "core.hooksPath",
                root.join("no-hooks").to_str().unwrap(),
            ]);
            fs::write(root.join("file.txt"), "original\n").unwrap();
            git(&["add", "."]);
            git(&["commit", "-m", "initial"]);
            git(&["checkout", "-b", "feature"]);
            fs::write(root.join("ignored.secret"), "PR content\n").unwrap();
            git(&["add", "."]);
            git(&["commit", "-m", "PR fixture"]);
            let target = text(line(&git(&["rev-parse", "HEAD"])));
            git(&["checkout", "main"]);
            fs::write(root.join(".gitignore"), "*.secret\n").unwrap();
            git(&["add", "."]);
            git(&["commit", "-m", "ignore secrets"]);
            let original_head = text(line(&git(&["rev-parse", "HEAD"])));
            if protect_ignored {
                fs::write(root.join("ignored.secret"), "user secret\n").unwrap();
            }
            let mut backend = Backend::default();
            let info = backend.open(root.to_str().unwrap()).unwrap();
            assert!(info.files.is_empty());
            let result = checkout_pr(backend.repo(info.id).unwrap(), |temporary| {
                read(temporary, &argv(&["checkout", "--detach", &target])).map(|_| ())
            });
            let current = backend.status(info.id).unwrap();
            if protect_ignored {
                assert!(result.is_err());
                assert_eq!(current.branch.as_deref(), Some("main"));
                assert_eq!(
                    fs::read_to_string(root.join("ignored.secret")).unwrap(),
                    "user secret\n"
                );
            } else {
                result.unwrap();
                assert!(current.detached);
                assert_eq!(current.head.as_deref(), Some(target.as_str()));
            }
            assert_eq!(text(line(&git(&["rev-parse", "main"]))), original_head);
            assert_eq!(
                text(&git(&["worktree", "list", "--porcelain"]))
                    .lines()
                    .filter(|line| line.starts_with("worktree "))
                    .count(),
                1
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn capture_times_out_and_kills_helpers() {
        let start = Instant::now();
        assert!(capture(
            crate::platform::shell("sleep 10"),
            3,
            Duration::from_millis(20)
        )
        .err()
        .unwrap()
        .contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
