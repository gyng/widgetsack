use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[derive(Default)]
pub(super) struct Sessions {
    clients: HashMap<String, Session>,
}
struct Session {
    used: Instant,
    requests: HashMap<String, Option<oneshot::Sender<()>>>,
    cancelled: HashMap<String, Instant>,
}

pub(super) struct RequestGuard {
    sessions: Arc<Mutex<Sessions>>,
    session: String,
    request: String,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Some(client) = self
            .sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clients
            .get_mut(&self.session)
        {
            client.requests.remove(&self.request);
        }
    }
}
impl Sessions {
    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.clients.len()
    }
    pub(super) fn create(&mut self) -> Result<String, String> {
        self.clients.retain(|_, client| {
            !client.requests.is_empty() || client.used.elapsed() < Duration::from_secs(3600)
        });
        if self.clients.len() >= 128 {
            let oldest = self
                .clients
                .iter()
                .filter(|(_, client)| client.requests.is_empty())
                .min_by_key(|(_, client)| client.used)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                self.clients.remove(&id);
            } else {
                return Err("Too many active MCP sessions".into());
            }
        }
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
        let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        self.clients.insert(
            id.clone(),
            Session {
                used: Instant::now(),
                requests: HashMap::new(),
                cancelled: HashMap::new(),
            },
        );
        Ok(id)
    }
    pub(super) fn contains(&mut self, id: &str) -> bool {
        if let Some(client) = self.clients.get_mut(id) {
            client.used = Instant::now();
            true
        } else {
            false
        }
    }
    pub(super) fn cancel(&mut self, session: &str, request: &Value) {
        if !valid_id(request) {
            return;
        }
        if let Some(client) = self.clients.get_mut(session) {
            let key = request.to_string();
            client
                .cancelled
                .retain(|_, when| when.elapsed() < Duration::from_secs(40));
            if client.cancelled.len() >= 128
                && let Some(oldest) = client
                    .cancelled
                    .iter()
                    .min_by_key(|(_, when)| **when)
                    .map(|(id, _)| id.clone())
            {
                client.cancelled.remove(&oldest);
            }
            client.cancelled.insert(key.clone(), Instant::now());
            if let Some(sender) = client.requests.get_mut(&key).and_then(Option::take) {
                let _ = sender.send(());
            }
        }
    }
    pub(super) fn register(
        sessions: &Arc<Mutex<Self>>,
        session: &str,
        request: &Value,
    ) -> Result<(RequestGuard, oneshot::Receiver<()>), String> {
        if !valid_id(request) {
            return Err("Invalid MCP request ID".into());
        }
        let key = request.to_string();
        let mut state = sessions.lock().map_err(|_| "MCP sessions unavailable")?;
        let client = state
            .clients
            .get_mut(session)
            .ok_or("MCP session expired")?;
        if client.requests.contains_key(&key) {
            return Err("MCP request ID is already active".into());
        }
        let (send, receive) = oneshot::channel();
        if client
            .cancelled
            .remove(&key)
            .is_some_and(|when| when.elapsed() < Duration::from_secs(40))
        {
            let _ = send.send(());
            client.requests.insert(key.clone(), None);
        } else {
            client.requests.insert(key.clone(), Some(send));
        }
        Ok((
            RequestGuard {
                sessions: sessions.clone(),
                session: session.into(),
                request: key,
            },
            receive,
        ))
    }
}

pub(super) fn valid_id(id: &Value) -> bool {
    id.as_str().is_some_and(|id| id.len() <= 256) || id.is_i64() || id.is_u64()
}

pub(super) async fn run<T>(
    registration: Option<(RequestGuard, oneshot::Receiver<()>)>,
    operation: impl std::future::Future<Output = T>,
) -> Option<T> {
    if let Some((_owner, mut cancelled)) = registration {
        tokio::select! { biased;
            _ = &mut cancelled => None,
            result = operation => Some(result),
        }
    } else {
        Some(operation.await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_ids_are_bounded_and_keep_string_and_integer_ids_distinct() {
        for id in [
            json!(null),
            json!(true),
            json!(1.5),
            json!([]),
            json!("x".repeat(257)),
        ] {
            assert!(!valid_id(&id), "{id}");
        }
        assert!(valid_id(&json!("x".repeat(256))));
        assert!(valid_id(&json!(1)));
        assert!(valid_id(&json!("1")));
    }

    #[tokio::test]
    async fn cancellation_arriving_before_registration_prevents_processing() {
        let sessions = Arc::new(Mutex::new(Sessions::default()));
        let id = sessions.lock().unwrap().create().unwrap();
        sessions.lock().unwrap().cancel(&id, &json!(3));
        let registration = Sessions::register(&sessions, &id, &json!(3)).unwrap();
        let processed = std::sync::atomic::AtomicBool::new(false);
        let result = run(Some(registration), async {
            processed.store(true, std::sync::atomic::Ordering::SeqCst);
        })
        .await;
        assert!(result.is_none());
        assert!(!processed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(sessions.lock().unwrap().clients[&id].requests.is_empty());
    }
    #[tokio::test]
    async fn cancellation_is_scoped_and_keeps_ids_reserved_until_the_owner_finishes() {
        let sessions = Arc::new(Mutex::new(Sessions::default()));
        let a = sessions.lock().unwrap().create().unwrap();
        let b = sessions.lock().unwrap().create().unwrap();
        let (owner_a, mut cancelled_a) = Sessions::register(&sessions, &a, &json!(1)).unwrap();
        let (owner_b, mut cancelled_b) = Sessions::register(&sessions, &b, &json!(1)).unwrap();
        let (owner_text, mut cancelled_text) =
            Sessions::register(&sessions, &a, &json!("1")).unwrap();
        sessions.lock().unwrap().cancel(&a, &json!(1));
        assert_eq!(cancelled_a.try_recv(), Ok(()));
        assert_eq!(
            cancelled_text.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        assert_eq!(
            cancelled_b.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        assert!(Sessions::register(&sessions, &a, &json!(1)).is_err());
        sessions.lock().unwrap().cancel(&a, &json!(1));
        drop(owner_a);
        let (replacement, _) = Sessions::register(&sessions, &a, &json!(1)).unwrap();
        drop(replacement);
        drop(owner_b);
        drop(owner_text);
        assert!(
            sessions
                .lock()
                .unwrap()
                .clients
                .values()
                .all(|client| client.requests.is_empty())
        );
    }

    #[test]
    fn bounded_sessions_preserve_active_owners_and_bound_cancellation_history() {
        let sessions = Arc::new(Mutex::new(Sessions::default()));
        let mut owners = Vec::new();
        let first = sessions.lock().unwrap().create().unwrap();
        owners.push(Sessions::register(&sessions, &first, &json!(0)).unwrap());
        for id in 1..128 {
            let session = sessions.lock().unwrap().create().unwrap();
            owners.push(Sessions::register(&sessions, &session, &json!(id)).unwrap());
        }
        assert!(sessions.lock().unwrap().create().is_err());
        drop(owners.pop());
        assert!(sessions.lock().unwrap().create().is_ok());
        let mut state = sessions.lock().unwrap();
        assert_eq!(state.clients.len(), 128);
        assert!(state.contains(&first));
        assert!(!state.contains("missing"));
        state.cancel("missing", &json!(0));
        for id in 1..201 {
            state.cancel(&first, &json!(id));
        }
        state.cancel(&first, &Value::Null);
        assert_eq!(state.clients[&first].cancelled.len(), 128);
        drop(state);
        drop(owners);
    }

    #[tokio::test]
    async fn expired_early_cancellation_does_not_cancel_a_future_request() {
        let sessions = Arc::new(Mutex::new(Sessions::default()));
        let id = sessions.lock().unwrap().create().unwrap();
        sessions
            .lock()
            .unwrap()
            .clients
            .get_mut(&id)
            .unwrap()
            .cancelled
            .insert("3".into(), Instant::now() - Duration::from_secs(41));
        let registration = Sessions::register(&sessions, &id, &json!(3)).unwrap();
        assert_eq!(run(Some(registration), async { 7 }).await, Some(7));
        assert_eq!(run(None, async { 9 }).await, Some(9));
    }
}
