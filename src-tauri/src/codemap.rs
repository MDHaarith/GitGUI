//! Code map: indexes a repository with code-review-graph so agents and the visualizer can search it.
use crate::git::Result;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn cli() -> Command {
    // Desktop launches often miss ~/.local/bin (pip --user, pipx, uv tool) on PATH.
    let local = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".local/bin/code-review-graph"))
        .filter(|path| path.is_file());
    let mut command = crate::platform::command(local.unwrap_or_else(|| "code-review-graph".into()));
    command.stdin(Stdio::null());
    command
}

/// Searches the existing index without rebuilding or changing repository files.
pub fn search(root: &Path, query: &str, limit: u64) -> Result<String> {
    if !root.join(".code-review-graph/graph.db").is_file() {
        return Err("No code index found. Install code-review-graph and run code-review-graph build --repo <path> first.".into());
    }
    let output = cli()
        .args(["search", "--repo"])
        .arg(root)
        .args(["--limit", &limit.to_string(), "--", query])
        .output()
        .map_err(|_| "code-review-graph is not installed. Install it with: pip install --user code-review-graph".to_owned())?;
    if !output.status.success() {
        return Err(crate::git::redact(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Builds the index in the background; skipped silently when code-review-graph is not installed.
pub fn index(root: &Path) {
    let root = root.to_owned();
    std::thread::spawn(move || {
        let _ = cli()
            .args(["build", "--repo"])
            .arg(&root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    });
}

fn run(root: &Path, args: &[&str]) -> Result<()> {
    let output = cli().args(args).arg("--repo").arg(root).output().map_err(|_| {
        "code-review-graph is not installed. Install it with: pip install --user code-review-graph"
            .to_owned()
    })?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "code-review-graph {} failed: {}",
        args[0],
        stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no output")
            .trim()
    ))
}

/// Brings the index up to date (full build on first use or when asked) and returns it as JSON.
pub fn load(root: &Path, rebuild: bool) -> Result<String> {
    let dir = root.join(".code-review-graph");
    let fresh = rebuild || !dir.join("graph.db").exists();
    run(root, &[if fresh { "build" } else { "update" }])?;
    run(root, &["visualize", "--format", "json"])?;
    std::fs::read_to_string(dir.join("graph.json"))
        .map_err(|e| format!("Cannot read the code index: {e}"))
}
