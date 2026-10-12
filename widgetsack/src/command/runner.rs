//! Explicit, bounded PowerShell execution for the CLI widget. No automatic or scheduled runs.
use serde::Serialize;
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};
const OUTPUT_LIMIT: usize = 64 * 1024;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    truncated: bool,
}
async fn read_bounded(mut reader: impl AsyncRead + Unpin) -> std::io::Result<(String, bool)> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let keep = count.min(OUTPUT_LIMIT - bytes.len());
        bytes.extend_from_slice(&chunk[..keep]);
        truncated |= keep < count;
        // Drain after the limit so a full pipe cannot deadlock the child.
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}
fn validate_command(command: &str) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Set a PowerShell command first".into());
    }
    if command.len() > 8192 {
        return Err("Command exceeds 8192 bytes".into());
    }
    Ok(())
}
async fn execute(command: &str, deadline: Duration) -> Result<CommandResult, String> {
    validate_command(command)?;
    let mut process = tokio::process::Command::new("powershell.exe");
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); \
         $OutputEncoding = [Console]::OutputEncoding; {command}"
    );
    process
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    process.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = process
        .spawn()
        .map_err(|e| format!("Could not start PowerShell: {e}"))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let work = async {
        let (status, (stdout, out_cut), (stderr, err_cut)) =
            tokio::try_join!(child.wait(), read_bounded(stdout), read_bounded(stderr))?;
        Ok::<_, std::io::Error>(CommandResult {
            stdout,
            stderr,
            exit_code: status.code(),
            truncated: out_cut || err_cut,
        })
    };
    tokio::time::timeout(deadline, work)
        .await
        .map_err(|_| "Command timed out after 30 seconds".to_string())?
        .map_err(|e| format!("Could not read command output: {e}"))
}
#[tauri::command]
pub async fn run_widget_command(command: String) -> Result<CommandResult, String> {
    execute(&command, Duration::from_secs(30)).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_empty_and_oversized_commands() {
        assert!(validate_command("  ").is_err());
        assert!(validate_command(&"x".repeat(8193)).is_err());
        assert!(validate_command("Get-Date").is_ok());
    }
    #[tokio::test]
    async fn caps_output_but_drains_the_pipe() {
        let bytes = vec![b'x'; OUTPUT_LIMIT + 5000];
        let (text, cut) = read_bounded(bytes.as_slice()).await.unwrap();
        assert_eq!(text.len(), OUTPUT_LIMIT);
        assert!(cut);
        assert_eq!(
            read_bounded("hello".as_bytes()).await.unwrap(),
            ("hello".into(), false)
        );
    }
    #[tokio::test]
    async fn handles_empty_and_non_utf8_output() {
        assert_eq!(
            read_bounded(&b""[..]).await.unwrap(),
            (String::new(), false)
        );
        assert_eq!(
            read_bounded(&b"\xff"[..]).await.unwrap(),
            ("�".into(), false)
        );
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn captures_real_process_output_and_exit_status() {
        let result = execute(
            "[Console]::Write('hello'); [Console]::Error.Write('failure'); exit 7",
            Duration::from_secs(15),
        )
        .await
        .unwrap();
        assert_eq!(result.stdout, "hello");
        assert_eq!(result.stderr, "failure");
        assert_eq!(result.exit_code, Some(7));
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["exitCode"], 7);
        assert_eq!(json["truncated"], false);
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn times_out_a_process_that_does_not_finish() {
        assert!(
            execute("Start-Sleep -Seconds 60", Duration::from_millis(50))
                .await
                .unwrap_err()
                .contains("timed out")
        );
    }
}
