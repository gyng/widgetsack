//! App-owned integration worker: ensure and restart share one transition lock.
use std::future::Future;
use tauri::async_runtime::JoinHandle;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct IntegrationTask {
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl IntegrationTask {
    pub async fn start<F: Future<Output = ()> + Send + 'static>(
        &self,
        restart: bool,
        make: impl FnOnce() -> Result<Option<F>, String>,
    ) -> Result<(), String> {
        let mut handle = self.handle.lock().await;
        if !restart && handle.is_some() {
            return Ok(());
        }
        // Validate/load the replacement before interrupting the current worker.
        let future = make()?;
        if let Some(old) = handle.take() {
            old.abort();
            let _ = old.await;
        }
        *handle = future.map(tauri::async_runtime::spawn);
        Ok(())
    }

    pub async fn stop(&self) -> bool {
        let mut handle = self.handle.lock().await;
        if let Some(old) = handle.take() {
            old.abort();
            let _ = old.await;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[tokio::test]
    async fn ensure_shares_the_worker_and_failed_replacement_preserves_it() {
        let task = IntegrationTask::default();
        let starts = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let starts = starts.clone();
            task.start(false, move || {
                starts.fetch_add(1, Ordering::SeqCst);
                Ok(Some(std::future::pending()))
            })
            .await
            .unwrap();
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert!(
            task.start(true, || Err::<Option<std::future::Pending<()>>, _>(
                "bad config".into()
            ))
            .await
            .is_err()
        );
        assert!(task.stop().await);
        assert!(!task.stop().await);
    }
    #[tokio::test]
    async fn restart_disposes_the_old_worker_before_running_the_replacement() {
        struct Running(Arc<AtomicUsize>);
        impl Drop for Running {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let task = IntegrationTask::default();
        let live = Arc::new(AtomicUsize::new(0));
        for restart in [false, true] {
            let live = live.clone();
            let (ready, started) = tokio::sync::oneshot::channel();
            task.start(restart, move || {
                Ok(Some(async move {
                    assert_eq!(live.fetch_add(1, Ordering::SeqCst), 0);
                    let _running = Running(live);
                    let _ = ready.send(());
                    std::future::pending::<()>().await;
                }))
            })
            .await
            .unwrap();
            started.await.unwrap();
        }
        task.stop().await;
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }
}
