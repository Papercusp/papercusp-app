//! IPC client (SSE→IPC pivot). Connects to the operator's endpoint-ipc Unix
//! socket and invokes tools — including `sys:http` for `/api/*` routes.
//! Leaner mirror of `papercusp-desktop/src-tauri/src/endpoint_ipc.rs`
//! (mpsc + std Mutex map instead of Tauri Channels). No auth token: the Unix
//! socket is the trust boundary.
#![allow(dead_code)] // some surface (CallResult.result, generic invoke) is consumed as panels grow.

use crate::framing::{decode_event_bin_payload, encode_frame, Frame, FrameDecoder, FrameType};
use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixStream;
use tokio::sync::mpsc;

/// A non-terminal event frame for a call.
pub enum CallEvent {
    Json { name: String, data: Value },
    Bin { name: String, bytes: Vec<u8> },
}

/// Frames routed from the reader loop to a waiting call. Public so streaming
/// callers (e.g. an SSE subscription over `sys:http`) can drain them directly.
pub enum CallFrame {
    Event(CallEvent),
    Done(Value),
    Error { code: String, message: String },
    ConnLost,
}

/// Result of a completed call: the events seen + the DONE `result`.
pub struct CallResult {
    pub events: Vec<CallEvent>,
    pub result: Value,
}

type Sinks = Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<CallFrame>>>>;

/// How the client re-resolves its socket when it RECONNECTS. The operator
/// process restarts whenever the release pipeline redeploys `:3070` — a new pid
/// means a new `<pid>.sock`, so a long-lived pui pane (dock-driver, refetch /
/// invalidation loops) whose single socket was resolved at startup is severed
/// for good unless it re-reads discovery. `Discover` re-reads
/// `endpoint-ipc.json` each reconnect (pick up the new operator); `Fixed` pins
/// one path (tests / an explicit `connect`).
#[derive(Clone)]
enum SocketSource {
    Discover,
    Fixed(PathBuf),
}

/// One physical socket connection: the write half + THIS connection's sink map
/// (its reader task owns a clone) + a liveness flag the reader clears on EOF so
/// the next call reconnects instead of writing into a dead socket.
struct Conn {
    writer: OwnedWriteHalf,
    sinks: Sinks,
    alive: Arc<AtomicBool>,
}

pub struct IpcClient {
    /// How to re-resolve the socket on reconnect (D — operator-restart resilience).
    source: SocketSource,
    /// The live connection, replaced wholesale on reconnect. A tokio Mutex so a
    /// reconnect and a request-issue serialize (only one reconnect in flight).
    conn: tokio::sync::Mutex<Conn>,
    next_id: AtomicU64,
}

impl IpcClient {
    /// Resolve the socket from `~/.papercusp/endpoint-ipc.json` and connect.
    pub async fn connect_discovered() -> Result<Self> {
        let path = discover_socket().context("resolve endpoint-ipc socket")?;
        let conn = Self::dial(&path).await?;
        Ok(Self {
            source: SocketSource::Discover,
            conn: tokio::sync::Mutex::new(conn),
            next_id: AtomicU64::new(1),
        })
    }

    pub async fn connect(socket_path: &Path) -> Result<Self> {
        let conn = Self::dial(socket_path).await?;
        Ok(Self {
            source: SocketSource::Fixed(socket_path.to_path_buf()),
            conn: tokio::sync::Mutex::new(conn),
            next_id: AtomicU64::new(1),
        })
    }

    /// Open ONE socket connection + spawn its reader task. The reader routes
    /// frames to the connection's sinks until EOF/error, then marks the
    /// connection dead (so a racing issuer reconnects rather than registering
    /// into a now-readerless map) and fails every in-flight call.
    async fn dial(socket_path: &Path) -> Result<Conn> {
        let stream = UnixStream::connect(socket_path)
            .await
            .with_context(|| format!("connect ipc socket {}", socket_path.display()))?;
        let (mut read_half, write_half) = stream.into_split();
        let sinks: Sinks = Arc::new(Mutex::new(HashMap::new()));
        let reader_sinks = sinks.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let reader_alive = alive.clone();

        tokio::spawn(async move {
            let mut dec = FrameDecoder::new();
            let mut buf = [0u8; 64 * 1024];
            loop {
                match read_half.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if dec.push(&buf[..n]).is_err() {
                            break;
                        }
                        for frame in dec.drain() {
                            route_frame(&reader_sinks, frame);
                        }
                    }
                }
            }
            // Socket closed → mark dead FIRST (the next issuer reconnects), then
            // fail every in-flight call.
            reader_alive.store(false, Ordering::SeqCst);
            let mut g = reader_sinks.lock().unwrap();
            for (_, tx) in g.drain() {
                let _ = tx.send(CallFrame::ConnLost);
            }
        });

        Ok(Conn {
            writer: write_half,
            sinks,
            alive,
        })
    }

    /// Re-resolve the socket (re-reading discovery when `Discover`) and replace
    /// `conn` with a fresh connection. Called with the `conn` lock held.
    async fn reconnect(&self, conn: &mut Conn) -> Result<()> {
        let path = match &self.source {
            SocketSource::Discover => {
                discover_socket().context("re-resolve endpoint-ipc socket")?
            }
            SocketSource::Fixed(p) => p.clone(),
        };
        *conn = Self::dial(&path).await?;
        Ok(())
    }

    /// Open a streaming call: returns a receiver of `CallFrame`s for this call.
    /// It yields `Event(..)`s as they arrive then a terminal `Done`/`Error`
    /// (`ConnLost` on socket loss), after which it closes. For a long-lived
    /// stream (e.g. an SSE route via `sys:http`) there is no Done until the
    /// upstream stream ends — the caller processes events indefinitely.
    pub async fn invoke_stream(
        &self,
        tool: &str,
        input: Value,
    ) -> Result<mpsc::UnboundedReceiver<CallFrame>> {
        let mut conn = self.conn.lock().await;
        // Fast path: a dead connection (the operator restarted) → reconnect to
        // the new socket BEFORE issuing, rather than writing into a corpse.
        if !conn.alive.load(Ordering::SeqCst) {
            self.reconnect(&mut conn)
                .await
                .context("ipc reconnect (stale connection)")?;
        }
        let mut last_err: Option<anyhow::Error> = None;
        // Two attempts: a write that fails because the socket died mid-flight
        // triggers ONE reconnect-and-retry (so a restart that races our write
        // still lands on the fresh operator).
        for attempt in 0..2 {
            let id = self.next_id.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = mpsc::unbounded_channel::<CallFrame>();
            conn.sinks.lock().unwrap().insert(id, tx);

            let req = serde_json::json!({ "id": id, "toolName": tool, "input": input });
            let payload = match serde_json::to_vec(&req) {
                Ok(p) => p,
                Err(e) => {
                    conn.sinks.lock().unwrap().remove(&id);
                    return Err(e.into());
                }
            };
            let frame = match encode_frame(FrameType::Request, &payload) {
                Ok(f) => f,
                Err(e) => {
                    conn.sinks.lock().unwrap().remove(&id);
                    return Err(anyhow!("encode: {e}"));
                }
            };
            match conn.writer.write_all(&frame).await {
                Ok(()) => {
                    let _ = conn.writer.flush().await;
                    return Ok(rx);
                }
                Err(e) => {
                    // Write failed → the socket is gone. Drop the orphaned sink,
                    // reconnect once, and retry on the fresh connection.
                    conn.sinks.lock().unwrap().remove(&id);
                    last_err = Some(anyhow::Error::new(e).context("write request frame"));
                    if attempt == 0 {
                        self.reconnect(&mut conn)
                            .await
                            .context("ipc reconnect (write failed)")?;
                    }
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow!("ipc invoke_stream {tool}: failed")))
    }

    /// Invoke `tool` with `input`; collect events until DONE/ERROR. A
    /// request/response call (`sys:http`) — NOT a long-lived stream — so it
    /// carries a timeout: if the socket died in the tiny window AFTER the reader
    /// exited but BEFORE we registered our sink (so no `ConnLost` was delivered),
    /// the call would otherwise hang forever and wedge the whole refetch loop.
    /// On timeout we return an error rather than block; the reader has by then
    /// cleared the liveness flag, so the NEXT call reconnects.
    pub async fn invoke(&self, tool: &str, input: Value) -> Result<CallResult> {
        const CALL_TIMEOUT: Duration = Duration::from_secs(30);
        let mut rx = self.invoke_stream(tool, input).await?;
        let mut events: Vec<CallEvent> = Vec::new();
        loop {
            match tokio::time::timeout(CALL_TIMEOUT, rx.recv()).await {
                Err(_) => return Err(anyhow!("ipc {tool}: timed out (no response)")),
                Ok(None) => return Err(anyhow!("ipc {tool}: stream closed without terminal")),
                Ok(Some(msg)) => match msg {
                    CallFrame::Event(ev) => events.push(ev),
                    CallFrame::Done(result) => return Ok(CallResult { events, result }),
                    CallFrame::Error { code, message } => {
                        return Err(anyhow!("ipc {tool} error [{code}]: {message}"))
                    }
                    CallFrame::ConnLost => return Err(anyhow!("ipc {tool}: connection lost")),
                },
            }
        }
    }

    /// Invoke `sys:http` for an `/api/*` route; reassemble the `body` EVENT_BIN
    /// chunks into the response bytes. Errors on a non-2xx/3xx status.
    pub async fn sys_http(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<Vec<u8>> {
        let mut input = serde_json::json!({ "method": method, "path": path });
        if let Some(b) = body {
            input["headers"] = serde_json::json!({ "content-type": "application/json" });
            input["body"] = Value::String(b);
        }
        let res = self.invoke("sys:http", input).await?;

        let mut status: i64 = 200;
        let mut body_bytes: Vec<u8> = Vec::new();
        for ev in &res.events {
            match ev {
                CallEvent::Json { name, data } if name == "head" => {
                    status = data.get("status").and_then(|s| s.as_i64()).unwrap_or(200);
                }
                CallEvent::Bin { name, bytes } if name == "body" => {
                    body_bytes.extend_from_slice(bytes)
                }
                _ => {}
            }
        }
        if !(200..400).contains(&status) {
            let txt: String = String::from_utf8_lossy(&body_bytes)
                .chars()
                .take(65_536)
                .collect();
            return Err(anyhow::Error::new(crate::http::HttpStatusError {
                method: method.to_string(),
                path: path.to_string(),
                status: status as u16,
                body: txt,
            }));
        }
        Ok(body_bytes)
    }
}

fn route_frame(sinks: &Sinks, frame: Frame) {
    let (id, cf): (u64, CallFrame) = match frame.frame_type {
        FrameType::EventJson => {
            let v: Value = match serde_json::from_slice(&frame.payload) {
                Ok(v) => v,
                Err(_) => return,
            };
            let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            let name = v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let data = v.get("data").cloned().unwrap_or(Value::Null);
            (id, CallFrame::Event(CallEvent::Json { name, data }))
        }
        FrameType::EventBin => match decode_event_bin_payload(&frame.payload) {
            Ok(d) => (
                d.id,
                CallFrame::Event(CallEvent::Bin {
                    name: d.name,
                    bytes: d.binary,
                }),
            ),
            Err(_) => return,
        },
        FrameType::Done => {
            let v: Value = match serde_json::from_slice(&frame.payload) {
                Ok(v) => v,
                Err(_) => return,
            };
            let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            (
                id,
                CallFrame::Done(v.get("result").cloned().unwrap_or(Value::Null)),
            )
        }
        FrameType::Error => {
            let v: Value = match serde_json::from_slice(&frame.payload) {
                Ok(v) => v,
                Err(_) => return,
            };
            let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            let err = v.get("error").cloned().unwrap_or(Value::Null);
            let code = err
                .get("code")
                .and_then(|x| x.as_str())
                .unwrap_or("error")
                .to_string();
            let message = err
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            (id, CallFrame::Error { code, message })
        }
        // Client→server frame types never arrive here.
        FrameType::Request | FrameType::Cancel => return,
    };
    // Terminal frames free the sink (so streaming receivers close cleanly).
    let is_terminal = matches!(cf, CallFrame::Done(_) | CallFrame::Error { .. });
    let tx = {
        let mut g = sinks.lock().unwrap();
        if is_terminal {
            g.remove(&id)
        } else {
            g.get(&id).cloned()
        }
    };
    if let Some(tx) = tx {
        let _ = tx.send(cf);
    }
}

fn discover_socket() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home dir")?;
    let port = std::env::var("PAPERCUSP_HONO_PORT")
        .ok()
        .and_then(|p| p.parse::<u32>().ok())
        .unwrap_or(3070);
    discover_socket_in(&home.join(".papercusp"), port)
}

/// EI-190 / EI-7760 / WI-41592: the singleton `endpoint-ipc.json` is
/// LAST-WRITER-WINS across EVERY operator on the box. It is therefore not a
/// valid fallback for an already-selected port: doing so can connect this PUI
/// to a different operator/store. Resolve the per-port record only and fail
/// loudly when it is absent or stale; the caller may use HTTP to the SAME
/// selected origin, never another discovery source.
fn discover_socket_in(dir: &Path, port: u32) -> Result<PathBuf> {
    let per_port = dir.join(format!("endpoint-ipc.{port}.json"));
    let (path, pid) = read_discovery(&per_port)?;
    if !writer_alive(pid) {
        anyhow::bail!("discovery {} points at dead pid {pid}", per_port.display());
    }
    Ok(path)
}

fn read_discovery(disc: &Path) -> Result<(PathBuf, i64)> {
    let txt = std::fs::read_to_string(disc).with_context(|| format!("read {}", disc.display()))?;
    let v: Value =
        serde_json::from_str(&txt).with_context(|| format!("parse {}", disc.display()))?;
    let sp = v
        .get("socketPath")
        .and_then(|x| x.as_str())
        .with_context(|| format!("{} missing socketPath", disc.display()))?;
    let pid = v.get("pid").and_then(|x| x.as_i64()).unwrap_or(0);
    Ok((PathBuf::from(sp), pid))
}

/// pid 0/absent (a legacy file) can't be checked — treat as alive. Non-Linux
/// has no /proc; treat as alive there too (the dial will sort it out).
fn writer_alive(pid: i64) -> bool {
    if pid <= 0 {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::OperatorClient;
    use crate::models::{HiveVisibility, SetHiveListingRequest};
    use tokio::net::UnixListener;
    use tokio::sync::oneshot;

    #[test]
    fn discover_socket_is_strictly_per_port_and_skips_dead_writers() {
        let dir = tempfile::tempdir().unwrap();
        let me = std::process::id() as i64;
        // pid_max caps well below this — /proc/<dead> never exists.
        let dead: i64 = 999_999_999;
        let pp = dir.path().join("endpoint-ipc.3070.json");
        let single = dir.path().join("endpoint-ipc.json");
        // Live per-port writer wins over the singleton.
        std::fs::write(
            &pp,
            format!(r#"{{"socketPath":"/tmp/pp.sock","pid":{me},"port":3070}}"#),
        )
        .unwrap();
        std::fs::write(
            &single,
            format!(r#"{{"socketPath":"/tmp/single.sock","pid":{dead}}}"#),
        )
        .unwrap();
        assert_eq!(
            discover_socket_in(dir.path(), 3070).unwrap(),
            PathBuf::from("/tmp/pp.sock")
        );
        // A live singleton must NEVER rescue a dead per-port writer: it may
        // belong to a different operator/store.
        std::fs::write(
            &pp,
            format!(r#"{{"socketPath":"/tmp/pp.sock","pid":{dead}}}"#),
        )
        .unwrap();
        std::fs::write(
            &single,
            format!(r#"{{"socketPath":"/tmp/single.sock","pid":{me}}}"#),
        )
        .unwrap();
        assert!(discover_socket_in(dir.path(), 3070).is_err());
        // Both writers dead → error, not a corpse dial.
        std::fs::write(
            &single,
            format!(r#"{{"socketPath":"/tmp/single.sock","pid":{dead}}}"#),
        )
        .unwrap();
        assert!(discover_socket_in(dir.path(), 3070).is_err());
        // A legacy singleton without a per-port record is also refused.
        std::fs::remove_file(&pp).unwrap();
        std::fs::write(&single, r#"{"socketPath":"/tmp/legacy.sock"}"#).unwrap();
        assert!(discover_socket_in(dir.path(), 3070).is_err());
    }

    fn event_bin_frame(id: u64, name: &str, bin: &[u8]) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&id.to_be_bytes());
        p.extend_from_slice(&(name.len() as u32).to_be_bytes());
        p.extend_from_slice(name.as_bytes());
        p.extend_from_slice(bin);
        encode_frame(FrameType::EventBin, &p).unwrap()
    }

    /// Fake operator: accept one connection, read a REQUEST, reply with the
    /// sys:http frame sequence (head EVENT_JSON + body EVENT_BIN + DONE).
    async fn spawn_fake(socket: PathBuf, status: i64, body: &'static [u8]) {
        drop(spawn_fake_capture(socket, status, body).await);
    }

    /// The same fake, with the exact request returned to the test. This keeps
    /// typed `OperatorClient` route tests at the IPC seam that owns them.
    async fn spawn_fake_capture(
        socket: PathBuf,
        status: i64,
        body: &'static [u8],
    ) -> oneshot::Receiver<Value> {
        let listener = UnixListener::bind(&socket).unwrap();
        let (request_tx, request_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut r, mut w) = stream.into_split();
            // Read exactly one REQUEST frame.
            let mut hdr = [0u8; 5];
            if r.read_exact(&mut hdr).await.is_err() {
                return;
            }
            let len = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize;
            let mut payload = vec![0u8; len];
            let _ = r.read_exact(&mut payload).await;
            let req: Value = serde_json::from_slice(&payload).unwrap();
            let id = req["id"].as_u64().unwrap();
            let _ = request_tx.send(req);

            let head =
                serde_json::json!({"id":id,"name":"head","data":{"status":status,"headers":{}}})
                    .to_string();
            let _ = w
                .write_all(&encode_frame(FrameType::EventJson, head.as_bytes()).unwrap())
                .await;
            let _ = w.write_all(&event_bin_frame(id, "body", body)).await;
            let done = serde_json::json!({"id":id,"result":{"content":[]}}).to_string();
            let _ = w
                .write_all(&encode_frame(FrameType::Done, done.as_bytes()).unwrap())
                .await;
            let _ = w.flush().await;
        });
        // Give bind a beat before the client connects.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        request_rx
    }

    /// Fake operator that streams several EVENT_JSON frames before DONE — the
    /// shape `invoke_stream` consumes for the SSE-over-IPC subscription.
    async fn spawn_fake_stream(socket: PathBuf, chunks: Vec<&'static str>) {
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut r, mut w) = stream.into_split();
            let mut hdr = [0u8; 5];
            if r.read_exact(&mut hdr).await.is_err() {
                return;
            }
            let len = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize;
            let mut payload = vec![0u8; len];
            let _ = r.read_exact(&mut payload).await;
            let req: Value = serde_json::from_slice(&payload).unwrap();
            let id = req["id"].as_u64().unwrap();
            for c in chunks {
                let f = serde_json::json!({"id":id,"name":"sse-chunk","data":c}).to_string();
                let _ = w
                    .write_all(&encode_frame(FrameType::EventJson, f.as_bytes()).unwrap())
                    .await;
            }
            let done = serde_json::json!({"id":id,"result":Value::Null}).to_string();
            let _ = w
                .write_all(&encode_frame(FrameType::Done, done.as_bytes()).unwrap())
                .await;
            let _ = w.flush().await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    #[tokio::test]
    async fn invoke_stream_yields_events_then_closes() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("op.sock");
        spawn_fake_stream(
            sock.clone(),
            vec!["event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"],
        )
        .await;
        let client = IpcClient::connect(&sock).await.unwrap();
        let mut rx = client
            .invoke_stream(
                "sys:http",
                serde_json::json!({"method":"GET","path":"/api/sse"}),
            )
            .await
            .unwrap();
        let mut chunks = 0;
        let mut saw_done = false;
        while let Some(f) = rx.recv().await {
            match f {
                CallFrame::Event(CallEvent::Json { name, .. }) if name == "sse-chunk" => {
                    chunks += 1
                }
                CallFrame::Done(_) => {
                    saw_done = true;
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(chunks, 2);
        assert!(saw_done);
        // After the terminal frame the sink is freed, so the channel is closed.
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn sys_http_reassembles_body() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("op.sock");
        spawn_fake(sock.clone(), 200, br#"{"ok":true,"n":7}"#).await;
        let client = IpcClient::connect(&sock).await.unwrap();
        let bytes = client.sys_http("GET", "/api/x", None).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        assert_eq!(v["n"], serde_json::json!(7));
    }

    #[tokio::test]
    async fn operator_client_uses_the_hive_native_share_routes_over_ipc() {
        let dir = tempfile::tempdir().unwrap();

        let meta_sock = dir.path().join("meta.sock");
        let meta_request = spawn_fake_capture(
            meta_sock.clone(),
            200,
            br#"{"potId":"my hive","found":false,"visibility":null,"title":"my hive","description":"","inviteSecret":null,"hivePubkey":null,"memberRepos":[]}"#,
        )
        .await;
        let meta_client =
            OperatorClient::new(Arc::new(IpcClient::connect(&meta_sock).await.unwrap()));
        let meta = meta_client.hive_share_meta("my hive").await.unwrap();
        assert_eq!(meta.pot_id, "my hive");
        let request = meta_request.await.unwrap();
        assert_eq!(request["toolName"], "sys:http");
        assert_eq!(request["input"]["method"], "GET");
        assert_eq!(
            request["input"]["path"],
            "/api/discovery/pot-meta?potId=my%20hive"
        );

        let set_sock = dir.path().join("set.sock");
        let set_request = spawn_fake_capture(
            set_sock.clone(),
            200,
            br#"{"ok":true,"saved":true,"announced":true,"reachablePeers":2}"#,
        )
        .await;
        let set_client =
            OperatorClient::new(Arc::new(IpcClient::connect(&set_sock).await.unwrap()));
        let outcome = set_client
            .set_hive_listing(&SetHiveListingRequest {
                pot_id: "my hive".to_string(),
                title: "My Hive".to_string(),
                description: "Shared workspace".to_string(),
                visibility: HiveVisibility::Invite,
                invite_secret: Some("0123456789abcdef0123456789abcdef".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(outcome.reachable_peers, Some(2));
        let request = set_request.await.unwrap();
        assert_eq!(request["toolName"], "sys:http");
        assert_eq!(request["input"]["method"], "POST");
        assert_eq!(request["input"]["path"], "/api/discovery/set-pot");
        let body: Value = serde_json::from_str(request["input"]["body"].as_str().unwrap()).unwrap();
        assert_eq!(body["potId"], "my hive");
        assert_eq!(body["visibility"], "invite");
        assert_eq!(body["inviteSecret"], "0123456789abcdef0123456789abcdef");
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_ipc_smoke() {
        let client = IpcClient::connect_discovered()
            .await
            .expect("connect via discovery");
        let bytes = client
            .sys_http("GET", "/api/admin/plans/list", None)
            .await
            .expect("sys_http GET");
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        let n = v["plans"].as_array().map(|a| a.len()).unwrap_or(0);
        eprintln!("live IPC sys:http → plans count = {n}");
        assert!(v.get("plans").is_some(), "expected a plans array");
        assert!(n > 0, "operator should have plans");
    }

    #[tokio::test]
    #[ignore = "requires a running operator (endpoint-ipc socket present)"]
    async fn live_sse_subscription_smoke() {
        let client = IpcClient::connect_discovered()
            .await
            .expect("connect via discovery");
        let mut rx = client
            .invoke_stream(
                "sys:http",
                serde_json::json!({"method":"GET","path":"/api/zero-harness/sse"}),
            )
            .await
            .expect("open sse stream");
        // The route sends an initial heartbeat — we should see a sse-chunk frame
        // carrying SSE wire text within a few seconds.
        let got = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(f) = rx.recv().await {
                if let CallFrame::Event(CallEvent::Json { name, data }) = f {
                    if name == "sse-chunk" {
                        return data.as_str().map(|s| s.to_string());
                    }
                }
            }
            None
        })
        .await
        .expect("timed out waiting for first sse-chunk");
        let text = got.expect("first sse-chunk had string data");
        eprintln!("live SSE first chunk: {text:?}");
        let (frames, _rest) = crate::sse::parse_sse_frames(&text);
        // At least one parseable frame, and it should be a known sync event.
        assert!(
            frames.iter().any(|fr| matches!(
                fr.event.as_str(),
                "heartbeat" | "invalidate" | "update" | "message"
            )),
            "expected a recognisable SSE event, got {frames:?}"
        );
    }

    /// EI: the operator restarts (release redeploy) and the long-lived pui
    /// panes must reconnect transparently — the original bug was a single
    /// socket resolved at startup, so a restart severed the dock-driver and
    /// New-plan launches never opened a pane. The server here drops the
    /// connection after each call (a "restart"); the client must re-dial and
    /// the next call must succeed.
    #[tokio::test]
    async fn reconnects_after_connection_drop() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("op.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        // Accept connections forever; serve exactly ONE sys:http call per
        // connection, then drop it (the per-deploy operator restart).
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let (mut r, mut w) = stream.into_split();
                let mut hdr = [0u8; 5];
                if r.read_exact(&mut hdr).await.is_err() {
                    continue;
                }
                let len = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize;
                let mut payload = vec![0u8; len];
                if r.read_exact(&mut payload).await.is_err() {
                    continue;
                }
                let req: Value = serde_json::from_slice(&payload).unwrap();
                let id = req["id"].as_u64().unwrap();
                let head =
                    serde_json::json!({"id":id,"name":"head","data":{"status":200,"headers":{}}})
                        .to_string();
                let _ = w
                    .write_all(&encode_frame(FrameType::EventJson, head.as_bytes()).unwrap())
                    .await;
                let _ = w
                    .write_all(&event_bin_frame(id, "body", br#"{"ok":true}"#))
                    .await;
                let done = serde_json::json!({"id":id,"result":{"content":[]}}).to_string();
                let _ = w
                    .write_all(&encode_frame(FrameType::Done, done.as_bytes()).unwrap())
                    .await;
                let _ = w.flush().await;
                // r,w drop here → the connection closes (the simulated restart).
            }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        let client = IpcClient::connect(&sock).await.unwrap();
        // First call lands on the original connection.
        let b1 = client.sys_http("GET", "/api/x", None).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&b1).unwrap()["ok"],
            serde_json::json!(true)
        );

        // The server dropped that connection; let the client's reader observe
        // EOF and clear the liveness flag.
        tokio::time::sleep(Duration::from_millis(60)).await;

        // The second call must transparently RECONNECT (re-dial the same path)
        // and succeed — the regression guard for operator-restart resilience.
        let b2 = client.sys_http("GET", "/api/y", None).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&b2).unwrap()["ok"],
            serde_json::json!(true)
        );
    }

    #[tokio::test]
    async fn sys_http_errors_on_non_2xx() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("op.sock");
        spawn_fake(sock.clone(), 404, b"not found").await;
        let client = IpcClient::connect(&sock).await.unwrap();
        let err = client
            .sys_http("GET", "/api/missing", None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("404"));
    }
}
