//! Process spawning that works the same on Linux, macOS, and Windows.
use std::{ffi::OsStr, process::Command};

/// A command for an external program. Child processes must not inherit the running AppImage's
/// launcher variables, and on Windows they must not open a console window.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    for var in [
        "APPIMAGE",
        "APPDIR",
        "ARGV0",
        "OWD",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "TARGET_APPIMAGE",
        "REDIRECT_APPIMAGE",
        "APPIMAGE_SILENT_INSTALL",
    ] {
        command.env_remove(var);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Runs a command line through the platform shell, in its own process group so `kill_tree` stops its children too.
pub fn shell(line: &str) -> Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut shell = command("sh");
        shell.args(["-c", line]).process_group(0);
        shell
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut shell = command("cmd");
        shell.arg("/C").raw_arg(line);
        shell
    }
}

/// Stops process `pid` and everything it started.
pub fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        // The negative pid signals the whole process group, including dev servers started by npm.
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = command("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .status();
    }
}

/// Opens a URL in the default browser.
pub fn open_url(url: &str) -> Result<(), String> {
    let mut opener = if cfg!(target_os = "macos") {
        command("open")
    } else if cfg!(windows) {
        // Unlike `cmd /C start`, this does not reinterpret `&` in query strings.
        let mut c = command("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else {
        command("xdg-open")
    };
    opener
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Cannot open the browser: {e}. Visit {url}"))
}

/// Today's local date as YYYY-MM-DD.
pub fn today() -> Result<String, String> {
    let out = if cfg!(windows) {
        command("powershell")
            .args(["-NoProfile", "-Command", "Get-Date -Format yyyy-MM-dd"])
            .output()
    } else {
        command("date").arg("+%F").output()
    }
    .map_err(|e| format!("Cannot read the date: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_runs_a_command_line_and_reports_today() {
        let out = shell("echo hi").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
        let date = today().unwrap();
        assert!(date.len() == 10 && date.as_bytes()[4] == b'-', "{date}");
    }
}
