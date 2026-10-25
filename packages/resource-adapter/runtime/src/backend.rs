use crate::wire;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    net::UnixStream,
    sync::Semaphore,
    time::timeout,
};

pub struct Backend {
    pub path: String,
    pub control: Arc<Semaphore>,
    pub urgent: Arc<Semaphore>,
    waiting: Arc<Semaphore>,
    pub mutations: Arc<Semaphore>,
    pub execution: Arc<Semaphore>,
    claim_waiters: Arc<Semaphore>,
    claim_connecting: Semaphore,
    pub input: Arc<Semaphore>,
    output: Arc<Semaphore>,
}
impl Backend {
    pub fn new(path: String, execution_slots: usize) -> Self {
        Self {
            path,
            control: Arc::new(Semaphore::new(8)),
            urgent: Arc::new(Semaphore::new(4)),
            waiting: Arc::new(Semaphore::new(1024)),
            mutations: Arc::new(Semaphore::new(8)),
            execution: Arc::new(Semaphore::new(execution_slots)),
            claim_waiters: Arc::new(Semaphore::new(1024)),
            claim_connecting: Semaphore::new(16),
            input: Arc::new(Semaphore::new(64 * 1024 * 1024)),
            output: Arc::new(Semaphore::new(64 * 1024 * 1024)),
        }
    }
    pub async fn request(&self, request: Value) -> Reply {
        let value = self.perform(request).await;
        self.reply(value)
    }
    fn reply(&self, value: Value) -> Reply {
        let size = serde_json::to_vec(&value).map_or(wire::FRAME_LIMIT, |v| v.len());
        match self.output.clone().try_acquire_many_owned(size as u32) {
            Ok(memory) => Reply {
                value,
                _memory: Some(memory),
            },
            Err(_) => Reply {
                value: json!({"error":{"code":"outcome_unknown"}}),
                _memory: None,
            },
        }
    }
    pub async fn wait_claim(&self, mut request: Value, owner: &str) -> Reply {
        let Some(wait) = request["waitMs"]
            .as_u64()
            .filter(|ms| (1..=30000).contains(ms))
        else {
            return self.reply(json!({"error":{"code":"request_invalid"}}));
        };
        let Ok(_permit) = self.claim_waiters.clone().try_acquire_owned() else {
            return self.reply(json!({"error":{"code":"adapter_busy"}}));
        };
        let gateway = std::path::Path::new(&self.path)
            .parent()
            .unwrap()
            .join("gateway/claims.sock");
        let result = timeout(Duration::from_millis(wait + 5000), async {
            let connecting = self
                .claim_connecting
                .acquire()
                .await
                .map_err(std::io::Error::other)?;
            let mut socket = UnixStream::connect(gateway).await?;
            let mut queued = request.clone();
            queued["action"] = json!("wait");
            queued["owner"] = json!(owner);
            wire::write(&mut socket, &queued).await?;
            let mut reader = BufReader::new(socket);
            let frame = wire::read(&mut reader, &self.input)
                .await?
                .ok_or_else(|| std::io::Error::other("claim gateway closed"))?;
            let reply: Value = serde_json::from_slice(&frame.bytes)?;
            drop(frame);
            drop(connecting);
            if reply["waiting"] != true {
                return Ok::<Value, std::io::Error>(reply);
            }
            let frame = wire::read(&mut reader, &self.input)
                .await?
                .ok_or_else(|| std::io::Error::other("claim gateway closed"))?;
            Ok::<Value, std::io::Error>(serde_json::from_slice(&frame.bytes)?)
        })
        .await;
        // Waiting uses no Python handler or mutation permit. Only install after an authoritative grant.
        match result {
            Ok(Ok(value)) if value.get("error").is_some() => self.reply(value),
            Ok(Ok(value)) if value["result"].is_object() => {
                request.as_object_mut().unwrap().remove("waitMs");
                request["action"] = json!("claim_install");
                request["grant"] = value["result"].clone();
                self.request(request).await
            }
            _ => self.reply(json!({"error":{"code":"outcome_unknown"}})),
        }
    }
    async fn perform(&self, request: Value) -> Value {
        let action = request["action"].as_str().unwrap_or("");
        let lane = match action {
            "run" => &self.execution,
            "write" | "delete" | "rename" | "claim" | "claim_install" => &self.mutations,
            "heartbeat" | "release" | "receipt" => &self.urgent,
            _ => &self.control,
        };
        // Free reserved capacity must remain usable even when another lane's queue is full.
        let permit = if let Ok(permit) = lane.clone().try_acquire_owned() {
            Some(permit)
        } else if action == "run" {
            None
        } else {
            let Ok(_waiting) = self.waiting.clone().try_acquire_owned() else {
                return json!({"error":{"code":"adapter_busy"}});
            };
            timeout(Duration::from_secs(2), lane.clone().acquire_owned())
                .await
                .ok()
                .and_then(Result::ok)
        };
        let Some(_permit) = permit else {
            return json!({"error":{"code":"adapter_busy"}});
        };
        let result = timeout(
            Duration::from_secs(if action == "run" { 310 } else { 35 }),
            self.exchange(&request),
        )
        .await;
        match result {
            Ok(Ok(value)) => value,
            _ => json!({"error":{"code":"outcome_unknown"}}),
        }
    }
    pub async fn exchange(&self, request: &Value) -> std::io::Result<Value> {
        let mut socket = UnixStream::connect(&self.path).await?;
        wire::write(&mut socket, request).await?;
        socket.shutdown().await?;
        let frame = wire::read(&mut BufReader::new(socket), &self.input)
            .await?
            .ok_or_else(|| std::io::Error::other("backend closed"))?;
        Ok(serde_json::from_slice(&frame.bytes)?)
    }
}

pub struct Reply {
    pub value: Value,
    _memory: Option<tokio::sync::OwnedSemaphorePermit>,
}

#[cfg(test)]
mod tests {
    #[test]
    fn configured_native_capacity_keeps_urgent_work_available() {
        let backend = super::Backend::new(String::new(), 10);
        let permits: Vec<_> = (0..10).map(|_| backend.execution.clone().try_acquire_owned().unwrap()).collect();
        assert!(backend.execution.clone().try_acquire_owned().is_err());
        let urgent = backend.urgent.clone().try_acquire_owned().unwrap();
        drop(permits);
        assert_eq!(backend.execution.available_permits(), 10);
        drop(urgent);
    }
    use super::*;

    #[tokio::test]
    async fn a_thousand_parked_claims_leave_authority_lanes_free() {
        let root = std::env::temp_dir().join(format!("claim-waits-{}", std::process::id()));
        std::fs::create_dir_all(root.join("gateway")).unwrap();
        let gateway = tokio::net::UnixListener::bind(root.join("gateway/claims.sock")).unwrap();
        let authority = tokio::net::UnixListener::bind(root.join("commands.sock")).unwrap();
        let backend = Arc::new(Backend::new(
            root.join("commands.sock").to_str().unwrap().into(),
            8,
        ));
        let mut waiters = tokio::task::JoinSet::new();
        for worker in 0..1024 {
            let backend = backend.clone();
            waiters.spawn(async move {
                backend.wait_claim(json!({"action":"claim","resource":"file:busy","waitMs":30000,"workerUid":worker}), &format!("owner-{worker}")).await
            });
        }
        let mut parked = Vec::new();
        for _ in 0..1024 {
            let (socket, _) = timeout(Duration::from_secs(10), gateway.accept())
                .await
                .unwrap()
                .unwrap();
            let mut reader = BufReader::new(socket);
            let frame = wire::read(&mut reader, &backend.input)
                .await
                .unwrap()
                .unwrap();
            let request: Value = serde_json::from_slice(&frame.bytes).unwrap();
            assert_eq!(request["action"], "wait");
            assert_eq!(request["owner"], format!("owner-{}", request["workerUid"]));
            wire::write(reader.get_mut(), &json!({"waiting":true}))
                .await
                .unwrap();
            parked.push(reader.into_inner());
        }
        assert_eq!(backend.control.available_permits(), 8);
        assert_eq!(backend.urgent.available_permits(), 4);
        assert_eq!(backend.mutations.available_permits(), 8);
        assert_eq!(backend.execution.available_permits(), 8);
        assert_eq!(
            backend
                .wait_claim(json!({"waitMs":30000}), "extra")
                .await
                .value["error"]["code"],
            "adapter_busy"
        );

        let backend_task = tokio::spawn(async move {
            for expected in ["receipt", "claim_install"] {
                let (socket, _) = authority.accept().await.unwrap();
                let mut reader = BufReader::new(socket);
                let frame = wire::read(&mut reader, &Arc::new(Semaphore::new(wire::FRAME_LIMIT)))
                    .await
                    .unwrap()
                    .unwrap();
                let request: Value = serde_json::from_slice(&frame.bytes).unwrap();
                assert_eq!(request["action"], expected);
                assert!(request.get("waitMs").is_none());
                wire::write(reader.get_mut(), &json!({"result":{"status":"ok"}}))
                    .await
                    .unwrap();
            }
        });
        assert_eq!(
            backend.request(json!({"action":"receipt"})).await.value["result"]["status"],
            "ok"
        );
        wire::write(&mut parked[0], &json!({"result":{}}))
            .await
            .unwrap();
        assert_eq!(
            waiters.join_next().await.unwrap().unwrap().value["result"]["status"],
            "ok"
        );
        backend_task.await.unwrap();
        waiters.abort_all();
        while waiters.join_next().await.is_some() {}
        assert_eq!(backend.claim_waiters.available_permits(), 1024);
        drop(parked);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_full_waiting_queue_does_not_consume_reserved_urgent_capacity() {
        let backend = Backend::new("/nonexistent/ablo-coordinator-test.sock".into(), 8);
        let _queue = backend
            .waiting
            .clone()
            .acquire_many_owned(1024)
            .await
            .unwrap();
        let _reads = backend.control.clone().acquire_many_owned(8).await.unwrap();
        assert_eq!(
            backend.request(json!({"action":"read"})).await.value["error"]["code"],
            "adapter_busy"
        );
        // It reaches the unavailable authority rather than being rejected by the read backlog.
        assert_eq!(
            backend.request(json!({"action":"receipt"})).await.value["error"]["code"],
            "outcome_unknown"
        );
    }
}
