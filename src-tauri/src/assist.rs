//! Asks an AI to explain changes or draft commit messages: Claude, any OpenAI-compatible API
//! (DeepSeek, OpenAI, OpenRouter, Groq, Ollama…), or a command-line agent (Codex, opencode…).
//! HTTP goes through curl so no HTTP stack is bundled.
use crate::git::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
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
    /// Which provider answered, so the app only prices Claude requests.
    pub provider: String,
}

/// `kind` is "claude", "openai" (any OpenAI-compatible chat API), or "command" (a CLI agent reading the prompt on stdin).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub command: String,
}

fn config_dir() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(config.join("com.gitgui.app"))
}
fn key_file() -> Option<PathBuf> {
    Some(config_dir()?.join("anthropic-key"))
}
fn provider_file() -> Option<PathBuf> {
    Some(config_dir()?.join("ai-provider.json"))
}

/// Writes a file readable only by this user.
fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().ok_or("Invalid config path")?).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(path);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())
}

/// Saves the Claude API key readable only by this user.
pub fn save_key(key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() || key.len() > 512 || key.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("That does not look like an API key.".into());
    }
    write_private(
        &key_file().ok_or("Cannot find the config folder")?,
        key.as_bytes(),
    )
}

pub fn provider() -> Provider {
    let saved = provider_file()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Provider>(&t).ok());
    saved.unwrap_or_else(|| Provider {
        kind: "claude".into(),
        ..Provider::default()
    })
}
/// The provider without its key, for showing in the app.
pub fn public_provider() -> Provider {
    Provider {
        api_key: String::new(),
        ..provider()
    }
}
/// Saves the provider; an empty key keeps the one already saved.
pub fn save_provider(mut next: Provider) -> Result<()> {
    next.base_url = next.base_url.trim().trim_end_matches('/').to_owned();
    next.model = next.model.trim().to_owned();
    next.api_key = next.api_key.trim().to_owned();
    next.command = next.command.trim().to_owned();
    // These values are written into curl config lines, so quotes, backslashes, and control characters are refused.
    let unsafe_text =
        |s: &str| s.len() > 2048 || s.chars().any(|c| c.is_control() || c == '"' || c == '\\');
    match next.kind.as_str() {
        "claude" => {}
        "openai" => {
            if !(next.base_url.starts_with("https://") || next.base_url.starts_with("http://")) {
                return Err("Enter the API address, starting with https:// (for example https://api.deepseek.com).".into());
            }
            if next.model.is_empty() {
                return Err("Enter the model name (for example deepseek-chat).".into());
            }
            if [&next.base_url, &next.model, &next.api_key]
                .iter()
                .any(|s| unsafe_text(s) || s.contains(' '))
            {
                return Err(
                    "The address, model, and key cannot contain spaces, quotes, or backslashes."
                        .into(),
                );
            }
        }
        "command" => {
            if next.command.is_empty()
                || next.command.len() > 2048
                || next.command.contains(['\0', '\n'])
            {
                return Err("Enter one command line (for example codex exec -).".into());
            }
        }
        _ => {
            return Err("Choose Claude, an OpenAI-compatible API, or a command-line agent.".into())
        }
    }
    if next.api_key.is_empty() {
        let old = provider();
        if old.kind == next.kind && old.base_url == next.base_url {
            next.api_key = old.api_key;
        }
    }
    let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    write_private(
        &provider_file().ok_or("Cannot find the config folder")?,
        text.as_bytes(),
    )
}

/// curl config lines carrying the Claude credentials, so they never appear in the process list.
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
        .ok_or("No Claude API key. Add one in AI settings (from console.anthropic.com), or choose another AI provider.")?;
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
        "pr" => "Write a concise pull request title on the first line, a blank line, then a plain-English description of the branch changes and why they matter. Reply only with the title and body.",
        _ => return Err("Unknown request".into()),
    };
    Ok(format!(
        "{instructions}\n\n<changes>\n{changes}\n</changes>"
    ))
}

fn unexpected(name: &str, body: &str) -> String {
    format!(
        "{name} returned an unexpected response: {}",
        body.chars().take(200).collect::<String>()
    )
}

pub fn parse(body: &str) -> Result<Answer> {
    let value: Value = serde_json::from_str(body).map_err(|_| unexpected("Claude", body))?;
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
        provider: "claude".into(),
    })
}

/// Parses an OpenAI-compatible chat completion.
pub fn parse_openai(body: &str, model: &str) -> Result<Answer> {
    let value: Value = serde_json::from_str(body).map_err(|_| unexpected(model, body))?;
    if let Some(message) = value["error"]["message"]
        .as_str()
        .or(value["error"].as_str())
    {
        return Err(format!("{model}: {message}"));
    }
    let choice = &value["choices"][0];
    if choice["finish_reason"] == "content_filter" {
        return Err(format!("{model} declined to answer this request."));
    }
    let text = choice["message"]["content"].as_str().unwrap_or("").trim();
    if text.is_empty() {
        return Err(unexpected(model, body));
    }
    Ok(Answer {
        text: text.to_owned(),
        input_tokens: value["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
        output_tokens: value["usage"]["completion_tokens"].as_u64().unwrap_or(0),
        provider: model.into(),
    })
}

/// POSTs a JSON body with curl, reading headers and body from stdin so keys never reach the process list.
fn post(url: &str, headers: &str, body: &Value, name: &str) -> Result<String> {
    let mut child = Command::new("curl")
        .args(["-sS", "--max-time", "300", "-K", "-", url])
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Install curl to use AI features.".to_owned())?;
    // The serialized JSON body has no control characters, so quoting it once is a valid curl config string.
    let config = format!(
        "{headers}header = \"content-type: application/json\"\ndata-binary = {}\n",
        json!(body.to_string())
    );
    child
        .stdin
        .take()
        .unwrap()
        .write_all(config.as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Could not reach {name}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs a command-line agent in an empty folder (so it cannot edit the project) with the prompt on stdin.
fn run_command(command: &str, prompt: &str) -> Result<Answer> {
    let dir = std::env::temp_dir().join(format!("gitgui-agent-{}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // shortcut: `timeout` is GNU coreutils (Linux); use a watchdog thread when macOS is supported.
    let mut child = Command::new("timeout")
        .args(["600", "sh", "-c", command])
        .current_dir(&dir)
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Cannot start {command}: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let input = prompt.to_owned();
    // Write on another thread so a command that prints before reading stdin cannot deadlock.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let output = child.wait_with_output().map_err(|e| e.to_string());
    let _ = writer.join();
    let _ = fs::remove_dir_all(&dir);
    let output = output?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || text.is_empty() {
        let error = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<_> = error.lines().rev().take(8).collect();
        return Err(format!(
            "{command} failed ({}): {}",
            output.status,
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        ));
    }
    let name = command.split_whitespace().next().unwrap_or("agent");
    Ok(Answer {
        text,
        input_tokens: 0,
        output_tokens: 0,
        provider: name.into(),
    })
}

pub fn ask(task: &str, changes: &str) -> Result<Answer> {
    let prompt = prompt(task, changes)?;
    let provider = provider();
    match provider.kind.as_str() {
        "openai" => {
            let auth = if provider.api_key.is_empty() {
                String::new()
            } else {
                format!("header = \"Authorization: Bearer {}\"\n", provider.api_key)
            };
            let body = json!({
                "model": provider.model,
                "messages": [{"role": "user", "content": prompt}],
            });
            let url = format!("{}/chat/completions", provider.base_url);
            parse_openai(&post(&url, &auth, &body, &provider.model)?, &provider.model)
        }
        "command" => run_command(&provider.command, &prompt),
        _ => {
            let body = json!({
                "model": MODEL,
                "max_tokens": 16000,
                "fallbacks": "default",
                "output_config": {"effort": "medium"},
                "messages": [{"role": "user", "content": prompt}],
            });
            let (auth, beta) = credentials()?;
            let headers = format!(
                "{auth}header = \"anthropic-version: 2023-06-01\"\nheader = \"anthropic-beta: server-side-fallback-2026-07-01{beta}\"\n"
            );
            parse(&post(
                "https://api.anthropic.com/v1/messages",
                &headers,
                &body,
                "Claude",
            )?)
        }
    }
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
        assert!(prompt("pr", "diff").unwrap().contains("pull request title"));
    }

    #[test]
    fn openai_compatible_responses_and_command_agents_work() {
        let ok = r#"{"choices":[{"message":{"content":" Fix login "},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}"#;
        let answer = parse_openai(ok, "deepseek-chat").unwrap();
        assert_eq!(
            (
                answer.text.as_str(),
                answer.input_tokens,
                answer.output_tokens
            ),
            ("Fix login", 7, 2)
        );
        assert!(parse_openai(
            r#"{"error":{"message":"Authentication Fails"}}"#,
            "deepseek-chat"
        )
        .unwrap_err()
        .contains("Authentication"));
        assert!(parse_openai(
            r#"{"choices":[{"message":{"content":""},"finish_reason":"content_filter"}]}"#,
            "m"
        )
        .unwrap_err()
        .contains("declined"));
        let answer = run_command("tr a-z A-Z", "hello").unwrap();
        assert_eq!(
            (answer.text.as_str(), answer.provider.as_str()),
            ("HELLO", "tr")
        );
        assert!(run_command("exit 4", "x").unwrap_err().contains("failed"));
        let invalid = |kind: &str, base_url: &str, command: &str| {
            save_provider(Provider {
                kind: kind.into(),
                base_url: base_url.into(),
                model: "m".into(),
                command: command.into(),
                ..Provider::default()
            })
            .is_err()
        };
        assert!(invalid("openai", "api.deepseek.com", "") && invalid("openai", "https://x\"y", ""));
        assert!(
            invalid("command", "", "")
                && invalid("command", "", "a\nb")
                && invalid("gemini", "", "")
        );
    }
}
