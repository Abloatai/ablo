mod backend;
mod feed;
mod listener;
mod wire;

use backend::Backend;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{self, BufRead},
    os::unix::fs::MetadataExt,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, BufReader},
    net::UnixStream,
    sync::{Semaphore, broadcast, mpsc},
    task::JoinSet,
    time::timeout,
};

struct Server {
    backend: Arc<Backend>,
    workers: HashMap<u32, String>,
    supervisor: u32,
    events: broadcast::Sender<Arc<Value>>,
}
impl Server {
    fn bind_identity(&self, peer: u32, request: &mut Value) -> Result<(), &'static str> {
        let object = request.as_object_mut().ok_or("request_invalid")?;
        let worker = if peer == self.supervisor {
            object
                .get("workerUid")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(peer)
        } else {
            if object.contains_key("workerUid") {
                return Err("permission_denied");
            }
            peer
        };
        if !self.workers.contains_key(&worker) {
            return Err("permission_denied");
        }
        if let Some(authority) = object.get("authority") {
            let text = |key| authority[key].as_str().ok_or("request_invalid");
            let sorted = |key| -> Result<Vec<&str>, &'static str> {
                let mut values = authority[key]
                    .as_array()
                    .ok_or("request_invalid")?
                    .iter()
                    .map(|value| value.as_str().ok_or("request_invalid"))
                    .collect::<Result<Vec<_>, _>>()?;
                values.sort_unstable();
                Ok(values)
            };
            let scope = json!([
                text("organizationId")?,
                text("projectId")?,
                text("branchId")?
            ])
            .to_string();
            let owner = json!([
                scope,
                text("participantId")?,
                text("participantKind")?,
                sorted("syncGroups")?,
                sorted("operations")?
            ]);
            let registered: Value =
                serde_json::from_str(&self.workers[&worker]).map_err(|_| "permission_denied")?;
            if owner != registered {
                return Err("permission_denied");
            }
        }
        object.insert("workerUid".into(), json!(worker));
        Ok(())
    }
}

async fn native(server: &Server, mut client: UnixStream, request: Value) -> io::Result<()> {
    let Ok(_permit) = server.backend.execution.clone().try_acquire_owned() else {
        return wire::write(&mut client, &json!({"error":{"code":"adapter_busy"}})).await;
    };
    let mut backend = UnixStream::connect(&server.backend.path).await?;
    wire::write(&mut backend, &request).await?;
    let _ = timeout(
        Duration::from_secs(310),
        tokio::io::copy_bidirectional(&mut client, &mut backend),
    )
    .await;
    Ok(())
}

async fn connection(server: Arc<Server>, client: UnixStream) -> io::Result<()> {
    let peer = client.peer_cred()?.uid();
    if peer != server.supervisor && !server.workers.contains_key(&peer) {
        return Ok(());
    }
    let mut input = BufReader::new(client);
    let Some(first) = timeout(
        Duration::from_secs(10),
        wire::read(&mut input, &server.backend.input),
    )
    .await??
    else {
        return Ok(());
    };
    let mut packet = Arc::new(first);
    let mut frame: Value = serde_json::from_slice(&packet.bytes)?;
    // Native streams are dedicated connections; multiplexed coordination uses request IDs.
    if frame["interactive"] == true {
        if peer != server.supervisor || frame["action"] != "run" {
            return Ok(());
        }
        if let Err(code) = server.bind_identity(peer, &mut frame) {
            return wire::write(input.get_mut(), &json!({"error":{"code":code}})).await;
        }
        // No control frames may precede the backend's started response.
        if !input.buffer().is_empty() {
            return Err(io::Error::other("early native input"));
        }
        return native(&server, input.into_inner(), frame).await;
    }
    let buffered = input.buffer().to_vec();
    let (reader, mut writer) = input.into_inner().into_split();
    let mut reader = BufReader::new(std::io::Cursor::new(buffered).chain(reader));
    let (incoming_tx, mut incoming_rx) = mpsc::channel(1);
    let mut reader_task = JoinSet::new();
    let budget = server.backend.input.clone();
    reader_task.spawn(async move {
        loop {
            let frame = wire::read(&mut reader, &budget).await;
            let done = !matches!(&frame, Ok(Some(_)));
            if incoming_tx.send(frame).await.is_err() || done {
                break;
            }
        }
    });
    let mut tasks = JoinSet::new();
    let mut ids = HashSet::new();
    let mut subscription: Option<(HashSet<String>, u64, broadcast::Receiver<Arc<Value>>)> = None;
    loop {
        let id = frame["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .map(str::to_owned);
        let Some(id) = id else {
            return Err(io::Error::other("request id required"));
        };
        let mut request = frame["request"].take();
        let error = server.bind_identity(peer, &mut request).err().or_else(|| {
            (!matches!(
                request["action"].as_str(),
                Some(
                    "ready"
                        | "read"
                        | "changes"
                        | "receipt"
                        | "claim"
                        | "heartbeat"
                        | "release"
                        | "write"
                        | "delete"
                        | "rename"
                        | "run"
                        | "subscribe"
                        | "unsubscribe"
                )
            ))
            .then_some("operation_invalid")
        });
        if let Some(code) = error {
            wire::write(&mut writer, &json!({"id":id,"error":{"code":code}})).await?;
        } else if request["interactive"] == true {
            return Err(io::Error::other("dedicated native stream required"));
        } else if ids.contains(&id) {
            return Err(io::Error::other("duplicate request id"));
        } else if request["action"] == "subscribe" {
            // Subscribe before the caller's durable catch-up: overlap is deduplicated by cursor.
            let resources = request["resources"]
                .as_array()
                .filter(|r| r.len() <= 256)
                .and_then(|r| {
                    r.iter()
                        .map(|s| s.as_str().filter(|s| s.len() <= 4096).map(str::to_owned))
                        .collect::<Option<HashSet<_>>>()
                });
            let after = request["after"].as_u64();
            if let (Some(resources), Some(after)) = (resources, after) {
                let receiver = server.events.subscribe();
                let mut check = request.clone();
                check["action"] = json!("changes");
                let guarded = server.backend.request(check).await;
                let reply = &guarded.value;
                if reply.get("error").is_some() {
                    wire::write(&mut writer, &json!({"id":id,"error":reply["error"]})).await?;
                } else {
                    subscription = Some((resources, after, receiver));
                    wire::write(&mut writer, &json!({"id":id,"result":{"subscribed":true}}))
                        .await?;
                }
            } else {
                wire::write(
                    &mut writer,
                    &json!({"id":id,"error":{"code":"request_invalid"}}),
                )
                .await?;
            }
        } else if request["action"] == "unsubscribe" {
            subscription = None;
            wire::write(&mut writer, &json!({"id":id,"result":{}})).await?;
        } else if tasks.len() >= 16 {
            wire::write(
                &mut writer,
                &json!({"id":id,"error":{"code":"adapter_busy"}}),
            )
            .await?;
        } else {
            ids.insert(id.clone());
            let server = server.clone();
            let memory = packet.clone();
            if request["action"] == "claim" && request.get("waitMs").is_some() {
                // Unadmitted queue waits end with their connection; accepted publications do not.
                tasks.spawn(async move {
                    let _memory = memory;
                    let worker = request["workerUid"].as_u64().unwrap() as u32;
                    (
                        id,
                        Ok(server
                            .backend
                            .wait_claim(request, &server.workers[&worker])
                            .await),
                    )
                });
            } else {
                let task = tokio::spawn(async move {
                    let _memory = memory;
                    server.backend.request(request).await
                });
                tasks.spawn(async move { (id, task.await) });
            }
        }
        loop {
            tokio::select! {
                incoming = incoming_rx.recv() => {
                    let Some(Ok(Some(incoming))) = incoming else { return Ok(()); };
                    packet = Arc::new(incoming);
                    frame = serde_json::from_slice(&packet.bytes)?;
                    break;
                }
                Some(reply) = tasks.join_next(), if !tasks.is_empty() => {
                    let (id, reply) = reply.map_err(io::Error::other)?;
                    let mut reply = reply.map_err(io::Error::other)?;
                    ids.remove(&id);
                    reply.value["id"] = json!(id);
                    wire::write(&mut writer, &reply.value).await?;
                }
                event = async { match subscription.as_mut() { Some((_,_,rx)) => rx.recv().await, None => std::future::pending().await } } => {
                    let Ok(event) = event else {
                        wire::write(&mut writer, &json!({"event":"resync_required"})).await?;
                        return Ok(());
                    };
                    if event.get("error").is_some() {
                        wire::write(&mut writer, &json!({"event":"resync_required"})).await?;
                        return Ok(());
                    }
                    let (resources, cursor, _) = subscription.as_mut().unwrap();
                    let rows: Vec<_> = event["events"].as_array().unwrap().iter().filter(|row| {
                        let path = row["path"].as_str().unwrap_or("");
                        let resource = if path.starts_with("ref:") { path.to_owned() } else { format!("file:{path}") };
                        row["sequence"].as_u64().unwrap_or(0) > *cursor && resources.contains(&resource)
                    }).collect();
                    let next = event["cursor"].as_u64().unwrap_or(*cursor);
                    if !rows.is_empty() { wire::write(&mut writer, &json!({"event":"changes","events":rows,"cursor":next})).await?; }
                    *cursor = (*cursor).max(next);
                }
            }
        }
    }
}

fn execution_slots(value: Option<&str>) -> io::Result<usize> {
    let slots = value.unwrap_or("8").parse::<usize>().map_err(io::Error::other)?;
    if !(1..=64).contains(&slots) {
        return Err(io::Error::other("execution slots must be from 1 to 64"));
    }
    Ok(slots)
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 && args.len() != 4 {
        return Err(io::Error::other(
            "usage: coordinator PUBLIC_SOCKET PRIVATE_BACKEND [EXECUTION_SLOTS]",
        ));
    }
    let private = std::fs::metadata(std::path::Path::new(&args[2]).parent().unwrap())?;
    if private.mode() & 0o077 != 0 {
        return Err(io::Error::other("backend directory must be private"));
    }
    let registration = io::stdin()
        .lock()
        .lines()
        .next()
        .ok_or_else(|| io::Error::other("workers required"))??;
    let workers: HashMap<u32, String> = serde_json::from_str::<Value>(&registration)?
        .as_object()
        .ok_or_else(|| io::Error::other("workers required"))?
        .iter()
        .map(|(key, owner)| {
            Ok((
                key.parse().map_err(io::Error::other)?,
                owner
                    .as_str()
                    .ok_or_else(|| io::Error::other("worker owner required"))?
                    .to_owned(),
            ))
        })
        .collect::<io::Result<_>>()?;
    let first = *workers
        .keys()
        .next()
        .ok_or_else(|| io::Error::other("workers required"))?;
    let backend = Arc::new(Backend::new(args[2].clone(), execution_slots(args.get(3).map(String::as_str))?));
    let (events, _) = broadcast::channel(256);
    let server = Arc::new(Server {
        backend: backend.clone(),
        workers,
        supervisor: private.uid(),
        events: events.clone(),
    });
    // Establish the live boundary before admitting subscribers; catch-up belongs to their cursors.
    let cursor = timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(reply) = backend
                .exchange(&json!({"action":"change_cursor", "workerUid":first}))
                .await
                && let Some(cursor) = reply["result"]["cursor"].as_u64()
            {
                break cursor;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?;
    tokio::spawn(feed::pump(backend, events, first, cursor));
    let listener = listener::Listener::bind(std::path::Path::new(&args[1]), private.uid()).await?;
    let connections = Arc::new(Semaphore::new(2048));
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        let accepted = tokio::select! {
            accepted = listener.socket.accept() => accepted,
            _ = terminate.recv() => break,
            _ = tokio::signal::ctrl_c() => break,
        };
        let (client, _) = accepted?;
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            drop(client);
            continue;
        };
        let server = server.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = connection(server, client).await;
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_capacity_requires_a_bounded_host_value() {
        assert_eq!(execution_slots(None).unwrap(), 8);
        assert_eq!(execution_slots(Some("10")).unwrap(), 10);
        for value in ["0", "65", "-1", "1.5", "invalid"] {
            assert!(execution_slots(Some(value)).is_err());
        }
    }

    #[test]
    fn peer_identity_cannot_be_overridden_by_a_worker() {
        let (events, _) = broadcast::channel(1);
        let server = Server {
            backend: Arc::new(Backend::new(String::new(), 8)),
            workers: HashMap::from([
                (
                    1001,
                    json!([
                        json!(["org", "project", "branch"]).to_string(),
                        "first",
                        "agent",
                        [],
                        []
                    ])
                    .to_string(),
                ),
                (1002, "second".into()),
            ]),
            supervisor: 0,
            events,
        };
        let authority = json!({"organizationId":"org","projectId":"project","branchId":"branch","participantId":"first","participantKind":"agent","syncGroups":[],"operations":[]});
        assert!(
            server
                .bind_identity(
                    1001,
                    &mut json!({"action":"claim","waitMs":1000,"authority":authority})
                )
                .is_ok()
        );
        let mut foreign = authority.clone();
        foreign["participantId"] = json!("second");
        assert_eq!(
            server.bind_identity(
                1001,
                &mut json!({"action":"claim","waitMs":1000,"authority":foreign})
            ),
            Err("permission_denied")
        );
        let mut own = json!({"action":"read"});
        assert!(server.bind_identity(1001, &mut own).is_ok());
        assert_eq!(own["workerUid"], 1001);
        assert_eq!(
            server.bind_identity(1001, &mut json!({"workerUid":1002})),
            Err("permission_denied")
        );
        assert_eq!(
            server.bind_identity(9999, &mut json!({})),
            Err("permission_denied")
        );
        assert!(
            server
                .bind_identity(0, &mut json!({"workerUid":1002}))
                .is_ok()
        );
        assert_eq!(
            server.bind_identity(0, &mut json!({"workerUid":9999})),
            Err("permission_denied")
        );
        assert_eq!(
            server.bind_identity(1001, &mut json!([])),
            Err("request_invalid")
        );
    }
}
