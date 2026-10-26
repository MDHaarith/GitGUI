use gitgui_lib::{
    git::{output_log, Backend},
    platform,
    terminal::{Output, Terminals},
};
use std::{
    path::Path,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

fn git(root: &Path, args: &[&str]) {
    let output = platform::command("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn real_git_commands_and_checkpoint_snapshot_are_logged_without_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "Test"]);
    git(root, &["config", "user.email", "test@example.invalid"]);
    let mut backend = Backend::default();
    let repo = backend.open(root.to_str().unwrap()).unwrap();
    std::fs::write(root.join("file.txt"), "keep me").unwrap();
    backend.checkpoint(repo.id, "Terminal test").unwrap();
    // A real failed remote command echoes its argument on some Git versions.
    assert!(backend
        .clone(
            "https://user:secret@127.0.0.1:1/missing.git",
            root.to_str().unwrap(),
            None
        )
        .is_err());
    let entries = output_log::entries();
    assert!(entries
        .iter()
        .any(|e| e.args.first().is_some_and(|a| a == "write-tree") && e.success));
    assert!(entries
        .iter()
        .any(|e| e.args.first().is_some_and(|a| a == "add") && e.success));
    let failed = entries
        .iter()
        .find(|e| e.args.iter().any(|a| a == "clone"))
        .unwrap();
    assert!(!failed.success);
    assert!(failed.exit_status.is_some());
    assert!(!failed.stderr.is_empty());
    let serialized = serde_json::to_string(&entries).unwrap();
    assert!(!serialized.contains("secret"), "{serialized}");
    assert!(serialized.contains("[redacted]"));
    assert_eq!(
        std::fs::read_to_string(root.join("file.txt")).unwrap(),
        "keep me"
    );
}

fn start(terminals: &Arc<Terminals>, id: u64, root: &Path) -> mpsc::Receiver<Output> {
    let (send, recv) = mpsc::channel();
    let weak = Arc::downgrade(terminals);
    terminals
        .start(id, root, 80, 24, move |output| {
            let data = matches!(output, Output::Data(_));
            let ok = send.send(output).is_ok();
            if data {
                if let Some(terminals) = weak.upgrade() {
                    terminals.ack(id);
                }
            }
            ok
        })
        .unwrap();
    recv
}

fn wait_for(recv: &mpsc::Receiver<Output>, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut bytes = Vec::new();
    loop {
        match recv
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|error| {
                panic!(
                    "Waiting for {needle:?}: {error}; output: {:?}",
                    String::from_utf8_lossy(&bytes)
                )
            }) {
            Output::Data(data) => bytes.extend(data),
            Output::Exit(message) => panic!("Shell exited too soon: {message}"),
        }
        let output = String::from_utf8_lossy(&bytes);
        if output.contains(needle) {
            return output.into_owned();
        }
    }
}

fn echo(terminals: &Terminals, id: u64, marker: &str) {
    // Shell integration can insert control sequences before command output.
    #[cfg(unix)]
    let command = format!("printf '\\n{marker}\\n'\r");
    #[cfg(windows)]
    let command = format!("echo {marker}\r");
    terminals.write(id, command.into_bytes()).unwrap();
}

#[test]
fn terminals_stream_input_resize_isolate_repositories_and_close() {
    let one = tempfile::tempdir().unwrap();
    let two = tempfile::tempdir().unwrap();
    git(one.path(), &["init", "-b", "main"]);
    git(two.path(), &["init", "-b", "main"]);
    let terminals = Arc::new(Terminals::default());
    let output_one = start(&terminals, 1, one.path());
    let output_two = start(&terminals, 2, two.path());
    assert!(terminals.start(1, one.path(), 80, 24, |_| true).is_err());
    assert!(terminals.write(999, vec![1]).is_err());
    assert!(terminals.write(1, vec![0; 65537]).is_err());
    assert!(terminals.resize(1, 0, 30).is_err());
    terminals.resize(1, 100, 30).unwrap();
    echo(&terminals, 1, "TERMINAL_ONE");
    echo(&terminals, 2, "TERMINAL_TWO");
    wait_for(&output_one, "\r\nTERMINAL_ONE\r\n");
    wait_for(&output_two, "\r\nTERMINAL_TWO\r\n");
    #[cfg(unix)]
    {
        terminals.write(1, b"pwd; stty size\r".to_vec()).unwrap();
        let output = wait_for(&output_one, "30 100");
        assert!(output.contains(one.path().to_str().unwrap()), "{output}");
    }
    terminals.close(1);
    assert!(terminals.write(1, b"echo nope\r".to_vec()).is_err());
    echo(&terminals, 2, "STILL_ALIVE");
    wait_for(&output_two, "\r\nSTILL_ALIVE\r\n");
    // Reuse the ID to exercise teardown racing with a new reader.
    let restarted = start(&terminals, 1, one.path());
    echo(&terminals, 1, "RESTARTED");
    wait_for(&restarted, "\r\nRESTARTED\r\n");
    terminals.close_all();
    assert!(terminals.resize(1, 80, 24).is_err());
    assert!(terminals.resize(2, 80, 24).is_err());
}
