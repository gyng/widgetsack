//! CLI protocol and installed executable discovery.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const ADAPTER_INSTRUCTIONS: &str = "You are a studio adapter. Do not call native tools. Reply ONLY with one JSON object: {\"tool\":\"studio_read\",\"args\":{}} or {\"tool\":\"studio_apply\",\"args\":{\"ops\":[...]}} or {\"tool\":\"studio_verify\",\"args\":{}} or {\"message\":\"reply to the user\"}.";

#[derive(Clone, Debug)]
pub struct AgentCommand {
    pub program: PathBuf,
    pub prefix: Vec<String>,
}

pub fn discover(name: &str, directories: &[PathBuf]) -> Option<AgentCommand> {
    for directory in directories {
        let executable = directory.join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        });
        if executable.is_file() {
            return Some(AgentCommand {
                program: executable,
                prefix: vec![],
            });
        }
        if cfg!(windows) && name != "node" {
            let shim = directory.join(format!("{name}.cmd"));
            if let Ok(contents) = std::fs::read_to_string(shim)
                && let Some(script) = npm_script(directory, &contents)
            {
                let local_node = directory.join("node.exe");
                let node = if local_node.is_file() {
                    AgentCommand {
                        program: local_node,
                        prefix: vec![],
                    }
                } else if let Some(node) = discover("node", directories) {
                    node
                } else {
                    continue;
                };
                return Some(AgentCommand {
                    program: node.program,
                    prefix: vec![script.to_string_lossy().into_owned()],
                });
            }
        }
    }
    None
}

// Resolve npm's script path directly. Never execute a command shell with model/user arguments.
fn npm_script(directory: &Path, contents: &str) -> Option<PathBuf> {
    contents.split('"').find_map(|part| {
        let relative = part.strip_prefix("%dp0%\\")?;
        if !relative.ends_with(".js") && !relative.ends_with(".mjs") {
            return None;
        }
        let script = directory.join(relative);
        script.is_file().then_some(script)
    })
}

pub fn arguments(backend: &str, model: &str) -> Vec<String> {
    let args: &[&str] = match backend {
        "pi" => &[
            "--print",
            "--mode",
            "json",
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-session",
        ],
        "codex" => &[
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--disable",
            "shell_tool",
            "--disable",
            "unified_exec",
            "-c",
            "mcp_servers={}",
            "-c",
            "web_search=\"disabled\"",
            "--json",
        ],
        _ => &[
            "-p",
            "--output-format",
            "json",
            "--tools",
            "",
            "--no-session-persistence",
            "--setting-sources",
            "user",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
        ],
    };
    let mut args: Vec<String> = args.iter().map(|arg| (*arg).into()).collect();
    if backend == "codex" {
        args.extend([
            "-c".into(),
            format!(
                "developer_instructions={}",
                serde_json::to_string(ADAPTER_INSTRUCTIONS).expect("string serialization")
            ),
        ]);
    } else {
        args.extend(["--system-prompt".into(), ADAPTER_INSTRUCTIONS.into()]);
    }
    if !model.is_empty() {
        args.extend(["--model".into(), model.into()]);
    }
    if backend == "codex" {
        args.push("-".into());
    }
    args
}

pub fn status(available: [bool; 3]) -> Value {
    let names = [("pi", "Pi"), ("codex", "Codex"), ("claude", "Claude")];
    json!({
        "defaultBackend": names.iter().zip(available).find(|(_, found)| *found).map(|((id, _), _)| *id).unwrap_or(""),
        "backends": names.iter().zip(available).map(|((id, label), available)| json!({ "id": id, "label": label, "available": available })).collect::<Vec<_>>()
    })
}

pub fn reply(backend: &str, output: &str) -> Result<Value, String> {
    let mut text = None;
    for line in if backend == "claude" {
        vec![output]
    } else {
        output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect()
    } {
        let event: Value = serde_json::from_str(line).map_err(|_| "Invalid agent output")?;
        if event["is_error"] == true || event["type"] == "turn.failed" || event["type"] == "error" {
            return Err(event["error"]["message"]
                .as_str()
                .or(event["result"].as_str())
                .or(event["message"].as_str())
                .unwrap_or("Agent request failed")
                .into());
        }
        if backend == "claude" {
            text = event["result"].as_str().map(str::to_owned);
        }
        if backend == "pi"
            && event["type"] == "message_end"
            && event["message"]["role"] == "assistant"
        {
            let message = &event["message"];
            if matches!(message["stopReason"].as_str(), Some("error" | "aborted")) {
                return Err(message["errorMessage"]
                    .as_str()
                    .unwrap_or("Pi request failed")
                    .into());
            }
            text = Some(
                message["content"]
                    .as_array()
                    .ok_or("Invalid Pi reply")?
                    .iter()
                    .filter(|block| block["type"] == "text")
                    .filter_map(|block| block["text"].as_str())
                    .collect::<String>(),
            );
        }
        if backend == "codex"
            && event["type"] == "item.completed"
            && event["item"]["type"] == "agent_message"
        {
            text = event["item"]["text"].as_str().map(str::to_owned);
        }
    }
    let text = text
        .filter(|text| !text.trim().is_empty())
        .ok_or("Agent returned no reply")?;
    let trimmed = text.trim();
    let payload = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|text| text.strip_suffix("```"))
        .unwrap_or(trimmed)
        .trim();
    if let Ok(value) = serde_json::from_str::<Value>(payload) {
        if matches!(
            value["tool"].as_str(),
            Some("studio_read" | "studio_apply" | "studio_verify")
        ) && value["args"].is_object()
        {
            return Ok(value);
        }
        if value["message"].is_string() {
            return Ok(json!({ "message": value["message"] }));
        }
    }
    Ok(json!({ "message": text }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_native_and_npm_agents_without_a_shell_or_bundled_runtime() {
        let directory = std::env::temp_dir().join(format!(
            "widgetsack-agent-discovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let native = directory.join(if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        });
        std::fs::write(&native, "fixture").unwrap();
        assert_eq!(
            discover("claude", std::slice::from_ref(&directory))
                .unwrap()
                .program,
            native
        );
        assert!(discover("pi", std::slice::from_ref(&directory)).is_none());
        if cfg!(windows) {
            let script = directory.join("cli.js");
            std::fs::write(&script, "fixture").unwrap();
            std::fs::write(
                directory.join("pi.cmd"),
                r#"@echo off
"%_prog%" "%dp0%\cli.js" %*"#,
            )
            .unwrap();
            assert!(discover("pi", std::slice::from_ref(&directory)).is_none());
            let node = directory.join("node.exe");
            std::fs::write(&node, "fixture").unwrap();
            let pi = discover("pi", std::slice::from_ref(&directory)).unwrap();
            assert_eq!(pi.program, node);
            assert_eq!(pi.prefix, [script.to_string_lossy()]);
        }
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn installed_preference_and_missing_agents() {
        for (available, expected) in [
            ([true, true, true], "pi"),
            ([false, true, true], "codex"),
            ([false, false, true], "claude"),
            ([false; 3], ""),
        ] {
            assert_eq!(status(available)["defaultBackend"], expected);
            assert_eq!(status(available)["backends"].as_array().unwrap().len(), 3);
        }
    }
    #[test]
    fn preserves_studio_actions_and_plain_replies() {
        let action =
            json!({"tool":"studio_apply","args":{"ops":[{"op":"addWidget","widgetType":"clock"}]}});
        let codex = json!({"type":"item.completed","item":{"type":"agent_message","text":format!("```json\n{action}\n```")}});
        assert_eq!(reply("codex", &codex.to_string()).unwrap(), action);
        let pi = json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}});
        assert_eq!(reply("pi", &pi.to_string()).unwrap()["message"], "Hello");
        assert_eq!(
            reply("claude", r#"{"result":"{\"message\":\"Done\"}"}"#).unwrap()["message"],
            "Done"
        );
        let unknown = json!({"result":"{\"tool\":\"shell\",\"args\":{}}"});
        assert!(reply("claude", &unknown.to_string()).unwrap()["message"].is_string());
    }
    #[test]
    fn reports_provider_failures_and_invalid_output() {
        for (backend, output, error) in [
            (
                "claude",
                r#"{"is_error":true,"result":"login required"}"#,
                "login required",
            ),
            (
                "codex",
                r#"{"type":"turn.failed","error":{"message":"bad"}}"#,
                "bad",
            ),
            (
                "pi",
                r#"{"type":"message_end","message":{"role":"assistant","stopReason":"aborted","errorMessage":"Stopped"}}"#,
                "Stopped",
            ),
            ("codex", "", "Agent returned no reply"),
            ("codex", "invalid", "Invalid agent output"),
        ] {
            assert_eq!(reply(backend, output).unwrap_err(), error);
        }
    }
    #[test]
    fn cli_arguments_disable_native_tools_and_preserve_model_as_one_argument() {
        assert!(arguments("pi", "").contains(&"--no-tools".into()));
        assert!(arguments("codex", "").contains(&"read-only".into()));
        let args = arguments("claude", "model & literal");
        assert_eq!(
            args[args.iter().position(|arg| arg == "--tools").unwrap() + 1],
            ""
        );
        assert_eq!(args.last().unwrap(), "model & literal");
    }
}

/// Model IDs only: never return local account, endpoint, or credential metadata.
pub fn cached_model_ids(value: &Value) -> Vec<String> {
    let mut ids: Vec<String> = value["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["slug"].as_str())
        .chain(value["model"].as_str())
        .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_whitespace))
        .map(str::to_owned)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}
pub fn pi_model_ids(output: &str) -> Vec<String> {
    let mut ids: Vec<String> = output
        .lines()
        .filter_map(|line| {
            let cells: Vec<_> = line.split_whitespace().collect();
            if cells.len() < 6
                || cells[0] == "provider"
                || !["yes", "no"].contains(&cells[cells.len() - 1])
            {
                return None;
            }
            Some(format!("{}/{}", cells[0], cells[1]))
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids
}
#[cfg(test)]
mod model_tests {
    use super::*;
    #[test]
    fn model_catalogs_keep_only_ids_and_deduplicate() {
        assert_eq!(
            cached_model_ids(
                &json!({"models":[{"slug":"custom-model","token":"secret"},{"slug":"custom-model"},{"slug":""},{"slug":"bad\nname"},{}],"model":"other-model"})
            ),
            vec!["custom-model", "other-model"]
        );
        assert!(cached_model_ids(&Value::Null).is_empty());
        assert_eq!(
            pi_model_ids(
                "provider model context max-out thinking images\nopenai test-model 128K 8K yes yes\nopenai test-model 128K 8K yes yes\nstatus: none\n"
            ),
            vec!["openai/test-model"]
        );
    }
}
