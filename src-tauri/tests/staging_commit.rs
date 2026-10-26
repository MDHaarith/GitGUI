use gitgui_lib::git::{Backend, CommitOptions, RepoInfo};
use std::{fs, path::Path, process::Command};
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
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
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn fixture(content: Option<&str>, path: &str) -> (TempDir, Backend, RepoInfo) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    git(root, &["init", "-b", "main"]);
    for (key, value) in [
        ("user.name", "GitGUI Test"),
        ("user.email", "test@example.invalid"),
        ("commit.gpgsign", "false"),
        ("push.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(root, &["config", key, value]);
    }
    git(
        root,
        &[
            "config",
            "core.hooksPath",
            root.join(".git/hooks").to_str().unwrap(),
        ],
    );
    if let Some(content) = content {
        fs::write(root.join(path), content).unwrap();
        git(root, &["add", "--", path]);
    }
    git(root, &["commit", "--allow-empty", "-m", "Initial"]);
    let mut backend = Backend::default();
    let info = backend.open(root.to_str().unwrap()).unwrap();
    (temp, backend, info)
}

fn apply(backend: &mut Backend, info: RepoInfo, staged: bool, texts: &[&str]) -> RepoInfo {
    let file = &info.files[0];
    let preview = backend.working_diff(info.id, &file.id, staged).unwrap();
    let lines: Vec<_> = preview
        .text
        .split('\n')
        .enumerate()
        .filter(|(_, line)| texts.contains(line))
        .map(|(n, _)| n)
        .collect();
    assert_eq!(lines.len(), texts.len(), "{}", preview.text);
    backend
        .stage_lines(
            info.id,
            &file.id,
            &lines,
            &preview.text,
            staged,
            &info.token,
        )
        .unwrap()
}

#[test]
fn selected_additions_removals_and_mixed_changes_only_touch_the_index() {
    for reverse in [false, true] {
        for (selected, expected) in [
            (
                vec!["+B"],
                if reverse {
                    "a\nD\nz\n"
                } else {
                    "a\nb\nd\nB\nz\n"
                },
            ),
            (
                vec!["-b"],
                if reverse {
                    "a\nb\nB\nD\nz\n"
                } else {
                    "a\nd\nz\n"
                },
            ),
            (
                vec!["-b", "+B"],
                if reverse {
                    "a\nb\nD\nz\n"
                } else {
                    "a\nd\nB\nz\n"
                },
            ),
            (
                vec!["-b", "+D"],
                if reverse {
                    "a\nb\nB\nz\n"
                } else {
                    "a\nd\nD\nz\n"
                },
            ),
        ] {
            let (temp, mut backend, info) = fixture(Some("a\nb\nd\nz\n"), "f");
            fs::write(temp.path().join("f"), "a\nB\nD\nz\n").unwrap();
            if reverse {
                git(temp.path(), &["add", "f"]);
            }
            let info = backend.status(info.id).unwrap();
            apply(&mut backend, info, reverse, &selected);
            assert_eq!(
                git(temp.path(), &["show", ":f"]),
                expected.as_bytes(),
                "{selected:?}, reverse={reverse}"
            );
            assert_eq!(fs::read(temp.path().join("f")).unwrap(), b"a\nB\nD\nz\n");
        }
    }
}

#[test]
fn selections_across_hunks_recount_offsets() {
    let middle: String = (0..40).map(|n| format!("line {n}\n")).collect();
    let old = format!("old\n{middle}last\n");
    let new = format!("new\n{middle}final\n");
    for reverse in [false, true] {
        let (temp, mut backend, info) = fixture(Some(&old), "f");
        fs::write(temp.path().join("f"), &new).unwrap();
        if reverse {
            git(temp.path(), &["add", "f"]);
        }
        let info = backend.status(info.id).unwrap();
        apply(&mut backend, info, reverse, &["+new", "-last"]);
        let expected = if reverse {
            format!("{middle}last\nfinal\n")
        } else {
            format!("old\nnew\n{middle}")
        };
        assert_eq!(git(temp.path(), &["show", ":f"]), expected.as_bytes());
    }
}

#[test]
fn selection_preserves_missing_newlines() {
    for (old, new, selected, expected, reverse) in [
        ("a\nold", "a\nnew", vec!["-old", "+new"], "a\nnew", false),
        ("a\nold", "a\nnew", vec!["-old", "+new"], "a\nold", true),
        ("a\nold", "a\nnew", vec!["+new"], "a\nold\nnew", false),
        ("a\nold", "a\nnew", vec!["-old"], "a\nold\nnew", true),
        ("a\nold", "a\nnew", vec!["-old"], "a\n", false),
        ("a\nold", "a\nnew", vec!["+new"], "a\n", true),
        (
            "a\nold",
            "a\nold\n",
            vec!["-old", "+old"],
            "a\nold\n",
            false,
        ),
    ] {
        let (temp, mut backend, info) = fixture(Some(old), "f");
        fs::write(temp.path().join("f"), new).unwrap();
        if reverse {
            git(temp.path(), &["add", "f"]);
        }
        let info = backend.status(info.id).unwrap();
        apply(&mut backend, info, reverse, &selected);
        assert_eq!(
            git(temp.path(), &["show", ":f"]),
            expected.as_bytes(),
            "{selected:?}, reverse={reverse}"
        );
        assert_eq!(fs::read(temp.path().join("f")).unwrap(), new.as_bytes());
    }
}

#[test]
fn standalone_additions_and_removals_work_in_both_directions() {
    for (old, new, selected) in [
        ("a\nc\n", "a\nb\nc\n", "+b"),
        ("a\nb\nc\n", "a\nc\n", "-b"),
        ("", "b\n", "+b"),
        ("b\n", "", "-b"),
    ] {
        for reverse in [false, true] {
            let (temp, mut backend, info) = fixture(Some(old), "f");
            fs::write(temp.path().join("f"), new).unwrap();
            if reverse {
                git(temp.path(), &["add", "f"]);
            }
            let info = backend.status(info.id).unwrap();
            apply(&mut backend, info, reverse, &[selected]);
            assert_eq!(
                git(temp.path(), &["show", ":f"]),
                if reverse { old } else { new }.as_bytes()
            );
            assert_eq!(fs::read(temp.path().join("f")).unwrap(), new.as_bytes());
        }
    }
}

#[test]
fn new_file_lines_use_gits_line_ending_conversion() {
    let (temp, mut backend, info) = fixture(None, "f");
    git(temp.path(), &["config", "core.autocrlf", "true"]);
    fs::write(temp.path().join("f"), b"one\r\ntwo\r\n").unwrap();
    let info = backend.status(info.id).unwrap();
    apply(&mut backend, info, false, &["+one"]);
    assert_eq!(git(temp.path(), &["show", ":f"]), b"one\n");
    assert_eq!(fs::read(temp.path().join("f")).unwrap(), b"one\r\ntwo\r\n");
}

#[cfg(unix)]
#[test]
fn new_file_line_staging_preserves_executable_mode_and_literal_paths() {
    use std::os::unix::{ffi::OsStringExt, fs::PermissionsExt};
    for path in [
        std::ffi::OsString::from("a\"\nfile"),
        std::ffi::OsString::from_vec(b"invalid-\xff".to_vec()),
    ] {
        let (temp, mut backend, info) = fixture(None, "unused");
        let file = temp.path().join(&path);
        fs::write(&file, "one\ntwo\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        let info = backend.status(info.id).unwrap();
        let info = apply(&mut backend, info, false, &["+one"]);
        assert!(git(temp.path(), &["ls-files", "--stage"]).starts_with(b"100755 "));
        let preview = backend
            .working_diff(info.id, &info.files[0].id, true)
            .unwrap();
        assert!(preview.text.ends_with("+one\n"));
        assert_eq!(fs::read(file).unwrap(), b"one\ntwo\n");
    }
}

#[test]
fn new_and_deleted_files_support_partial_staging_and_unstaging() {
    let path = "new file é.txt";
    let (temp, mut backend, info) = fixture(None, path);
    fs::write(temp.path().join(path), "one\ntwo\nthree").unwrap();
    let info = backend.status(info.id).unwrap();
    let info = apply(&mut backend, info, false, &["+one", "+three"]);
    assert_eq!(
        git(temp.path(), &["show", &format!(":{path}")]),
        b"one\nthree"
    );
    let info = apply(&mut backend, info, true, &["+one"]);
    assert_eq!(git(temp.path(), &["show", &format!(":{path}")]), b"three");
    apply(&mut backend, info, true, &["+three"]);
    assert!(git(temp.path(), &["ls-files"]).is_empty());
    assert_eq!(
        fs::read(temp.path().join(path)).unwrap(),
        b"one\ntwo\nthree"
    );

    let (temp, mut backend, info) = fixture(Some("one\ntwo\nthree"), "f");
    fs::remove_file(temp.path().join("f")).unwrap();
    let info = backend.status(info.id).unwrap();
    let info = apply(&mut backend, info, false, &["-two"]);
    assert_eq!(git(temp.path(), &["show", ":f"]), b"one\nthree");
    apply(&mut backend, info, true, &["-two"]);
    assert_eq!(git(temp.path(), &["show", ":f"]), b"one\ntwo\nthree");
    git(temp.path(), &["add", "-u"]);
    let info = backend.open(temp.path().to_str().unwrap()).unwrap();
    let info = apply(&mut backend, info, true, &["-two"]);
    assert_eq!(git(temp.path(), &["show", ":f"]), b"two\n");
    apply(&mut backend, info, false, &["-two"]);
    assert!(git(temp.path(), &["ls-files"]).is_empty());
    assert!(!temp.path().join("f").exists());
}

#[test]
fn stale_previews_and_invalid_selections_leave_everything_alone() {
    let (temp, mut backend, info) = fixture(Some("old\n"), "f");
    fs::write(temp.path().join("f"), "new\n").unwrap();
    let info = backend.status(info.id).unwrap();
    let file = &info.files[0];
    let preview = backend.working_diff(info.id, &file.id, false).unwrap();
    for lines in [vec![], vec![0], vec![usize::MAX], vec![0; 5001]] {
        assert!(backend
            .stage_lines(info.id, &file.id, &lines, &preview.text, false, &info.token)
            .is_err());
    }
    fs::write(temp.path().join("f"), "NEW\n").unwrap();
    let selected = preview
        .text
        .lines()
        .position(|line| line == "+new")
        .unwrap();
    assert!(backend
        .stage_lines(
            info.id,
            &file.id,
            &[selected],
            &preview.text,
            false,
            &info.token
        )
        .unwrap_err()
        .contains("changed since"));
    assert!(git(temp.path(), &["diff", "--cached"]).is_empty());
    assert_eq!(fs::read(temp.path().join("f")).unwrap(), b"NEW\n");
}

#[test]
fn commit_options_use_explicit_author_and_committer_signoff_then_existing_push() {
    let (temp, mut backend, info) = fixture(Some("old\n"), "f");
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare"]);
    git(
        temp.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    fs::write(temp.path().join("f"), "new\n").unwrap();
    git(temp.path(), &["add", "f"]);
    let info = backend.status(info.id).unwrap();
    assert!(backend
        .commit_with_options(
            info.id,
            "Change",
            &info.token,
            false,
            None,
            false,
            CommitOptions {
                signoff: true,
                author: Some("not an identity".into())
            }
        )
        .is_err());
    let info = backend
        .commit_with_options(
            info.id,
            "Change",
            &info.token,
            false,
            None,
            false,
            CommitOptions {
                signoff: true,
                author: Some("Other Author <other@example.invalid>".into()),
            },
        )
        .unwrap();
    let log = String::from_utf8(git(
        temp.path(),
        &["log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B"],
    ))
    .unwrap();
    assert!(log
        .starts_with("Other Author <other@example.invalid>\nGitGUI Test <test@example.invalid>\n"));
    assert!(log.contains("Signed-off-by: GitGUI Test <test@example.invalid>"));
    let info = backend
        .push(info.id, Some(info.remotes[0].id.clone()), &info.token, None)
        .unwrap();
    assert!(info.upstream.is_some());
    assert_eq!(
        git(remote.path(), &["rev-parse", "refs/heads/main"]),
        git(temp.path(), &["rev-parse", "HEAD"])
    );
}
