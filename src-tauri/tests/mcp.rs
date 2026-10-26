use gitgui_lib::platform::command;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Stdio},
};
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> String {
    let output = command("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", root.join("empty-config"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}

fn repo() -> TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "MCP Test"]);
    git(root, &["config", "user.email", "mcp@example.invalid"]);
    git(root, &["config", "commit.gpgsign", "false"]);
    git(root, &["config", "core.autocrlf", "false"]);
    git(
        root,
        &[
            "config",
            "core.hooksPath",
            root.join(".git/hooks").to_str().unwrap(),
        ],
    );
    fs::write(root.join("file.txt"), "first\nsecond\n").unwrap();
    git(root, &["add", "file.txt"]);
    git(root, &["commit", "-m", "initial"]);
    temp
}

struct Server {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: u64,
}

impl Server {
    fn new(root: &Path, write: bool, destructive: bool, repo_arg: bool) -> Self {
        let mut cmd = command(env!("CARGO_BIN_EXE_gitgui-mcp"));
        cmd.current_dir(root)
            .env_remove("GITGUI_MCP_ALLOW_WRITE")
            .env_remove("GITGUI_MCP_ALLOW_DESTRUCTIVE")
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", root.join("empty-config"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if repo_arg {
            cmd.arg("--repo").arg(root);
        }
        if write {
            cmd.env("GITGUI_MCP_ALLOW_WRITE", "1");
        }
        if destructive {
            cmd.env("GITGUI_MCP_ALLOW_DESTRUCTIVE", "1");
        }
        let mut child = cmd.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut server = Self {
            child,
            input,
            output,
            sequence: 0,
        };
        let init = server.request("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}));
        assert_eq!(init["result"]["serverInfo"]["name"], "gitgui-mcp");
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
        server.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        server
    }

    fn send(&mut self, value: Value) {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(
            self.output.read_line(&mut line).unwrap() > 0,
            "Server exited"
        );
        serde_json::from_str(&line).unwrap()
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.sequence += 1;
        self.send(json!({"jsonrpc":"2.0","id":self.sequence,"method":method,"params":params}));
        let response = self.read();
        assert_eq!(response["id"], self.sequence);
        response
    }

    fn tool(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name":name,"arguments":arguments}))["result"].clone()
    }

    fn ok(&mut self, name: &str, args: Value) -> String {
        let result = self.tool(name, args);
        assert_eq!(result["isError"], false, "{name}: {result}");
        result["content"][0]["text"].as_str().unwrap().into()
    }

    fn data(&mut self, name: &str, args: Value) -> Value {
        serde_json::from_str(&self.ok(name, args)).unwrap()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn handshake_status_permissions_and_protocol_errors() {
    let temp = repo();
    let mut server = Server::new(temp.path(), false, false, false);
    let list = server.request("tools/list", json!({}));
    let tools = list["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 11);
    assert!(tools
        .iter()
        .all(|t| t["annotations"]["readOnlyHint"] == true));
    assert!(tools
        .iter()
        .all(|t| t["inputSchema"]["properties"]["repo"]["type"] == "string"));
    assert!(tools.iter().any(|t| t["name"] == "code_search"));
    let status = server.data("status", json!({}));
    assert_eq!(status["branch"], "main");
    assert!(status["files"].as_array().unwrap().is_empty());
    for name in ["stage", "commit", "reset", "drop_stash"] {
        assert_eq!(server.tool(name, json!({}))["isError"], true);
    }
    // A notification cannot write, and must not insert an extra response before the ping.
    server.send(json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"commit","arguments":{"message":"no"}}}));
    assert_eq!(server.request("ping", json!({}))["result"], json!({}));
    writeln!(server.input, "not json").unwrap();
    server.input.flush().unwrap();
    assert_eq!(server.read()["error"]["code"], -32700);
    server.send(json!([{"jsonrpc":"2.0","id":42,"method":"ping"}]));
    assert_eq!(server.read()["error"]["code"], -32600);
    assert_eq!(
        server.request("unknown", json!({}))["error"]["code"],
        -32601
    );
    server.send(json!({"jsonrpc":"2.0","id":"string-id","method":"ping"}));
    assert_eq!(server.read()["id"], "string-id");
    writeln!(server.input, "{}", "x".repeat(1024 * 1024 + 1)).unwrap();
    server.input.flush().unwrap();
    assert_eq!(server.read()["error"]["code"], -32600);
    assert_eq!(server.request("ping", json!({}))["result"], json!({}));
}

#[test]
fn read_tools_filters_validation_redaction_and_limits() {
    let temp = repo();
    let root = temp.path();
    git(root, &["branch", "before"]);
    git(root, &["tag", "v-test"]);
    fs::write(root.join("other.txt"), "other\n").unwrap();
    git(root, &["add", "other.txt"]);
    git(root, &["commit", "-m", "other change"]);
    git(
        root,
        &[
            "remote",
            "add",
            "origin",
            "https://user:password@example.invalid/repo.git",
        ],
    );
    let mut server = Server::new(root, false, false, true);
    assert!(!server.ok("status", json!({})).contains("password"));
    assert_eq!(
        server.tool("code_search", json!({"query":"Backend"}))["isError"],
        true
    );
    assert!(!root.join(".code-review-graph").exists());
    let log = server.ok("log", json!({"limit":1}));
    assert!(log.contains("other change") && !log.contains("initial"));
    let log = server.ok("log", json!({"branch":"before","path":"file.txt"}));
    assert!(log.contains("initial") && !log.contains("other change"));
    assert!(server
        .ok("file_history", json!({"path":"file.txt"}))
        .contains("initial"));
    assert!(server
        .ok("blame", json!({"path":"file.txt","end_line":2}))
        .contains("MCP Test"));
    assert!(server.data("branches", json!({})).as_array().unwrap().len() >= 2);
    assert_eq!(server.data("tags", json!({}))[0]["name"], "v-test");
    assert_eq!(
        server.data("show_commit", json!({"reference":"HEAD"}))["message"],
        "other change"
    );
    assert!(server
        .ok("diff", json!({"mode":"refs","from":"before","to":"HEAD"}))
        .contains("other.txt"));
    fs::write(root.join("file.txt"), "working\n").unwrap();
    assert!(server
        .ok("diff", json!({"path":"file.txt"}))
        .contains("working"));
    git(root, &["add", "file.txt"]);
    assert!(server
        .ok("diff", json!({"mode":"staged"}))
        .contains("working"));
    for (tool, args) in [
        ("log", json!({"limit":0})),
        ("log", json!({"branch":"--all"})),
        ("log", json!({"branch":"HEAD\u{0000}"})),
        ("diff", json!({"path":"../outside"})),
        ("diff", json!({"mode":"working","from":"HEAD"})),
        ("blame", json!({"path":"file.txt","start_line":0})),
        (
            "blame",
            json!({"path":"file.txt","start_line":5,"end_line":1}),
        ),
        ("status", json!({"repo":false})),
        ("status", json!({"extra":true})),
    ] {
        assert_eq!(server.tool(tool, args)["isError"], true, "{tool}");
    }
    fs::write(root.join("file.txt"), "🦀\n".repeat(30000)).unwrap();
    let diff = server.ok("diff", json!({}));
    assert!(diff.len() <= 64 * 1024 && diff.contains("Result truncated"));
    let other = repo();
    git(other.path(), &["branch", "-m", "override"]);
    assert_eq!(
        server.data("status", json!({"repo":other.path()}))["branch"],
        "override"
    );
}

#[test]
fn write_tools_and_checkpointed_destructive_tools() {
    let temp = repo();
    let root = temp.path();
    let mut server = Server::new(root, true, false, true);
    let list = server.request("tools/list", json!({}));
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 18);
    assert_eq!(
        server.tool("reset", json!({"reference":"HEAD","mode":"hard"}))["isError"],
        true
    );
    server.ok("create_branch", json!({"name":"feature"}));
    server.ok("switch_branch", json!({"name":"feature"}));
    fs::write(root.join("file.txt"), "to commit\n").unwrap();
    let status = server.data("status", json!({}));
    let files = json!([status["files"][0]["id"]]);
    server.ok("stage", json!({"files":files}));
    server.ok("unstage", json!({"files":files}));
    server.ok("stage", json!({"files":files}));
    server.ok("commit", json!({"message":"via MCP"}));
    assert_eq!(git(root, &["log", "-1", "--format=%s"]), "via MCP");
    fs::write(root.join("file.txt"), "checkpoint me\n").unwrap();
    let checkpoints = server.data("save_checkpoint", json!({"label":"manual"}));
    let oid = checkpoints[0]["oid"].clone();
    fs::write(root.join("untracked.txt"), "keep this too\n").unwrap();
    server.ok("stash_save", json!({"message":"saved"}));
    assert_eq!(
        server.data("stashes", json!({})).as_array().unwrap().len(),
        1
    );
    drop(server);
    let mut server = Server::new(root, false, true, true);
    let list = server.request("tools/list", json!({}));
    assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 15);
    assert_eq!(
        server.tool("commit", json!({"message":"disabled"}))["isError"],
        true
    );
    fs::write(root.join("file.txt"), "discard me\n").unwrap();
    let status = server.data("status", json!({}));
    server.ok("discard_files", json!({"files":[status["files"][0]["id"]]}));
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "to commit\n"
    );
    assert!(server
        .ok("list_checkpoints", json!({}))
        .contains("Before discarding"));
    server.ok("restore_checkpoint", json!({"oid":oid}));
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "checkpoint me\n"
    );
    for mode in ["soft", "mixed", "hard"] {
        server.ok("reset", json!({"reference":"HEAD","mode":mode}));
    }
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "to commit\n"
    );
    let stash = server.data("stashes", json!({}))[0].clone();
    let dropped = server.data(
        "drop_stash",
        json!({"index":stash["index"],"message":stash["message"]}),
    );
    assert!(server
        .data("stashes", json!({}))
        .as_array()
        .unwrap()
        .is_empty());
    let recovery = dropped["recoveryRef"].as_str().unwrap();
    git(root, &["stash", "apply", recovery]);
    assert_eq!(
        fs::read_to_string(root.join("file.txt")).unwrap(),
        "checkpoint me\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("untracked.txt")).unwrap(),
        "keep this too\n"
    );
}
