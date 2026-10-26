//! Runs the project being built (npm run dev, cargo run, ...) and streams its output.
use crate::git::Result;
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::Stdio,
    sync::Mutex,
};

static RUNNING: Mutex<Option<u32>> = Mutex::new(None);
// The packaged app's library and GTK paths would break the user's own tools.
const LAUNCHER_ENV: [&str; 12] = [
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "GTK_PATH",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GIO_EXTRA_MODULES",
    "GDK_PIXBUF_MODULE_FILE",
    "GSETTINGS_SCHEMA_DIR",
];

/// The command that starts this project: `git config gitgui.runCommand`, else a guess from its files.
pub fn command(root: &Path) -> Option<String> {
    let configured = crate::git::config(root, "gitgui.runCommand")
        .ok()
        .filter(|c| !c.is_empty());
    if configured.is_some() {
        return configured;
    }
    let package = std::fs::read_to_string(root.join("package.json")).ok();
    let scripts = package
        .and_then(|p| serde_json::from_str::<serde_json::Value>(&p).ok())
        .map(|v| v["scripts"].clone());
    for script in ["dev", "start"] {
        if scripts.as_ref().is_some_and(|s| s[script].is_string()) {
            return Some(format!("npm run {script}"));
        }
    }
    [
        ("Cargo.toml", "cargo run"),
        ("manage.py", "python3 manage.py runserver"),
        ("main.py", "python3 main.py"),
        ("app.py", "python3 app.py"),
        ("index.html", "python3 -m http.server 8000"),
    ]
    .into_iter()
    .find(|(file, _)| root.join(file).exists())
    .map(|(_, command)| command.to_owned())
}

/// Runs the project until it exits or is stopped, sending each output line; returns the exit description.
pub fn run(root: &Path, output: impl Fn(String)) -> Result<String> {
    let command = command(root).ok_or("GitGUI could not tell how to start this project. Set it with: git config gitgui.runCommand \"<command>\"")?;
    let mut guard = RUNNING.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("The project is already running. Stop it first.".into());
    }
    let line = if cfg!(windows) {
        format!("({command}) 2>&1")
    } else {
        format!("exec 2>&1; {command}")
    };
    let mut process = crate::platform::shell(&line);
    process
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
    for variable in LAUNCHER_ENV {
        process.env_remove(variable);
    }
    let mut child = process
        .spawn()
        .map_err(|e| format!("Cannot start {command}: {e}"))?;
    *guard = Some(child.id());
    drop(guard);
    output(format!("$ {command}"));
    for line in BufReader::new(child.stdout.take().unwrap())
        .split(b'\n')
        .map_while(|l| l.ok())
    {
        output(String::from_utf8_lossy(&line).trim_end().to_owned());
    }
    let status = child.wait().map_err(|e| e.to_string());
    RUNNING.lock().map_err(|e| e.to_string())?.take();
    Ok(status?.to_string())
}

pub fn stop() -> Result<()> {
    if let Some(pid) = *RUNNING.lock().map_err(|e| e.to_string())? {
        crate::platform::kill_tree(pid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    #[test]
    fn projects_are_detected_and_run_output_is_streamed() {
        let dir = std::env::temp_dir().join(format!("gitgui-run-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(Command::new("git")
            .current_dir(&dir)
            .args(["init", "-q"])
            .status()
            .unwrap()
            .success());
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"start":"node ."}}"#,
        )
        .unwrap();
        assert_eq!(super::command(&dir).as_deref(), Some("npm run start"));
        Command::new("git")
            .current_dir(&dir)
            .args([
                "config",
                "gitgui.runCommand",
                "echo hi; echo oops >&2; exit 3",
            ])
            .status()
            .unwrap();
        let lines = std::sync::Mutex::new(Vec::new());
        let status = super::run(&dir, |l| lines.lock().unwrap().push(l)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(status.contains('3'), "{status}");
        assert_eq!(lines.into_inner().unwrap()[1..], ["hi", "oops"]);
    }
}
