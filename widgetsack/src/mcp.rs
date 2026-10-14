//! Native, opt-in MCP transport. Studio tools share the frontend editor seams; stdio needs no Node.
mod sessions;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
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
type PendingRequests = HashMap<String, (oneshot::Sender<Value>, bool)>;
type CancelNotifier = Box<dyn FnOnce(&str) + Send>;
struct PendingRequestGuard {
    pending: Arc<Mutex<PendingRequests>>,
    id: String,
    on_cancel: Option<CancelNotifier>,
}
impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        let outstanding = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id)
            .is_some();
        if outstanding && let Some(notify) = self.on_cancel.take() {
            notify(&self.id);
        }
    }
}
#[derive(Default)]
pub struct McpState {
    server: tokio::sync::Mutex<Option<Server>>,
    pending: Arc<Mutex<PendingRequests>>,
    next: AtomicU64,
    pub browser_port: Mutex<Option<u16>>,
}
impl McpState {
    fn claim_request(&self, request_id: &str) -> Result<bool, String> {
        let mut pending = self.pending.lock().map_err(|_| "MCP state unavailable")?;
        if pending
            .get(request_id)
            .is_some_and(|(sender, _)| sender.is_closed())
        {
            pending.remove(request_id);
            return Ok(false);
        }
        if let Some((_, claimed)) = pending.get_mut(request_id)
            && !*claimed
        {
            *claimed = true;
            return Ok(true);
        }
        Ok(false)
    }
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
        let cancelled: Vec<String> = state
            .pending
            .lock()
            .map_err(|_| "MCP state unavailable")?
            .drain()
            .map(|(id, _)| id)
            .collect();
        for id in cancelled {
            emit_studio_cancellation(&app, &id);
        }
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
    let sessions = Arc::new(Mutex::new(sessions::Sessions::default()));
    let handle = tauri::async_runtime::spawn(async move {
        let mut clients = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
             incoming = listener.accept() => {
              let Ok((stream, _)) = incoming else { break; };
              if clients.len() >= 32 { continue; }
              let app = app.clone(); let token = token2.clone(); let sessions = sessions.clone();
              clients.spawn(async move {
                serve_connection(&token, sessions, stream, move |name, args| async move {
                    if name == "studio_screenshot" { capture_studio(&app).await }
                    else { call_studio(&app, &name, args).await }
                }).await;
              });
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
    if request["jsonrpc"] != "2.0" || !request["method"].is_string() || !sessions::valid_id(id) {
        return Some(rpc_error(
            if sessions::valid_id(id) {
                id
            } else {
                &Value::Null
            },
            -32600,
            "Invalid JSON-RPC request",
        ));
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
async fn serve_connection<F, Fut>(
    token: &str,
    sessions: Arc<Mutex<sessions::Sessions>>,
    mut stream: TcpStream,
    call: F,
) where
    F: FnOnce(String, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
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
    let session = head.headers.get("mcp-session-id").cloned();
    if session.as_ref().is_some_and(|id| {
        !sessions
            .lock()
            .map(|mut state| state.contains(id))
            .unwrap_or(false)
    }) {
        crate::control::write_resp(
            &mut stream,
            "404 Not Found",
            &json!({"error":"MCP session expired"}),
        )
        .await;
        return;
    }
    if request["jsonrpc"] == "2.0"
        && request.get("id").is_none()
        && request["method"]
            .as_str()
            .is_some_and(|m| m.starts_with("notifications/"))
    {
        if request["method"] == "notifications/cancelled"
            && let Some(session) = &session
            && let Ok(mut state) = sessions.lock()
        {
            state.cancel(session, &request["params"]["requestId"]);
        }
        write_mcp_accepted(&mut stream).await;
        return;
    }
    if let Some(value) = static_rpc(&request) {
        if request["method"] == "initialize" && value.get("result").is_some() {
            let created = sessions
                .lock()
                .map_err(|_| "MCP sessions unavailable".to_string())
                .and_then(|mut state| state.create());
            match created {
                Ok(id) => write_mcp_response(&mut stream, &value, Some(&id)).await,
                Err(error) => {
                    write_mcp_response(
                        &mut stream,
                        &rpc_error(&request["id"], -32603, &error),
                        None,
                    )
                    .await
                }
            }
        } else {
            write_mcp_response(&mut stream, &value, None).await;
        }
        return;
    }
    let response = {
        let name = request["params"]["name"].as_str().unwrap_or("");
        let args = request["params"]
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let registration = match &session {
            Some(id) => match sessions::Sessions::register(&sessions, id, &request["id"]) {
                Ok(registered) => Some(registered),
                Err(error) => {
                    write_mcp_response(
                        &mut stream,
                        &rpc_error(&request["id"], -32600, &error),
                        None,
                    )
                    .await;
                    return;
                }
            },
            None => None,
        };
        let operation = async {
            if [
                "studio_screenshot",
                "studio_read",
                "studio_apply",
                "studio_verify",
            ]
            .contains(&name)
                && args.is_object()
            {
                call(name.to_owned(), args).await
            } else {
                Err("Unknown tool or invalid arguments".into())
            }
        };
        let result = sessions::run(registration, operation).await;
        let Some(result) = result else {
            write_mcp_accepted(&mut stream).await;
            return;
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

async fn write_mcp_accepted(stream: &mut TcpStream) {
    let _ = stream
        .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .await;
}

async fn write_mcp_response(stream: &mut TcpStream, value: &Value, session: Option<&str>) {
    let body = value.to_string();
    let header = session
        .map(|id| format!("Mcp-Session-Id: {id}\r\n"))
        .unwrap_or_default();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{header}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
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
    let cancelled_app = app.clone();
    let _request = PendingRequestGuard {
        pending: state.pending.clone(),
        id: id.clone(),
        on_cancel: Some(Box::new(move |id| {
            emit_studio_cancellation(&cancelled_app, id)
        })),
    };
    app.emit_to(
        "studio",
        crate::bridge::MCP_STUDIO_REQUEST,
        json!({"id":id,"name":name,"args":args}),
    )
    .map_err(|error| error.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(20), recv).await;
    result
        .map_err(|_| "Studio did not answer in time".to_string())?
        .map_err(|_| "MCP request was cancelled".into())
}
fn emit_studio_cancellation(app: &AppHandle, id: &str) {
    let _ = app.emit_to(
        "studio",
        crate::bridge::MCP_STUDIO_REQUEST,
        json!({"id":id,"cancelled":true}),
    );
}

#[tauri::command]
pub fn mcp_studio_claim(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, McpState>,
    request_id: String,
) -> Result<bool, String> {
    only_studio(&window)?;
    state.claim_request(&request_id)
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
const STDIO_REQUEST_LIMIT: usize = 256_000;
const STDIO_RESPONSE_LIMIT: usize = 32 * 1024 * 1024;

async fn read_stdio_line<R: tokio::io::AsyncBufRead + Unpin>(
    input: &mut R,
) -> Result<Option<String>, String> {
    let mut line = String::new();
    if (&mut *input)
        .take((STDIO_REQUEST_LIMIT + 1) as u64)
        .read_line(&mut line)
        .await
        .map_err(|error| error.to_string())?
        == 0
    {
        return Ok(None);
    }
    if line.len() > STDIO_REQUEST_LIMIT {
        return Err("MCP request is too large".into());
    }
    Ok(Some(line))
}

fn stdio_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(crate::http_response::request_error)
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
    let client = stdio_http_client()?;
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    forward_stdio(&mut input, &mut output, &client, url, token).await
}

async fn forward_stdio<R: tokio::io::AsyncBufRead + Unpin, W: tokio::io::AsyncWrite + Unpin>(
    input: &mut R,
    output: &mut W,
    client: &reqwest::Client,
    url: reqwest::Url,
    token: &str,
) -> Result<(), String> {
    let mut session: Option<String> = None;
    let mut requests = tokio::task::JoinSet::new();
    let mut active = std::collections::HashSet::new();
    let mut cancelled = std::collections::HashSet::new();
    loop {
        // Keep the same read future alive while replies complete: read_line is not cancellation-safe.
        let read = read_stdio_line(input);
        tokio::pin!(read);
        let line = loop {
            tokio::select! {
                line = &mut read => break line?,
                Some(reply) = requests.join_next(), if !requests.is_empty() => {
                    emit_stdio_reply(output, reply, &mut active, &mut cancelled).await?;
                }
            }
        };
        let Some(line) = line else {
            while let Some(reply) = requests.join_next().await {
                emit_stdio_reply(output, reply, &mut active, &mut cancelled).await?;
            }
            return Ok(());
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                let error = rpc_error(&Value::Null, -32700, "Invalid JSON").to_string();
                write_stdio_response(output, error.as_bytes()).await?;
                continue;
            }
        };
        if value["method"] == "tools/call" && sessions::valid_id(&value["id"]) {
            let key = value["id"].to_string();
            if active.contains(&key) || requests.len() >= 4 {
                let error = rpc_error(
                    &value["id"],
                    -32000,
                    "Too many pending requests or duplicate request ID",
                );
                write_stdio_response(output, error.to_string().as_bytes()).await?;
                continue;
            }
            active.insert(key.clone());
            let client = client.clone();
            let url = url.clone();
            let token = token.to_string();
            let session = session.clone();
            requests.spawn(async move {
                let result = post_stdio_request(&client, url, &token, session.as_deref(), &value)
                    .await
                    .map(|(bytes, _)| bytes);
                (key, result)
            });
            continue;
        }
        if value["jsonrpc"] == "2.0"
            && value.get("id").is_none()
            && value["method"] == "notifications/cancelled"
        {
            let key = value["params"]["requestId"].to_string();
            if active.contains(&key) {
                cancelled.insert(key);
            }
        }
        let (bytes, assigned) =
            post_stdio_request(client, url.clone(), token, session.as_deref(), &value).await?;
        if let Some(id) = assigned {
            session = Some(id);
        }
        if let Some(bytes) = bytes {
            write_stdio_response(output, &bytes).await?;
        }
    }
}

type StdioReply = (String, Result<Option<Vec<u8>>, String>);
async fn emit_stdio_reply<W: tokio::io::AsyncWrite + Unpin>(
    output: &mut W,
    reply: Result<StdioReply, tokio::task::JoinError>,
    active: &mut std::collections::HashSet<String>,
    cancelled: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    let (id, result) = reply.map_err(|error| error.to_string())?;
    active.remove(&id);
    if !cancelled.remove(&id)
        && let Some(bytes) = result?
    {
        write_stdio_response(output, &bytes).await?;
    }
    Ok(())
}

async fn post_stdio_request(
    client: &reqwest::Client,
    url: reqwest::Url,
    token: &str,
    session: Option<&str>,
    value: &Value,
) -> Result<(Option<Vec<u8>>, Option<String>), String> {
    let mut request = client
        .post(url)
        .bearer_auth(token)
        .header("Accept", "application/json, text/event-stream")
        .json(value);
    if let Some(session) = session {
        request = request.header("Mcp-Session-Id", session);
    }
    let response = request
        .send()
        .await
        .map_err(crate::http_response::request_error)?;
    if !response.status().is_success() {
        return Err(format!("MCP endpoint returned {}", response.status()));
    }
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|id| id.to_str().ok())
        .map(str::to_string);
    let bytes = if response.status() == reqwest::StatusCode::ACCEPTED {
        None
    } else {
        Some(crate::http_response::read_body(response, STDIO_RESPONSE_LIMIT).await?)
    };
    Ok((bytes, session))
}

async fn write_stdio_response<W: tokio::io::AsyncWrite + Unpin>(
    output: &mut W,
    bytes: &[u8],
) -> Result<(), String> {
    output.write_all(bytes).await.map_err(|e| e.to_string())?;
    output.write_all(b"\n").await.map_err(|e| e.to_string())?;
    output.flush().await.map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_guards_notify_after_removal_but_completed_requests_do_not() {
        let pending = Arc::new(Mutex::new(PendingRequests::new()));
        let notifications = Arc::new(Mutex::new(Vec::new()));
        for completed in [false, true] {
            let (sender, _receiver) = oneshot::channel();
            pending
                .lock()
                .unwrap()
                .insert("request".into(), (sender, false));
            let check_pending = pending.clone();
            let received = notifications.clone();
            let guard = PendingRequestGuard {
                pending: pending.clone(),
                id: "request".into(),
                on_cancel: Some(Box::new(move |id| {
                    assert!(!check_pending.lock().unwrap().contains_key(id));
                    received.lock().unwrap().push(id.to_string());
                })),
            };
            if completed {
                pending.lock().unwrap().remove("request");
            }
            drop(guard);
        }
        assert_eq!(*notifications.lock().unwrap(), vec!["request"]);
    }

    #[tokio::test]
    async fn stdio_cancels_a_pending_tool_without_blocking_following_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url =
            reqwest::Url::parse(&format!("http://{}/mcp", listener.local_addr().unwrap())).unwrap();
        let sessions = Arc::new(Mutex::new(sessions::Sessions::default()));
        let state = Arc::new(McpState::default());
        let check_state = state.clone();
        let (ready, mut received) = tokio::sync::mpsc::channel(4);
        let mut server = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            for _ in 0..10 {
                let (stream, _) = listener.accept().await.unwrap();
                let sessions = sessions.clone();
                let state = state.clone();
                let ready = ready.clone();
                tasks.spawn(serve_connection(
                    "fixture-token",
                    sessions,
                    stream,
                    move |name, args| async move {
                        assert_eq!(name, "studio_apply");
                        let id = format!("pending-{}", args["n"]);
                        let (sender, _receiver) = oneshot::channel();
                        state
                            .pending
                            .lock()
                            .unwrap()
                            .insert(id.clone(), (sender, false));
                        let _owner = PendingRequestGuard {
                            pending: state.pending.clone(),
                            id: id.clone(),
                            on_cancel: None,
                        };
                        ready.try_send(id).unwrap();
                        std::future::pending::<Result<Value, String>>().await
                    },
                ));
            }
            while let Some(result) = tasks.join_next().await {
                result.unwrap();
            }
        });
        let (mut input, stream) = tokio::io::duplex(4096);
        let mut bridge = tokio::spawn(async move {
            let mut reader = BufReader::new(stream);
            let mut output = Vec::new();
            let result = forward_stdio(
                &mut reader,
                &mut output,
                &stdio_http_client().unwrap(),
                url,
                "fixture-token",
            )
            .await;
            (result, output)
        });
        let completed = tokio::time::timeout(Duration::from_secs(5), async {
            input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\"}\n").await.unwrap();
            for id in 1..=4 {
                let request = json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"studio_apply","arguments":{"n":id}}});
                input.write_all(format!("{request}\n").as_bytes()).await.unwrap();
            }
            for _ in 0..4 { received.recv().await.unwrap(); }
            assert_eq!(check_state.pending.lock().unwrap().len(), 4);
            let overflow = json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"studio_apply","arguments":{"n":5}}});
            input.write_all(format!("{overflow}\n").as_bytes()).await.unwrap();
            for id in 1..=4 {
                let cancel = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id}});
                input.write_all(format!("{cancel}\n").as_bytes()).await.unwrap();
            }
            input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"ping\"}\n").await.unwrap();
            input.shutdown().await.unwrap();
            let result = (&mut bridge).await;
            let server_result = (&mut server).await;
            (result, server_result)
        }).await;
        let (result, server_result) = match completed {
            Ok(result) => result,
            Err(_) => {
                bridge.abort();
                server.abort();
                let _ = bridge.await;
                let _ = server.await;
                panic!("cancellation was blocked behind pending tools");
            }
        };
        server_result.unwrap();
        let (result, output) = result.unwrap();
        result.unwrap();
        assert!(check_state.pending.lock().unwrap().is_empty());
        for id in 1..=4 {
            assert!(!check_state.claim_request(&format!("pending-{id}")).unwrap());
        }
        let replies: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[0]["id"], 0);
        assert_eq!(replies[1]["id"], 5);
        assert_eq!(replies[1]["error"]["code"], -32000);
        assert_eq!(replies[2], rpc_result(&json!(6), json!({})));
    }
    #[tokio::test]
    async fn stdio_reports_parse_errors_and_continues_with_the_next_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url =
            reqwest::Url::parse(&format!("http://{}/mcp", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(3), async {
                for method in ["notifications/initialized", "ping"] {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let (head, bytes) = crate::control::read_request(&mut stream).await.unwrap();
                    assert_eq!(head.method, "POST");
                    assert!(crate::control::bearer_ok(&head.headers, "fixture-token"));
                    assert_eq!(
                        serde_json::from_slice::<Value>(&bytes).unwrap()["method"],
                        method
                    );
                    crate::control::write_resp(
                        &mut stream,
                        if method == "ping" {
                            "200 OK"
                        } else {
                            "202 Accepted"
                        },
                        &rpc_result(&json!(7), json!({})),
                    )
                    .await;
                }
            })
            .await
            .unwrap();
        });
        let mut input = &b"not json\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"ping\"}\n"[..];
        let mut output = Vec::new();
        let result = forward_stdio(
            &mut input,
            &mut output,
            &stdio_http_client().unwrap(),
            url,
            "fixture-token",
        )
        .await;
        if result.is_err() {
            server.abort();
        }
        let joined = server.await;
        assert!(result.is_ok(), "{result:?}");
        joined.unwrap();
        let replies: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0], rpc_error(&Value::Null, -32700, "Invalid JSON"));
        assert_eq!(replies[1], rpc_result(&json!(7), json!({})));
    }

    #[tokio::test]
    async fn aborted_tool_tasks_release_their_pending_request() {
        let state = McpState::default();
        let (sender, _receiver) = oneshot::channel();
        state
            .pending
            .lock()
            .unwrap()
            .insert("request".into(), (sender, false));
        let request = PendingRequestGuard {
            pending: state.pending.clone(),
            id: "request".into(),
            on_cancel: None,
        };
        let (ready, started) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _request = request;
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(!state.claim_request("request").unwrap());
        assert!(state.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn cancelled_tool_requests_cannot_be_claimed_for_late_edits() {
        let state = McpState::default();
        let (sender, receiver) = oneshot::channel();
        state
            .pending
            .lock()
            .unwrap()
            .insert("cancelled".into(), (sender, false));
        drop(receiver);
        assert!(!state.claim_request("cancelled").unwrap());
        assert!(!state.pending.lock().unwrap().contains_key("cancelled"));
        let (sender, _receiver) = oneshot::channel();
        state
            .pending
            .lock()
            .unwrap()
            .insert("live".into(), (sender, false));
        assert!(state.claim_request("live").unwrap());
        assert!(!state.claim_request("live").unwrap());
        assert!(!state.claim_request("missing").unwrap());
    }

    #[tokio::test]
    async fn oversized_stdio_input_is_rejected_before_consuming_the_entire_line() {
        let bytes = vec![b'x'; STDIO_REQUEST_LIMIT * 8];
        let mut input = bytes.as_slice();
        assert!(read_stdio_line(&mut input).await.is_err());
        assert!(
            bytes.len() - input.len() <= STDIO_REQUEST_LIMIT + 1,
            "read the entire oversized request before rejecting it"
        );
    }

    #[tokio::test]
    async fn stdio_requests_keep_lines_and_final_unterminated_input_separate() {
        let mut input = b"first\nlast".as_slice();
        assert_eq!(
            read_stdio_line(&mut input).await.unwrap().as_deref(),
            Some("first\n")
        );
        assert_eq!(
            read_stdio_line(&mut input).await.unwrap().as_deref(),
            Some("last")
        );
        assert!(read_stdio_line(&mut input).await.unwrap().is_none());
        let bytes = vec![b'x'; STDIO_REQUEST_LIMIT];
        assert!(
            read_stdio_line(&mut bytes.as_slice())
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn stdio_transport_does_not_follow_endpoint_redirects() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 1024];
            assert!(socket.read(&mut request).unwrap() > 0);
            write!(socket, "HTTP/1.1 302 Found\r\nLocation: http://{address}/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let result = stdio_http_client()
            .unwrap()
            .get(format!("http://{address}/mcp"))
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        server.join().unwrap();
        assert_eq!(result.unwrap().status(), reqwest::StatusCode::FOUND);
    }

    #[test]
    fn protocol_handshake_and_tool_catalog_are_stable() {
        for id in [
            Value::Null,
            json!(true),
            json!(1.5),
            json!([]),
            json!("x".repeat(257)),
        ] {
            let response =
                static_rpc(&json!({"jsonrpc":"2.0","id":id,"method":"tools/call"})).unwrap();
            assert_eq!(response["error"]["code"], -32600);
            assert_eq!(response["id"], Value::Null);
        }
        assert_eq!(
            static_rpc(&json!({"jsonrpc":"2.0","method":"tools/call"})).unwrap()["error"]["code"],
            -32600
        );
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
