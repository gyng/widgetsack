//! App-owned, studio-only agent sidecars. JSONL stays off the filesystem; a Channel delivers events.
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, State, ipc::Channel};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};

#[derive(Default)]
pub struct StudioAgentState {
    inner: Mutex<Jobs>,
}
#[derive(Default)]
struct Jobs {
    active: HashMap<String, mpsc::UnboundedSender<Value>>,
    cancelled: HashSet<String>,
}
fn studio(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "studio" {
        Ok(())
    } else {
        Err("Studio agent commands are studio-only".into())
    }
}
fn runtime_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("studio-agent");
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent/runtime");
    for root in [packaged, development] {
        let node = root.join(if cfg!(windows) { "node.exe" } else { "node" });
        let entry = root.join("entry.mjs");
        if node.is_file() && entry.is_file() {
            return Ok((node, entry));
        }
    }
    Err("Bundled Pi runtime is missing. Run npm run build:agent in client/.".into())
}
fn request_valid(
    request_id: &str,
    backend: &str,
    prompt: &str,
    system: &str,
    model: &str,
) -> Result<(), String> {
    if request_id.is_empty()
        || request_id.len() > 80
        || !["pi", "pi-bundled", "codex", "claude"].contains(&backend)
        || prompt.is_empty()
        || prompt.len() > 512_000
        || system.len() > 128_000
        || model.len() > 256
    {
        return Err("Invalid studio agent request".into());
    }
    Ok(())
}

// Kill the entire child tree when a request ends, including CLI children created by the SDK adapter.
#[cfg(windows)]
struct ProcessJob(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
// Windows job handles are transferable kernel handles; each job has one owner.
unsafe impl Send for ProcessJob {}
#[cfg(windows)]
impl ProcessJob {
    fn attach(pid: u32) -> Result<Self, String> {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            let handle = CreateJobObjectW(None, None).map_err(|e| e.to_string())?;
            let job = Self(handle);
            let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                    LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    ..Default::default()
                },
                ..Default::default()
            };
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )
            .map_err(|e| e.to_string())?;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|e| e.to_string())?;
            let result = AssignProcessToJobObject(handle, process).map_err(|e| e.to_string());
            let _ = CloseHandle(process);
            result?;
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

async fn run_process(
    app: &tauri::AppHandle,
    initial: Value,
    channel: Option<&Channel<Value>>,
    mut replies: mpsc::UnboundedReceiver<Value>,
) -> Result<Value, String> {
    let (node, entry) = runtime_paths(app)?;
    let mut command = tokio::process::Command::new(node);
    command
        .arg(&entry)
        .current_dir(entry.parent().expect("entry parent"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start studio agent: {e}"))?;
    #[cfg(windows)]
    let _job = ProcessJob::attach(child.id().ok_or("Agent has no process ID")?)?;
    let mut input = child.stdin.take().ok_or("Agent stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Agent stdout unavailable")?;
    let mut lines = BufReader::new(stdout.take(4 * 1024 * 1024)).lines();
    input
        .write_all(format!("{initial}\n").as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let work = async {
        let mut status = Value::Null;
        let mut error = None;
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Some(line) = line.map_err(|e| e.to_string())? else { return Err("Studio agent exited before completing the request".into()); };
                    let event: Value = serde_json::from_str(&line).map_err(|_| "Invalid studio agent output".to_string())?;
                    match event.get("type").and_then(Value::as_str) {
                        Some("status") => status = event["result"].clone(),
                        Some("error") => error = Some(event["text"].as_str().unwrap_or("Agent failed").to_string()),
                        Some("done") => break,
                        Some("text" | "tool") => {},
                        _ => return Err("Unknown studio agent event".into()),
                    }
                    if let Some(channel) = channel { channel.send(event).map_err(|_| "Studio disconnected".to_string())?; }
                }
                reply = replies.recv(), if channel.is_some() => {
                    let Some(reply) = reply else { return Err("Studio disconnected".into()); };
                    if reply["type"] == "cancel" { return Err("Stopped".into()); }
                    input.write_all(format!("{reply}\n").as_bytes()).await.map_err(|e| e.to_string())?;
                }
            }
        }
        if let Some(error) = error {
            return Err(error);
        }
        Ok(status)
    };
    let result = tokio::time::timeout(
        Duration::from_secs(if channel.is_some() { 180 } else { 30 }),
        work,
    )
    .await
    .map_err(|_| "Studio agent timed out".to_string())
    .and_then(|r| r);
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

#[tauri::command]
pub async fn studio_agent_status(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    studio(&window)?;
    let (_sender, receiver) = mpsc::unbounded_channel();
    run_process(
        &app,
        json!({ "type": "status", "llmConfig": crate::llm::load_llm_config(&app)? }),
        None,
        receiver,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn studio_agent_run(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, StudioAgentState>,
    request_id: String,
    backend: String,
    prompt: String,
    system_prompt: String,
    model: String,
    channel: Channel<Value>,
) -> Result<(), String> {
    studio(&window)?;
    request_valid(&request_id, &backend, &prompt, &system_prompt, &model)?;
    let (sender, receiver) = mpsc::unbounded_channel();
    {
        let mut jobs = state.inner.lock().map_err(|_| "Agent state unavailable")?;
        if jobs.cancelled.remove(&request_id) {
            return Err("Stopped".into());
        }
        if !jobs.active.is_empty() {
            return Err("A studio agent request is already running".into());
        }
        jobs.active.insert(request_id.clone(), sender);
    }
    let result = async {
        let config = crate::llm::load_llm_config(&app)?;
        run_process(&app, json!({ "backend": backend, "prompt": prompt, "systemPrompt": system_prompt, "model": model, "llmConfig": config }), Some(&channel), receiver).await.map(|_| ())
    }.await;
    if let Ok(mut jobs) = state.inner.lock() {
        jobs.active.remove(&request_id);
    }
    result
}

#[tauri::command]
pub fn studio_agent_reply(
    window: tauri::WebviewWindow,
    state: State<'_, StudioAgentState>,
    request_id: String,
    tool_id: String,
    result: Value,
) -> Result<(), String> {
    studio(&window)?;
    if tool_id.len() > 80 || result.to_string().len() > 2_000_000 {
        return Err("Invalid studio tool reply".into());
    }
    let jobs = state.inner.lock().map_err(|_| "Agent state unavailable")?;
    let sender = jobs
        .active
        .get(&request_id)
        .ok_or("Agent request is no longer active")?;
    sender
        .send(json!({ "type": "reply", "id": tool_id, "result": result }))
        .map_err(|_| "Agent disconnected".into())
}
#[tauri::command]
pub async fn studio_agent_cancel(
    window: tauri::WebviewWindow,
    state: State<'_, StudioAgentState>,
    request_id: String,
) -> Result<(), String> {
    studio(&window)?;
    if request_id.len() > 80 {
        return Err("Invalid request ID".into());
    }
    {
        let mut jobs = state.inner.lock().map_err(|_| "Agent state unavailable")?;
        if let Some(sender) = jobs.active.get(&request_id) {
            let _ = sender.send(json!({ "type": "cancel" }));
        } else {
            if jobs.cancelled.len() >= 128 {
                jobs.cancelled.clear();
            }
            jobs.cancelled.insert(request_id);
            return Ok(());
        }
    }
    for _ in 0..200 {
        if !state
            .inner
            .lock()
            .map_err(|_| "Agent state unavailable")?
            .active
            .contains_key(&request_id)
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Err("The previous agent is still stopping".into())
}

pub fn forget_studio(state: &StudioAgentState) {
    if let Ok(jobs) = state.inner.lock() {
        for sender in jobs.active.values() {
            let _ = sender.send(json!({ "type": "cancel" }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_studio_cancels_every_owned_request() {
        let state = StudioAgentState::default();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        state
            .inner
            .lock()
            .unwrap()
            .active
            .insert("request".into(), sender);
        forget_studio(&state);
        assert_eq!(receiver.try_recv().unwrap()["type"], "cancel");
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn job_cleanup_terminates_the_sidecar_and_its_children() {
        use windows::Win32::{
            Foundation::{CloseHandle, WAIT_OBJECT_0},
            System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
        };
        let node = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent/runtime/node.exe");
        let mut command = tokio::process::Command::new(node);
        command.args(["-e", "process.stdin.once('data',()=>{const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);});"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).creation_flags(0x08000000);
        let mut child = command.spawn().unwrap();
        let job = ProcessJob::attach(child.id().unwrap()).unwrap();
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"start\n")
            .await
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let pid: u32 = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .parse()
            .unwrap();
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid).unwrap() };
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        let stopped = unsafe { WaitForSingleObject(process, 5000) };
        unsafe {
            let _ = CloseHandle(process);
        }
        assert_eq!(stopped, WAIT_OBJECT_0);
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
    }
    #[test]
    fn validates_backends_and_bounded_requests() {
        for backend in ["pi", "codex", "claude"] {
            assert!(request_valid("id", backend, "hello", "system", "").is_ok());
        }
        assert!(request_valid("", "pi", "hi", "", "").is_err());
        assert!(request_valid("id", "shell", "hi", "", "").is_err());
        assert!(request_valid("id", "pi", "", "", "").is_err());
        assert!(request_valid("id", "pi", &"x".repeat(512_001), "", "").is_err());
    }
}
