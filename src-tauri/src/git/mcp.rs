//! A synchronous stdio MCP server. All repository operations share the desktop's safety checks.
use super::*;
use serde_json::{json, Map, Value};
use std::io::{self, BufRead};

const REQUEST_LIMIT: usize = 1024 * 1024;
const RESULT_LIMIT: usize = 64 * 1024;
const PROTOCOL: &str = "2025-11-25";

struct Tool {
    name: &'static str,
    description: &'static str,
    access: u8,
    properties: Value,
    required: &'static [&'static str],
}

fn tools() -> Vec<Tool> {
    let string = json!({"type":"string", "minLength":1, "maxLength":32768});
    let path = json!({"type":"string", "description":"Literal repository-relative path (not a glob).", "minLength":1, "maxLength":32768});
    let files = json!({"type":"array", "items":string, "minItems":1, "maxItems":1000, "description":"File IDs returned by status; supports every filename Git supports."});
    let limit = json!({"type":"integer", "minimum":1, "maximum":1000});
    vec![
        Tool {name:"status", description:"Working tree, staged files, branch, and file IDs.", access:0, properties:json!({}), required:&[]},
        Tool {name:"log", description:"Recent commits (default 50) on HEAD, optionally filtered by branch and literal path.", access:0, properties:json!({"limit":limit,"branch":string,"path":path}), required:&[]},
        Tool {name:"show_commit", description:"Commit details and changed files for a ref or object ID.", access:0, properties:json!({"reference":string}), required:&["reference"]},
        Tool {name:"diff", description:"Tracked working or staged diff, or between two refs. Defaults to working; untracked files can be previewed by path.", access:0, properties:json!({"mode":{"type":"string","enum":["working","staged","refs"]},"from":string,"to":string,"path":path}), required:&[]},
        Tool {name:"branches", description:"Local and remote branches.", access:0, properties:json!({}), required:&[]},
        Tool {name:"tags", description:"Tags and their commit targets.", access:0, properties:json!({}), required:&[]},
        Tool {name:"stashes", description:"Saved stashes with indices and messages.", access:0, properties:json!({}), required:&[]},
        Tool {name:"blame", description:"Committed line history (default HEAD, first 5000 lines).", access:0, properties:json!({"path":path,"reference":string,"start_line":{"type":"integer","minimum":1,"maximum":2147483647},"end_line":{"type":"integer","minimum":1,"maximum":2147483647}}), required:&["path"]},
        Tool {name:"file_history", description:"Commits touching a path, following renames (default 50).", access:0, properties:json!({"path":path,"reference":string,"limit":limit}), required:&["path"]},
        Tool {name:"list_checkpoints", description:"Recovery checkpoints, newest first.", access:0, properties:json!({}), required:&[]},
        Tool {name:"code_search", description:"Search the existing code-review-graph index, if installed. Build the index with code-review-graph build first.", access:0, properties:json!({"query":string,"limit":{"type":"integer","minimum":1,"maximum":100}}), required:&["query"]},
        Tool {name:"stage", description:"Stage selected file IDs from status.", access:1, properties:json!({"files":files}), required:&["files"]},
        Tool {name:"unstage", description:"Unstage selected file IDs, preserving working files.", access:1, properties:json!({"files":files}), required:&["files"]},
        Tool {name:"commit", description:"Commit staged changes. Hooks and signing still run; detached HEAD is refused.", access:1, properties:json!({"message":{"type":"string","minLength":1,"maxLength":131072}}), required:&["message"]},
        Tool {name:"create_branch", description:"Create a local branch at HEAD or a supplied reference.", access:1, properties:json!({"name":string,"reference":string}), required:&["name"]},
        Tool {name:"switch_branch", description:"Switch to an existing local branch; Git refuses changes that would lose work.", access:1, properties:json!({"name":string}), required:&["name"]},
        Tool {name:"stash_save", description:"Stash tracked and untracked changes.", access:1, properties:json!({"message":{"type":"string","maxLength":1000}}), required:&[]},
        Tool {name:"save_checkpoint", description:"Save tracked and untracked work for recovery (ignored files excluded).", access:1, properties:json!({"label":{"type":"string","minLength":1,"maxLength":200}}), required:&["label"]},
        Tool {name:"discard_files", description:"Discard selected unstaged file IDs after checkpointing. Staged changes stay.", access:2, properties:json!({"files":files}), required:&["files"]},
        Tool {name:"reset", description:"Reset the current branch after checkpointing. Published history is protected.", access:2, properties:json!({"reference":string,"mode":{"type":"string","enum":["soft","mixed","hard"]}}), required:&["reference","mode"]},
        Tool {name:"restore_checkpoint", description:"Restore a checkpoint's tracked tree after saving current work.", access:2, properties:json!({"oid":string}), required:&["oid"]},
        Tool {name:"drop_stash", description:"Drop a stash after checkpointing; retain its full contents at the returned recoveryRef.", access:2, properties:json!({"index":{"type":"integer","minimum":0,"maximum":u32::MAX},"message":string}), required:&["index","message"]},
    ]
}

impl Tool {
    fn schema(&self) -> Value {
        let mut properties = self.properties.clone();
        properties["repo"] = json!({"type":"string","minLength":1,"maxLength":32768,"description":"Override --repo for this call. Only use repositories whose Git config and hooks you trust."});
        json!({"type":"object","properties":properties,"required":self.required,"additionalProperties":false})
    }

    fn description(&self) -> Value {
        json!({"name":self.name,"description":self.description,"inputSchema":self.schema(),
            "annotations":{"readOnlyHint":self.access == 0,"destructiveHint":self.access == 2,"openWorldHint":false}})
    }

    fn validate(&self, args: &Map<String, Value>) -> Result<()> {
        for name in self.required {
            if !args.contains_key(*name) {
                return Err(format!("Missing argument: {name}"));
            }
        }
        let schema = self.schema();
        for (name, value) in args {
            let spec = &schema["properties"][name];
            let valid = match spec["type"].as_str() {
                Some("string") => value.as_str().is_some_and(|s| {
                    !s.contains('\0')
                        && s.len() >= spec["minLength"].as_u64().unwrap_or(0) as usize
                        && s.len() <= spec["maxLength"].as_u64().unwrap_or(32768) as usize
                        && spec["enum"]
                            .as_array()
                            .is_none_or(|values| values.contains(value))
                }),
                Some("integer") => value.as_u64().is_some_and(|n| {
                    n >= spec["minimum"].as_u64().unwrap_or(0)
                        && n <= spec["maximum"].as_u64().unwrap_or(u64::MAX)
                }),
                Some("array") => value.as_array().is_some_and(|values| {
                    !values.is_empty()
                        && values.len() <= 1000
                        && values.iter().all(|v| {
                            v.as_str().is_some_and(|s| {
                                !s.is_empty() && s.len() <= 32768 && !s.contains('\0')
                            })
                        })
                }),
                _ => false,
            };
            if !valid {
                return Err(format!("Invalid or unknown argument: {name}"));
            }
        }
        Ok(())
    }
}

fn string<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn required<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    string(args, key).ok_or_else(|| format!("Missing argument: {key}"))
}

fn number(args: &Map<String, Value>, key: &str, default: u64) -> u64 {
    args.get(key).and_then(Value::as_u64).unwrap_or(default)
}

fn value(data: impl Serialize) -> Result<Value> {
    serde_json::to_value(data).map_err(|e| e.to_string())
}

fn resolve(repo: &Repository, reference: &str) -> Result<String> {
    if reference.is_empty()
        || reference.len() > 32768
        || reference.contains('\0')
        || reference.starts_with('-')
    {
        return Err("Choose a valid commit reference".into());
    }
    let oid = text(line(&read(
        &repo.root,
        &argv(&[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ]),
    )?));
    valid_oid(&oid)?;
    Ok(oid)
}

fn path(args: &Map<String, Value>) -> Result<Option<&str>> {
    let path = string(args, "path");
    if let Some(path) = path {
        relative_path(path.as_bytes())?;
    }
    Ok(path)
}

fn call(name: &str, args: &Map<String, Value>, default_repo: &Path) -> Result<Value> {
    let mut backend = Backend::default();
    let root = string(args, "repo").map(Path::new).unwrap_or(default_repo);
    let info = backend.open(root.to_str().ok_or("Repository path is not valid UTF-8")?)?;
    let id = info.id;
    let token = &info.token;
    match name {
        "status" => value(info),
        "branches" | "tags" => value(
            backend
                .repo(id)?
                .refs()?
                .into_iter()
                .filter(|r| {
                    if name == "tags" {
                        r.kind == "tag"
                    } else {
                        matches!(r.kind.as_str(), "local" | "remote")
                    }
                })
                .collect::<Vec<_>>(),
        ),
        "log" | "file_history" => {
            let repo = backend.repo(id)?;
            let path = path(args)?;
            let reference = string(args, if name == "log" { "branch" } else { "reference" });
            let oid = match reference {
                Some(reference) => resolve(repo, reference)?,
                None => match info.head {
                    Some(head) => head,
                    None => return value(""),
                },
            };
            let mut command = argv(&[
                "log",
                "--no-show-signature",
                "--encoding=UTF-8",
                "--format=%H %aI %an%n%s%n",
                &format!("--max-count={}", number(args, "limit", 50)),
            ]);
            if name == "file_history" {
                command.push(os("--follow"));
            }
            command.extend([os(&oid), os("--")]);
            if let Some(path) = path {
                command.push(os(path));
            }
            value(preview(&repo.root, &command)?)
        }
        "show_commit" => {
            let oid = resolve(backend.repo(id)?, required(args, "reference")?)?;
            value(backend.commit_details(id, &oid, None)?)
        }
        "diff" => {
            let mode = string(args, "mode").unwrap_or("working");
            let path = path(args)?;
            let from = string(args, "from");
            let to = string(args, "to");
            if mode != "refs" && (from.is_some() || to.is_some()) {
                return Err("Set mode to refs when supplying from/to".into());
            }
            if mode == "working" {
                if let Some(file) =
                    path.and_then(|p| info.files.iter().find(|f| f.path == p && f.untracked))
                {
                    return value(backend.working_diff(id, &file.id, false)?);
                }
            }
            let repo = backend.repo(id)?;
            let mut command = argv(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--submodule=short",
            ]);
            if mode == "staged" {
                command.push(os("--cached"));
            }
            if mode == "refs" {
                command.push(os(&resolve(repo, from.ok_or("refs diff needs from")?)?));
                command.push(os(&resolve(repo, to.ok_or("refs diff needs to")?)?));
            }
            command.push(os("--"));
            if let Some(path) = path {
                command.push(os(path));
            }
            value(preview(&repo.root, &command)?)
        }
        "stashes" => value(backend.stashes(id)?),
        "blame" => {
            let repo = backend.repo(id)?;
            let path = path(args)?.ok_or("blame needs path")?;
            let oid = resolve(repo, string(args, "reference").unwrap_or("HEAD"))?;
            let start = number(args, "start_line", 1);
            let end = number(
                args,
                "end_line",
                start.saturating_add(4999).min(i32::MAX as u64),
            );
            if end < start || end - start >= 5000 {
                return Err("Choose a range of 1 to 5000 lines".into());
            }
            value(preview(
                &repo.root,
                &argv(&[
                    "blame",
                    "--porcelain",
                    "-L",
                    &format!("{start},{end}"),
                    &oid,
                    "--",
                    path,
                ]),
            )?)
        }
        "list_checkpoints" => value(backend.checkpoints(id)?),
        "code_search" => value(crate::codemap::search(
            Path::new(&info.root),
            required(args, "query")?,
            number(args, "limit", 20),
        )?),
        "stage" | "unstage" | "discard_files" => {
            let files = args["files"]
                .as_array()
                .ok_or("Choose files")?
                .iter()
                .map(|v| v.as_str().unwrap_or_default().to_owned())
                .collect::<Vec<_>>();
            if name == "discard_files" {
                value(backend.discard(id, &files, token)?)
            } else {
                value(backend.stage(id, &files, name == "unstage", token)?)
            }
        }
        "commit" => {
            value(backend.commit(id, required(args, "message")?, token, false, None, false)?)
        }
        "create_branch" => {
            let oid = string(args, "reference")
                .map(|r| resolve(backend.repo(id)?, r))
                .transpose()?;
            value(backend.create_branch(id, required(args, "name")?, oid, token)?)
        }
        "switch_branch" => {
            let name = required(args, "name")?;
            let reference = backend
                .repo(id)?
                .refs()?
                .into_iter()
                .find(|r| r.kind == "local" && r.name == name)
                .ok_or("Choose an existing local branch")?;
            value(backend.switch_branch(id, &reference.id, token)?)
        }
        "stash_save" => {
            value(backend.stash_save(id, string(args, "message").unwrap_or(""), token)?)
        }
        "save_checkpoint" => value(backend.checkpoint(id, required(args, "label")?)?),
        "reset" => {
            let oid = resolve(backend.repo(id)?, required(args, "reference")?)?;
            backend.repo(id)?.save_checkpoint("Before MCP reset")?;
            value(backend.reset_commit(id, &oid, required(args, "mode")?, token)?)
        }
        "restore_checkpoint" => {
            value(backend.restore_checkpoint(id, required(args, "oid")?, token)?)
        }
        "drop_stash" => {
            let index = number(args, "index", 0) as u32;
            let message = required(args, "message")?;
            backend.same_stash(id, index, message)?;
            let repo = backend.repo(id)?;
            repo.save_checkpoint("Before dropping a stash via MCP")?;
            let oid = resolve(repo, &format!("stash@{{{index}}}"))?;
            // Keep all stash parents, including the untracked tree, reachable after dropping its reflog entry.
            let recovery_ref = format!("refs/gitgui/mcp-dropped-stashes/{oid}");
            repo.write(
                &argv(&["update-ref", &recovery_ref, &oid]),
                None,
                None,
                None,
            )?;
            value(
                json!({"status":backend.stash_drop(id,index,message,token)?,"recoveryRef":recovery_ref}),
            )
        }
        _ => Err("Unknown tool".into()),
    }
}

fn tool_result(result: Result<Value>) -> Value {
    let (data, is_error) = match result {
        Ok(value) => (
            value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string()),
            false,
        ),
        Err(error) => (error, true),
    };
    let mut text = redact(&data);
    if text.len() > RESULT_LIMIT {
        let notice = "\n[Result truncated at 64 KiB; narrow the path, limit, or line range.]";
        let mut end = RESULT_LIMIT - notice.len();
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str(notice);
    }
    json!({"content":[{"type":"text","text":text}],"isError":is_error})
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

/// Serve newline-delimited JSON-RPC until stdin closes. Stdout contains protocol messages only.
pub fn serve(
    mut input: impl BufRead,
    mut output: impl Write,
    default_repo: &Path,
) -> io::Result<()> {
    let allow_write = std::env::var("GITGUI_MCP_ALLOW_WRITE").as_deref() == Ok("1");
    let allow_destructive = std::env::var("GITGUI_MCP_ALLOW_DESTRUCTIVE").as_deref() == Ok("1");
    let tools = tools()
        .into_iter()
        .filter(|t| {
            t.access == 0 || (t.access == 1 && allow_write) || (t.access == 2 && allow_destructive)
        })
        .collect::<Vec<_>>();
    let mut initialized = false;
    loop {
        let mut line = Vec::new();
        if input
            .by_ref()
            .take((REQUEST_LIMIT + 1) as u64)
            .read_until(b'\n', &mut line)?
            == 0
        {
            return Ok(());
        }
        let response = if line.len() > REQUEST_LIMIT {
            if line.last() != Some(&b'\n') {
                input.skip_until(b'\n')?;
            }
            error(Value::Null, -32600, "Request exceeds 1 MiB")
        } else {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            match serde_json::from_slice::<Value>(&line) {
                Err(_) => error(Value::Null, -32700, "Invalid JSON"),
                Ok(request) => {
                    let id = request.get("id").cloned();
                    let method = request["method"].as_str();
                    if !request.is_object()
                        || request["jsonrpc"] != "2.0"
                        || method.is_none()
                        || id.as_ref().is_some_and(|id| {
                            !id.is_string() && id.as_i64().is_none() && id.as_u64().is_none()
                        })
                        || request
                            .get("params")
                            .is_some_and(|p| !p.is_object() && !p.is_array())
                    {
                        error(Value::Null, -32600, "Invalid JSON-RPC request")
                    } else {
                        let Some(id) = id else {
                            continue;
                        }; // Notifications never execute tools or get responses.
                        let result = match method.unwrap_or_default() {
                            "ping" => Ok(json!({})),
                            "initialize" => {
                                if initialized {
                                    Err((-32600, "Already initialized"))
                                } else if request["params"]["protocolVersion"].as_str().is_none() {
                                    Err((-32602, "Missing protocolVersion"))
                                } else {
                                    initialized = true;
                                    let requested = request["params"]["protocolVersion"]
                                        .as_str()
                                        .unwrap_or(PROTOCOL);
                                    let protocol =
                                        if [PROTOCOL, "2025-06-18", "2025-03-26", "2024-11-05"]
                                            .contains(&requested)
                                        {
                                            requested
                                        } else {
                                            PROTOCOL
                                        };
                                    Ok(
                                        json!({"protocolVersion":protocol,"capabilities":{"tools":{}},"serverInfo":{"name":"gitgui-mcp","version":env!("CARGO_PKG_VERSION")}}),
                                    )
                                }
                            }
                            "tools/list" | "tools/call" if !initialized => {
                                Err((-32000, "Initialize first"))
                            }
                            "tools/list" => Ok(
                                json!({"tools":tools.iter().map(Tool::description).collect::<Vec<_>>()}),
                            ),
                            "tools/call" => Ok(tool_result((|| {
                                let name = request["params"]["name"]
                                    .as_str()
                                    .ok_or("Missing tool name")?;
                                let tool = tools
                                    .iter()
                                    .find(|t| t.name == name)
                                    .ok_or("Tool is unknown or disabled")?;
                                let empty = Map::new();
                                let args = match request["params"].get("arguments") {
                                    Some(args) => args
                                        .as_object()
                                        .ok_or("Tool arguments must be an object")?,
                                    None => &empty,
                                };
                                tool.validate(args)?;
                                call(name, args, default_repo)
                            })())),
                            _ => Err((-32601, "Method not found")),
                        };
                        match result {
                            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                            Err((code, message)) => error(id, code, message),
                        }
                    }
                }
            }
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
}
