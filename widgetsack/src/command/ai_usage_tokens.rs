//! Incremental local Claude activity. Start at EOF, then read only newly appended JSONL records.
//! Keep usage counters only: never persist conversation text. The scope is this app process lifetime.
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
struct Tracker {
    initialized: bool,
    since: u64,
    offsets: HashMap<PathBuf, u64>,
    requests: HashMap<String, [u64; 4]>,
    total: u64,
}
impl Tracker {
    fn fold(&mut self, value: &Value) {
        if value["type"] != "assistant" {
            return;
        }
        let Some(id) = value["message"]["id"].as_str() else {
            return;
        };
        let usage = &value["message"]["usage"];
        if !usage.is_object() {
            return;
        }
        if self.requests.len() >= 100000 && !self.requests.contains_key(id) {
            return;
        }
        let current = [
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        ]
        .map(|key| usage[key].as_u64().unwrap_or(0));
        let previous = self.requests.entry(id.into()).or_insert([0; 4]);
        for i in 0..4 {
            let next = previous[i].max(current[i]);
            self.total = self.total.saturating_add(next - previous[i]);
            previous[i] = next;
        }
    }
    fn read(&mut self, root: &Path) -> Result<(u64, u64), String> {
        let mut dirs = vec![root.to_path_buf()];
        let mut files = Vec::new();
        while let Some(dir) = dirs.pop() {
            let entries = match fs::read_dir(dir) {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("Local Claude activity directory unavailable".into()),
            };
            for entry in entries.flatten() {
                let kind = entry
                    .file_type()
                    .map_err(|_| "Cannot read Claude activity metadata")?;
                // Never follow junctions/symlinks into unrelated directories.
                if kind.is_dir() {
                    dirs.push(entry.path());
                } else if kind.is_file() && entry.path().extension().is_some_and(|s| s == "jsonl") {
                    files.push(entry.path());
                }
                if files.len() + dirs.len() > 10000 {
                    return Err("Too many local Claude logs to track safely".into());
                }
            }
        }
        if !self.initialized {
            self.since = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            for file in files {
                if let Ok(meta) = fs::metadata(&file) {
                    self.offsets.insert(file, meta.len());
                }
            }
            self.initialized = true;
            return Ok((self.total, self.since));
        }
        let mut budget = 32 * 1024 * 1024;
        for path in files {
            if budget == 0 {
                break;
            }
            let Ok(mut file) = fs::File::open(&path) else {
                continue;
            };
            let length = file
                .metadata()
                .map_err(|_| "Cannot read Claude log size")?
                .len();
            let mut offset = *self.offsets.get(&path).unwrap_or(&0);
            if length < offset {
                offset = 0;
            }
            if length == offset {
                continue;
            }
            file.seek(SeekFrom::Start(offset))
                .map_err(|_| "Cannot seek Claude activity")?;
            let mut bytes = Vec::new();
            file.take(budget.min(8 * 1024 * 1024))
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read Claude activity")?;
            budget -= bytes.len() as u64;
            if let Some(end) = bytes.iter().rposition(|b| *b == b'\n') {
                for line in bytes[..=end].split(|b| *b == b'\n') {
                    if let Ok(value) = serde_json::from_slice::<Value>(line) {
                        self.fold(&value);
                    }
                }
                self.offsets.insert(path, offset + end as u64 + 1);
            }
        }
        Ok((self.total, self.since))
    }
}
pub(super) async fn observed_tokens(root: PathBuf) -> Result<(u64, u64), String> {
    static TRACKER: OnceLock<Mutex<Tracker>> = OnceLock::new();
    tokio::task::spawn_blocking(move || {
        TRACKER
            .get_or_init(|| Mutex::new(Tracker::default()))
            .lock()
            .map_err(|_| "Claude token tracker unavailable".to_string())?
            .read(&root)
    })
    .await
    .map_err(|_| "Claude token tracker stopped".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn streaming_updates_and_repeated_assistant_blocks_are_not_double_counted() {
        let mut tracker = Tracker::default();
        let first = json!({"type":"assistant","message":{"id":"message-1","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":20}}});
        tracker.fold(&first);
        tracker.fold(&first);
        tracker.fold(&json!({"type":"assistant","message":{"id":"message-1","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":20}}}));
        tracker
            .fold(&json!({"type":"user","message":{"id":"copied","usage":{"input_tokens":500}}}));
        tracker.fold(&json!({"type":"assistant"}));
        assert_eq!(tracker.total, 35);
    }
    #[test]
    fn starts_at_eof_and_only_counts_complete_new_records() {
        use std::io::Write;
        let dir =
            std::env::temp_dir().join(format!("widgetsack-token-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        fs::write(&path,b"{\"type\":\"assistant\",\"message\":{\"id\":\"old\",\"usage\":{\"input_tokens\":999}}}\n").unwrap();
        let mut tracker = Tracker::default();
        assert_eq!(tracker.read(&dir).unwrap().0, 0);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"assistant\",\"message\":{\"id\":\"new\",\"usage\":{\"input_tokens\":42}}}").unwrap();
        assert_eq!(tracker.read(&dir).unwrap().0, 0);
        file.write_all(b"\n").unwrap();
        assert_eq!(tracker.read(&dir).unwrap().0, 42);
        assert_eq!(tracker.read(&dir).unwrap().0, 42);
        drop(file);
        fs::remove_dir_all(&dir).unwrap();
    }
}
