//! Native, opt-in MCP transport. Studio tools share the frontend editor seams; stdio needs no Node.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub enabled: bool,
    #[serde(default)]
    pub browser_access: bool,
}
struct Server {
    handle: tauri::async_runtime::JoinHandle<()>,
    endpoint: String,
}
#[derive(Default)]
pub struct McpState {
    server: tokio::sync::Mutex<Option<Server>>,
    pending: Mutex<HashMap<String, (oneshot::Sender<Value>, bool)>>,
    next: AtomicU64,
    pub browser_port: Mutex<Option<u16>>,
}
impl McpState {
    pub fn new(browser_port: Option<u16>) -> Self {
        Self {
            browser_port: Mutex::new(browser_port),
            ..Default::default()
        }
    }
}
fn only_studio(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "studio" {
        Ok(())
    } else {
        Err("MCP settings are studio-only".into())
    }
}
fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::file_io::config_root(app)?.join("mcp.json"))
}
pub fn read_prefs(app: &AppHandle) -> Prefs {
    prefs_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
fn descriptor(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::file_io::config_root(app)?.join("mcp/server.json"))
}
fn status(prefs: Prefs, server: Option<&Server>, browser_port: Option<u16>) -> Value {
    let command = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    json!({"enabled": prefs.enabled, "browserAccess": prefs.browser_access, "running": server.is_some(), "endpoint": server.map(|s| &s.endpoint), "browserUrl": browser_port.map(|p| format!("http://127.0.0.1:{p}")), "config": {"mcpServers": {"widgetsack": {"command": command, "args": if crate::multi_instance() {vec!["--mcp", "--multi"]} else {vec!["--mcp"]}}}}})
}
#[tauri::command]
pub async fn mcp_status(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, McpState>,
) -> Result<Value, String> {
    only_studio(&window)?;
    let server = state.server.lock().await;
    Ok(status(
        read_prefs(&app),
        server.as_ref(),
        *state
            .browser_port
            .lock()
            .map_err(|_| "MCP state unavailable")?,
    ))
}
#[tauri::command]
pub async fn mcp_set_preferences(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, McpState>,
    enabled: bool,
    browser_access: bool,
) -> Result<Value, String> {
    only_studio(&window)?;
    let prefs = Prefs {
        enabled,
        browser_access,
    };
    let mut server = state.server.lock().await;
    let started = enabled && server.is_none();
    if started {
        *server = Some(start_server(app.clone()).await?);
    }
    let path = prefs_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Err(error) = crate::file_io::atomic_write(
        &path,
        &serde_json::to_string(&prefs).map_err(|e| e.to_string())?,
    ) {
        if started {
            if let Some(old) = server.take() {
                old.handle.abort();
            }
            let _ = std::fs::remove_file(descriptor(&app)?);
        }
        return Err(error);
    }
    if !enabled {
        if let Some(old) = server.take() {
            old.handle.abort();
        }
        state
            .pending
            .lock()
            .map_err(|_| "MCP state unavailable")?
            .clear();
        let _ = std::fs::remove_file(descriptor(&app)?);
    }
    Ok(status(
        prefs,
        server.as_ref(),
        *state
            .browser_port
            .lock()
            .map_err(|_| "MCP state unavailable")?,
    ))
}
pub async fn restore(app: AppHandle) {
    let state = app.state::<McpState>();
    let mut guard = state.server.lock().await;
    if read_prefs(&app).enabled {
        if guard.is_none() {
            match start_server(app.clone()).await {
                Ok(server) => *guard = Some(server),
                Err(error) => crate::log::error("mcp", "could not start MCP")
                    .field("error", error)
                    .emit(),
            }
        }
    } else if let Ok(path) = descriptor(&app) {
        let _ = std::fs::remove_file(path);
    }
}

async fn start_server(app: AppHandle) -> Result<Server, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let endpoint = format!(
        "http://127.0.0.1:{}/mcp",
        listener.local_addr().map_err(|e| e.to_string())?.port()
    );
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let path = descriptor(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("Invalid MCP path")?).map_err(|e| e.to_string())?;
    crate::file_io::atomic_write(
        &path,
        &json!({"endpoint": endpoint, "token": token}).to_string(),
    )?;
    let token2 = token.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut clients = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
             incoming = listener.accept() => {
              let Ok((stream, _)) = incoming else { break; };
              if clients.len() >= 32 { continue; }
              let app = app.clone(); let token = token2.clone();
              clients.spawn(async move { serve_connection(app, &token, stream).await; });
             }
             _ = clients.join_next(), if !clients.is_empty() => {}
            }
        }
    });
    Ok(Server { handle, endpoint })
}
pub fn tools() -> Value {
    json!({"tools": [
    {"name":"studio_read","description":"Read the active editor target, layout, catalog, sensor IDs and revision. Studio must be open; the assistant sidebar can stay closed.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
    {"name":"studio_apply","description":"Apply one undoable edit batch against the revision returned by studio_read. Use studio_verify afterward. Does not save automatically.","inputSchema":{"type":"object","properties":{"revision":{"type":"string"},"ops":{"type":"array","maxItems":32,"items":{"type":"object"}}},"required":["revision","ops"],"additionalProperties":false}},
    {"name":"studio_verify","description":"Measure the rendered layout after edits. Reports missing, collapsed, hidden, overflowing and failed widgets. Geometry does not replace visual review.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
    {"name":"studio_screenshot","description":"Capture only the current Studio webview as a PNG for visual review. Restore Studio if minimized.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}
    ]})
}
pub fn rpc_result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
pub fn rpc_error(id: &Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
pub fn static_rpc(request: &Value) -> Option<Value> {
    let id = &request["id"];
    if request["jsonrpc"] != "2.0"
        || !request["method"].is_string()
        || !(id.is_string() || id.is_number() || id.is_null())
    {
        return Some(rpc_error(id, -32600, "Invalid JSON-RPC request"));
    }
    match request["method"].as_str()? {
        "initialize" => Some(rpc_result(
            id,
            json!({"protocolVersion": match request["params"]["protocolVersion"].as_str() { Some("2025-03-26") => "2025-03-26", Some("2025-06-18") => "2025-06-18", _ => "2025-11-25" },"capabilities":{"tools":{}},"serverInfo":{"name":"widgetsack","version":env!("CARGO_PKG_VERSION")},"instructions":"Read before editing. Apply against the returned revision, verify geometry, then review a Studio screenshot. Edits are live and undoable; Save keeps them."}),
        )),
        "ping" => Some(rpc_result(id, json!({}))),
        "tools/list" => Some(rpc_result(id, tools())),
        "tools/call" => None,
        _ => Some(rpc_error(id, -32601, "Unknown method")),
    }
}
async fn serve_connection(app: AppHandle, token: &str, mut stream: TcpStream) {
    let Ok(Some((head, bytes))) = tokio::time::timeout(
        Duration::from_secs(10),
        crate::control::read_request(&mut stream),
    )
    .await
    else {
        return;
    };
    if !crate::control::bearer_ok(&head.headers, token) || head.headers.contains_key("origin") {
        crate::control::write_resp(
            &mut stream,
            "401 Unauthorized",
            &json!({"error":"unauthorized"}),
        )
        .await;
        return;
    }
    if head.path != "/mcp" || head.method != "POST" {
        crate::control::write_resp(
            &mut stream,
            "405 Method Not Allowed",
            &json!({"error":"Use POST /mcp"}),
        )
        .await;
        return;
    }
    if !crate::control::is_json(&head.headers) {
        crate::control::write_resp(
            &mut stream,
            "415 Unsupported Media Type",
            &json!({"error":"Send application/json"}),
        )
        .await;
        return;
    }
    let request = match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => value,
        Err(_) => {
            crate::control::write_resp(
                &mut stream,
                "200 OK",
                &rpc_error(&Value::Null, -32700, "Invalid JSON"),
            )
            .await;
            return;
        }
    };
    if request["jsonrpc"] == "2.0"
        && request.get("id").is_none()
        && request["method"]
            .as_str()
            .is_some_and(|m| m.starts_with("notifications/"))
    {
        let _ = stream
            .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return;
    }
    let response = if let Some(value) = static_rpc(&request) {
        value
    } else {
        let name = request["params"]["name"].as_str().unwrap_or("");
        let args = request["params"]
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let result = if name == "studio_screenshot" {
            capture_studio(&app).await
        } else if ["studio_read", "studio_apply", "studio_verify"].contains(&name)
            && args.is_object()
        {
            call_studio(&app, name, args).await
        } else {
            Err("Unknown tool or invalid arguments".into())
        };
        let content = match result {
            Ok(value) if name == "studio_screenshot" => {
                json!({"content":[{"type":"image","data":value["data"],"mimeType":"image/png"}],"isError":false})
            }
            Ok(value) => {
                json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":value.get("error").is_some() || value.get("errors").and_then(Value::as_array).is_some_and(|errors| !errors.is_empty())})
            }
            Err(error) => json!({"content":[{"type":"text","text":error}],"isError":true}),
        };
        rpc_result(&request["id"], content)
    };
    crate::control::write_resp(&mut stream, "200 OK", &response).await;
}
async fn call_studio(app: &AppHandle, name: &str, args: Value) -> Result<Value, String> {
    if app.get_webview_window("studio").is_none() {
        return Err(
            "Open Studio to use layout tools. The assistant sidebar is not required.".into(),
        );
    }
    let state = app.state::<McpState>();
    let id = format!("mcp-{}", state.next.fetch_add(1, Ordering::Relaxed));
    let (send, recv) = oneshot::channel();
    state
        .pending
        .lock()
        .map_err(|_| "MCP state unavailable")?
        .insert(id.clone(), (send, false));
    if let Err(error) = app.emit_to(
        "studio",
        crate::bridge::MCP_STUDIO_REQUEST,
        json!({"id":id,"name":name,"args":args}),
    ) {
        state
            .pending
            .lock()
            .map_err(|_| "MCP state unavailable")?
            .remove(&id);
        return Err(error.to_string());
    }
    let result = tokio::time::timeout(Duration::from_secs(20), recv).await;
    state
        .pending
        .lock()
        .map_err(|_| "MCP state unavailable")?
        .remove(&id);
    result
        .map_err(|_| "Studio did not answer in time".to_string())?
        .map_err(|_| "MCP request was cancelled".into())
}
#[tauri::command]
pub fn mcp_studio_claim(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, McpState>,
    request_id: String,
) -> Result<bool, String> {
    only_studio(&window)?;
    let mut pending = state.pending.lock().map_err(|_| "MCP state unavailable")?;
    if let Some((_, claimed)) = pending.get_mut(&request_id)
        && !*claimed
    {
        *claimed = true;
        return Ok(true);
    }
    Ok(false)
}
#[tauri::command]
pub fn mcp_studio_reply(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, McpState>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    only_studio(&window)?;
    if let Some((sender, _)) = state
        .pending
        .lock()
        .map_err(|_| "MCP state unavailable")?
        .remove(&request_id)
    {
        let _ = sender.send(result);
    }
    Ok(())
}
pub async fn capture_studio(app: &AppHandle) -> Result<Value, String> {
    let window = app
        .get_webview_window("studio")
        .ok_or("Open Studio before taking a screenshot")?;
    if window.is_minimized().map_err(|e| e.to_string())? {
        return Err("Restore Studio before taking a screenshot".into());
    }
    #[cfg(windows)]
    {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        let (sender, recv) = oneshot::channel();
        let sender = std::sync::Arc::new(Mutex::new(Some(sender)));
        window
            .with_webview(move |view| {
                let complete = sender.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result, payload| {
                        let result = result
                            .map_err(|e| e.to_string())
                            .and_then(|()| {
                                serde_json::from_str::<Value>(&payload).map_err(|e| e.to_string())
                            })
                            .and_then(|value| {
                                if value["data"]
                                    .as_str()
                                    .is_some_and(|s| !s.is_empty() && s.len() <= 16_000_000)
                                {
                                    Ok(value)
                                } else {
                                    Err("Screenshot is empty or too large".into())
                                }
                            });
                        if let Ok(mut sender) = complete.lock()
                            && let Some(sender) = sender.take()
                        {
                            let _ = sender.send(result);
                        }
                        Ok(())
                    },
                ));
                let result = unsafe {
                    view.controller().CoreWebView2().and_then(|core| {
                        core.CallDevToolsProtocolMethod(
                            windows::core::w!("Page.captureScreenshot"),
                            windows::core::w!("{\"format\":\"png\"}"),
                            &handler,
                        )
                    })
                };
                if let Err(error) = result
                    && let Ok(mut sender) = sender.lock()
                    && let Some(sender) = sender.take()
                {
                    let _ = sender.send(Err(error.to_string()));
                }
            })
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(15), recv)
            .await
            .map_err(|_| "Screenshot timed out".to_string())?
            .map_err(|_| "Studio closed during capture".to_string())?
    }
    #[cfg(not(windows))]
    {
        Err("Studio screenshots require Windows".into())
    }
}
/// The installed executable is also the stdio MCP bridge. It forwards to the running app's authenticated endpoint.
pub async fn stdio_bridge(path: Option<PathBuf>) -> Result<(), String> {
    let path = path.unwrap_or_else(|| {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("io.github.gyng");
        if crate::multi_instance() {
            base.join("multi/mcp/server.json")
        } else {
            base.join("mcp/server.json")
        }
    });
    let descriptor: Value = serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "Start widgetsack and enable Settings → MCP first")?,
    )
    .map_err(|_| "Invalid MCP descriptor")?;
    let endpoint = descriptor["endpoint"]
        .as_str()
        .ok_or("Missing MCP endpoint")?;
    let url = reqwest::Url::parse(endpoint).map_err(|e| e.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.path() != "/mcp" {
        return Err("MCP endpoint must be local".into());
    }
    let token = descriptor["token"].as_str().ok_or("Missing MCP token")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    loop {
        let mut line = String::new();
        if input
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?
            == 0
        {
            break;
        }
        if line.len() > 256_000 {
            return Err("MCP request is too large".into());
        }
        let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let response = client
            .post(url.clone())
            .bearer_auth(token)
            .header("Accept", "application/json, text/event-stream")
            .json(&value)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("MCP endpoint returned {}", response.status()));
        }
        if response.status() != reqwest::StatusCode::ACCEPTED {
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            output.write_all(&bytes).await.map_err(|e| e.to_string())?;
            output.write_all(b"\n").await.map_err(|e| e.to_string())?;
            output.flush().await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_handshake_and_tool_catalog_are_stable() {
        let result = static_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})).unwrap();
        assert_eq!(result["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(tools()["tools"].as_array().unwrap().len(), 4);
        assert_eq!(
            static_rpc(&json!({"jsonrpc":"2.0","id":"x","method":"ping"})).unwrap()["result"],
            json!({})
        );
        assert!(static_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call"})).is_none());
        assert_eq!(
            static_rpc(&json!({"id":1,"method":"ping"})).unwrap()["error"]["code"],
            -32600
        );
        assert_eq!(
            static_rpc(&json!({"jsonrpc":"2.0","id":1,"method":"unknown"})).unwrap()["error"]["code"],
            -32601
        );
    }
}

/// Scope optional CDP to this app's WebView2 process, without changing global environment variables.
pub fn configure_browser(context: &mut tauri::Context<tauri::Wry>) -> Option<u16> {
    let mut root = PathBuf::from(std::env::var_os("APPDATA")?);
    root.push(&context.config().identifier);
    if crate::multi_instance() {
        root.push("multi");
    }
    let prefs: Prefs = serde_json::from_slice(&std::fs::read(root.join("mcp.json")).ok()?).ok()?;
    if !prefs.browser_access {
        return None;
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    let port = listener.local_addr().ok()?.port();
    for window in &mut context.config_mut().app.windows {
        let previous = window.additional_browser_args.take().unwrap_or_default();
        window.additional_browser_args = Some(format!(
            "{previous} --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
        ));
    }
    Some(port)
}
