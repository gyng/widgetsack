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

#[derive(Debug, PartialEq)]
enum StdioLine {
    Line(Vec<u8>),
    TooLarge,
}

async fn read_stdio_line<R: tokio::io::AsyncBufRead + Unpin>(
    input: &mut R,
) -> Result<Option<StdioLine>, String> {
    let mut line = Vec::new();
    if (&mut *input)
        .take((STDIO_REQUEST_LIMIT + 1) as u64)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|error| error.to_string())?
        == 0
    {
        return Ok(None);
    }
    if line.len() <= STDIO_REQUEST_LIMIT {
        return Ok(Some(StdioLine::Line(line)));
    }
    // Discard the rest of the oversized line without buffering it.
    while !line.ends_with(b"\n") {
        let buffer = input.fill_buf().await.map_err(|error| error.to_string())?;
        if buffer.is_empty() {
            break;
        }
        let (used, done) = match buffer.iter().position(|&byte| byte == b'\n') {
            Some(end) => (end + 1, true),
            None => (buffer.len(), false),
        };
        input.consume(used);
        if done {
            break;
        }
    }
    Ok(Some(StdioLine::TooLarge))
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
    let endpoint = read_descriptor(&path)?;
    let reload: DescriptorReader = Arc::new(move || read_descriptor(&path));
    let bridge = StdioBridge::new(stdio_http_client()?, endpoint, reload);
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    forward_stdio(&mut input, &mut output, bridge).await
}

/// Where the stdio bridge posts: the running app's endpoint + bearer token (`mcp/server.json`).
#[derive(Clone, Debug, PartialEq)]
struct StdioEndpoint {
    url: reqwest::Url,
    token: String,
}

/// Parse `server.json`, refusing anything but this app's local endpoint.
fn parse_descriptor(bytes: &[u8]) -> Result<StdioEndpoint, String> {
    let descriptor: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid MCP descriptor")?;
    let endpoint = descriptor["endpoint"]
        .as_str()
        .ok_or("Missing MCP endpoint")?;
    let url = reqwest::Url::parse(endpoint).map_err(|e| e.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.path() != "/mcp" {
        return Err("MCP endpoint must be local".into());
    }
    let token = descriptor["token"].as_str().ok_or("Missing MCP token")?;
    Ok(StdioEndpoint {
        url,
        token: token.to_string(),
    })
}

fn read_descriptor(path: &std::path::Path) -> Result<StdioEndpoint, String> {
    parse_descriptor(
        &std::fs::read(path).map_err(|_| "Start widgetsack and enable Settings → MCP first")?,
    )
}

type DescriptorReader = Arc<dyn Fn() -> Result<StdioEndpoint, String> + Send + Sync>;

/// Failures that mean the bridge's view of the app is out of date — the app restarted or MCP was
/// toggled (new port → connect refused; new token → 401), or the session was evicted (404). Anything
/// else is the request's own failure and is reported as-is.
enum PostError {
    Stale(String),
    Failed(String),
}
impl PostError {
    fn message(self) -> String {
        match self {
            PostError::Stale(error) | PostError::Failed(error) => error,
        }
    }
}

/// Whether an endpoint status means "re-read the descriptor and re-initialize" (see [`PostError`]).
fn stale_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::NOT_FOUND
    )
}

/// The bridge's current link to the app, shared by in-flight tool calls.
struct StdioLink {
    endpoint: StdioEndpoint,
    session: Option<String>,
    /// The client's own `initialize`, replayed to open a fresh session after a recovery.
    initialize: Option<Value>,
    /// Bumped per recovery so concurrent failures of the same stale link recover only once.
    generation: u64,
}

struct StdioBridge {
    client: reqwest::Client,
    link: tokio::sync::Mutex<StdioLink>,
    reload: DescriptorReader,
}
impl StdioBridge {
    fn new(
        client: reqwest::Client,
        endpoint: StdioEndpoint,
        reload: DescriptorReader,
    ) -> Arc<Self> {
        Arc::new(Self {
            client,
            link: tokio::sync::Mutex::new(StdioLink {
                endpoint,
                session: None,
                initialize: None,
                generation: 0,
            }),
            reload,
        })
    }

    /// Post one message. A stale link is recovered once — re-read the descriptor, replay the cached
    /// `initialize` for a new session — and the message retried; a second failure is reported.
    async fn post(&self, value: &Value) -> Result<Option<Vec<u8>>, String> {
        let (endpoint, session, generation) = self.snapshot().await;
        let stale =
            match post_stdio_request(&self.client, &endpoint, session.as_deref(), value).await {
                Ok(reply) => return Ok(self.accept(reply, value, generation).await),
                Err(PostError::Failed(error)) => return Err(error),
                Err(PostError::Stale(error)) => error,
            };
        let (endpoint, session, generation) = self
            .recover(generation, value)
            .await
            .map_err(|error| format!("{stale}; reconnect failed: {error}"))?;
        match post_stdio_request(&self.client, &endpoint, session.as_deref(), value).await {
            Ok(reply) => Ok(self.accept(reply, value, generation).await),
            Err(error) => Err(error.message()),
        }
    }

    async fn snapshot(&self) -> (StdioEndpoint, Option<String>, u64) {
        let link = self.link.lock().await;
        (link.endpoint.clone(), link.session.clone(), link.generation)
    }

    async fn accept(
        &self,
        (bytes, assigned): (Option<Vec<u8>>, Option<String>),
        value: &Value,
        generation: u64,
    ) -> Option<Vec<u8>> {
        let mut link = self.link.lock().await;
        if link.generation == generation {
            if let Some(id) = assigned {
                link.session = Some(id);
            }
            if value["method"] == "initialize" {
                link.initialize = Some(value.clone());
            }
        }
        bytes
    }

    /// Re-read the descriptor and open a new session — unless another request already recovered
    /// from the same stale link (`seen` is behind), in which case its result is reused.
    async fn recover(
        &self,
        seen: u64,
        value: &Value,
    ) -> Result<(StdioEndpoint, Option<String>, u64), String> {
        let mut link = self.link.lock().await;
        if link.generation == seen {
            link.endpoint = (self.reload)()?;
            link.session = None;
            link.generation += 1;
            if value["method"] != "initialize"
                && let Some(initialize) = link.initialize.clone()
            {
                let (_, assigned) =
                    post_stdio_request(&self.client, &link.endpoint, None, &initialize)
                        .await
                        .map_err(PostError::message)?;
                link.session = assigned;
            }
        }
        Ok((link.endpoint.clone(), link.session.clone(), link.generation))
    }
}

async fn forward_stdio<R: tokio::io::AsyncBufRead + Unpin, W: tokio::io::AsyncWrite + Unpin>(
    input: &mut R,
    output: &mut W,
    bridge: Arc<StdioBridge>,
) -> Result<(), String> {
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
        let line = match line {
            StdioLine::Line(line) => line,
            StdioLine::TooLarge => {
                let error = rpc_error(&Value::Null, -32600, "MCP request is too large").to_string();
                write_stdio_response(output, error.as_bytes()).await?;
                continue;
            }
        };
        let value: Value = match serde_json::from_slice(&line) {
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
            let bridge = bridge.clone();
            requests.spawn(async move {
                let result = bridge.post(&value).await;
                (key, value["id"].clone(), result)
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
        let result = bridge.post(&value).await;
        write_stdio_result(output, &value["id"], result).await?;
    }
}

/// Endpoint failures answer that request; the bridge stays up for the client's other requests.
async fn write_stdio_result<W: tokio::io::AsyncWrite + Unpin>(
    output: &mut W,
    id: &Value,
    result: Result<Option<Vec<u8>>, String>,
) -> Result<(), String> {
    match result {
        Ok(Some(bytes)) => write_stdio_response(output, &bytes).await,
        Ok(None) => Ok(()),
        Err(error) if sessions::valid_id(id) => {
            let error = rpc_error(id, -32603, &error).to_string();
            write_stdio_response(output, error.as_bytes()).await
        }
        Err(error) => {
            eprintln!("MCP notification failed: {error}");
            Ok(())
        }
    }
}

type StdioReply = (String, Value, Result<Option<Vec<u8>>, String>);
async fn emit_stdio_reply<W: tokio::io::AsyncWrite + Unpin>(
    output: &mut W,
    reply: Result<StdioReply, tokio::task::JoinError>,
    active: &mut std::collections::HashSet<String>,
    cancelled: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    let (key, id, result) = reply.map_err(|error| error.to_string())?;
    active.remove(&key);
    if cancelled.remove(&key) {
        return Ok(());
    }
    write_stdio_result(output, &id, result).await
}

async fn post_stdio_request(
    client: &reqwest::Client,
    endpoint: &StdioEndpoint,
    session: Option<&str>,
    value: &Value,
) -> Result<(Option<Vec<u8>>, Option<String>), PostError> {
    let mut request = client
        .post(endpoint.url.clone())
        .bearer_auth(&endpoint.token)
        .header("Accept", "application/json, text/event-stream")
        .json(value);
    if let Some(session) = session {
        request = request.header("Mcp-Session-Id", session);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_connect() {
            PostError::Stale(crate::http_response::request_error(error))
        } else {
            PostError::Failed(crate::http_response::request_error(error))
        }
    })?;
    if !response.status().is_success() {
        let error = format!("MCP endpoint returned {}", response.status());
        return Err(if stale_status(response.status()) {
            PostError::Stale(error)
        } else {
            PostError::Failed(error)
        });
    }
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|id| id.to_str().ok())
        .map(str::to_string);
    let bytes = if response.status() == reqwest::StatusCode::ACCEPTED {
        None
    } else {
        Some(
            crate::http_response::read_body(response, STDIO_RESPONSE_LIMIT)
                .await
                .map_err(PostError::Failed)?,
        )
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
/// wry 0.55's default WebView2 arguments (`webview2/mod.rs`: the base `--disable-features` set, plus
/// the autoplay flag because Tauri leaves wry's `autoplay` at its default `true`). wry applies them
/// ONLY when a window passes no `additional_browser_args`, so once any window passes its own string
/// it must include these itself. Re-check on a wry upgrade (`wry_version_matches_the_pinned_defaults`).
const WRY_DEFAULT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// The ONE WebView2 argument string every window of this process must be created with. All webviews
/// share one user-data folder, and WebView2 refuses a controller whose environment options differ
/// from the live environment's (ERROR_INVALID_STATE 0x8007139F) — so the debugging flags, when
/// browser tools are on, must reach every window, not just the ones declared in tauri.conf.json.
pub fn browser_args(debug_port: Option<u16>) -> String {
    match debug_port {
        Some(port) => format!(
            "{WRY_DEFAULT_BROWSER_ARGS} --remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
        ),
        None => WRY_DEFAULT_BROWSER_ARGS.to_string(),
    }
}

/// [`browser_args`] for this process — what every Rust `WebviewWindowBuilder` passes.
pub fn app_browser_args(app: &AppHandle) -> String {
    let port = app
        .try_state::<McpState>()
        .and_then(|state| state.browser_port.lock().ok().and_then(|port| *port));
    browser_args(port)
}

/// [`browser_args`] for windows the frontend creates (overlay.ts `new WebviewWindow`).
#[tauri::command]
pub fn webview_browser_args(state: tauri::State<'_, McpState>) -> String {
    browser_args(state.browser_port.lock().ok().and_then(|port| *port))
}

/// Scope optional CDP to this app's WebView2 process, without changing global environment variables.
/// Every config-declared window gets the shared [`browser_args`]; code-built windows pass the same
/// string via [`app_browser_args`] / [`webview_browser_args`].
pub fn configure_browser(context: &mut tauri::Context<tauri::Wry>) -> Option<u16> {
    let port = browser_debug_port(context);
    let args = browser_args(port);
    for window in &mut context.config_mut().app.windows {
        window.additional_browser_args = Some(args.clone());
    }
    port
}

fn browser_debug_port(context: &tauri::Context<tauri::Wry>) -> Option<u16> {
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
    Some(listener.local_addr().ok()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bridge whose descriptor never changes (recovery re-reads the same endpoint).
    fn fixed_bridge(url: reqwest::Url) -> Arc<StdioBridge> {
        let endpoint = StdioEndpoint {
            url,
            token: "fixture-token".into(),
        };
        let reload = endpoint.clone();
        StdioBridge::new(
            stdio_http_client().unwrap(),
            endpoint,
            Arc::new(move || Ok(reload.clone())),
        )
    }

    #[test]
    fn descriptor_accepts_only_the_local_mcp_endpoint() {
        assert_eq!(
            parse_descriptor(br#"{"endpoint":"http://127.0.0.1:4100/mcp","token":"t"}"#),
            Ok(StdioEndpoint {
                url: reqwest::Url::parse("http://127.0.0.1:4100/mcp").unwrap(),
                token: "t".into()
            })
        );
        for bad in [
            &br#"{"endpoint":"http://example.com:4100/mcp","token":"t"}"#[..],
            br#"{"endpoint":"http://127.0.0.1:4100/other","token":"t"}"#,
            br#"{"endpoint":"http://127.0.0.1:4100/mcp"}"#,
            b"not json",
        ] {
            assert!(parse_descriptor(bad).is_err());
        }
    }

    #[test]
    fn only_auth_and_session_failures_trigger_a_reconnect() {
        assert!(stale_status(reqwest::StatusCode::UNAUTHORIZED));
        assert!(stale_status(reqwest::StatusCode::NOT_FOUND));
        for status in [
            reqwest::StatusCode::BAD_REQUEST,
            reqwest::StatusCode::METHOD_NOT_ALLOWED,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert!(!stale_status(status));
        }
    }

    /// The bridge outlives the app's MCP server: a dead port, a rotated token (app restart / MCP
    /// toggle) and an evicted session each re-read the descriptor, replay `initialize` for a fresh
    /// session, and retry — instead of failing every later call with -32603.
    #[tokio::test]
    async fn stdio_recovers_from_restart_token_rotation_and_session_eviction() {
        type Live = (String, Arc<Mutex<sessions::Sessions>>);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let live_url =
            reqwest::Url::parse(&format!("http://{}/mcp", listener.local_addr().unwrap())).unwrap();
        let live: Arc<Mutex<Live>> = Arc::new(Mutex::new((
            "token-a".into(),
            Arc::new(Mutex::new(sessions::Sessions::default())),
        )));
        let serving = live.clone();
        let server = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let (token, sessions) = serving.lock().unwrap().clone();
                tokio::spawn(async move {
                    serve_connection(&token, sessions, stream, |_, _| async { Ok(json!({})) }).await
                });
            }
        });
        // The descriptor the bridge started with points at a server that is gone.
        let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead_url =
            reqwest::Url::parse(&format!("http://{}/mcp", dead.local_addr().unwrap())).unwrap();
        drop(dead);
        let descriptor = live.clone();
        let bridge = StdioBridge::new(
            stdio_http_client().unwrap(),
            StdioEndpoint {
                url: dead_url,
                token: "token-a".into(),
            },
            Arc::new(move || {
                Ok(StdioEndpoint {
                    url: live_url.clone(),
                    token: descriptor.lock().unwrap().0.clone(),
                })
            }),
        );
        let (mut input, bridge_input) = tokio::io::duplex(4096);
        let (bridge_output, output) = tokio::io::duplex(4096);
        let forward = tokio::spawn(async move {
            let mut reader = BufReader::new(bridge_input);
            let mut writer = bridge_output;
            forward_stdio(&mut reader, &mut writer, bridge).await
        });
        let mut replies = BufReader::new(output).lines();
        let mut call = async |request: Value| -> Value {
            input
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
            let line = tokio::time::timeout(Duration::from_secs(5), replies.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            serde_json::from_str(&line).unwrap()
        };
        let tool = |id: i64| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"studio_read","arguments":{}}});
        let sessions_now = || live.lock().unwrap().1.clone();

        // 1. Dead port at startup: recovered before the client's own initialize.
        let init = call(json!({"jsonrpc":"2.0","id":0,"method":"initialize"})).await;
        assert!(init["result"].is_object(), "{init}");
        assert_eq!(call(tool(1)).await["result"]["isError"], false);

        // 2. Idle eviction: the server forgot the session (404) — a new one is opened.
        let evicted = Arc::new(Mutex::new(sessions::Sessions::default()));
        live.lock().unwrap().1 = evicted.clone();
        assert_eq!(call(tool(2)).await["result"]["isError"], false);
        assert_eq!(evicted.lock().unwrap().len(), 1, "initialize was replayed");

        // 3. App restart / MCP toggle: new token (401) — the descriptor is re-read.
        *live.lock().unwrap() = (
            "token-b".into(),
            Arc::new(Mutex::new(sessions::Sessions::default())),
        );
        assert_eq!(call(tool(3)).await["result"]["isError"], false);
        assert_eq!(sessions_now().lock().unwrap().len(), 1);

        drop(input);
        forward.await.unwrap().unwrap();
        server.abort();
    }

    #[test]
    fn browser_args_always_keep_wry_defaults_and_add_debugging_only_when_on() {
        assert_eq!(browser_args(None), WRY_DEFAULT_BROWSER_ARGS);
        let on = browser_args(Some(9333));
        assert!(on.starts_with(WRY_DEFAULT_BROWSER_ARGS));
        assert!(on.contains("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
        assert!(on.ends_with(" --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1"));
    }

    #[test]
    fn wry_version_matches_the_pinned_defaults() {
        // WRY_DEFAULT_BROWSER_ARGS mirrors wry 0.55's built-in defaults; a wry bump must re-check them.
        let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../Cargo.lock"))
            .expect("workspace Cargo.lock");
        let version = lock
            .split("[[package]]")
            .find(|pkg| pkg.lines().any(|l| l == "name = \"wry\""))
            .and_then(|pkg| pkg.lines().find_map(|l| l.strip_prefix("version = ")))
            .expect("wry in Cargo.lock");
        assert!(
            version.starts_with("\"0.55."),
            "wry is {version}: re-check WRY_DEFAULT_BROWSER_ARGS"
        );
    }

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
            let result = forward_stdio(&mut reader, &mut output, fixed_bridge(url)).await;
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
        let result = forward_stdio(&mut input, &mut output, fixed_bridge(url)).await;
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
    async fn stdio_reports_endpoint_failures_per_request_and_keeps_running() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url =
            reqwest::Url::parse(&format!("http://{}/mcp", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(3), async {
                for _ in 0..3 {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let (_, bytes) = crate::control::read_request(&mut stream).await.unwrap();
                    let request: Value = serde_json::from_slice(&bytes).unwrap();
                    let status = if request["method"] == "ping" {
                        "200 OK"
                    } else {
                        "500 Internal Server Error"
                    };
                    crate::control::write_resp(
                        &mut stream,
                        status,
                        &rpc_result(&request["id"], json!({})),
                    )
                    .await;
                }
            })
            .await
            .unwrap();
        });
        let mut input = &b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"studio_read\"}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n"[..];
        let mut output = Vec::new();
        let result = forward_stdio(&mut input, &mut output, fixed_bridge(url)).await;
        if result.is_err() {
            server.abort();
        }
        let joined = server.await;
        assert!(result.is_ok(), "{result:?}");
        joined.unwrap();
        let mut replies: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        replies.sort_by_key(|reply| reply["id"].as_i64());
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["id"], 1);
        assert_eq!(replies[0]["error"]["code"], -32603);
        assert!(
            replies[0]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("500")
        );
        assert_eq!(replies[1], rpc_result(&json!(2), json!({})));
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
    async fn oversized_stdio_lines_are_skipped_and_the_next_line_is_intact() {
        for oversized in [
            STDIO_REQUEST_LIMIT,
            STDIO_REQUEST_LIMIT + 1,
            STDIO_REQUEST_LIMIT * 8,
        ] {
            let mut bytes = vec![b'x'; oversized];
            bytes.extend_from_slice(b"\nnext\n");
            let mut input = bytes.as_slice();
            assert_eq!(
                read_stdio_line(&mut input).await.unwrap(),
                Some(StdioLine::TooLarge)
            );
            assert_eq!(
                read_stdio_line(&mut input).await.unwrap(),
                Some(StdioLine::Line(b"next\n".to_vec()))
            );
        }
        let bytes = vec![b'x'; STDIO_REQUEST_LIMIT * 8];
        let mut input = bytes.as_slice();
        assert_eq!(
            read_stdio_line(&mut input).await.unwrap(),
            Some(StdioLine::TooLarge)
        );
        assert!(read_stdio_line(&mut input).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn stdio_answers_an_oversized_request_and_keeps_reading() {
        let mut bytes = vec![b'x'; STDIO_REQUEST_LIMIT * 2];
        bytes.extend_from_slice(b"\n\xff{}\n");
        let mut output = Vec::new();
        let url = reqwest::Url::parse("http://127.0.0.1:9/mcp").unwrap();
        let result = forward_stdio(&mut bytes.as_slice(), &mut output, fixed_bridge(url)).await;
        assert!(result.is_ok(), "{result:?}");
        let replies: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            replies,
            [
                rpc_error(&Value::Null, -32600, "MCP request is too large"),
                rpc_error(&Value::Null, -32700, "Invalid JSON")
            ]
        );
    }

    #[tokio::test]
    async fn stdio_requests_keep_lines_and_final_unterminated_input_separate() {
        let mut input = b"first\nlast".as_slice();
        assert_eq!(
            read_stdio_line(&mut input).await.unwrap(),
            Some(StdioLine::Line(b"first\n".to_vec()))
        );
        assert_eq!(
            read_stdio_line(&mut input).await.unwrap(),
            Some(StdioLine::Line(b"last".to_vec()))
        );
        assert!(read_stdio_line(&mut input).await.unwrap().is_none());
        let bytes = vec![b'x'; STDIO_REQUEST_LIMIT];
        assert!(matches!(
            read_stdio_line(&mut bytes.as_slice()).await.unwrap(),
            Some(StdioLine::Line(_))
        ));
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
