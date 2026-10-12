//! Native, studio-only installed-agent adapter. A Channel delivers validated tool requests.
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tauri::{State, ipc::Channel};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
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
fn search_directories() -> Vec<PathBuf> {
    let mut directories: Vec<_> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|path| path.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        directories.extend([
            home.join(".local/bin"),
            home.join("AppData/Local/Programs/OpenAI/Codex/bin"),
            home.join("AppData/Roaming/npm"),
        ]);
    }
    directories
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
        || !["pi", "codex", "claude"].contains(&backend)
        || prompt.is_empty()
        || prompt.len() > 512_000
        || system.len() > 128_000
        || prompt.len() + system.len() > 512_000
        || model.len() > 256
    {
        return Err("Invalid studio agent request".into());
    }
    Ok(())
}

// Kill the entire child tree when a request ends, including npm CLI wrappers.
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

async fn execute_cli(
    agent: &crate::studio_agent_cli::AgentCommand,
    backend: &str,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let mut command = tokio::process::Command::new(&agent.program);
    command
        .args(&agent.prefix)
        .args(crate::studio_agent_cli::arguments(backend, model))
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {backend}: {e}"))?;
    #[cfg(windows)]
    let _job = ProcessJob::attach(child.id().ok_or("Agent has no process ID")?)?;
    let mut input = child.stdin.take().ok_or("Agent stdin unavailable")?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("Agent stdout unavailable")?
        .take(2_000_001);
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Agent stderr unavailable")?
        .take(8193);
    let write = async move {
        input.write_all(prompt.as_bytes()).await?;
        drop(input);
        Ok::<_, std::io::Error>(())
    };
    let read = async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        if bytes.len() > 2_000_000 {
            return Err(std::io::Error::other("Agent output exceeded the limit"));
        }
        Ok::<_, std::io::Error>(bytes)
    };
    let errors = async {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await?;
        if bytes.len() > 8192 {
            return Err(std::io::Error::other("Agent output exceeded the limit"));
        }
        Ok::<_, std::io::Error>(bytes)
    };
    let ((), output, error) = tokio::try_join!(write, read, errors).map_err(|e| e.to_string())?;
    let exit = child.wait().await.map_err(|e| e.to_string())?;
    if !exit.success() {
        let error = String::from_utf8_lossy(&error);
        return Err(if error.trim().is_empty() {
            format!("{backend} exited with {exit}")
        } else {
            error.into_owned()
        });
    }
    String::from_utf8(output).map_err(|_| "Invalid agent output encoding".into())
}

async fn run_agent(
    backend: &str,
    model: &str,
    prompt: &str,
    system: &str,
    channel: &Channel<Value>,
    mut replies: mpsc::UnboundedReceiver<Value>,
) -> Result<(), String> {
    let agent = crate::studio_agent_cli::discover(backend, &search_directories()).ok_or_else(|| format!("{backend} is not installed. Install and sign in with Pi, Codex, or Claude, then refresh agents."))?;
    let mut prompt = format!(
        "{system}\n{}\n\n{prompt}",
        crate::studio_agent_cli::ADAPTER_INSTRUCTIONS
    );
    for turn in 0..8 {
        let output = tokio::select! {
            output = execute_cli(&agent, backend, model, &prompt) => output?,
            _ = async {
                while let Some(reply) = replies.recv().await {
                    if reply["type"] == "cancel" { break; }
                }
            } => return Err("Stopped".into()),
        };
        let reply = crate::studio_agent_cli::reply(backend, &output)?;
        if let Some(message) = reply["message"].as_str() {
            channel
                .send(json!({ "type": "text", "text": message }))
                .map_err(|_| "Studio disconnected")?;
            return Ok(());
        }
        let id = turn.to_string();
        channel
            .send(json!({ "type": "tool", "id": id, "name": reply["tool"], "args": reply["args"] }))
            .map_err(|_| "Studio disconnected")?;
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let response = replies.recv().await.ok_or("Studio disconnected")?;
                if response["type"] == "cancel" {
                    return Err("Stopped");
                }
                if response["type"] == "reply" && response["id"] == id {
                    return Ok(response["result"].clone());
                }
            }
        })
        .await
        .map_err(|_| "Studio did not answer the tool request")??;
        prompt.push_str(&format!("\nAssistant: {reply}\nTool result: {result}"));
        if prompt.len() > 512_000 {
            return Err("Studio context exceeded the limit".into());
        }
    }
    Err("Agent reached the eight-step limit. Continue with a new message.".into())
}

#[tauri::command]
pub async fn studio_agent_status(window: tauri::WebviewWindow) -> Result<Value, String> {
    studio(&window)?;
    let directories = search_directories();
    Ok(crate::studio_agent_cli::status(
        ["pi", "codex", "claude"]
            .map(|name| crate::studio_agent_cli::discover(name, &directories).is_some()),
    ))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn studio_agent_run(
    window: tauri::WebviewWindow,
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
    let result = tokio::time::timeout(
        Duration::from_secs(180),
        run_agent(
            &backend,
            &model,
            &prompt,
            &system_prompt,
            &channel,
            receiver,
        ),
    )
    .await
    .map_err(|_| "Studio agent timed out".to_string())
    .and_then(|result| result);
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
    use tokio::io::{AsyncBufReadExt, BufReader};
    #[tokio::test]
    #[ignore = "Read-only smoke check of installed agents; requires local Pi/Codex/Claude installations"]
    async fn installed_agent_versions() {
        let directories = search_directories();
        let mut found = 0;
        for backend in ["pi", "codex", "claude"] {
            if let Some(agent) = crate::studio_agent_cli::discover(backend, &directories) {
                let mut command = tokio::process::Command::new(&agent.program);
                command
                    .args(&agent.prefix)
                    .arg("--version")
                    .stdin(Stdio::null());
                #[cfg(windows)]
                command.creation_flags(0x08000000);
                let output = tokio::time::timeout(Duration::from_secs(15), command.output())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{backend}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                println!(
                    "{backend}: {} ({})",
                    String::from_utf8_lossy(&output.stdout).trim(),
                    agent.program.display()
                );
                found += 1;
            }
        }
        assert!(found > 0, "No installed agents found");
    }
    fn fixture(code: &str) -> crate::studio_agent_cli::AgentCommand {
        let node = crate::studio_agent_cli::discover("node", &search_directories())
            .expect("Developer Node is required for CLI process fixtures");
        crate::studio_agent_cli::AgentCommand {
            program: node.program,
            prefix: vec!["-e".into(), code.into(), "--".into()],
        }
    }
    #[tokio::test]
    async fn native_adapter_pipes_large_prompts_and_literal_models_without_a_shell() {
        let agent = fixture(
            "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>console.log(JSON.stringify({input,model:process.argv.at(-1)})));",
        );
        let prompt = format!("{}\n& literal \"quotes\"", "context".repeat(8000));
        let model = "model & literal";
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            execute_cli(&agent, "pi", model, &prompt),
        )
        .await
        .unwrap()
        .unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["input"], prompt);
        assert_eq!(value["model"], model);
    }
    #[tokio::test]
    async fn oversized_output_fails_promptly_and_agent_failures_remain_visible() {
        for (code, expected) in [
            (
                "process.stdin.resume();process.stdout.write('x'.repeat(2100000));setInterval(()=>{},1000);",
                "Agent output exceeded the limit",
            ),
            (
                "process.stdin.resume();console.error('Login required');process.exitCode=1;",
                "Login required",
            ),
        ] {
            let error = tokio::time::timeout(
                Duration::from_secs(10),
                execute_cli(&fixture(code), "pi", "", "request"),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
    }
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
        let node = crate::studio_agent_cli::discover("node", &search_directories())
            .expect("Node is required for this process-tree test")
            .program;
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
        assert!(request_valid("id", "pi-bundled", "hi", "", "").is_err());
        assert!(request_valid("id", "pi", "", "", "").is_err());
        assert!(request_valid("id", "pi", &"x".repeat(512_001), "", "").is_err());
    }
}
