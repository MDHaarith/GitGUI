use super::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommit {
    pub oid: String,
    pub timestamp: i64,
    pub author: String,
    pub subject: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub oid: String,
    pub author: String,
    pub timestamp: i64,
    pub text: String,
}

fn gitignore_pattern(path: &[u8], folder: bool) -> Vec<u8> {
    let mut out = b"/".to_vec();
    for (i, byte) in path.iter().enumerate() {
        if matches!(*byte, b'*' | b'?' | b'[' | b'\\')
            || (i == 0 && matches!(*byte, b'!' | b'#'))
            || (*byte == b' ' && i + 1 == path.len())
        {
            out.push(b'\\');
        }
        out.push(*byte);
    }
    if folder {
        out.push(b'/');
    }
    out
}

impl Repository {
    /// Real path of a commit's file id, or of a tracked working-tree file id when `commit` is None.
    fn file_path(&mut self, file_id: &str, commit: Option<&str>) -> Result<OsString> {
        if let Some(oid) = commit {
            valid_oid(oid)?;
            return self
                .commit_paths(oid, None)?
                .remove(file_id)
                .ok_or_else(|| "That file is not part of the selected commit.".into());
        }
        self.info()?
            .files
            .iter()
            .find(|f| f.id == file_id && !f.untracked)
            .ok_or("Choose a tracked file.")?;
        Ok(self.paths.get(file_id).ok_or("Unknown file")?.clone())
    }
}

impl Backend {
    pub fn ignore_untracked(
        &mut self,
        id: u64,
        file_id: &str,
        folder: bool,
        token: &str,
    ) -> Result<RepoInfo> {
        let repo = self.repo(id)?;
        let info = repo.checked(token)?;
        let _file = info
            .files
            .iter()
            .find(|f| f.id == file_id && f.untracked)
            .ok_or("Choose a file that is still untracked.")?;
        let bytes = repo.paths.get(file_id).ok_or("Unknown file")?.as_os_str();
        let path = bytes.as_bytes();
        relative_path(path)?;
        if folder && !path.contains(&b'/') {
            return Err("This file is not inside a folder; ignore the file instead.".into());
        }
        let pattern = gitignore_pattern(
            if folder {
                path.split(|b| *b == b'/').next().unwrap_or(path)
            } else {
                path
            },
            folder,
        );
        let gitignore = repo.root.join(".gitignore");
        let mut contents = match fs::read(&gitignore) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(format!("Could not read .gitignore: {error}")),
        };
        let line = pattern.as_slice();
        if contents
            .split(|b| *b == b'\n')
            .any(|entry| entry.strip_suffix(b"\r").unwrap_or(entry) == line)
        {
            return repo.info();
        }
        if !contents.is_empty() && !contents.ends_with(b"\n") {
            contents.push(b'\n');
        }
        contents.extend_from_slice(line);
        contents.push(b'\n');
        fs::write(gitignore, contents).map_err(|e| format!("Could not update .gitignore: {e}"))?;
        repo.info()
    }

    pub fn file_history(
        &mut self,
        id: u64,
        file_id: &str,
        commit: Option<&str>,
    ) -> Result<Vec<FileCommit>> {
        let repo = self.repo(id)?;
        let path = repo.file_path(file_id, commit)?;
        let mut args = argv(&[
            "log",
            "--follow",
            "--format=%H%x00%ct%x00%an%x00%s",
            "-z",
            "-n",
            "500",
        ]);
        args.extend([os(commit.unwrap_or("HEAD")), os("--"), path]);
        parse_file_log(&read(&repo.root, &args)?)
    }

    pub fn file_blame(
        &mut self,
        id: u64,
        file_id: &str,
        commit: Option<&str>,
    ) -> Result<Vec<BlameLine>> {
        let repo = self.repo(id)?;
        let path = repo.file_path(file_id, commit)?;
        let mut args = argv(&["blame", "--porcelain", "-L", "1,+5000"]);
        if let Some(oid) = commit {
            args.push(os(oid));
        } else {
            args.push(os("HEAD"));
        }
        args.push(os("--"));
        args.push(path);
        let output = match read(&repo.root, &args) {
            Err(e) if e.contains("has only 0 lines") => return Ok(Vec::new()),
            other => other,
        }
        .map_err(|e| {
            if e.to_lowercase().contains("binary") {
                "This file is binary, so Git cannot show line history.".to_owned()
            } else {
                e
            }
        })?;
        parse_blame(&output)
    }
}

/// `git log -z` rows of hash, time, author, subject; empty fields (an empty subject) keep their place.
fn parse_file_log(data: &[u8]) -> Result<Vec<FileCommit>> {
    let data = data.strip_suffix(b"\0").unwrap_or(data);
    if data.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<_> = data.split(|b| *b == 0).collect();
    if fields.len() % 4 != 0 {
        return Err("Malformed Git file history output".into());
    }
    fields
        .chunks(4)
        .map(|row| {
            let oid = text(row[0]);
            valid_oid(&oid)?;
            Ok(FileCommit {
                oid,
                timestamp: text(row[1]).parse().unwrap_or(0),
                author: display(row[2]),
                subject: display(row[3]),
            })
        })
        .collect()
}

fn parse_blame(data: &[u8]) -> Result<Vec<BlameLine>> {
    // Porcelain prints a commit's author headers only the first time that commit appears.
    let mut known: HashMap<String, (String, i64)> = HashMap::new();
    let mut lines = Vec::new();
    let mut rows = data.split(|b| *b == b'\n');
    while let Some(header) = rows.next() {
        let fields: Vec<_> = header.split(|b| *b == b' ').collect();
        if fields.len() < 3
            || !(fields[0].len() == 40 || fields[0].len() == 64)
            || text(fields[1]).parse::<usize>().is_err()
        {
            continue;
        }
        let oid = text(fields[0]);
        let entry = known.entry(oid.clone()).or_default();
        for row in rows.by_ref() {
            if let Some(content) = row.strip_prefix(b"\t") {
                lines.push(BlameLine {
                    oid: oid.clone(),
                    author: entry.0.clone(),
                    timestamp: entry.1,
                    text: display(content),
                });
                break;
            }
            if let Some(name) = row.strip_prefix(b"author ") {
                entry.0 = display(name);
            } else if let Some(time) = row.strip_prefix(b"author-time ") {
                entry.1 = text(time).parse().unwrap_or(0);
            }
        }
        if lines.len() == 5000 {
            break;
        }
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escapes_gitignore_globs_and_comments() {
        assert_eq!(
            gitignore_pattern(b"#file[1]*?.txt ", false),
            br"/\#file\[1]\*\?.txt\ "
        );
    }

    #[test]
    fn file_history_keeps_rows_aligned_after_an_empty_subject() {
        let (a, b, c) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
        let data =
            format!("{a}\x001\x00Ada\x00\x00{b}\x002\x00\x00second\x00{c}\x003\x00Bo\x00third\x00");
        let commits = parse_file_log(data.as_bytes()).unwrap();
        assert_eq!(commits.len(), 3);
        assert_eq!(
            (commits[0].subject.as_str(), commits[1].author.as_str()),
            ("", "")
        );
        assert_eq!(
            (commits[2].oid.as_str(), commits[2].subject.as_str()),
            (c.as_str(), "third")
        );
        assert!(parse_file_log(b"").unwrap().is_empty());
    }

    #[test]
    fn parses_blame_lines_and_repeated_commit_headers() {
        let oid = "0123456789012345678901234567890123456789";
        let other = "1".repeat(40);
        let data = format!(
            "{oid} 1 1 1\nauthor Ada\nauthor-time 123\n\tfirst\n{other} 2 2 1\nauthor Bo\nauthor-time 9\n\tsecond\n{oid} 3 3 1\n\tthird\n"
        );
        let lines = parse_blame(data.as_bytes()).unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1].author, "Bo");
        assert_eq!((lines[2].author.as_str(), lines[2].timestamp), ("Ada", 123));
        assert_eq!(lines[2].text, "third");
    }
}
