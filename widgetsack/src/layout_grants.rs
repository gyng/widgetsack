//! Saved-layout grants for the two capability commands overlays may call without a studio gate:
//! `run_widget_command` (PowerShell) and `check_service_health` (outbound HTTP). An overlay only
//! renders the SAVED layout, so a non-studio caller may only run a command / check a URL that the
//! saved `widgets.json` actually configures. The studio previews unsaved edits and bypasses this.
//!
//! The layout JSON is frontend-owned; this module only reads it, generically and tolerantly: every
//! `command` unit's `config.command`, every `servicehealth` unit's `config.url`, and every group
//! instance's string param value whose library def routes that param onto a `command` / `url` path
//! (see client `core/params.ts` `applyParams`). Anything malformed grants nothing (fail closed).
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// The capabilities one saved layout configures.
#[derive(Debug, Default, PartialEq)]
pub struct LayoutGrants {
    commands: HashSet<String>,
    health_urls: HashSet<String>,
    usage_sources: HashSet<(String, String, String)>,
}

impl LayoutGrants {
    pub fn allows_usage_source(&self, source: &str, env: &str, account: &str) -> bool {
        self.usage_sources
            .contains(&(source.into(), env.into(), account.into()))
    }
    /// Exact match: the command string is run verbatim, so nothing is normalized.
    pub fn allows_command(&self, command: &str) -> bool {
        self.commands.contains(command)
    }
    /// The service-health host trims its configured URL before calling, so compare trimmed.
    pub fn allows_health_url(&self, url: &str) -> bool {
        self.health_urls.contains(url.trim())
    }
}

/// What a def param can write: its key plus whether any target ends in `command` / `url`.
struct ParamRoute {
    key: String,
    command: bool,
    url: bool,
}

fn param_routes(spec: &Map<String, Value>) -> Option<ParamRoute> {
    let key = spec.get("key")?.as_str()?.to_string();
    // Same precedence as applyParams: `targets`, else `target`, else `unit.config.<key>`.
    let targets: Vec<String> = match (spec.get("targets"), spec.get("target")) {
        (Some(Value::Array(list)), _) => list
            .iter()
            .filter_map(|t| t.as_str().map(str::to_string))
            .collect(),
        (_, Some(Value::String(t))) => vec![t.clone()],
        _ => vec![format!("unit.config.{key}")],
    };
    let ends = |segment: &str| {
        targets
            .iter()
            .any(|t| t.rsplit('.').next() == Some(segment))
    };
    Some(ParamRoute {
        command: ends("command"),
        url: ends("url"),
        key,
    })
}

/// Library defs by id → their param routes (only `library.defs` is consulted by the renderer).
fn library_routes(doc: &Map<String, Value>) -> HashMap<String, Vec<ParamRoute>> {
    let mut out = HashMap::new();
    let defs = doc
        .get("library")
        .and_then(|l| l.get("defs"))
        .and_then(Value::as_array);
    for def in defs.into_iter().flatten() {
        let (Some(id), Some(params)) = (
            def.get("id").and_then(Value::as_str),
            def.get("params").and_then(Value::as_array),
        ) else {
            continue;
        };
        let routes = params
            .iter()
            .filter_map(|p| p.as_object().and_then(param_routes))
            .collect();
        out.insert(id.to_string(), routes);
    }
    out
}

fn config_str<'a>(obj: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    obj.get("config")?.get(field)?.as_str()
}

/// PURE SEAM: the grants a saved layout document configures, or `None` when it is not a JSON
/// object (corrupt / truncated) — callers refuse in that case. Walks the WHOLE document (v1 widget
/// lists, v2 monitor trees and floating layers, inline group children, and library defs alike).
pub fn grants_from_layout(contents: &str) -> Option<LayoutGrants> {
    let doc: Value = serde_json::from_str(contents).ok()?;
    let root = doc.as_object()?;
    let routes = library_routes(root);
    let mut grants = LayoutGrants::default();
    // Iterative walk: serde_json already caps nesting, but no recursion keeps this stack-safe.
    let mut pending = vec![&doc];
    while let Some(value) = pending.pop() {
        match value {
            Value::Array(items) => pending.extend(items),
            Value::Object(obj) => {
                match obj.get("type").and_then(Value::as_str) {
                    Some("command") => {
                        if let Some(c) = config_str(obj, "command") {
                            grants.commands.insert(c.to_string());
                        }
                    }
                    Some("aiusage") => {
                        if let Some(providers) = obj
                            .get("config")
                            .and_then(|c| c.get("providers"))
                            .and_then(Value::as_array)
                        {
                            for provider in providers {
                                if let Some(source) = provider.get("source").and_then(Value::as_str)
                                {
                                    grants.usage_sources.insert((
                                        source.to_string(),
                                        provider
                                            .get("env")
                                            .and_then(Value::as_str)
                                            .unwrap_or("OPENROUTER_API_KEY")
                                            .into(),
                                        provider
                                            .get("account")
                                            .and_then(Value::as_str)
                                            .unwrap_or("")
                                            .into(),
                                    ));
                                }
                                if let Some(command) =
                                    provider.get("command").and_then(Value::as_str)
                                {
                                    grants.commands.insert(command.to_string());
                                }
                            }
                        } else {
                            for source in ["codex", "claude"] {
                                grants.usage_sources.insert((
                                    source.into(),
                                    "OPENROUTER_API_KEY".into(),
                                    String::new(),
                                ));
                            }
                        }
                    }
                    Some("servicehealth") => {
                        if let Some(u) = config_str(obj, "url") {
                            grants.health_urls.insert(u.trim().to_string());
                        }
                    }
                    _ => {}
                }
                let group_routes = (obj.get("kind").and_then(Value::as_str) == Some("group"))
                    .then(|| obj.get("def").and_then(Value::as_str))
                    .flatten()
                    .and_then(|def| routes.get(def));
                if let (Some(def_routes), Some(Value::Object(values))) =
                    (group_routes, obj.get("params"))
                {
                    for route in def_routes {
                        let Some(v) = values.get(&route.key).and_then(Value::as_str) else {
                            continue;
                        };
                        if route.command {
                            grants.commands.insert(v.to_string());
                        }
                        if route.url {
                            grants.health_urls.insert(v.trim().to_string());
                        }
                    }
                }
                pending.extend(obj.values());
            }
            _ => {}
        }
    }
    Some(grants)
}

/// PURE SEAM: the gate decision. The studio is trusted (it runs unsaved edits); any other window
/// needs a saved layout (`contents`) whose grants pass `allowed`. `what` names the capability.
pub fn authorize(
    window_label: &str,
    contents: Option<&str>,
    what: &str,
    allowed: impl FnOnce(&LayoutGrants) -> bool,
) -> Result<(), String> {
    if window_label == "studio" {
        return Ok(());
    }
    let contents = contents.ok_or_else(|| format!("{what} refused: no saved layout"))?;
    let grants = grants_from_layout(contents)
        .ok_or_else(|| format!("{what} refused: the saved layout could not be read"))?;
    if allowed(&grants) {
        Ok(())
    } else {
        Err(format!(
            "{what} refused: it is not configured in the saved layout"
        ))
    }
}

/// Read the saved `widgets.json` (`None` when it does not exist). Small; read per call.
pub async fn read_saved_layout<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    let path = crate::file_io::config_root(app)?.join("widgets.json");
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("could not read the saved layout: {err}")),
    }
}

/// The adapter both commands share: studio passes without touching disk; others are checked.
pub async fn authorize_saved<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window_label: &str,
    what: &str,
    allowed: impl FnOnce(&LayoutGrants) -> bool,
) -> Result<(), String> {
    if window_label == "studio" {
        return Ok(());
    }
    let contents = read_saved_layout(app).await?;
    authorize(window_label, contents.as_deref(), what, allowed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn usage_widgets_grant_only_their_exact_configured_commands() {
        let g = grants(
            json!({"widgets":[{"type":"aiusage","config":{"providers":[{"source":"codex"},{"source":"command","command":"Get-Usage"}]}}]}),
        );
        assert!(g.allows_command("Get-Usage"));
        assert!(!g.allows_command("Get-Usage; Write-Output hacked"));
        assert!(g.allows_usage_source("codex", "OPENROUTER_API_KEY", ""));
        assert!(!g.allows_usage_source("openrouter", "OTHER_SECRET", ""));
        let defaults = grants(json!({"widgets":[{"type":"aiusage","config":{}}]}));
        assert!(defaults.allows_usage_source("claude", "OPENROUTER_API_KEY", ""));
    }

    fn grants(doc: Value) -> LayoutGrants {
        grants_from_layout(&doc.to_string()).unwrap()
    }

    fn leaf(id: &str, kind: &str, config: Value) -> Value {
        json!({ "id": id, "unit": { "id": id, "type": kind, "config": config } })
    }

    #[test]
    fn collects_commands_and_urls_from_trees_floating_layers_and_inline_groups() {
        let g = grants(json!({
            "version": 2,
            "monitors": { "M1": {
                "root": { "id": "r", "kind": "row", "children": [
                    leaf("a", "command", json!({ "command": "Get-Date" })),
                    leaf("b", "servicehealth", json!({ "url": "  https://ok.example/health " })),
                    { "id": "g", "unit": { "id": "g", "kind": "group", "size": { "w": 1, "h": 1 },
                        "child": leaf("c", "command", json!({ "command": "hostname" })) } }
                ] },
                "floating": [leaf("d", "command", json!({ "command": "Get-Process | Select -First 1" }))]
            } }
        }));
        for c in ["Get-Date", "hostname", "Get-Process | Select -First 1"] {
            assert!(g.allows_command(c), "{c}");
        }
        assert!(g.allows_health_url("https://ok.example/health"));
        assert!(g.allows_health_url(" https://ok.example/health\n"));
        // Exact match only: a near-miss or an extra suffix is a different command.
        assert!(!g.allows_command("Get-Date; Remove-Item x"));
        assert!(!g.allows_command("get-date"));
        assert!(!g.allows_command(" Get-Date"));
        assert!(!g.allows_health_url("https://evil.example/"));
    }

    #[test]
    fn ignores_capability_fields_on_other_unit_types() {
        let g = grants(
            json!({ "monitors": { "M1": { "root": { "id": "r", "kind": "row", "children": [
            leaf("a", "text", json!({ "command": "calc", "url": "https://x.example" })),
            leaf("b", "iframe", json!({ "url": "https://y.example" })),
            leaf("c", "command", json!({ "command": 5 }))
        ] }, "floating": [] } } }),
        );
        assert_eq!(g, LayoutGrants::default());
    }

    #[test]
    fn grants_library_defs_and_param_values_routed_onto_command_or_url() {
        let g = grants(json!({
            "library": { "version": 1, "defs": [
                { "id": "cli", "name": "CLI", "size": { "w": 1, "h": 1 },
                  "child": leaf("x", "command", json!({ "command": "Get-Uptime" })),
                  "params": [
                    { "key": "command" },
                    { "key": "label", "target": "unit.config.label" }
                  ] },
                { "id": "probe", "name": "Probe", "size": { "w": 1, "h": 1 },
                  "child": leaf("y", "servicehealth", json!({})),
                  "params": [{ "key": "where", "targets": ["unit.config.url", "unit.config.label"] }] }
            ] },
            "monitors": { "M1": { "root": { "id": "r", "kind": "row", "children": [
                { "id": "i1", "unit": { "id": "i1", "kind": "group", "def": "cli",
                    "size": { "w": 1, "h": 1 }, "child": { "id": "e", "kind": "row", "children": [] },
                    "params": { "command": "Get-Service", "label": "Restart-Computer" } } },
                { "id": "i2", "unit": { "id": "i2", "kind": "group", "def": "probe",
                    "size": { "w": 1, "h": 1 }, "child": { "id": "e2", "kind": "row", "children": [] },
                    "params": { "where": "https://nas.example/ping " } } },
                { "id": "i3", "unit": { "id": "i3", "kind": "group", "def": "missing",
                    "size": { "w": 1, "h": 1 }, "child": { "id": "e3", "kind": "row", "children": [] },
                    "params": { "command": "Stop-Computer" } } }
            ] }, "floating": [] } }
        }));
        assert!(g.allows_command("Get-Uptime")); // the def's own unit
        assert!(g.allows_command("Get-Service")); // default target unit.config.command
        assert!(!g.allows_command("Restart-Computer")); // routed to a label, not a command
        assert!(!g.allows_command("Stop-Computer")); // def not in the library: params are inert
        assert!(g.allows_health_url("https://nas.example/ping"));
    }

    #[test]
    fn v1_widget_lists_are_scanned_too() {
        let g = grants(json!({ "widgets": [
            { "id": "a", "type": "command", "config": { "command": "whoami" }, "rect": {} }
        ] }));
        assert!(g.allows_command("whoami"));
    }

    #[test]
    fn malformed_documents_grant_nothing() {
        for bad in ["", "{", "[]", "null", "\"x\"", "{\"monitors\":"] {
            assert!(grants_from_layout(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn authorize_trusts_the_studio_and_checks_everyone_else() {
        let saved =
            json!({ "widgets": [{ "type": "command", "config": { "command": "Get-Date" } }] })
                .to_string();
        let check = |label: &str, contents: Option<&str>, cmd: &str| {
            authorize(label, contents, "command", |g| g.allows_command(cmd))
        };
        assert!(check("studio", None, "anything").is_ok());
        assert!(check("main", Some(&saved), "Get-Date").is_ok());
        assert!(check("overlay-2", Some(&saved), "Get-Date").is_ok());
        let refused = check("main", Some(&saved), "calc").unwrap_err();
        assert!(refused.contains("not configured"), "{refused}");
        assert!(
            check("main", None, "Get-Date")
                .unwrap_err()
                .contains("no saved layout")
        );
        assert!(
            check("main", Some("{oops"), "Get-Date")
                .unwrap_err()
                .contains("could not be read")
        );
    }
}
