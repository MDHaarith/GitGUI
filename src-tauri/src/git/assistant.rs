//! Narrow assistant tools: the same validation and checkpoints as the regular UI.
use super::*;
use crate::assist::chat::{is_write, permitted, Permission, ToolCall};
use serde_json::{json, Value};

fn argument<'a>(input: &'a Value, name: &str) -> Result<&'a str> {
    input[name]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 16_000 && !value.contains('\0'))
        .ok_or_else(|| format!("Invalid {name}"))
}
fn encoded(value: impl Serialize) -> Result<String> {
    serde_json::to_string(&value).map_err(|e| e.to_string())
}
impl Backend {
    pub fn assistant_tool(
        &mut self,
        id: u64,
        call: &ToolCall,
        permission: Permission,
        allow: bool,
        token: &str,
    ) -> Result<String> {
        if !permitted(&call.name, permission) {
            return Err("This tool is disabled by the assistant permission level.".into());
        }
        if !call.input.is_object() {
            return Err("Tool arguments must be an object".into());
        }
        let fields: &[&str] = match call.name.as_str() {
            "diff" => &["oid", "staged"],
            "show_file" => &["oid", "path"],
            "stage" => &["fileIds"],
            "commit" => &["message", "bump"],
            "create_branch" => &["name"],
            "switch_branch" => &["referenceId"],
            "stash" => &["message"],
            _ => &[],
        };
        if call
            .input
            .as_object()
            .unwrap()
            .keys()
            .any(|key| !fields.contains(&key.as_str()))
            || call.input.to_string().len() > 32_000
        {
            return Err("Invalid tool arguments".into());
        }
        if let Some(bump) = call.input.get("bump") {
            if !matches!(bump.as_str(), Some("patch" | "minor" | "major")) {
                return Err("Choose a patch, minor, or major version bump".into());
            }
        }
        let write = is_write(&call.name);
        if write && !allow {
            return Err("This write requires an explicit Allow click.".into());
        }
        let input = &call.input;
        // Validate before creating a checkpoint or changing anything.
        match call.name.as_str() {
            "diff" => {
                if let Some(oid) = input.get("oid") {
                    valid_oid(oid.as_str().ok_or("Invalid commit ID")?)?;
                }
                if input.get("staged").is_some_and(|v| !v.is_boolean()) {
                    return Err("Invalid staged flag".into());
                }
            }
            "show_file" => {
                valid_oid(argument(input, "oid")?)?;
                relative_path(argument(input, "path")?.as_bytes())?;
            }
            "stage" => {
                let ids = input["fileIds"]
                    .as_array()
                    .ok_or("Choose file IDs from status")?;
                if ids.is_empty() || ids.len() > 200 || ids.iter().any(|v| v.as_str().is_none()) {
                    return Err("Choose 1–200 file IDs from status".into());
                }
            }
            "commit" | "stash" => {
                argument(input, "message")?;
            }
            "create_branch" => self.repo(id)?.valid_branch_name(argument(input, "name")?)?,
            "switch_branch" => {
                self.repo(id)?
                    .local_branch(argument(input, "referenceId")?)?;
            }
            _ => {}
        }
        if write {
            self.repo(id)?.checked(token)?;
            self.checkpoint(id, &format!("Before assistant {}", call.name))?;
        }
        let output = match call.name.as_str() {
            "status" => encoded(self.status(id)?),
            "branches" => encoded(self.repo(id)?.refs()?),
            "log" => {
                let repo = self.repo(id)?;
                if repo.info()?.head.is_none() {
                    Ok("[]".into())
                } else {
                    Ok(text(&read(
                        &repo.root,
                        &argv(&["log", "-50", "--format=%H %s", "--no-decorate"]),
                    )?))
                }
            }
            "diff" => {
                if let Some(oid) = input["oid"].as_str() {
                    encoded(self.commit_diff(id, oid, None, None)?)
                } else {
                    let repo = self.repo(id)?;
                    let mut args = argv(&[
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--no-color",
                        "--submodule=short",
                    ]);
                    if input["staged"] == true {
                        args.push(os("--cached"));
                    }
                    args.push(os("--"));
                    encoded(preview(&repo.root, &args)?)
                }
            }
            "show_file" => {
                let repo = self.repo(id)?;
                let object = format!("{}:{}", argument(input, "oid")?, argument(input, "path")?);
                encoded(preview(
                    &repo.root,
                    &argv(&["show", "--no-ext-diff", "--no-textconv", &object, "--"]),
                )?)
            }
            "stage" => {
                let ids = input["fileIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>();
                encoded(self.stage(id, &ids, false, token)?)
            }
            "commit" => encoded(self.commit(
                id,
                argument(input, "message")?,
                token,
                false,
                input["bump"].as_str().map(str::to_owned),
                false,
            )?),
            "create_branch" => {
                encoded(self.create_branch(id, argument(input, "name")?, None, token)?)
            }
            "switch_branch" => {
                encoded(self.switch_branch(id, argument(input, "referenceId")?, token)?)
            }
            "stash" => encoded(self.stash_save(id, argument(input, "message")?, token)?),
            _ => Err("Unknown assistant tool".into()),
        };
        output
            .map(|text| {
                let text = redact(&text);
                if text.chars().count() <= 60_000 {
                    text
                } else {
                    json!({"text":text.chars().take(60_000).collect::<String>(),"truncated":true})
                        .to_string()
                }
            })
            .map_err(|error| redact(&error))
    }
}
