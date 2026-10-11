//! Running Git safely: process spawning, bounded output, redaction, and byte/path helpers.
use super::*;

pub(super) struct Output {
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: String,
    pub(super) ok: bool,
    pub(super) truncated: bool,
}
pub(super) fn os(s: &str) -> OsString {
    OsString::from(s)
}
pub(super) fn argv(s: &[&str]) -> Vec<OsString> {
    s.iter().map(|v| os(v)).collect()
}
pub(super) fn raw(s: &OsStr) -> &[u8] {
    #[cfg(unix)]
    {
        s.as_bytes()
    }
    #[cfg(not(unix))]
    {
        s.as_encoded_bytes()
    }
}
pub(super) fn from_bytes(s: &[u8]) -> OsString {
    #[cfg(unix)]
    {
        OsString::from_vec(s.to_vec())
    }
    #[cfg(not(unix))]
    {
        OsString::from(String::from_utf8_lossy(s).into_owned())
    }
}
pub(super) fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
pub(super) fn line(data: &[u8]) -> &[u8] {
    data.strip_suffix(b"\n").unwrap_or(data)
}
pub(super) fn text(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}
pub(super) fn display(data: &[u8]) -> String {
    if let Ok(value) = std::str::from_utf8(data) {
        value
            .chars()
            .flat_map(|c| {
                if c.is_control() {
                    c.escape_default().collect::<Vec<_>>()
                } else {
                    vec![c]
                }
            })
            .collect()
    } else {
        data.iter()
            .map(|b| {
                if b.is_ascii_graphic() || *b == b' ' {
                    char::from(*b).to_string()
                } else {
                    format!("\\x{b:02x}")
                }
            })
            .collect()
    }
}
pub fn redact(message: &str) -> String {
    let mut out = message.to_owned();
    let mut offset = 0;
    while let Some(found) = out[offset..].find("://") {
        let start = offset + found + 3;
        let end = out[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '\'' | '"'))
            .map_or(out.len(), |i| start + i);
        if let Some(at) = out[start..end].rfind('@') {
            out.replace_range(start..start + at, "[redacted]");
            offset = start + 10;
        } else {
            offset = end;
        }
        if offset >= out.len() {
            break;
        }
    }
    out
}
pub(super) fn report_progress(progress: &Option<Progress>, line: &[u8], sent: &mut usize) {
    if let Some(progress) = progress {
        let message = display(redact(&text(line)).as_bytes());
        if !message.trim().is_empty() && *sent + message.len() <= 64 * 1024 {
            *sent += message.len();
            progress(message);
        }
    }
}
pub(super) fn drain(
    mut reader: impl Read,
    limit: usize,
    progress: Option<Progress>,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut saved = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    let mut pending = Vec::new();
    let mut oversized = false;
    let mut sent = 0;
    loop {
        match reader.read(&mut buffer)? {
            0 => break,
            n => {
                let keep = n.min(limit.saturating_sub(saved.len()));
                saved.extend_from_slice(&buffer[..keep]);
                truncated |= keep < n;
                if progress.is_some() && sent < 64 * 1024 {
                    for &byte in &buffer[..n] {
                        if matches!(byte, b'\r' | b'\n') {
                            if !oversized {
                                report_progress(&progress, &pending, &mut sent);
                            }
                            pending.clear();
                            oversized = false;
                        } else if pending.len() < 4096 {
                            pending.push(byte);
                        } else {
                            // Drop oversized lines entirely so truncated credentials cannot be exposed.
                            oversized = true;
                        }
                    }
                }
            }
        }
    }
    if !oversized {
        report_progress(&progress, &pending, &mut sent);
    }
    Ok((saved, truncated))
}
pub(super) fn execute(
    root: &Path,
    args: &[OsString],
    input: Option<&[u8]>,
    limit: usize,
    timeout: Option<Duration>,
    progress: Option<Progress>,
) -> Result<Output> {
    let mut command = Command::new(if cfg!(target_os = "linux") {
        "/usr/bin/git"
    } else {
        "git"
    });
    command
        .current_dir(root)
        .args([
            "--no-pager",
            "--no-replace-objects",
            "--literal-pathspecs",
            "-c",
            "color.ui=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "log.showSignature=false",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for variable in [
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
        // The packaged app's libraries break hooks and test commands run by Git.
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
    ] {
        command.env_remove(variable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Git: {e}. Install Git and ensure it is on PATH."))?;
    let stdout = child.stdout.take().ok_or("Git stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Git stderr unavailable")?;
    let out_reader = thread::spawn(move || drain(stdout, limit, None));
    let err_reader = thread::spawn(move || drain(stderr, 64 * 1024, progress));
    if let Some(data) = input {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(data);
        }
    }
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if timeout.is_some_and(|duration| start.elapsed() > duration) {
            timed_out = true;
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            break child.wait().map_err(|e| e.to_string())?;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let capture_deadline = Instant::now() + Duration::from_secs(2);
    while (!out_reader.is_finished() || !err_reader.is_finished())
        && Instant::now() < capture_deadline
    {
        thread::sleep(Duration::from_millis(10));
    }
    if !out_reader.is_finished() || !err_reader.is_finished() {
        return Err("Git exited but a hook or helper kept its output stream open. The action may have completed; refresh before retrying.".into());
    }
    let (stdout, truncated) = out_reader
        .join()
        .map_err(|_| "Git output reader failed")?
        .map_err(|e| e.to_string())?;
    let (stderr, _) = err_reader
        .join()
        .map_err(|_| "Git error reader failed")?
        .map_err(|e| e.to_string())?;
    if timed_out {
        return Err("Git timed out. Refresh repository state before retrying; check credentials or the remote connection.".into());
    }
    Ok(Output {
        stdout,
        stderr: redact(&text(&stderr)),
        ok: status.success(),
        truncated,
    })
}
pub(super) fn read(root: &Path, args: &[OsString]) -> Result<Vec<u8>> {
    let output = execute(
        root,
        args,
        None,
        DATA_LIMIT,
        Some(Duration::from_secs(30)),
        None,
    )?;
    if !output.ok {
        return Err(if output.stderr.trim().is_empty() {
            "Git command failed".into()
        } else {
            output.stderr.trim().to_owned()
        });
    }
    if output.truncated {
        return Err("Git output exceeds the supported limit. Narrow the history scope or reduce the file list.".into());
    }
    Ok(output.stdout)
}
pub(super) fn optional(root: &Path, args: &[&str]) -> Result<Option<Vec<u8>>> {
    let output = execute(
        root,
        &argv(args),
        None,
        DATA_LIMIT,
        Some(Duration::from_secs(30)),
        None,
    )?;
    if output.truncated {
        return Err("Git output exceeds the supported limit".into());
    }
    Ok(output.ok.then(|| line(&output.stdout).to_vec()))
}
pub(super) fn valid_oid(oid: &str) -> Result<()> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Invalid commit object ID".into())
    }
}

pub(super) fn preview(root: &Path, args: &[OsString]) -> Result<Preview> {
    let output = execute(
        root,
        args,
        None,
        PREVIEW_LIMIT,
        Some(Duration::from_secs(30)),
        None,
    )?;
    if !output.ok {
        return Err(output.stderr.trim().to_owned());
    }
    let binary = output.stdout.contains(&0) || std::str::from_utf8(&output.stdout).is_err();
    Ok(Preview {
        text: if binary {
            "Binary file preview is unavailable.".into()
        } else {
            text(&output.stdout)
        },
        truncated: output.truncated,
        binary,
    })
}
pub(super) fn decode_hex(id: &str) -> Result<Vec<u8>> {
    if id.len() > 32768 || !id.len().is_multiple_of(2) || !id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid file or ref ID".into());
    }
    (0..id.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&id[i..i + 2], 16).map_err(|_| "Invalid file or ref ID".into()))
        .collect()
}
pub(super) fn relative_path(path: &[u8]) -> Result<()> {
    let name = from_bytes(path);
    if path.is_empty()
        || path.contains(&0)
        || Path::new(&name)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        Err("Git returned an invalid repository-relative filename".into())
    } else {
        Ok(())
    }
}
pub(super) fn untracked_preview(root: &Path, path: &OsStr) -> Result<Preview> {
    let path = Path::new(path);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid repository-relative filename".into());
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        let mut directory = File::open(root).map_err(|e| e.to_string())?;
        let components: Vec<_> = path.components().collect();
        for (index, component) in components.iter().enumerate() {
            let name = CString::new(raw(component.as_os_str())).map_err(|_| "Invalid filename")?;
            let last = index == components.len() - 1;
            let flags = libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | if last {
                    libc::O_NONBLOCK
                } else {
                    libc::O_DIRECTORY
                };
            let descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if descriptor < 0 {
                if last && std::io::Error::last_os_error().raw_os_error() == Some(libc::ELOOP) {
                    let mut target = vec![0u8; 4096];
                    let length = unsafe {
                        libc::readlinkat(
                            directory.as_raw_fd(),
                            name.as_ptr(),
                            target.as_mut_ptr().cast(),
                            target.len(),
                        )
                    };
                    if length >= 0 {
                        target.truncate(length as usize);
                        return Ok(Preview {
                            text: format!("Symbolic link → {}", display(&target)),
                            truncated: false,
                            binary: false,
                        });
                    }
                }
                return Err(format!(
                    "Cannot safely preview this file: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let file = unsafe { File::from_raw_fd(descriptor) };
            if last {
                if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                    return Err("Only regular files and symbolic links can be previewed".into());
                }
                let (bytes, truncated) =
                    drain(file, PREVIEW_LIMIT, None).map_err(|e| e.to_string())?;
                let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
                return Ok(Preview {
                    text: if binary {
                        "Binary file preview is unavailable.".into()
                    } else {
                        text(&bytes)
                    },
                    truncated,
                    binary,
                });
            }
            directory = file;
        }
    }
    Err("This platform cannot safely preview this untracked file".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn progress_redacts_complete_lines_across_reads_and_drops_oversized_lines() {
        let input = format!(
            "Receiving objects: 50%\r\n{}\nhttps://user:secret@example.invalid/path\n{}\nfinal\x1b",
            "x".repeat(8140),
            "https://user:".to_owned() + &"password".repeat(2000) + "@example.invalid"
        );
        let messages = Arc::new(Mutex::new(Vec::new()));
        let received = messages.clone();
        let (saved, truncated) = drain(
            input.as_bytes(),
            32,
            Some(Arc::new(move |line| received.lock().unwrap().push(line))),
        )
        .unwrap();
        assert_eq!(saved, input.as_bytes()[..32]);
        assert!(truncated);
        assert_eq!(
            *messages.lock().unwrap(),
            vec![
                "Receiving objects: 50%",
                "https://[redacted]@example.invalid/path",
                "final\\u{1b}"
            ]
        );
    }

    #[test]
    fn progress_is_bounded_while_the_entire_pipe_is_drained() {
        let input = "Receiving objects: 50%\n".repeat(10_000);
        let mut reader = std::io::Cursor::new(input.as_bytes());
        let messages = Arc::new(Mutex::new(Vec::new()));
        let received = messages.clone();
        drain(
            &mut reader,
            0,
            Some(Arc::new(move |line| received.lock().unwrap().push(line))),
        )
        .unwrap();
        assert_eq!(reader.position(), input.len() as u64);
        let messages = messages.lock().unwrap();
        assert!(!messages.is_empty());
        assert!(messages.iter().map(String::len).sum::<usize>() <= 64 * 1024);
    }
}
