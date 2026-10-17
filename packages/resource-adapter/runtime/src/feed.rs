//! One durable event scan per workspace; connected subscribers share each batch.
use crate::backend::Backend;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::broadcast;

pub async fn pump(
    backend: Arc<Backend>,
    events: broadcast::Sender<Arc<Value>>,
    worker: u32,
    mut cursor: u64,
) {
    loop {
        loop {
            let reply = backend
                .exchange(&json!({"action":"await_changes", "workerUid":worker,"after":cursor}))
                .await;
            let Ok(reply) = reply else {
                // Close subscriber continuity explicitly; reconnection uses the durable cursor.
                let _ = events.send(Arc::new(json!({"error":{"code":"resync_required"}})));
                break;
            };
            let Some(rows) = reply["result"]["events"].as_array() else {
                let _ = events.send(Arc::new(json!({"error":{"code":"resync_required"}})));
                break;
            };
            if rows.is_empty() {
                let _ = events.send(Arc::new(json!({"error":{"code":"resync_required"}})));
                break;
            }
            let Some(next) = reply["result"]["cursor"].as_u64().filter(|c| *c > cursor) else {
                let _ = events.send(Arc::new(json!({"error":{"code":"resync_required"}})));
                break;
            };
            cursor = next;
            let _ = events.send(Arc::new(reply["result"].clone()));
        }
        tokio::time::sleep(std::time::Duration::from_millis(
            if events.receiver_count() == 0 {
                10
            } else {
                1000
            },
        ))
        .await;
    }
}
