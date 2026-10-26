use super::*;

pub(super) fn untracked_diff(root: &Path, path: &OsStr) -> Result<Preview> {
    let mut preview = untracked_preview(root, path)?;
    if !preview.binary
        && !preview.truncated
        && fs::symlink_metadata(root.join(path))
            .map_err(|e| e.to_string())?
            .is_file()
    {
        // Git supplies quoting, file modes, attributes and line-ending conversion; exit 1 means differences.
        let args = [
            argv(&[
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--",
                "/dev/null",
            ]),
            vec![path.to_owned()],
        ]
        .concat();
        let output = execute(
            root,
            &args,
            None,
            PREVIEW_LIMIT,
            Some(Duration::from_secs(30)),
            None,
        )?;
        if !output.ok && output.stdout.is_empty() {
            return Err(output.stderr.trim().to_owned());
        }
        preview.text = text(&output.stdout);
        preview.truncated = output.truncated;
    }
    Ok(preview)
}

fn range(value: &str) -> Result<(i64, usize)> {
    let (start, count) = value.split_once(',').unwrap_or((value, "1"));
    let start: i64 = start.parse().map_err(|_| "Invalid diff range")?;
    let count: usize = count.parse().map_err(|_| "Invalid diff range")?;
    Ok((start - i64::from(count > 0), count))
}

/// Unselected removals become context when staging; unselected additions become context when unstaging.
fn line_patch(diff: &str, selected: &[usize], reverse: bool) -> Result<Vec<u8>> {
    let lines: Vec<_> = diff.split_inclusive('\n').collect();
    let selected: HashSet<_> = selected.iter().copied().collect();
    let first = lines
        .iter()
        .position(|line| line.starts_with("@@ "))
        .ok_or("No text changes to select")?;
    if selected.is_empty()
        || selected.iter().any(|&n| {
            n <= first || n >= lines.len() || !matches!(lines[n].as_bytes()[0], b'+' | b'-')
        })
    {
        return Err("Select changed lines from the current diff.".into());
    }
    let complete = lines
        .iter()
        .enumerate()
        .skip(first + 1)
        .all(|(n, line)| !matches!(line.as_bytes()[0], b'+' | b'-') || selected.contains(&n));
    let mut patch = String::new();
    let new_file = lines[..first]
        .iter()
        .any(|line| line.starts_with("new file mode "));
    let deleted = lines[..first]
        .iter()
        .any(|line| line.starts_with("deleted file mode "));
    for line in &lines[..first] {
        if line.starts_with("index ")
            || line.starts_with("old mode ")
            || line.starts_with("new mode ")
        {
            continue;
        }
        if !complete
            && ((new_file && reverse && line.starts_with("new file mode "))
                || (deleted && !reverse && line.starts_with("deleted file mode ")))
        {
            continue;
        }
        if !complete && new_file && reverse && *line == "--- /dev/null\n" {
            let path = lines[..first]
                .iter()
                .find_map(|line| line.strip_prefix("+++ "))
                .ok_or("Missing diff path")?;
            patch.push_str("--- ");
            patch.push_str(&path.replacen("b/", "a/", 1));
        } else if !complete && deleted && !reverse && *line == "+++ /dev/null\n" {
            let path = lines[..first]
                .iter()
                .find_map(|line| line.strip_prefix("--- "))
                .ok_or("Missing diff path")?;
            patch.push_str("+++ ");
            patch.push_str(&path.replacen("a/", "b/", 1));
        } else {
            patch.push_str(line);
        }
    }
    let mut offset = 0i64;
    let mut n = first;
    while n < lines.len() {
        let header: Vec<_> = lines[n].split_whitespace().collect();
        let (old_before, _) = range(
            header
                .get(1)
                .and_then(|v| v.strip_prefix('-'))
                .ok_or("Invalid diff hunk")?,
        )?;
        let (new_before, _) = range(
            header
                .get(2)
                .and_then(|v| v.strip_prefix('+'))
                .ok_or("Invalid diff hunk")?,
        )?;
        n += 1;
        let mut records: Vec<(u8, &str, bool)> = Vec::new();
        let mut changed = false;
        let mut kept = false;
        while n < lines.len() && !lines[n].starts_with("@@ ") {
            let line = lines[n];
            let prefix = line.as_bytes()[0];
            if prefix == b'\\' {
                if kept {
                    records.last_mut().unwrap().2 = true;
                }
                n += 1;
                continue;
            }
            let chosen = selected.contains(&n);
            changed |= chosen;
            kept = prefix == b' ' || chosen || prefix == if reverse { b'+' } else { b'-' };
            if kept {
                records.push((if chosen { prefix } else { b' ' }, &line[1..], false));
            }
            n += 1;
        }
        let old_last = records.iter().rposition(|r| r.0 != b'+');
        let new_last = records.iter().rposition(|r| r.0 != b'-');
        let mut body = String::new();
        let (mut old_count, mut new_count) = (0, 0);
        for (i, &(prefix, text, no_newline)) in records.iter().enumerate() {
            old_count += usize::from(prefix != b'+');
            new_count += usize::from(prefix != b'-');
            let old_eof = no_newline && old_last == Some(i);
            let new_eof = no_newline && new_last == Some(i);
            // A retained EOF line needs a newline on the side where another selected line follows it.
            if prefix == b' ' && old_eof != new_eof {
                body.push('-');
                body.push_str(text);
                if old_eof {
                    body.push_str("\\ No newline at end of file\n");
                }
                body.push('+');
                body.push_str(text);
                if new_eof {
                    body.push_str("\\ No newline at end of file\n");
                }
            } else {
                body.push(prefix as char);
                body.push_str(text);
                if (prefix != b'+' && old_eof) || (prefix != b'-' && new_eof) {
                    body.push_str("\\ No newline at end of file\n");
                }
            }
        }
        if !changed {
            continue;
        }
        let old = if reverse {
            new_before - offset
        } else {
            old_before
        };
        let new = if reverse {
            new_before
        } else {
            old_before + offset
        };
        patch.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            old + i64::from(old_count > 0),
            old_count,
            new + i64::from(new_count > 0),
            new_count
        ));
        patch.push_str(&body);
        offset += new_count as i64 - old_count as i64;
    }
    Ok(patch.into_bytes())
}

impl Backend {
    pub fn stage_lines(
        &mut self,
        id: u64,
        file_id: &str,
        lines: &[usize],
        expected: &str,
        unstage: bool,
        token: &str,
    ) -> Result<RepoInfo> {
        if lines.len() > 5000 || expected.len() > PREVIEW_LIMIT {
            return Err("Line selection exceeds the preview limit.".into());
        }
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        repo.require_normal(&info)?;
        let file = info
            .files
            .iter()
            .find(|f| f.id == file_id)
            .ok_or("File changed. Refresh the changes list.")?;
        if file.submodule || file.conflicted || file.old_id.is_some() || (unstage && file.untracked)
        {
            return Err("Stage renamed, conflicted, and submodule files as a whole.".into());
        }
        let path = repo.paths.get(file_id).ok_or("Unknown file")?.clone();
        let diff = if file.untracked {
            let preview = untracked_diff(&repo.root, &path)?;
            if preview.binary || preview.truncated {
                return Err("Stage this file as a whole.".into());
            }
            preview.text
        } else {
            let mut args = argv(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--submodule=short",
            ]);
            if unstage {
                args.push(os("--cached"));
            }
            args.extend([os("--"), path]);
            String::from_utf8(read(&repo.root, &args)?)
                .map_err(|_| "Stage binary files as a whole.")?
        };
        if diff != expected {
            return Err("This file changed since you opened it. Review the diff again.".into());
        }
        let patch = line_patch(&diff, lines, unstage)?;
        let mut args = argv(&["apply", "--cached", "--recount", "--whitespace=nowarn"]);
        if unstage {
            args.push(os("--reverse"));
        }
        args.push(os("-"));
        repo.write(&args, Some(&patch), None, None)?;
        repo.info()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_selection_keeps_the_correct_side_as_context() {
        let diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
        assert_eq!(
            String::from_utf8(line_patch(diff, &[6], false).unwrap()).unwrap(),
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n a\n b\n+B\n c\n"
        );
        assert_eq!(
            String::from_utf8(line_patch(diff, &[5], true).unwrap()).unwrap(),
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,3 @@\n a\n-b\n B\n c\n"
        );
        for selected in [vec![], vec![0], vec![3], vec![4], vec![100]] {
            assert!(line_patch(diff, &selected, false).is_err());
        }
    }
}
