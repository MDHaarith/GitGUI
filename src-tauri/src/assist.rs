//! Asks Claude to explain changes or draft commit messages, through curl so no HTTP stack is bundled.
use crate::git::Result;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    process::{Command, Stdio},
};

const MODEL: &str = "claude-opus-5-5";
// About 100k tokens; larger changes are refused rather than silently cut.
const INPUT_LIMIT: usize = 400_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

fn key_file() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(config.join("com.gitgui.app").join("anthropic-key"))
}

/// Saves the API key readable only by this user.
pub fn save_key(key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() || key.len() > 512 || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("That does not look like an API key.".into());
    }
    let path = key_file().ok_or("Cannot find the config folder")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&path);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(key.as_bytes()).map_err(|e| e.to_string())
}

/// curl config lines carrying the credentials, so they never appear in the process list.
fn credentials() -> Result<(String, &'static str)> {
    let key = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .or_else(|| key_file().and_then(|p| fs::read_to_string(p).ok()))
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty());
    if let Some(key) = key {
        return Ok((format!("header = \"x-api-key: {key}\"\n"), ""));
    }
    let token = Command::new("ant")
        .args(["auth", "print-credentials", "--access-token"])
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .filter(|t| !t.is_empty() && !t.contains(['"', '\n']))
        .ok_or("No Claude API key. Add one with Set API key (from console.anthropic.com).")?;
    Ok((
        format!("header = \"Authorization: Bearer {token}\"\n"),
        ",oauth-2025-04-20",
    ))
}

pub fn prompt(task: &str, changes: &str) -> Result<String> {
    if changes.len() > INPUT_LIMIT {
        return Err(format!("These changes are too large to explain at once ({} KB). Explain a smaller set, such as only the staged files.", changes.len() / 1024));
    }
    let instructions = match task {
        "explain" => "Explain these code changes to someone who builds apps with AI but cannot read code. Use short plain-English sections: What changed, Why (best guess), What could break, and Watch out (only if there are secrets, deleted tests, new dependencies, security or data-loss risks). No code unless essential.",
        "message" => "Write a Git commit message for these changes: an imperative summary line of at most 60 characters, then a blank line and up to 5 short bullet lines. Reply with the message only.",
        "conflict" => "This file has Git conflict markers. In plain English for a non-programmer, explain what each side (between <<<<<<< and =======, and between ======= and >>>>>>>) does and recommend which to keep, or how to combine them.",
        _ => return Err("Unknown request".into()),
    };
    Ok(format!(
        "{instructions}\n\n<changes>\n{changes}\n</changes>"
    ))
}

pub fn parse(body: &str) -> Result<Answer> {
    let value: Value = serde_json::from_str(body).map_err(|_| {
        format!(
            "Claude returned an unexpected response: {}",
            body.chars().take(200).collect::<String>()
        )
    })?;
    if value["type"] == "error" {
        return Err(format!(
            "Claude: {}",
            value["error"]["message"]
                .as_str()
                .unwrap_or("request failed")
        ));
    }
    if value["stop_reason"] == "refusal" {
        return Err("Claude declined to answer this request.".into());
    }
    let text = value["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("");
    if text.trim().is_empty() {
        return Err("Claude returned no text.".into());
    }
    Ok(Answer {
        text: text.trim().to_owned(),
        input_tokens: value["usage"]["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: value["usage"]["output_tokens"].as_u64().unwrap_or(0),
    })
}

pub fn ask(task: &str, changes: &str) -> Result<Answer> {
    let body = json!({
        "model": MODEL,
        "max_tokens": 16000,
        "fallbacks": "default",
        "output_config": {"effort": "medium"},
        "messages": [{"role": "user", "content": prompt(task, changes)?}],
    })
    .to_string();
    let (auth, beta) = credentials()?;
    let config = format!(
        "{auth}header = \"anthropic-version: 2023-06-01\"\nheader = \"anthropic-beta: server-side-fallback-2026-07-01{beta}\"\nheader = \"content-type: application/json\"\n"
    );
    let mut child = Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "300",
            "-K",
            "-",
            "https://api.anthropic.com/v1/messages",
        ])
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Install curl to use Claude features.".to_owned())?;
    // The key and body go through curl's stdin config; the JSON body has no control characters to escape.
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{config}data-binary = {}\n", json!(body)).as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Could not reach Claude: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_are_parsed_and_refusals_and_errors_reported() {
        let ok = r#"{"type":"message","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":" Add login \n"}],"usage":{"input_tokens":10,"output_tokens":3}}"#;
        let answer = parse(ok).unwrap();
        assert_eq!(
            (
                answer.text.as_str(),
                answer.input_tokens,
                answer.output_tokens
            ),
            ("Add login", 10, 3)
        );
        assert!(
            parse(r#"{"type":"message","stop_reason":"refusal","content":[]}"#)
                .unwrap_err()
                .contains("declined")
        );
        assert!(
            parse(r#"{"type":"error","error":{"message":"invalid x-api-key"}}"#)
                .unwrap_err()
                .contains("invalid x-api-key")
        );
        assert!(prompt("explain", &"x".repeat(INPUT_LIMIT + 1))
            .unwrap_err()
            .contains("too large"));
    }
}
