use gitgui_lib::{
    assist::chat::{Permission, ToolCall},
    git::Backend,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn git(root: &Path, args: &[&str]) -> String {
    let output = gitgui_lib::platform::command("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}
fn call(name: &str, input: Value) -> ToolCall {
    ToolCall {
        id: "test".into(),
        name: name.into(),
        input,
    }
}
#[test]
fn tools_require_permission_and_approval_and_preserve_work_in_checkpoints() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Assistant Test"),
        ("user.email", "test@example.invalid"),
        ("commit.gpgsign", "false"),
    ] {
        git(root, &["config", key, value]);
    }
    git(
        root,
        &[
            "config",
            "core.hooksPath",
            root.join("no-hooks").to_str().unwrap(),
        ],
    );
    fs::write(root.join("file.txt"), "original\n").unwrap();
    git(root, &["add", "file.txt"]);
    git(root, &["commit", "-m", "Initial"]);
    fs::write(root.join("file.txt"), "changed\n").unwrap();
    fs::write(root.join("new.txt"), "untracked\n").unwrap();
    let mut backend = Backend::default();
    let info = backend.open(root.to_str().unwrap()).unwrap();
    let stage = call(
        "stage",
        json!({"fileIds":info.files.iter().map(|f| f.id.clone()).collect::<Vec<_>>()}),
    );
    assert!(backend
        .assistant_tool(info.id, &stage, Permission::ReadOnly, true, &info.token)
        .is_err());
    assert!(backend
        .assistant_tool(info.id, &stage, Permission::Commits, false, &info.token)
        .is_err());
    assert!(backend.checkpoints(info.id).unwrap().is_empty());
    backend
        .assistant_tool(info.id, &stage, Permission::Commits, true, &info.token)
        .unwrap();
    let checkpoints = backend.checkpoints(info.id).unwrap();
    assert_eq!(checkpoints.len(), 1);
    assert_eq!(
        git(root, &["show", &format!("{}:new.txt", checkpoints[0].oid)]),
        "untracked"
    );
    let staged = backend.status(info.id).unwrap();
    assert!(backend
        .assistant_tool(
            info.id,
            &call("commit", json!({"message":"Saved"})),
            Permission::Commits,
            true,
            &info.token
        )
        .is_err());
    backend
        .assistant_tool(
            info.id,
            &call("diff", json!({"staged":true})),
            Permission::ReadOnly,
            false,
            "",
        )
        .unwrap();
    backend
        .assistant_tool(
            info.id,
            &call("commit", json!({"message":"Saved"})),
            Permission::Commits,
            true,
            &staged.token,
        )
        .unwrap();
    let clean = backend.status(info.id).unwrap();
    let shown = backend
        .assistant_tool(
            info.id,
            &call("show_file", json!({"oid":clean.head,"path":"file.txt"})),
            Permission::ReadOnly,
            false,
            "",
        )
        .unwrap();
    assert!(shown.contains("changed"));
    for input in [
        json!({"oid":"HEAD","path":"file.txt"}),
        json!({"oid":clean.head,"path":"../secret"}),
    ] {
        assert!(backend
            .assistant_tool(
                info.id,
                &call("show_file", input),
                Permission::Everything,
                false,
                ""
            )
            .is_err());
    }
    let branch = call("create_branch", json!({"name":"assistant-test"}));
    assert!(backend
        .assistant_tool(info.id, &branch, Permission::Commits, true, &clean.token)
        .is_err());
    backend
        .assistant_tool(info.id, &branch, Permission::Everything, true, &clean.token)
        .unwrap();
    let info = backend.status(info.id).unwrap();
    let branches: Value = serde_json::from_str(
        &backend
            .assistant_tool(
                info.id,
                &call("branches", json!({})),
                Permission::ReadOnly,
                false,
                "",
            )
            .unwrap(),
    )
    .unwrap();
    let main = branches
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["name"] == "main")
        .unwrap()["id"]
        .clone();
    backend
        .assistant_tool(
            info.id,
            &call("switch_branch", json!({"referenceId":main})),
            Permission::Everything,
            true,
            &info.token,
        )
        .unwrap();
    fs::write(root.join("newer.txt"), "keep me").unwrap();
    let dirty = backend.status(info.id).unwrap();
    backend
        .assistant_tool(
            info.id,
            &call("stash", json!({"message":"Assistant stash"})),
            Permission::Everything,
            true,
            &dirty.token,
        )
        .unwrap();
    assert!(backend.status(info.id).unwrap().files.is_empty());
    assert_eq!(backend.stashes(info.id).unwrap().len(), 1);
    assert!(backend.checkpoints(info.id).unwrap().len() >= 2);
    assert!(backend
        .assistant_tool(
            info.id,
            &call("shell", json!({"command":"rm -rf ."})),
            Permission::Everything,
            true,
            ""
        )
        .is_err());
}
