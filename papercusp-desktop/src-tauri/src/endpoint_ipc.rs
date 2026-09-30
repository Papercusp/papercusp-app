//! Endpoint IPC client. Connects to the Node sidecar's IPC server
//! (see apps/operator/lib/endpoint-ipc/server.ts) over a Unix domain
//! socket or named pipe and pumps events into per-call Tauri Channels.
//!
//! Lifecycle (when wired into main.rs in a follow-up commit):
//!
//!   1. Sidecar bootstrap reads PAPERCUSP_IPC_READY socket=<path> from
//!      Node's stdout (per PROTOCOL.md).
//!   2. main.rs calls `IpcClient::connect(socket_path)` → state.
//!   3. Webview JS calls `invoke('endpoint_invoke', { tool_name, input, channel })`.
//!   4. Rust writes a REQUEST frame, registers the Channel under a fresh
//!      monotonic id, and the reader-loop fans incoming events into it.
//!   5. Webview drops the Channel or window unloads → consumer's
//!      finally block sends CANCEL.

#![allow(dead_code)] // wired up by main.rs in a follow-up

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::endpoint_ipc_framing::{
    decode_event_bin_routing_id, encode_frame, FrameDecoder, FrameType,
};

/// One event surfaced to the webview JS. Tagged JSON via Serde.
///
/// The TS shape (apps/operator):
///   { kind: 'event', name: string, data: unknown }
///   | ArrayBuffer // raw EVENT_BIN payload; decoded by ipc-stream.ts
///   | { kind: 'done', result: ToolResult }
///   | { kind: 'error', code: string, message: string }
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EndpointEvent {
    /// JSON-valued event (delta, tool_call, suggestion, cost, etc.).
    Event {
        name: String,
        data: serde_json::Value,
    },
    /// Binary event. `payload` is the original EVENT_BIN wire payload:
    /// `[8B call id BE][4B name length BE][name UTF-8][binary]`.
    ///
    /// Its custom `IpcResponse` implementation sends this variant as
    /// `InvokeResponseBody::Raw`, so Tauri delivers an ArrayBuffer without a
    /// base64 or JSON-array round trip. Keeping control and raw messages on the
    /// SAME Channel preserves Tauri's per-channel ordering index; a second raw
    /// channel would let a small JSON `done` overtake a large binary fetch.
    Binary { payload: Vec<u8> },
    /// Tool returned successfully.
    Done { result: serde_json::Value },
    /// Dispatch or handler failed (role gate, quota, timeout, throw).
    Error { code: String, message: String },
}

/// Mixed JSON-control/raw-binary response for one ordered Tauri Channel.
///
/// Removing `Serialize` from `EndpointEvent` is deliberate: Tauri's blanket
/// `IpcResponse for T: Serialize` always produces JSON. This local implementation
/// is the typed seam that selects Raw only for the binary variant.
impl IpcResponse for EndpointEvent {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        let json = match self {
            Self::Binary { payload } => return Ok(InvokeResponseBody::Raw(payload)),
            Self::Event { name, data } => {
                serde_json::json!({ "kind": "event", "name": name, "data": data })
            }
            Self::Done { result } => serde_json::json!({ "kind": "done", "result": result }),
            Self::Error { code, message } => {
                serde_json::json!({ "kind": "error", "code": code, "message": message })
            }
        };
        serde_json::to_string(&json)
            .map(InvokeResponseBody::Json)
            .map_err(Into::into)
    }
}

/// Wire-shape envelopes used to parse server-emitted JSON payloads.

#[derive(Debug, Deserialize)]
struct EventJsonEnvelope {
    id: u64,
    name: String,
    data: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct DoneEnvelope {
    id: u64,
    result: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    id: u64,
    error: ErrorPayload,
}

#[derive(Debug, Deserialize)]
struct ErrorPayload {
    code: String,
    message: String,
}

/// Per-call channel handle. The reader-loop fans events into here.
///
/// `events_sent` is the per-call backpressure counter. Tauri 2's
/// `Channel::send()` queues internally with no exposed backpressure —
/// a tool emitting faster than the webview drains would grow Rust
/// process memory until OOM. The 10k cap was promised in the plan as
/// "non-negotiable"; this is the implementation.
///
/// When the cap trips:
///   1. One final ERROR is sent (the consumer-visible terminal).
///   2. `overflowed` flips to true; subsequent sends short-circuit.
///   3. The server-side dispatch keeps running (we can't cancel it
///      from the client mid-stream cheaply), but its emitted events
///      land in the void from the Rust side onward.
///
/// 10k is generous for the steady-state load we expect (token streams
/// at ~30/sec for 5-minute turns = 9k events) but bounded enough that
/// a wedged consumer can't take the desktop down. Tune via telemetry
/// if a real workload approaches the cap.
const PER_CALL_EVENT_CAP: u64 = 10_000;

/// WI-2817: an in-flight call gets NO activity (not even a keep-alive EVENT
/// frame) for this long ⇒ treated as wedged and force-failed with
/// `connection_lost` (the SAME terminal code `reader_loop`'s EOF path already
/// emits, so the existing, already-tested `ipc-fetch.ts` transparent retry
/// handles it with no new client-side logic). 20s comfortably exceeds both a
/// quick sidecar bounce (~120ms) and a cold embedded-PG + migrations boot
/// (~11-13s observed, ~3s with the pre-migrated seed fast path — see
/// WI-2601), so it never trips on a legitimately-slow-but-alive boot.
///
/// WHY THIS EXISTS: `IpcClient::is_alive()` only flips false when the reader
/// loop observes an EOF/read-error on the socket — a connection that stays
/// OPEN but whose peer process is wedged (e.g. mid-restart, between binding
/// its new socket and actually servicing requests) never trips that path.
/// Before this, such a call's `CallSink` just sat in `in_flight` forever:
/// no Done, no Error, no reconnect — exactly the "hangs on bprogress-busy,
/// needs manual relaunch" symptom this fixes.
const IPC_CALL_IDLE_TIMEOUT_MS: u64 = 20_000;
/// How often the per-call watchdog re-checks staleness. Small relative to
/// either timeout so the observed hang is bounded to ~timeout + one interval.
const IPC_WATCHDOG_CHECK_INTERVAL_MS: u64 = 2_000;

/// Heartbeat cadence for the long-lived session SSE streams. This mirrors
/// `SESSION_STREAM_HEARTBEAT_MS` in
/// `packages/operator-core/lib/endpoint-route/routes/harness/streams.ts`.
const IPC_STREAM_HEARTBEAT_INTERVAL_MS: u64 = 15_000;
/// A stream gets two complete heartbeat intervals plus one watchdog tick of
/// scheduling margin. The margin prevents a watchdog check racing a heartbeat
/// delivered exactly at the two-beat boundary from tearing down a healthy
/// stream. Request/response calls retain their shorter 20s budget above.
const IPC_STREAM_IDLE_TIMEOUT_MS: u64 =
    IPC_STREAM_HEARTBEAT_INTERVAL_MS * 2 + IPC_WATCHDOG_CHECK_INTERVAL_MS;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pure decision fn (testable without a socket/watchdog task): has this call
/// gone idle-timed-out? Saturating so a clock oddity never underflows/panics.
fn is_idle_timed_out(last_activity_ms: u64, now_ms: u64, timeout_ms: u64) -> bool {
    now_ms.saturating_sub(last_activity_ms) >= timeout_ms
}

/// Whether a `sys:http` response head identifies a long-lived SSE stream.
/// Header names and MIME types are case-insensitive; parameters such as
/// `charset=utf-8` do not change the media type.
fn is_sse_response_head(data: &serde_json::Value) -> bool {
    let Some(headers) = data.get("headers").and_then(serde_json::Value::as_object) else {
        return false;
    };
    headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("content-type")
            && value
                .as_str()
                .and_then(|content_type| content_type.split(';').next())
                .map(str::trim)
                .is_some_and(|media_type| media_type.eq_ignore_ascii_case("text/event-stream"))
    })
}

struct CallSink {
    channel: Channel<EndpointEvent>,
    events_sent: AtomicU64,
    overflowed: std::sync::atomic::AtomicBool,
    /// WI-2817: wall-clock ms of the last activity (creation, or any event/
    /// terminal frame) seen for this call — the idle-timeout watchdog's
    /// staleness clock.
    last_activity_ms: AtomicU64,
    /// Request/response calls use `IPC_CALL_IDLE_TIMEOUT_MS`; once their head
    /// proves they are SSE subscriptions this switches to the stream budget.
    idle_timeout_ms: AtomicU64,
}

/// Decision returned by `decide_backpressure` — testable in isolation.
#[derive(Debug, PartialEq, Eq)]
pub enum BackpressureDecision {
    /// Forward the event to the channel; under cap.
    Forward,
    /// First overflow event — emit a single backpressure_overflow error,
    /// then drop everything subsequent.
    EmitOverflowAndStop,
    /// Cap already tripped earlier; silently drop.
    Drop,
}

/// Pure decision function — given counter state and the cap, decide
/// what to do with the next event. Atomic state is updated in-place.
/// Extracted from `CallSink::try_send_event` so it can be tested
/// without spinning up a Tauri webview to construct a Channel.
fn decide_backpressure(
    events_sent: &AtomicU64,
    overflowed: &std::sync::atomic::AtomicBool,
    cap: u64,
) -> BackpressureDecision {
    use std::sync::atomic::Ordering;
    if overflowed.load(Ordering::Relaxed) {
        return BackpressureDecision::Drop;
    }
    let n = events_sent.fetch_add(1, Ordering::Relaxed);
    if n >= cap {
        if !overflowed.swap(true, Ordering::Relaxed) {
            BackpressureDecision::EmitOverflowAndStop
        } else {
            BackpressureDecision::Drop
        }
    } else {
        BackpressureDecision::Forward
    }
}

impl CallSink {
    /// Record inbound activity and classify a response head before forwarding
    /// it to the webview. Classification is intentionally based on the
    /// response MIME type, not the request path or Accept header: a route can
    /// legitimately negotiate a stream under more than one URL, while the
    /// head is the first authoritative proof that this call is a subscription.
    fn record_activity(&self, event: &EndpointEvent) {
        if let EndpointEvent::Event { name, data } = event {
            if name == "head" && is_sse_response_head(data) {
                self.idle_timeout_ms
                    .store(IPC_STREAM_IDLE_TIMEOUT_MS, Ordering::Relaxed);
            }
        }
        self.last_activity_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// Send a non-terminal event with the per-call cap enforced. Returns
    /// true if the event was forwarded; false if it was dropped (cap or
    /// channel error).
    fn try_send_event(&self, event: EndpointEvent) -> bool {
        // WI-2817: ANY inbound frame is activity — resets the idle-timeout clock.
        // The response head may also promote this call to the stream budget.
        self.record_activity(&event);
        match decide_backpressure(&self.events_sent, &self.overflowed, PER_CALL_EVENT_CAP) {
            BackpressureDecision::Forward => self.channel.send(event).is_ok(),
            BackpressureDecision::EmitOverflowAndStop => {
                let _ = self.channel.send(EndpointEvent::Error {
                    code: "backpressure_overflow".to_string(),
                    message: format!(
                        "per-call event cap {} exceeded — server kept emitting but client can't keep up",
                        PER_CALL_EVENT_CAP
                    ),
                });
                false
            }
            BackpressureDecision::Drop => false,
        }
    }

    /// Send a terminal event (Done / Error). Always attempts to forward,
    /// even when overflowed — the consumer needs to know the call ended.
    fn send_terminal(&self, event: EndpointEvent) {
        let _ = self.channel.send(event);
    }
}

/// Runtime-selected transport for the endpoint-IPC stream.
///
/// A Unix domain socket, a Windows named pipe, and a loopback TCP connection
/// all satisfy `AsyncRead + AsyncWrite`, but they are distinct concrete types
/// — and on Windows the choice can NOT be made at compile time: the sidecar
/// runs inside WSL2, where it is reachable from the Windows host only over
/// loopback TCP (a Unix socket it creates is invisible to the host, and it
/// can't create a `\\.\pipe\` named pipe), so a Windows build must be able to
/// speak EITHER a named pipe (a hypothetical native sidecar) OR TCP (the real
/// WSL2 sidecar). The variant is therefore chosen at CONNECT time from the
/// discovered endpoint string. TCP is what finally lights up the `/api`
/// connection-cap bypass on Windows — WI-3395 / fact
/// `windows-ipc-bypass-off-wsl2`. Three places classify this same string and
/// must stay in lockstep: `parse_endpoint`
/// (libs/generic/ipc-endpoint-server/src/server.ts), the
/// `endpoint_ipc_socket_path_supported_for_target` guard (main.rs), and
/// `parse_tcp_endpoint` below.
enum IpcStream {
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
    #[cfg(windows)]
    Pipe(tokio::net::windows::named_pipe::NamedPipeClient),
    Tcp(tokio::net::TcpStream),
}

// All three inner transports are `Unpin`, so the enum is `Unpin` and
// `Pin::get_mut` + re-pinning each `&mut inner` is sound. We just forward each
// poll to whichever variant is live.
impl AsyncRead for IpcStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            IpcStream::Unix(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            #[cfg(windows)]
            IpcStream::Pipe(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            IpcStream::Tcp(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for IpcStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            #[cfg(unix)]
            IpcStream::Unix(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            #[cfg(windows)]
            IpcStream::Pipe(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            IpcStream::Tcp(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            IpcStream::Unix(s) => std::pin::Pin::new(s).poll_flush(cx),
            #[cfg(windows)]
            IpcStream::Pipe(s) => std::pin::Pin::new(s).poll_flush(cx),
            IpcStream::Tcp(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            IpcStream::Unix(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            #[cfg(windows)]
            IpcStream::Pipe(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            IpcStream::Tcp(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Classify the discovered endpoint string: `Some("host:port")` for a
/// `tcp://host:port` address, else `None` (a Unix-socket / named-pipe path).
/// Mirrors `parse_endpoint` (Node) and is shared with the main.rs target guard
/// so all endpoint-IPC call sites use the same strict syntax. Handles a
/// bracketed IPv6 literal too (`tcp://[::1]:8080` → `[::1]:8080`), which
/// `ToSocketAddrs` for `&str` parses natively.
pub(crate) fn is_tcp_endpoint(socket: &str) -> bool {
    parse_tcp_endpoint(socket).is_some()
}

fn parse_tcp_endpoint(socket: &str) -> Option<&str> {
    let trimmed = socket.trim();
    let hostport = trimmed.strip_prefix("tcp://")?;

    // Keep this grammar aligned with server.ts' parseEndpoint regex:
    // `tcp://[host]:port` or `tcp://host:port`, with a numeric port. The
    // bracketed form may contain colons (IPv6); the unbracketed form may not.
    let (host, port, bracketed_host) = if let Some(bracketed) = hostport.strip_prefix('[') {
        let close = bracketed.find(']')?;
        let host = &bracketed[..close];
        let port = bracketed[close + 1..].strip_prefix(':')?;
        (host, port, true)
    } else {
        let (host, port) = hostport.rsplit_once(':')?;
        (host, port, false)
    };

    if host.is_empty()
        || (!bracketed_host
            && (host.contains('/')
                || host.contains(':')
                || host.contains('[')
                || host.contains(']')))
        || port.is_empty()
        || !port.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }

    Some(hostport)
}

/// Dial the endpoint at `socket_path` and return the opened stream. A
/// `tcp://host:port` path is dialed as loopback TCP on ANY host OS — that is
/// how the Windows host reaches the WSL2 sidecar (WI-3395). Otherwise the
/// platform transport is used: a Unix domain socket on unix, a named pipe on
/// Windows.
async fn connect_stream(path: &Path) -> std::io::Result<IpcStream> {
    if let Some(hostport) = path.to_str().and_then(parse_tcp_endpoint) {
        let stream = tokio::net::TcpStream::connect(hostport).await?;
        // IPC frames are small + latency-sensitive (a REQUEST then a stream of
        // events); disable Nagle to match the Unix-socket / named-pipe
        // transports, which have no such coalescing delay.
        let _ = stream.set_nodelay(true);
        return Ok(IpcStream::Tcp(stream));
    }
    #[cfg(unix)]
    {
        Ok(IpcStream::Unix(
            tokio::net::UnixStream::connect(path).await?,
        ))
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        Ok(IpcStream::Pipe(
            ClientOptions::new().open(path.as_os_str())?,
        ))
    }
}

/// IPC client. Holds the writer half of the multiplex stream + the
/// in-flight Channel map. Reader runs on a background task.
pub struct IpcClient {
    writer: Mutex<tokio::io::WriteHalf<IpcStream>>,
    next_id: AtomicU64,
    in_flight: Arc<DashMap<u64, CallSink>>,
    /// Cleared once the reader loop sees EOF/error or a write fails — the
    /// connection is dead and `IpcClientHandle` should reconnect.
    alive: Arc<AtomicBool>,
    /// Drop-guard: when this is dropped, the reader task notices and exits.
    _reader_task: tokio::task::JoinHandle<()>,
}

impl IpcClient {
    /// Connect to the IPC server at `socket_path` and spawn the reader
    /// task. Returns once the stream is open; protocol errors mid-call
    /// are surfaced via the per-call Channel as ERROR events.
    pub async fn connect(socket_path: &Path) -> std::io::Result<Arc<Self>> {
        let stream = connect_stream(socket_path).await?;
        let (read_half, write_half) = tokio::io::split(stream);
        let in_flight: Arc<DashMap<u64, CallSink>> = Arc::new(DashMap::new());
        let alive = Arc::new(AtomicBool::new(true));
        let reader_task = tokio::spawn(reader_loop(read_half, in_flight.clone(), alive.clone()));
        Ok(Arc::new(Self {
            writer: Mutex::new(write_half),
            next_id: AtomicU64::new(1),
            in_flight,
            alive,
            _reader_task: reader_task,
        }))
    }

    /// False once the reader loop has seen EOF/error or a write has failed.
    /// The owning `IpcClientHandle` reconnects on the next call.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Send a REQUEST and register the Channel for the response stream.
    /// Returns the call id; pass it to `cancel` to abort mid-stream.
    pub async fn invoke(
        &self,
        tool_name: String,
        input: serde_json::Value,
        channel: Channel<EndpointEvent>,
    ) -> Result<u64, String> {
        // Allocate the request id, register the sink, and write the frame all
        // while HOLDING the writer lock, so REQUEST ids reach the server in
        // strictly-increasing WIRE order.
        //
        // WHY (the "Operator connection lost" race): the IPC server enforces a
        // hard monotonic-id invariant and DESTROYS the entire connection on any
        // out-of-order REQUEST id (`non-monotonic REQUEST id=N (last=N+1);
        // closing` — libs/generic/ipc-endpoint-server/src/server.ts). With
        // `next_id.fetch_add` OUTSIDE the writer lock, two concurrent `invoke`s
        // on different runtime worker threads race between allocation and the
        // write: task A allocates id=743, task B allocates id=744, then B wins
        // the `writer.lock()` race and writes 744 BEFORE A writes 743 — the
        // server sees 744 then 743, tears down the socket, and the desktop's
        // live-data channel drops (surfacing, after the OfflineIndicator grace,
        // as the "actions will not save" banner). The off-by-exactly-one ids in
        // the logs are the fingerprint of exactly this two-invoke swap.
        // Allocating the id UNDER the writer lock makes wire order == id order,
        // closing the race. (`cancel` also takes this lock, so CANCEL frames stay
        // ordered against REQUESTs too.)
        let mut w = self.writer.lock().await;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = serde_json::json!({
            "id": id,
            "toolName": tool_name,
            "input": input,
        });
        // Build the frame BEFORE registering the sink so a (near-impossible)
        // serialize/encode error can't leave an orphaned CallSink behind (the
        // consumed id is harmless — the server only requires ids to INCREASE,
        // gaps are fine).
        let bytes = serde_json::to_vec(&req).map_err(|e| e.to_string())?;
        let frame = encode_frame(FrameType::Request, &bytes).map_err(|e| e.to_string())?;
        // Register the sink before the write so the reader loop can route the
        // first response frame (we still hold the writer lock, so no response
        // can arrive until after this write completes anyway).
        self.in_flight.insert(
            id,
            CallSink {
                channel,
                events_sent: AtomicU64::new(0),
                overflowed: std::sync::atomic::AtomicBool::new(false),
                last_activity_ms: AtomicU64::new(now_ms()),
                idle_timeout_ms: AtomicU64::new(IPC_CALL_IDLE_TIMEOUT_MS),
            },
        );
        if let Err(e) = w.write_all(&frame).await {
            // Socket gone (e.g. operator restarted) — drop the just-registered
            // sink and mark dead so the next call reconnects instead of writing
            // to a broken pipe forever.
            self.in_flight.remove(&id);
            self.alive.store(false, Ordering::Relaxed);
            return Err(e.to_string());
        }
        // Release the writer lock now — the idle-timeout watchdog below needs no
        // socket access, and holding it there would needlessly serialize every
        // other invoke/cancel behind this call's watchdog setup.
        drop(w);
        // WI-2817: arm the idle-timeout watchdog for this call. The reader
        // loop's EOF/error path already handles a connection that visibly
        // DIES; this backstop catches the other case — a connection that
        // stays open but whose peer never responds (most commonly an
        // operator/bg-host restart landing between "accepted the socket" and
        // "actually servicing requests"). If this exact call is still
        // unresolved after IPC_CALL_IDLE_TIMEOUT_MS of total silence, force
        // it to the SAME terminal `connection_lost` the reader loop emits on
        // a real EOF — reusing the existing, already-tested client retry
        // path rather than inventing a new one — and mark the connection
        // dead so the NEXT call reconnects instead of piling onto the same
        // wedged socket.
        {
            let in_flight = self.in_flight.clone();
            let alive = self.alive.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        IPC_WATCHDOG_CHECK_INTERVAL_MS,
                    ))
                    .await;
                    let (last_activity, timeout_ms) = match in_flight.get(&id) {
                        Some(sink) => (
                            sink.last_activity_ms.load(Ordering::Relaxed),
                            sink.idle_timeout_ms.load(Ordering::Relaxed),
                        ),
                        // Already resolved (Done/Error removed it) — nothing to watch.
                        None => return,
                    };
                    if !is_idle_timed_out(last_activity, now_ms(), timeout_ms) {
                        continue;
                    }
                    // Still present AND stale — force-fail it. A concurrent
                    // Done/Error racing this remove is fine: DashMap's
                    // `remove` only fires if the key is STILL present, so at
                    // most one of {reader_loop, this watchdog} wins the race
                    // for a given id.
                    if let Some((_, sink)) = in_flight.remove(&id) {
                        sink.send_terminal(EndpointEvent::Error {
                            code: "connection_lost".to_string(),
                            message: format!(
                                "endpoint-ipc call {id} got no response or activity for over {}s — treating the connection as wedged",
                                timeout_ms / 1000
                            ),
                        });
                    }
                    alive.store(false, Ordering::Relaxed);
                    return;
                }
            });
        }
        Ok(id)
    }

    /// Drop every in-flight call registration and return the ids.
    ///
    /// Used on webview page (re)load: the JS context that owned the
    /// Channels is gone, so every further `Channel::send` would eval
    /// `runCallback` against a callback id the new page doesn't have —
    /// the endless "[TAURI] Couldn't find callback id" console flood.
    /// CANCELs for the returned ids must be sent separately (async) so
    /// the server stops streaming work nobody can receive.
    pub fn detach_all(&self) -> Vec<u64> {
        drain_in_flight(&self.in_flight)
    }

    /// Send a CANCEL for an in-flight call. The server aborts the
    /// per-call AbortController and emits a terminal ERROR. Idempotent
    /// — extra CANCELs for an already-terminated id are ignored.
    pub async fn cancel(&self, id: u64) -> Result<(), String> {
        let cancel = serde_json::json!({ "id": id });
        let bytes = serde_json::to_vec(&cancel).map_err(|e| e.to_string())?;
        let frame = encode_frame(FrameType::Cancel, &bytes).map_err(|e| e.to_string())?;
        let mut w = self.writer.lock().await;
        w.write_all(&frame).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Remove every entry from the in-flight map, returning the call ids.
/// Extracted from `IpcClient::detach_all` so it can be tested without a
/// connected socket.
fn drain_in_flight(in_flight: &DashMap<u64, CallSink>) -> Vec<u64> {
    let ids: Vec<u64> = in_flight.iter().map(|e| *e.key()).collect();
    for id in &ids {
        in_flight.remove(id);
    }
    ids
}

/// Pump bytes off the read half, decode frames, dispatch to Channels.
async fn reader_loop(
    mut reader: tokio::io::ReadHalf<IpcStream>,
    in_flight: Arc<DashMap<u64, CallSink>>,
    alive: Arc<AtomicBool>,
) {
    let mut dec = FrameDecoder::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => break, // EOF — sidecar closed
            Ok(n) => n,
            Err(_) => break,
        };
        if let Err(e) = dec.push(&buf[..n]) {
            eprintln!("[endpoint_ipc] frame decode error: {e}; closing");
            break;
        }
        for frame in dec.drain() {
            match frame.frame_type {
                FrameType::EventJson => {
                    if let Ok(env) = serde_json::from_slice::<EventJsonEnvelope>(&frame.payload) {
                        if let Some(sink) = in_flight.get(&env.id) {
                            sink.try_send_event(EndpointEvent::Event {
                                name: env.name,
                                data: env.data,
                            });
                        }
                    }
                }
                FrameType::EventBin => {
                    match decode_event_bin_routing_id(&frame.payload) {
                        Ok(id) => {
                            if let Some(sink) = in_flight.get(&id) {
                                // Move the original EVENT_BIN payload into Tauri's Raw
                                // response. No base64 and no second multi-MB copy just to
                                // re-frame bytes the Node server already framed for us.
                                sink.try_send_event(EndpointEvent::Binary {
                                    payload: frame.payload,
                                });
                            }
                        }
                        Err(e) => eprintln!("[endpoint_ipc] EVENT_BIN decode error: {e}"),
                    }
                }
                FrameType::Done => {
                    if let Ok(env) = serde_json::from_slice::<DoneEnvelope>(&frame.payload) {
                        if let Some((_, sink)) = in_flight.remove(&env.id) {
                            sink.send_terminal(EndpointEvent::Done { result: env.result });
                        }
                    }
                }
                FrameType::Error => {
                    if let Ok(env) = serde_json::from_slice::<ErrorEnvelope>(&frame.payload) {
                        if let Some((_, sink)) = in_flight.remove(&env.id) {
                            sink.send_terminal(EndpointEvent::Error {
                                code: env.error.code,
                                message: env.error.message,
                            });
                        }
                    }
                }
                FrameType::Request | FrameType::Cancel => {
                    // Server should never send these to the client.
                    eprintln!(
                        "[endpoint_ipc] unexpected server frame type 0x{:02x}",
                        frame.frame_type as u8
                    );
                }
            }
        }
    }

    // EOF / error — mark dead so the handle reconnects, then notify every
    // in-flight Channel.
    alive.store(false, Ordering::Relaxed);
    for entry in in_flight.iter() {
        entry.send_terminal(EndpointEvent::Error {
            code: "connection_lost".to_string(),
            message: "endpoint-ipc Node sidecar connection closed".to_string(),
        });
    }
    in_flight.clear();
}

/// Where the operator's IPC endpoint lives — **and, when it can't be found,
/// why**.
///
/// Why this is a struct and not `Option<PathBuf>`: the resolver is the only
/// code that knows the difference between "the operator hasn't advertised
/// itself yet", "it advertised a pid that is gone", and "it advertised a
/// socket file that has since been deleted". Collapsing all three to `None`
/// discarded that at the exact moment it mattered, and left a stuck IPC
/// bridge with no signal but a single misleading startup line
/// (`no socket after 60s — /api on HTTP until operator is up`, which in fact
/// gates nothing). WI-6512 burned hours re-deriving by hand, from the
/// filesystem, a reason the resolver had already computed and thrown away.
///
/// `detail` is a short human phrase, safe to log and to surface through
/// `endpoint_ipc_status`. It must never contain secrets — it names discovery
/// file paths, pids and socket paths only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SocketResolution {
    pub path: Option<PathBuf>,
    pub detail: String,
    /// TRUE only when the operator owning this socket is PROVABLY the same
    /// operator that served the webview's document (its content origin).
    ///
    /// This exists to retire an undeclared HTTP carve-out, not as a diagnostic.
    /// `desktop-bootstrap.ts` excluded the whole `/api/desktop/*` prefix from the
    /// IPC reroute — permanently, on every platform — because those endpoints
    /// describe *the operator serving this webview*, and on a dev box the IPC
    /// bridge may target a DIFFERENT operator, where they would 404 and silently
    /// hide the env-switcher bar. The concern is real; the blunt fix violated
    /// D-005 (`no-http-anywhere-2026-07-28`), which admits exactly ONE HTTP
    /// exception (WSL2) and requires it be declared rather than inferred.
    ///
    /// MEASURED 2026-07-28 (D-008): that carve-out is the entire reason webview
    /// HTTP egress is nonzero — 9 escapes/minute, recurring on the 30 s poll tick
    /// long after the polyfill installs, so it was never the startup race P-011
    /// blamed.
    ///
    /// The resolver ALREADY knows the answer and was throwing it away: a per-port
    /// advertisement (`endpoint-ipc.<port>.json`) is published BY the operator on
    /// that port, so resolving through it proves owner == content origin. Only the
    /// legacy last-writer-wins singleton fallback can dial a foreign operator.
    ///
    /// Defaults to `false` at every constructor, and is opted into explicitly via
    /// [`SocketResolution::from_content_origin`], because the two error directions
    /// are NOT symmetric: a false negative costs one native HTTP request (today's
    /// behaviour), while a false positive routes a content-origin-scoped call to
    /// the wrong operator and reintroduces the silent 404 this carve-out was added
    /// to prevent. Never derive it from `detail` — parsing that prose is precisely
    /// the infer-from-a-string class D-005 retires.
    pub owner_is_content_origin: bool,
}

impl SocketResolution {
    pub fn found(path: impl Into<PathBuf>, detail: impl Into<String>) -> Self {
        Self {
            path: Some(path.into()),
            detail: detail.into(),
            owner_is_content_origin: false,
        }
    }

    pub fn missing(detail: impl Into<String>) -> Self {
        Self {
            path: None,
            detail: detail.into(),
            owner_is_content_origin: false,
        }
    }

    /// Mark this resolution as belonging to the webview's own content origin.
    ///
    /// Only two call sites may use it, and both are structural rather than
    /// heuristic: the per-port dev advertisement, and the production sidecar
    /// (which IS the operator serving the webview, including its packaged
    /// Windows-via-WSL WSL-native discovery read). The singleton fallback must
    /// NOT use it because that legacy file can name a foreign operator.
    #[must_use]
    pub fn from_content_origin(mut self) -> Self {
        self.owner_is_content_origin = true;
        self
    }
}

/// Monotonic counters + last-seen strings describing the dial history of one
/// `IpcClientHandle`. Read by `endpoint_ipc_status` without taking the
/// connection lock, so it stays answerable even while a dial is in flight.
#[derive(Default)]
struct DialStats {
    /// `live()` calls that had to (re)dial — i.e. no live client to reuse.
    attempts: AtomicU64,
    /// `live()` calls satisfied by the existing connection.
    reuses: AtomicU64,
    /// Dials abandoned because the resolver had no path to offer.
    resolve_misses: AtomicU64,
    /// Dials that had a path but failed to connect to it.
    connect_errors: AtomicU64,
    /// Dials that produced a live connection.
    connects: AtomicU64,
    /// `endpoint_invoke` calls that reached this handle.
    invokes: AtomicU64,
    last_attempt_ms: AtomicU64,
    last_connect_ms: AtomicU64,
}

/// A snapshot of IPC bridge health, as returned by `endpoint_ipc_status`.
///
/// This is the answer to "is /api actually riding IPC right now, and if not
/// what precisely is stopping it" — a question that previously could only be
/// answered by correlating `ss`, the discovery JSON files, and process
/// liveness by hand.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IpcStatus {
    /// Live re-resolution performed at status time (a pure filesystem read).
    pub resolved_path: Option<String>,
    pub resolution_detail: String,
    /// `connected` · `dead` · `never-connected` · `dial-in-flight` · `disabled`.
    ///
    /// `dial-in-flight` means the connection lock was held when we looked.
    /// Seeing it persist across repeated calls is itself the diagnosis: a
    /// dial is hung, and every `/api` call is queued behind it.
    pub client: &'static str,
    pub attempts: u64,
    pub reuses: u64,
    pub resolve_misses: u64,
    pub connect_errors: u64,
    pub connects: u64,
    pub invokes: u64,
    pub ms_since_last_attempt: Option<u64>,
    pub ms_since_last_connect: Option<u64>,
    pub last_error: Option<String>,
    pub connected_path: Option<String>,
    /// Whether the operator owning the IPC socket is provably the one that served
    /// this webview — see [`SocketResolution::owner_is_content_origin`]. The
    /// webview reads this to decide whether content-origin-scoped paths
    /// (`/api/desktop/*`) may ride IPC, instead of excluding them unconditionally.
    pub owner_is_content_origin: bool,
}

/// Reconnecting wrapper around `IpcClient` — the managed Tauri state.
///
/// `endpoint_invoke` / `endpoint_cancel` go through this so a dropped
/// connection (most commonly the DEV operator being restarted, which
/// changes its socket path) is transparently re-established on the next
/// call, instead of wedging every `/api` fetch onto the hanging HTTP
/// fallback (libsoup's 6-socket pool — the "loading… forever" / "few
/// seconds" bug). The socket path is resolved lazily via `socket_source`
/// on each (re)connect:
///   - prod: a fixed path from the sidecar's `PAPERCUSP_IPC_READY` handshake.
///   - dev:  re-reads `~/.papercusp/endpoint-ipc.json`, so a restarted
///           operator's NEW socket is picked up automatically.
///
/// There is NO time gate on this path: a dial is attempted on every call that
/// has no live connection to reuse, and a unix-socket connect is sub-millisecond.
/// The only thing anyone waits for is the operator itself becoming reachable.
///
/// A failed (re)connect returns an `invoke_failed:`-prefixed error so the
/// webview's `ipc-fetch.ts` treats IPC as unavailable and falls back to
/// HTTP, exactly as before IPC was wired. The prefix is load-bearing —
/// `isIpcUnavailableMessage` in `libs/generic/desktop-ipc` matches on it.
pub struct IpcClientHandle {
    client: Mutex<Option<Arc<IpcClient>>>,
    socket_source: Box<dyn Fn() -> SocketResolution + Send + Sync>,
    /// `Some` when IPC is switched OFF for this session. Every call then fails
    /// with an `ipc_disabled:`-prefixed error, which the webview treats as
    /// "use HTTP" rather than "wait" — see `IpcClientHandle::disabled`.
    disabled_reason: Option<String>,
    stats: DialStats,
    /// Last failure reason, and the path of the current connection. Plain
    /// `std::sync` mutexes: held only for the duration of a string swap,
    /// never across an `.await`.
    last_error: std::sync::Mutex<Option<String>>,
    connected_path: std::sync::Mutex<Option<String>>,
    /// The last line we logged, so a retry loop dialing every 500ms reports a
    /// CHANGE in state rather than printing the same failure 120 times.
    last_logged: std::sync::Mutex<Option<String>>,
}

impl IpcClientHandle {
    pub fn new(socket_source: impl Fn() -> SocketResolution + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            client: Mutex::new(None),
            socket_source: Box::new(socket_source),
            disabled_reason: None,
            stats: DialStats::default(),
            last_error: std::sync::Mutex::new(None),
            connected_path: std::sync::Mutex::new(None),
            last_logged: std::sync::Mutex::new(None),
        })
    }

    /// A handle that will never dial, because the operator turned IPC off
    /// (`PAPERCUSP_DESKTOP_IPC=0`).
    ///
    /// Registering this is deliberate, and better than the obvious alternative
    /// of simply not `.manage()`-ing anything. An unmanaged state makes every
    /// invoke fail with Tauri's generic "state not managed", which is
    /// **indistinguishable from the prod startup window** where the handle is
    /// not registered *yet*. The webview needs to tell those apart: it should
    /// WAIT through the startup window (falling back there strands a
    /// long-lived stream on one of ~6 HTTP sockets for the session — WI-6257),
    /// but it must FALL BACK when IPC is switched off, or this kill switch
    /// would hang the app instead of rolling it back. So say which one it is.
    pub fn disabled(reason: impl Into<String>) -> Arc<Self> {
        let reason = reason.into();
        Arc::new(Self {
            client: Mutex::new(None),
            socket_source: Box::new(|| {
                SocketResolution::missing("endpoint-ipc is disabled for this session")
            }),
            disabled_reason: Some(reason),
            stats: DialStats::default(),
            last_error: std::sync::Mutex::new(None),
            connected_path: std::sync::Mutex::new(None),
            last_logged: std::sync::Mutex::new(None),
        })
    }

    /// Print `msg` only if it differs from the previous transition we printed.
    /// The startup warm loop and ~10 concurrent SSE consumers all drive
    /// `live()`, so an unconditional log makes the real transition unfindable.
    fn log_transition(&self, msg: String) {
        let mut last = match self.last_logged.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if last.as_deref() == Some(msg.as_str()) {
            return;
        }
        println!("[endpoint_ipc] {msg}");
        *last = Some(msg);
    }

    fn set_last_error(&self, err: Option<String>) {
        if let Ok(mut g) = self.last_error.lock() {
            *g = err;
        }
    }

    /// Resolve the endpoint fresh, without dialing. Used by the status command
    /// so an operator can see what the resolver sees, right now.
    pub fn resolve_now(&self) -> SocketResolution {
        (self.socket_source)()
    }

    /// Health snapshot. Deliberately takes NO `.await` and never blocks on the
    /// connection lock — a hung dial must not make the diagnostic that would
    /// reveal it hang too.
    pub fn status(&self) -> IpcStatus {
        let resolution = self.resolve_now();
        let client = if self.disabled_reason.is_some() {
            "disabled"
        } else {
            match self.client.try_lock() {
                Ok(guard) => match guard.as_ref() {
                    Some(c) if c.is_alive() => "connected",
                    Some(_) => "dead",
                    None => "never-connected",
                },
                Err(_) => "dial-in-flight",
            }
        };
        let now = now_ms();
        let since = |v: u64| {
            if v == 0 {
                None
            } else {
                Some(now.saturating_sub(v))
            }
        };
        IpcStatus {
            resolved_path: resolution.path.as_ref().map(|p| p.display().to_string()),
            resolution_detail: resolution.detail,
            client,
            attempts: self.stats.attempts.load(Ordering::Relaxed),
            reuses: self.stats.reuses.load(Ordering::Relaxed),
            resolve_misses: self.stats.resolve_misses.load(Ordering::Relaxed),
            connect_errors: self.stats.connect_errors.load(Ordering::Relaxed),
            connects: self.stats.connects.load(Ordering::Relaxed),
            invokes: self.stats.invokes.load(Ordering::Relaxed),
            ms_since_last_attempt: since(self.stats.last_attempt_ms.load(Ordering::Relaxed)),
            ms_since_last_connect: since(self.stats.last_connect_ms.load(Ordering::Relaxed)),
            last_error: self.last_error.lock().ok().and_then(|g| g.clone()),
            connected_path: self.connected_path.lock().ok().and_then(|g| g.clone()),
            owner_is_content_origin: resolution.owner_is_content_origin,
        }
    }

    /// Return a live client, reconnecting if the current one is dead/absent.
    async fn live(&self) -> Result<Arc<IpcClient>, String> {
        if let Some(reason) = &self.disabled_reason {
            return Err(format!("ipc_disabled: {reason}"));
        }
        let mut guard = self.client.lock().await;
        if let Some(c) = guard.as_ref() {
            if c.is_alive() {
                self.stats.reuses.fetch_add(1, Ordering::Relaxed);
                return Ok(c.clone());
            }
        }
        self.stats.attempts.fetch_add(1, Ordering::Relaxed);
        self.stats
            .last_attempt_ms
            .store(now_ms(), Ordering::Relaxed);

        let resolution = (self.socket_source)();
        let Some(path) = resolution.path else {
            self.stats.resolve_misses.fetch_add(1, Ordering::Relaxed);
            let msg = format!(
                "invoke_failed: no endpoint-ipc socket available — {}",
                resolution.detail
            );
            self.set_last_error(Some(msg.clone()));
            self.log_transition(format!("not dialing: {}", resolution.detail));
            return Err(msg);
        };

        match IpcClient::connect(&path).await {
            Ok(c) => {
                self.stats.connects.fetch_add(1, Ordering::Relaxed);
                self.stats
                    .last_connect_ms
                    .store(now_ms(), Ordering::Relaxed);
                self.set_last_error(None);
                if let Ok(mut g) = self.connected_path.lock() {
                    *g = Some(path.display().to_string());
                }
                self.log_transition(format!(
                    "connected to {} ({})",
                    path.display(),
                    resolution.detail
                ));
                *guard = Some(c.clone());
                Ok(c)
            }
            Err(e) => {
                self.stats.connect_errors.fetch_add(1, Ordering::Relaxed);
                let msg = format!("invoke_failed: endpoint-ipc connect: {e}");
                self.set_last_error(Some(msg.clone()));
                self.log_transition(format!(
                    "dial FAILED for {} ({}): {e}",
                    path.display(),
                    resolution.detail
                ));
                Err(msg)
            }
        }
    }

    /// Eagerly (re)connect — used to warm the connection at startup.
    pub async fn warm(&self) -> Result<(), String> {
        self.live().await.map(|_| ())
    }

    /// Keep a live IPC connection at all times, for the life of the process.
    ///
    /// Replaces a bounded "try 120 times over 60s then give up" warm-up whose
    /// give-up line (`no socket after 60s — /api on HTTP until operator is up`)
    /// described a fallback that does not exist: expiry gated nothing, and the
    /// real wait was never the transport — it was the operator sidecar booting
    /// (embedded PG + migrations), which routinely takes longer than 60s. So
    /// the loop stopped warming precisely when the operator was about to
    /// appear, leaving the first connection to whatever `/api` call happened
    /// next.
    ///
    /// Now: dial fast until connected (the operator may appear at any second),
    /// then supervise — a dropped connection is re-established immediately
    /// rather than at the next webview call.
    pub async fn keep_warm(self: Arc<Self>, fast_probe: std::time::Duration) {
        let started = std::time::Instant::now();
        let mut announced_slow = false;
        loop {
            match self.warm().await {
                Ok(()) => {
                    // Connected (or still connected). Supervise cheaply: this
                    // is a lock + an atomic read when nothing is wrong.
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
                Err(_) => {
                    let waited = started.elapsed();
                    if !announced_slow && waited >= std::time::Duration::from_secs(60) {
                        announced_slow = true;
                        let s = self.status();
                        println!(
                            "[endpoint_ipc] still no IPC after {}s — /api is on the capped HTTP \
                             fallback until this clears. This is the OPERATOR not being reachable \
                             yet, not a transport timeout: there is no time gate on the dial. \
                             Resolver says: {}",
                            waited.as_secs(),
                            s.resolution_detail
                        );
                    }
                    tokio::time::sleep(fast_probe).await;
                }
            }
        }
    }

    /// Drop the current connection so the NEXT call re-resolves the socket
    /// via `socket_source` and dials fresh. EI-190: the dev wrapper calls
    /// this when the build switcher changes the selected /api operator — the
    /// OLD operator's socket is usually still healthy, so the `is_alive()`
    /// reconnect path would never fire on its own. In-flight calls are
    /// flushed first, exactly like a page (re)load (the build switch
    /// navigates the webview, so the old page's channels are dead anyway).
    pub fn reset(self: &Arc<Self>) {
        self.flush_for_page_load();
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut guard = this.client.lock().await;
            *guard = None;
        });
    }

    pub async fn invoke(
        &self,
        tool_name: String,
        input: serde_json::Value,
        channel: Channel<EndpointEvent>,
    ) -> Result<u64, String> {
        self.stats.invokes.fetch_add(1, Ordering::Relaxed);
        self.live().await?.invoke(tool_name, input, channel).await
    }

    pub async fn cancel(&self, id: u64) -> Result<(), String> {
        // Only the currently-connected client owns its ids; a cancel after a
        // reconnect targets a call that's already gone, so a missing/replaced
        // client is a no-op success.
        let guard = self.client.lock().await;
        match guard.as_ref() {
            Some(c) => c.cancel(id).await,
            None => Ok(()),
        }
    }

    /// Flush every in-flight call because the webview is (re)loading.
    ///
    /// The old page's JS context owned all the Channels; after a reload the
    /// reader loop would keep fanning server stream frames (sync SSE, log
    /// tails, heartbeats, …) into dead callbacks forever — each send evals
    /// `runCallback(<stale id>)` and floods the console with
    /// "[TAURI] Couldn't find callback id". Detach synchronously (so the new
    /// page's first invoke can't be swept up), then CANCEL server-side in the
    /// background so the operator stops streaming work nobody receives.
    pub fn flush_for_page_load(&self) {
        let client = match self.client.try_lock() {
            Ok(guard) => guard.as_ref().cloned(),
            // The lock is only held across (re)connects and brief
            // invoke/cancel forwarding; a client mid-(re)connect is brand
            // new and owns no stale calls. Skipping is safe either way —
            // worst case the flood resumes until the next reload.
            Err(_) => None,
        };
        let Some(c) = client else { return };
        let ids = c.detach_all();
        if ids.is_empty() {
            return;
        }
        println!(
            "[endpoint_ipc] webview (re)load — cancelled {} stale in-flight call(s)",
            ids.len()
        );
        tauri::async_runtime::spawn(async move {
            for id in ids {
                let _ = c.cancel(id).await;
            }
        });
    }
}

/// Tauri command — invoked from the webview. The wire shape mirrors
/// what `apps/operator/lib/transport-adapters/ipc-stream.ts` sends.
#[tauri::command]
#[specta::specta]
pub async fn endpoint_invoke(
    state: tauri::State<'_, Arc<IpcClientHandle>>,
    tool_name: String,
    input: serde_json::Value,
    channel: Channel<EndpointEvent>,
) -> Result<u64, String> {
    state.invoke(tool_name, input, channel).await
}

/// Tauri command — cancel an in-flight call.
#[tauri::command]
#[specta::specta]
pub async fn endpoint_cancel(
    state: tauri::State<'_, Arc<IpcClientHandle>>,
    call_id: u64,
) -> Result<(), String> {
    state.cancel(call_id).await
}

/// Tauri command — IPC bridge health, for humans and agents.
///
/// The observability hole this fills (WI-6512): when `/api` silently stayed on
/// the capped HTTP transport there was no way to ask the app *why*. The only
/// signal was a startup line that named the wrong cause, so the actual state —
/// which discovery file was consulted, whether the pid it named was alive,
/// whether a dial had even been attempted — had to be reconstructed by hand
/// from `ss`, `/proc` and the JSON files, per investigation.
///
/// Cheap and side-effect-free (one small filesystem read); safe to poll.
#[tauri::command]
#[specta::specta]
pub async fn endpoint_ipc_status(
    state: tauri::State<'_, Arc<IpcClientHandle>>,
) -> Result<IpcStatus, String> {
    Ok(state.status())
}

/// Wait for the sidecar to print `PAPERCUSP_IPC_READY socket=<path>` on
/// stdout and return the resolved path. Use this in main.rs after
/// spawning the sidecar with piped stdout (separately — main.rs is on
/// std::process today; the switch to piped output is its own commit).
pub fn parse_ipc_ready_line(line: &str) -> Option<&str> {
    line.strip_prefix("PAPERCUSP_IPC_READY socket=")
        .map(|s| s.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn backpressure_forwards_under_cap() {
        let sent = AtomicU64::new(0);
        let overflowed = AtomicBool::new(false);
        for _ in 0..10 {
            assert_eq!(
                decide_backpressure(&sent, &overflowed, 10_000),
                BackpressureDecision::Forward,
            );
        }
        assert_eq!(sent.load(Ordering::Relaxed), 10);
        assert!(!overflowed.load(Ordering::Relaxed));
    }

    #[test]
    fn backpressure_emits_overflow_exactly_once_at_cap() {
        let sent = AtomicU64::new(9_999);
        let overflowed = AtomicBool::new(false);
        // 10_000th send is the last allowed; 10_001th trips the cap.
        assert_eq!(
            decide_backpressure(&sent, &overflowed, 10_000),
            BackpressureDecision::Forward,
        );
        assert_eq!(
            decide_backpressure(&sent, &overflowed, 10_000),
            BackpressureDecision::EmitOverflowAndStop,
        );
        assert!(overflowed.load(Ordering::Relaxed));
        // Subsequent sends drop silently.
        for _ in 0..5 {
            assert_eq!(
                decide_backpressure(&sent, &overflowed, 10_000),
                BackpressureDecision::Drop,
            );
        }
    }

    #[test]
    fn backpressure_pre_overflowed_state_drops_immediately() {
        let sent = AtomicU64::new(50_000);
        let overflowed = AtomicBool::new(true);
        for _ in 0..3 {
            assert_eq!(
                decide_backpressure(&sent, &overflowed, 10_000),
                BackpressureDecision::Drop,
            );
        }
    }

    // WI-2817: the idle-timeout watchdog's pure staleness decision.
    #[test]
    fn idle_timeout_not_yet_stale_under_the_threshold() {
        assert!(!is_idle_timed_out(1_000, 1_000 + 19_999, 20_000));
    }

    #[test]
    fn idle_timeout_stale_exactly_at_the_threshold() {
        // >= is intentional: a call that has had ZERO activity for exactly
        // the timeout is treated as wedged, not given one more grace tick.
        assert!(is_idle_timed_out(1_000, 1_000 + 20_000, 20_000));
    }

    #[test]
    fn idle_timeout_stale_well_past_the_threshold() {
        assert!(is_idle_timed_out(1_000, 1_000 + 60_000, 20_000));
    }

    #[test]
    fn idle_timeout_saturates_instead_of_panicking_on_a_clock_oddity() {
        // now < last_activity (a clock adjustment, or a racy read) must never
        // underflow/panic — saturating_sub floors at 0, which is never >= a
        // positive timeout.
        assert!(!is_idle_timed_out(50_000, 1_000, 20_000));
    }

    #[test]
    fn sse_head_detection_ignores_header_case_and_mime_parameters() {
        assert!(is_sse_response_head(&serde_json::json!({
            "status": 200,
            "headers": { "Content-Type": "TEXT/EVENT-STREAM; charset=utf-8" }
        })));
        assert!(!is_sse_response_head(&serde_json::json!({
            "status": 200,
            "headers": { "content-type": "application/json" }
        })));
        assert!(!is_sse_response_head(&serde_json::json!({
            "status": 200,
            "headers": {}
        })));
    }

    #[test]
    fn stream_idle_timeout_allows_two_heartbeat_intervals() {
        assert!(IPC_STREAM_IDLE_TIMEOUT_MS >= IPC_STREAM_HEARTBEAT_INTERVAL_MS * 2);
        assert!(IPC_STREAM_IDLE_TIMEOUT_MS > IPC_CALL_IDLE_TIMEOUT_MS);
        assert!(!is_idle_timed_out(
            0,
            IPC_STREAM_IDLE_TIMEOUT_MS - 1,
            IPC_STREAM_IDLE_TIMEOUT_MS
        ));
        assert!(is_idle_timed_out(
            0,
            IPC_STREAM_IDLE_TIMEOUT_MS,
            IPC_STREAM_IDLE_TIMEOUT_MS
        ));
    }

    #[test]
    fn drain_in_flight_empties_map_and_returns_ids() {
        let map: DashMap<u64, CallSink> = DashMap::new();
        for id in [3u64, 7, 11] {
            map.insert(
                id,
                CallSink {
                    channel: Channel::new(|_| Ok(())),
                    events_sent: AtomicU64::new(0),
                    overflowed: AtomicBool::new(false),
                    last_activity_ms: AtomicU64::new(now_ms()),
                    idle_timeout_ms: AtomicU64::new(IPC_CALL_IDLE_TIMEOUT_MS),
                },
            );
        }
        let mut ids = drain_in_flight(&map);
        ids.sort_unstable();
        assert_eq!(ids, vec![3, 7, 11]);
        assert!(map.is_empty());
        // Idempotent on an empty map.
        assert!(drain_in_flight(&map).is_empty());
    }

    #[test]
    fn per_call_cap_constant_matches_plan() {
        // Plan said 10_000 per-call. Don't let a refactor silently
        // halve it without a deliberate decision.
        assert_eq!(PER_CALL_EVENT_CAP, 10_000);
    }

    #[test]
    fn parses_ready_line_with_unix_path() {
        let line = "PAPERCUSP_IPC_READY socket=/home/u/.papercusp/sockets/12345.sock\n";
        assert_eq!(
            parse_ipc_ready_line(line),
            Some("/home/u/.papercusp/sockets/12345.sock")
        );
    }

    #[test]
    fn parses_ready_line_with_windows_pipe() {
        let line = "PAPERCUSP_IPC_READY socket=\\\\.\\pipe\\papercusp-12345\n";
        assert_eq!(
            parse_ipc_ready_line(line),
            Some("\\\\.\\pipe\\papercusp-12345"),
        );
    }

    #[test]
    fn rejects_non_ready_lines() {
        assert_eq!(parse_ipc_ready_line("some other log\n"), None);
        assert_eq!(parse_ipc_ready_line(""), None);
        // The prefix match is exact — leading whitespace / partial prefixes
        // are NOT the handshake line.
        assert_eq!(parse_ipc_ready_line(" PAPERCUSP_IPC_READY socket=/x"), None);
        assert_eq!(parse_ipc_ready_line("PAPERCUSP_IPC_READY"), None);
    }

    #[test]
    fn ready_line_tolerates_crlf_and_no_newline() {
        assert_eq!(
            parse_ipc_ready_line("PAPERCUSP_IPC_READY socket=/tmp/a.sock\r\n"),
            Some("/tmp/a.sock")
        );
        assert_eq!(
            parse_ipc_ready_line("PAPERCUSP_IPC_READY socket=/tmp/a.sock"),
            Some("/tmp/a.sock")
        );
    }

    // ── EndpointEvent mixed JSON/raw wire shape ─────────────────────────────
    //
    // The webview hook (ipc-stream.ts) switches on `kind` and reads these
    // exact field names — a serde rename would silently break the frontend.

    #[test]
    fn endpoint_event_uses_json_for_controls_and_raw_for_binary() {
        let event = EndpointEvent::Event {
            name: "delta".into(),
            data: serde_json::json!({ "text": "hi" }),
        };
        let InvokeResponseBody::Json(event_json) = event.body().unwrap() else {
            panic!("control event must use JSON");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&event_json).unwrap(),
            serde_json::json!({
                "kind": "event", "name": "delta", "data": { "text": "hi" }
            })
        );

        let raw = crate::endpoint_ipc_framing::encode_event_bin_payload(7, "audio", &[1, 2, 3]);
        let InvokeResponseBody::Raw(binary) = EndpointEvent::Binary {
            payload: raw.clone(),
        }
        .body()
        .unwrap() else {
            panic!("binary event must use Tauri Raw");
        };
        assert_eq!(binary, raw);

        let done = EndpointEvent::Done {
            result: serde_json::json!({ "ok": true }),
        };
        let InvokeResponseBody::Json(done_json) = done.body().unwrap() else {
            panic!("done must use JSON");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&done_json).unwrap(),
            serde_json::json!({
                "kind": "done", "result": { "ok": true }
            })
        );

        let error = EndpointEvent::Error {
            code: "quota".into(),
            message: "over".into(),
        };
        let InvokeResponseBody::Json(error_json) = error.body().unwrap() else {
            panic!("error must use JSON");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&error_json).unwrap(),
            serde_json::json!({
                "kind": "error", "code": "quota", "message": "over"
            })
        );
    }

    #[test]
    fn endpoint_event_round_trips_through_serde() {
        let original = EndpointEvent::Error {
            code: "c".into(),
            message: "m".into(),
        };
        let InvokeResponseBody::Json(json) = original.body().unwrap() else {
            panic!("error must use JSON");
        };
        let back: EndpointEvent = serde_json::from_str(&json).unwrap();
        match back {
            EndpointEvent::Error { code, message } => {
                assert_eq!(code, "c");
                assert_eq!(message, "m");
            }
            other => panic!("round-trip changed variant: {other:?}"),
        }
    }

    // ── Server envelope parsing ─────────────────────────────────────────────

    #[test]
    fn event_json_envelope_parses_server_payload() {
        let env: EventJsonEnvelope =
            serde_json::from_slice(br#"{"id":7,"name":"delta","data":{"text":"hi"}}"#).unwrap();
        assert_eq!(env.id, 7);
        assert_eq!(env.name, "delta");
        assert_eq!(env.data, serde_json::json!({ "text": "hi" }));
    }

    #[test]
    fn done_and_error_envelopes_parse_server_payloads() {
        let done: DoneEnvelope =
            serde_json::from_slice(br#"{"id":3,"result":{"content":[]}}"#).unwrap();
        assert_eq!(done.id, 3);
        assert_eq!(done.result, serde_json::json!({ "content": [] }));

        let err: ErrorEnvelope =
            serde_json::from_slice(br#"{"id":9,"error":{"code":"role_gate","message":"denied"}}"#)
                .unwrap();
        assert_eq!(err.id, 9);
        assert_eq!(err.error.code, "role_gate");
        assert_eq!(err.error.message, "denied");
    }

    #[test]
    fn envelopes_reject_malformed_payloads() {
        // Missing id — the reader loop must skip these, never panic.
        assert!(
            serde_json::from_slice::<EventJsonEnvelope>(br#"{"name":"delta","data":1}"#).is_err()
        );
        // id of the wrong JSON type.
        assert!(serde_json::from_slice::<EventJsonEnvelope>(
            br#"{"id":"7","name":"delta","data":1}"#
        )
        .is_err());
        // Error envelope with a flat (non-nested) error shape.
        assert!(
            serde_json::from_slice::<ErrorEnvelope>(br#"{"id":1,"code":"x","message":"y"}"#)
                .is_err()
        );
        // Outright garbage.
        assert!(serde_json::from_slice::<DoneEnvelope>(b"not json").is_err());
        assert!(serde_json::from_slice::<DoneEnvelope>(b"").is_err());
    }

    // ── CallSink send paths (capturing Channel, no webview needed) ──────────

    /// A CallSink whose Channel captures every serialized body it forwards.
    fn capturing_sink() -> (CallSink, Arc<std::sync::Mutex<Vec<String>>>) {
        let captured: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(vec![]));
        let sink_captured = captured.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                sink_captured.lock().unwrap().push(s);
            }
            Ok(())
        });
        (
            CallSink {
                channel,
                events_sent: AtomicU64::new(0),
                overflowed: AtomicBool::new(false),
                last_activity_ms: AtomicU64::new(now_ms()),
                idle_timeout_ms: AtomicU64::new(IPC_CALL_IDLE_TIMEOUT_MS),
            },
            captured,
        )
    }

    #[test]
    fn call_sink_forwards_events_under_cap() {
        let (sink, captured) = capturing_sink();
        for i in 0..3 {
            assert!(sink.try_send_event(EndpointEvent::Event {
                name: format!("e{i}"),
                data: serde_json::Value::Null,
            }));
        }
        let bodies = captured.lock().unwrap();
        assert_eq!(bodies.len(), 3);
        assert!(bodies[0].contains("\"e0\""));
        assert!(bodies[2].contains("\"e2\""));
    }

    #[test]
    fn call_sink_forwards_binary_as_raw_without_base64() {
        let captured: Arc<std::sync::Mutex<Vec<InvokeResponseBody>>> =
            Arc::new(std::sync::Mutex::new(vec![]));
        let sink_captured = captured.clone();
        let sink = CallSink {
            channel: Channel::new(move |body| {
                sink_captured.lock().unwrap().push(body);
                Ok(())
            }),
            events_sent: AtomicU64::new(0),
            overflowed: AtomicBool::new(false),
            last_activity_ms: AtomicU64::new(now_ms()),
            idle_timeout_ms: AtomicU64::new(IPC_CALL_IDLE_TIMEOUT_MS),
        };
        let raw = crate::endpoint_ipc_framing::encode_event_bin_payload(
            42,
            "body",
            &[0xde, 0xad, 0xbe, 0xef],
        );

        assert!(sink.try_send_event(EndpointEvent::Binary {
            payload: raw.clone()
        }));
        let mut bodies = captured.lock().unwrap();
        assert_eq!(bodies.len(), 1);
        match bodies.pop().unwrap() {
            InvokeResponseBody::Raw(actual) => assert_eq!(actual, raw),
            InvokeResponseBody::Json(_) => panic!("binary event regressed to JSON/base64"),
        }
    }

    #[test]
    fn call_sink_promotes_only_sse_responses_to_stream_timeout() {
        let (sink, _captured) = capturing_sink();
        assert_eq!(
            sink.idle_timeout_ms.load(Ordering::Relaxed),
            IPC_CALL_IDLE_TIMEOUT_MS
        );

        sink.record_activity(&EndpointEvent::Event {
            name: "head".into(),
            data: serde_json::json!({
                "status": 200,
                "headers": { "content-type": "text/event-stream" }
            }),
        });
        assert_eq!(
            sink.idle_timeout_ms.load(Ordering::Relaxed),
            IPC_STREAM_IDLE_TIMEOUT_MS
        );

        let (request_sink, _captured) = capturing_sink();
        request_sink.record_activity(&EndpointEvent::Event {
            name: "head".into(),
            data: serde_json::json!({
                "status": 200,
                "headers": { "content-type": "application/json" }
            }),
        });
        assert_eq!(
            request_sink.idle_timeout_ms.load(Ordering::Relaxed),
            IPC_CALL_IDLE_TIMEOUT_MS
        );
    }

    #[test]
    fn call_sink_emits_one_overflow_error_then_drops_but_terminal_still_lands() {
        let (sink, captured) = capturing_sink();
        // Pre-position the counter one below the cap so the test doesn't
        // loop 10k sends: the next send is the last allowed one.
        sink.events_sent
            .store(PER_CALL_EVENT_CAP - 1, Ordering::Relaxed);

        let ev = || EndpointEvent::Event {
            name: "delta".into(),
            data: serde_json::Value::Null,
        };
        assert!(sink.try_send_event(ev()), "last under-cap event forwards");
        // Cap trip: returns false but emits exactly ONE backpressure error.
        assert!(!sink.try_send_event(ev()));
        // Everything after is dropped silently — no further bodies.
        assert!(!sink.try_send_event(ev()));
        assert!(!sink.try_send_event(ev()));

        {
            let bodies = captured.lock().unwrap();
            assert_eq!(
                bodies.len(),
                2,
                "one event + one overflow error, nothing more"
            );
            assert!(
                bodies[1].contains("backpressure_overflow"),
                "got: {}",
                bodies[1]
            );
        }

        // Terminal events bypass the cap — the consumer must learn the call ended.
        sink.send_terminal(EndpointEvent::Done {
            result: serde_json::Value::Null,
        });
        let bodies = captured.lock().unwrap();
        assert_eq!(bodies.len(), 3);
        assert!(bodies[2].contains("\"done\""));
    }

    /// End-to-end-ish: spin up a Node-server-equivalent on a Unix socket
    /// IN-PROCESS in Rust (no actual Node), have the client connect,
    /// invoke a "tool", and assert the events received. Validates that
    /// the framing is byte-identical to what the TS server emits.
    #[cfg(unix)]
    #[tokio::test]
    async fn end_to_end_against_synthetic_server() {
        use std::time::Duration;
        use tokio::net::UnixListener;

        // Keep the socket path short: unix sockets cap at SUN_LEN (~104
        // bytes on macOS), and darwin's temp_dir() is a long
        // /var/folders/... path — the old verbose name + full uuid blew
        // the cap and UnixListener::bind failed only on macOS. /tmp is
        // valid on every unix (a symlink to /private/tmp on darwin).
        let tmp = std::path::PathBuf::from(format!(
            "/tmp/pcipc-{}-{}.sock",
            std::process::id(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        let _ = std::fs::remove_file(&tmp);

        let listener = UnixListener::bind(&tmp).unwrap();
        let server_path = tmp.clone();

        // Synthetic server: accept one connection, read a REQUEST,
        // emit 2 EVENT_JSON + 1 DONE.
        let server_task = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let (mut r, mut w) = tokio::io::split(sock);
            let mut buf = [0u8; 4096];
            let n = r.read(&mut buf).await.unwrap();
            let mut dec = FrameDecoder::new();
            dec.push(&buf[..n]).unwrap();
            let req = dec.drain().pop().unwrap();
            assert_eq!(req.frame_type, FrameType::Request);
            let parsed: serde_json::Value = serde_json::from_slice(&req.payload).unwrap();
            let id = parsed["id"].as_u64().unwrap();

            let e1 = serde_json::to_vec(&serde_json::json!({
                "id": id, "name": "delta", "data": { "text": "hi" }
            }))
            .unwrap();
            let e2 = serde_json::to_vec(&serde_json::json!({
                "id": id, "name": "delta", "data": { "text": "there" }
            }))
            .unwrap();
            let done_payload = serde_json::to_vec(&serde_json::json!({
                "id": id, "result": { "content": [{ "type": "text", "text": "hi there" }] }
            }))
            .unwrap();

            w.write_all(&encode_frame(FrameType::EventJson, &e1).unwrap())
                .await
                .unwrap();
            w.write_all(&encode_frame(FrameType::EventJson, &e2).unwrap())
                .await
                .unwrap();
            w.write_all(&encode_frame(FrameType::Done, &done_payload).unwrap())
                .await
                .unwrap();
            // Hold the socket open briefly so the client has time to read.
            tokio::time::sleep(Duration::from_millis(50)).await;
        });

        // Wait for server to bind.
        tokio::time::sleep(Duration::from_millis(20)).await;

        // We can't easily use the real IpcClient::invoke here because it
        // requires a Tauri AppHandle to allocate a Channel<T>. So we test
        // the framing/reader-loop in isolation — invoke writes a REQUEST,
        // we read the wire bytes back.
        let mut stream = tokio::net::UnixStream::connect(&server_path).await.unwrap();
        let req = serde_json::to_vec(&serde_json::json!({
            "id": 1u64, "toolName": "synth", "input": {}
        }))
        .unwrap();
        stream
            .write_all(&encode_frame(FrameType::Request, &req).unwrap())
            .await
            .unwrap();

        let mut dec = FrameDecoder::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            dec.push(&buf[..n]).unwrap();
            let frames = dec.drain();
            if frames.iter().any(|f| f.frame_type == FrameType::Done) {
                let events: Vec<_> = frames
                    .iter()
                    .filter(|f| f.frame_type == FrameType::EventJson)
                    .collect();
                assert_eq!(events.len(), 2);
                let p0: serde_json::Value = serde_json::from_slice(&events[0].payload).unwrap();
                assert_eq!(p0["data"]["text"], "hi");
                let p1: serde_json::Value = serde_json::from_slice(&events[1].payload).unwrap();
                assert_eq!(p1["data"]["text"], "there");
                break;
            }
        }

        let _ = server_task.await;
        let _ = std::fs::remove_file(&server_path);
    }

    /// Regression guard for the "Operator connection lost" IPC race: many
    /// concurrent `invoke`s must reach the server with strictly-increasing
    /// REQUEST ids on the WIRE.
    ///
    /// Before the fix, `next_id.fetch_add` sat OUTSIDE the writer lock, so two
    /// concurrent invokes on different worker threads could allocate 743/744
    /// and then write them 744-first — the server's monotonic-id gate
    /// (`non-monotonic REQUEST id=N (last=N+1); closing`) then `socket.destroy()`d
    /// the whole IPC connection, dropping the desktop's live-data channel. With
    /// id allocation UNDER the writer lock, wire order == id order, so a server
    /// enforcing that same check (as this synthetic one does) never trips.
    ///
    /// Stress-style: the race is timing-dependent, so we fire enough concurrent
    /// invokes on a multi-thread runtime to reliably exercise it. The fix makes
    /// the assertion pass deterministically; a regression that moves allocation
    /// back outside the lock will (with very high probability) produce a
    /// non-monotonic pair and fail here.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_invokes_write_ids_in_monotonic_wire_order() {
        use std::sync::Mutex as StdMutex;
        use std::time::{Duration, Instant};
        use tokio::net::UnixListener;

        let tmp = std::path::PathBuf::from(format!(
            "/tmp/pcipc-mono-{}-{}.sock",
            std::process::id(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        let _ = std::fs::remove_file(&tmp);
        let listener = UnixListener::bind(&tmp).unwrap();

        const N: usize = 200;
        let arrival_ids: Arc<StdMutex<Vec<u64>>> = Arc::new(StdMutex::new(Vec::with_capacity(N)));
        let server_ids = arrival_ids.clone();

        // Synthetic server: accept one connection, decode REQUEST frames, record
        // each id in ARRIVAL (wire) order. Emits nothing back — the calls stay
        // in-flight, which is all we need to inspect wire ordering.
        let server_task = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let (mut r, _w) = tokio::io::split(sock);
            let mut dec = FrameDecoder::new();
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = match r.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                dec.push(&buf[..n]).unwrap();
                for frame in dec.drain() {
                    if frame.frame_type == FrameType::Request {
                        let v: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                        let id = v["id"].as_u64().unwrap();
                        let mut ids = server_ids.lock().unwrap();
                        ids.push(id);
                        if ids.len() >= N {
                            return;
                        }
                    }
                }
            }
        });

        // Let the server reach `accept()` before we dial.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let client = IpcClient::connect(&tmp).await.unwrap();

        // Fire N invokes concurrently across worker threads — this is what
        // races id allocation against the write.
        let mut handles = Vec::with_capacity(N);
        for _ in 0..N {
            let c = client.clone();
            handles.push(tokio::spawn(async move {
                c.invoke(
                    "synth".to_string(),
                    serde_json::json!({}),
                    Channel::new(|_| Ok(())),
                )
                .await
                .unwrap()
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        // Wait until the server has recorded all N arrivals (bounded).
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if arrival_ids.lock().unwrap().len() >= N {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "server only received {} / {N} REQUEST frames",
                arrival_ids.lock().unwrap().len()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let ids = arrival_ids.lock().unwrap().clone();
        // The invariant the real server enforces: ids strictly increase on the wire.
        for pair in ids.windows(2) {
            assert!(
                pair[1] > pair[0],
                "non-monotonic wire order: {} then {} (full: {:?})",
                pair[0],
                pair[1],
                ids
            );
        }
        assert_eq!(ids.len(), N, "every distinct id should have arrived");

        drop(client);
        let _ = server_task.await;
        let _ = std::fs::remove_file(&tmp);
    }

    // ── WI-3395: TCP-loopback transport (Windows/WSL2) ──────────────────────

    #[test]
    fn parse_tcp_endpoint_recognizes_tcp_and_rejects_socket_paths() {
        assert_eq!(
            parse_tcp_endpoint("tcp://127.0.0.1:35745"),
            Some("127.0.0.1:35745")
        );
        // Bracketed IPv6 literal is preserved for ToSocketAddrs.
        assert_eq!(parse_tcp_endpoint("tcp://[::1]:8080"), Some("[::1]:8080"));
        // Surrounding whitespace (a stray discovery-file newline) is trimmed.
        assert_eq!(
            parse_tcp_endpoint("  tcp://127.0.0.1:1 "),
            Some("127.0.0.1:1")
        );
        // A Unix socket + a named pipe are NOT tcp endpoints.
        assert_eq!(
            parse_tcp_endpoint("/home/u/.papercusp/sockets/1.sock"),
            None
        );
        assert_eq!(parse_tcp_endpoint("\\\\.\\pipe\\papercusp-1"), None);
        assert_eq!(parse_tcp_endpoint(""), None);

        for malformed in [
            "TCP://127.0.0.1:35745",
            "tcp://127.0.0.1",
            "tcp://127.0.0.1:not-a-port",
            "tcp://127.0.0.1:35745:1",
            "tcp://:1",
            "tcp://[]:1",
        ] {
            assert_eq!(parse_tcp_endpoint(malformed), None, "{malformed}");
        }
    }

    /// End-to-end over a real loopback TCP listener: the client dials a
    /// `tcp://127.0.0.1:<port>` endpoint (exercising `connect_stream`'s TCP
    /// branch + the `IpcStream::Tcp` AsyncRead/AsyncWrite delegation), invokes
    /// a synthetic tool, and receives the streamed event + terminal Done via
    /// its Channel — proving the byte-identical framing runs unchanged over
    /// TCP. Cross-platform (no `#[cfg]`), so it guards the Windows dial path
    /// even on a unix CI box.
    #[tokio::test]
    async fn connects_and_streams_over_tcp_loopback_end_to_end() {
        use std::sync::Mutex as StdMutex;
        use std::time::{Duration, Instant};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // Synthetic server: accept one connection, read the REQUEST, emit one
        // EVENT_JSON + a DONE for its id.
        let server_task = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let (mut r, mut w) = tokio::io::split(sock);
            let mut dec = FrameDecoder::new();
            let mut buf = [0u8; 4096];
            let id = loop {
                let n = r.read(&mut buf).await.unwrap();
                if n == 0 {
                    panic!("client closed before sending a REQUEST");
                }
                dec.push(&buf[..n]).unwrap();
                if let Some(req) = dec
                    .drain()
                    .into_iter()
                    .find(|f| f.frame_type == FrameType::Request)
                {
                    let v: serde_json::Value = serde_json::from_slice(&req.payload).unwrap();
                    break v["id"].as_u64().unwrap();
                }
            };
            let ev = serde_json::to_vec(&serde_json::json!({
                "id": id, "name": "delta", "data": { "text": "hi" }
            }))
            .unwrap();
            let done = serde_json::to_vec(&serde_json::json!({
                "id": id, "result": { "ok": true }
            }))
            .unwrap();
            w.write_all(&encode_frame(FrameType::EventJson, &ev).unwrap())
                .await
                .unwrap();
            w.write_all(&encode_frame(FrameType::Done, &done).unwrap())
                .await
                .unwrap();
            // Keep the socket open long enough for the client to read.
            tokio::time::sleep(Duration::from_millis(50)).await;
        });

        let endpoint = format!("tcp://127.0.0.1:{port}");
        let client = IpcClient::connect(std::path::Path::new(&endpoint))
            .await
            .unwrap();

        // A Channel that captures every serialized body it forwards.
        let captured: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(vec![]));
        let cap = captured.clone();
        let channel = Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
            if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                cap.lock().unwrap().push(s);
            }
            Ok(())
        });
        client
            .invoke("synth".to_string(), serde_json::json!({}), channel)
            .await
            .unwrap();

        // Wait for the terminal Done to land (bounded).
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if captured
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.contains("\"done\""))
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "no Done received over TCP; got {:?}",
                captured.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let bodies = captured.lock().unwrap().clone();
        assert!(
            bodies
                .iter()
                .any(|s| s.contains("\"event\"") && s.contains("hi")),
            "delta event missing over TCP: {bodies:?}"
        );
        assert!(
            bodies.iter().any(|s| s.contains("\"done\"")),
            "terminal Done missing over TCP: {bodies:?}"
        );

        drop(client);
        let _ = server_task.await;
    }
}
