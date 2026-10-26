//! Asks an AI to explain changes or draft commit messages: Claude, any OpenAI-compatible API
//! (DeepSeek, OpenAI, OpenRouter, Groq, Ollama…), or a command-line agent (Codex, opencode…).
//! HTTP goes through curl so no HTTP stack is bundled.
use crate::git::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};

pub mod chat;
mod keys;

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
    #[serde(skip_serializing, alias = "api_key")]
    pub api_key: String,
    pub command: String,
}

fn config_dir() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))?;
    Some(config.join("com.gitgui.app"))
}
fn provider_file() -> Option<PathBuf> {
    Some(config_dir()?.join("ai-provider.json"))
}

/// Writes a file readable only by this user.
fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().ok_or("Invalid config path")?).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = path.with_extension(format!("tmp-{}-{stamp}", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    // On Windows the per-user %APPDATA% folder is already private to this user.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn validate_key(key: &str) -> Result<()> {
    if key.is_empty()
        || key.len() > 512
        || key
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\\'))
    {
        return Err("That does not look like an API key.".into());
    }
    Ok(())
}
pub fn save_key(key: &str) -> Result<()> {
    let _lock = keys::LOCK
        .lock()
        .map_err(|_| "Key storage is unavailable")?;
    keys::save(
        &config_dir().ok_or("Cannot find the config folder")?,
        "anthropic",
        key.trim(),
    )
    .map(|_| ())
}
fn load_provider() -> Result<(Provider, &'static str)> {
    let dir = config_dir().ok_or("Cannot find the config folder")?;
    let mut saved = match fs::read_to_string(dir.join("ai-provider.json")) {
        Ok(text) => {
            serde_json::from_str::<Provider>(&text).map_err(|_| "Invalid AI provider settings")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Provider {
            kind: "claude".into(),
            ..Provider::default()
        },
        Err(_) => return Err("Cannot read AI provider settings".into()),
    };
    keys::legacy(&dir, &mut saved)?;
    let (key, storage) = keys::load(&dir, &keys::account(&saved))?;
    saved.api_key = key;
    Ok((saved, storage))
}
pub fn provider() -> Result<Provider> {
    let _lock = keys::LOCK
        .lock()
        .map_err(|_| "Key storage is unavailable")?;
    load_provider().map(|(p, _)| p)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProvider {
    #[serde(flatten)]
    pub provider: Provider,
    pub key_set: bool,
    pub key_storage: &'static str,
}
pub fn public_provider() -> Result<PublicProvider> {
    let _lock = keys::LOCK
        .lock()
        .map_err(|_| "Key storage is unavailable")?;
    let (provider, storage) = load_provider()?;
    let key_set = !provider.api_key.is_empty()
        || (provider.kind == "claude"
            && std::env::var("ANTHROPIC_API_KEY").is_ok_and(|k| !k.trim().is_empty()));
    Ok(PublicProvider {
        provider,
        key_set,
        key_storage: storage,
    })
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
            let url = tauri::Url::parse(&next.base_url).map_err(|_| "Invalid API address")?;
            if !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("The API address must not contain credentials, a query, or a fragment. Put the key in the API key field.".into());
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
    let _lock = keys::LOCK
        .lock()
        .map_err(|_| "Key storage is unavailable")?;
    let dir = config_dir().ok_or("Cannot find the config folder")?;
    let (old, _) = load_provider()?;
    if !next.api_key.is_empty() {
        keys::save(&dir, &keys::account(&next), &next.api_key)?;
    } else if old.kind == next.kind && old.base_url == next.base_url {
        next.api_key = old.api_key;
    }
    let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    write_private(
        &provider_file().ok_or("Cannot find the config folder")?,
        text.as_bytes(),
    )
}

/// curl config lines carrying the Claude credentials, so they never appear in the process list.
fn credentials(provider: &Provider) -> Result<(String, &'static str)> {
    let key = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .map(|k| k.trim().to_owned())
        .filter(|k| !k.is_empty())
        .or_else(|| Some(provider.api_key.clone()).filter(|key| !key.is_empty()));
    if let Some(key) = key {
        validate_key(&key)?;
        return Ok((format!("header = \"x-api-key: {key}\"\n"), ""));
    }
    let token = crate::platform::command("ant")
        .args(["auth", "print-credentials", "--access-token"])
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .filter(|t| validate_key(t).is_ok())
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

fn redact_headers(text: &str, headers: &str) -> String {
    let mut text = crate::git::redact(text);
    for line in headers.lines() {
        let secret = line
            .strip_prefix("header = \"x-api-key: ")
            .or_else(|| line.strip_prefix("header = \"Authorization: Bearer "))
            .and_then(|value| value.strip_suffix('"'));
        if let Some(secret) = secret.filter(|secret| !secret.is_empty()) {
            text = text.replace(secret, "[redacted]");
        }
    }
    text
}

/// POSTs a JSON body with curl, reading headers and body from stdin so keys never reach the process list.
fn post(url: &str, headers: &str, body: &Value, name: &str) -> Result<String> {
    let mut child = crate::platform::command("curl")
        .args([
            "-q",
            "-sS",
            "--max-time",
            "300",
            "--proto",
            "=http,https",
            "--max-filesize",
            "2097152",
            "-K",
            "-",
            "--url",
            url,
        ])
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
            redact_headers(String::from_utf8_lossy(&output.stderr).trim(), headers)
        ));
    }
    Ok(redact_headers(
        &String::from_utf8_lossy(&output.stdout),
        headers,
    ))
}

/// Runs a command-line agent in its own temporary folder with the prompt on stdin.
fn run_command(command: &str, prompt: &str) -> Result<Answer> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gitgui-agent-{}-{stamp}", std::process::id()));
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let mut child = crate::platform::shell(command)
        .current_dir(&dir)
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
    // Stop an agent that runs longer than 10 minutes; dropping `done` ends the watchdog early.
    let (done, finished) = std::sync::mpsc::channel::<()>();
    let pid = child.id();
    std::thread::spawn(move || {
        if finished.recv_timeout(std::time::Duration::from_secs(600))
            == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        {
            crate::platform::kill_tree(pid);
        }
    });
    let output = child.wait_with_output().map_err(|e| e.to_string());
    drop(done);
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

fn scrub(text: &str, provider: &Provider) -> String {
    let mut text = crate::git::redact(text);
    for key in [
        Some(provider.api_key.clone()),
        std::env::var("ANTHROPIC_API_KEY").ok(),
    ]
    .into_iter()
    .flatten()
    .filter(|key| !key.is_empty())
    {
        text = text.replace(&key, "[redacted]");
    }
    text
}

pub fn sanitize_output(output: Result<String>) -> Result<String> {
    let provider = provider()?;
    output
        .map(|text| scrub(&text, &provider))
        .map_err(|error| scrub(&error, &provider))
}

pub fn ask(task: &str, changes: &str) -> Result<Answer> {
    let prompt = prompt(task, changes)?;
    let provider = provider()?;
    let answer = (|| match provider.kind.as_str() {
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
            let (auth, beta) = credentials(&provider)?;
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
    })();
    answer
        .map(|mut answer: Answer| {
            answer.text = scrub(&answer.text, &provider);
            answer
        })
        .map_err(|error| scrub(&error, &provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_authentication_headers_never_reach_the_webview() {
        let provider = Provider {
            api_key: "private-key".into(),
            ..Provider::default()
        };
        let public = PublicProvider {
            provider,
            key_set: true,
            key_storage: "credential-store",
        };
        let value = serde_json::to_value(public).unwrap();
        assert_eq!(value["keySet"], true);
        assert!(value.get("apiKey").is_none());
        assert!(value.get("api_key").is_none());
        let headers =
            "header = \"x-api-key: secret-key\"\nheader = \"Authorization: Bearer secret-token\"\n";
        assert_eq!(
            redact_headers(
                "secret-key secret-token https://user:password@host/repo",
                headers
            ),
            "[redacted] [redacted] https://[redacted]@host/repo"
        );
    }

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
