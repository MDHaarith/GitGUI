//! Bounded, process-local history of Git invocations. Never stores stdin or environment.
use super::{redact, Result};
use serde::Serialize;
use std::{
    collections::VecDeque,
    ffi::OsString,
    path::Path,
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const LIMIT: usize = 500;
static LOG: Mutex<VecDeque<GitOutput>> = Mutex::new(VecDeque::new());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutput {
    pub time: u64,
    pub root: String,
    pub args: Vec<String>,
    pub duration_ms: u64,
    pub exit_status: Option<i32>,
    pub success: bool,
    pub stderr: String,
}

pub fn entries() -> Vec<GitOutput> {
    LOG.lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .cloned()
        .collect()
}

fn push(log: &mut VecDeque<GitOutput>, entry: GitOutput) {
    if log.len() == LIMIT {
        log.pop_front();
    }
    log.push_back(entry);
}

pub(super) struct CommandLog {
    entry: GitOutput,
    start: Instant,
}

impl CommandLog {
    pub(super) fn new(root: &Path, args: &[OsString]) -> Self {
        Self {
            entry: GitOutput {
                time: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                root: redact(&root.to_string_lossy()),
                args: args.iter().map(|a| redact(&a.to_string_lossy())).collect(),
                duration_ms: 0,
                exit_status: None,
                success: false,
                stderr: String::new(),
            },
            start: Instant::now(),
        }
    }

    pub(super) fn status(&mut self, status: std::process::ExitStatus, stderr: &str) {
        self.entry.exit_status = status.code();
        self.entry.success = status.success();
        if !status.success() {
            self.entry.stderr = redact(stderr);
        }
    }

    pub(super) fn finish<T>(mut self, result: &Result<T>) {
        if let Err(error) = result {
            self.entry.success = false;
            let error = redact(error);
            if self.entry.stderr.is_empty() {
                self.entry.stderr = error;
            } else if self.entry.stderr.trim() != error.trim() {
                self.entry.stderr.push('\n');
                self.entry.stderr.push_str(&error);
            }
        }
        self.entry.duration_ms = self.start.elapsed().as_millis() as u64;
        push(
            &mut LOG.lock().unwrap_or_else(|e| e.into_inner()),
            self.entry,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_the_last_500_entries_and_redacts_arguments_and_errors() {
        let mut log = VecDeque::new();
        for time in 0..505 {
            let mut command =
                CommandLog::new(Path::new("repo"), &["https://user:secret@host/repo".into()]);
            command.entry.time = time;
            command.entry.stderr = redact("fatal: https://user:secret@host/repo");
            push(&mut log, command.entry);
        }
        assert_eq!(log.len(), 500);
        assert_eq!(log.front().unwrap().time, 5);
        assert_eq!(log.back().unwrap().time, 504);
        assert_eq!(log[0].args, ["https://[redacted]@host/repo"]);
        assert!(!log[0].stderr.contains("secret"));
    }
}
