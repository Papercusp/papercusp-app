# Endpoint IPC Protocol

Binary stream-multiplexed protocol for the **webview→Tauri→Node** fast path.
Used by the desktop Tauri app to dispatch endpoint-system tools without the
localhost HTTP round-trip. Browser surfaces and MCP-spawned agents continue
to use HTTP+SSE.

**Trust model.** The webview is in-boundary (same UID, same process tree,
spawned by the same Tauri parent that spawned the Node sidecar). IPC calls
synthesize a `principal: { role: 'operator' }` and **skip HMAC signature
verification**. The signed-URL model applies to spawned subprocesses that
might forge their own role — the webview is not that. See
`apps/operator/content/internal-docs/endpoint-system/transports.mdx` § "Trust model".

## Transport

| Platform | Transport                                                         |
|----------|-------------------------------------------------------------------|
| Linux    | Unix domain socket at `~/.papercusp/sockets/<server-pid>.sock`    |
| macOS    | Unix domain socket at `~/.papercusp/sockets/<server-pid>.sock`    |
| Windows  | Named pipe `\\.\pipe\papercusp-<server-pid>`                      |

Server creates the parent directory (`mkdir -p` with mode `0o700`) and unlinks
any stale socket file before binding.

Both sides use the cross-platform abstraction:

- Node: `net.createServer` / `net.connect` for sockets, with platform branch.
- Rust: `tokio::net::UnixStream` on Unix, `tokio::net::windows::named_pipe`
  on Windows. Same `AsyncRead + AsyncWrite` surface either side.

## Cold-start ordering

The Node sidecar **must** print exactly one line to stdout after the server
binds successfully:

```
PAPERCUSP_IPC_READY socket=<absolute-path-or-pipe-name>
```

Rust waits for that line (with a 30s timeout) before opening connections. No
retry loop with arbitrary backoff — the line is the only signal.

## Frame format

Every frame on the wire is:

```
+----------+--------+----------------+
| length   | type   | payload        |
| (4B BE)  | (1B)   | (length bytes) |
+----------+--------+----------------+
```

- `length`: total bytes of `payload`. Excludes the 5-byte header.
  Max 16 MiB (sender MUST refuse to encode larger payloads; receiver
  MUST close the connection on >16 MiB frames as a protocol violation).
- `type`: u8, see table below.
- `payload`: `length` bytes. Format depends on type.

All multi-byte integers are **big-endian**.

## Frame types

| Tag    | Name        | Direction      | Payload                                      |
|--------|-------------|----------------|----------------------------------------------|
| `0x01` | REQUEST     | Client → Server | UTF-8 JSON: `{ id, toolName, input }`        |
| `0x02` | EVENT_JSON  | Server → Client | UTF-8 JSON: `{ id, name, data }`             |
| `0x03` | DONE        | Server → Client | UTF-8 JSON: `{ id, result }`                 |
| `0x04` | ERROR       | Server → Client | UTF-8 JSON: `{ id, error: { code, message }}`|
| `0x05` | EVENT_BIN   | Server → Client | Self-describing binary (see below)           |
| `0x06` | CANCEL      | Client → Server | UTF-8 JSON: `{ id }`                         |
| `0x07` | *(reserved)* | —              | Was DATA; removed — see "Removed frame types" |

### `id` semantics

`id` is a `u64` chosen by the client. Clients MUST issue strictly increasing
ids per-connection starting at `1`. The server MUST treat ids as opaque; it
MUST echo the request's `id` on every event/done/error frame for that call.

Multiple calls multiplex over one connection. The server MUST not assume any
ordering of REQUEST arrival vs the previous call's DONE.

### EVENT_BIN payload layout

For events whose schema is `z.instanceof(Uint8Array)`. **Self-describing** so
no separate header frame is needed (preventing the per-id pending-state bug
the reviewer flagged).

```
+-----------+-------------+--------------------+--------------------+
| id (8B BE)| nameLen (4B)| name (nameLen UTF-8)| binary bytes (rest)|
+-----------+-------------+--------------------+--------------------+
```

- `id`: u64 BE, matches the originating REQUEST.
- `nameLen`: u32 BE, length of the event name in UTF-8 bytes.
- `name`: event name as declared in the tool's `events` schema.
- Remaining bytes (`length - 8 - 4 - nameLen`) are the raw binary payload.

The 16 MiB frame cap caps binary events at ~16 MiB minus header overhead.

## Removed frame types

### `0x07` DATA — removed, tag RESERVED

**This channel is server-streaming, not full duplex.** Client → Server is
REQUEST and CANCEL only: once a call is open the client can abandon it but
cannot feed it. The server closes the connection on any other client frame.

DATA (`0x07`) was added by `no-http-anywhere-2026-07-28` P-012 to make the
channel full duplex, then removed on that same plan (WI-7545) because both of
its stated consumers went away:

- **P-014** (move the PTY and voice connections onto the channel) was
  **refuted**: the WebKitGTK connection cap is per-**origin**, so those
  listeners hold their own pools and moving them frees zero sockets. The
  shipped `ws-guard.ts` exempts both by name — they "must keep their native
  sockets."
- **P-013** shipped a WebSocket **guard** (`pass` / `declared-exemption` /
  `violation`), not a data-carrying shim. Nothing was ever built that needed a
  client → server byte path.

So the frame was specified, encoded, decoded and tested on both sides while
being unreachable in both directions — and the spec asserted MUST-level routing
semantics the server never implemented. That gap is the reason this section
exists rather than the frame: a spec that promises behaviour the implementation
refuses is worse than a spec that is silent.

**Do not reuse `0x07`.** A tag that meant DATA to one build and something else
to another is a silent wire-compat break. Both codecs pin it as unassigned
(`removed_and_unassigned_tags_are_rejected` in Rust; the matching case in the TS
suite). If the channel ever genuinely needs full duplex, the removed design is
recoverable from git history — take a fresh tag (`0x08`).

## Lifecycle

```
Client                              Server
  │                                   │
  │── REQUEST {id:1, toolName, in} ──>│
  │                                   │  dispatchProjectedToolStream
  │<── EVENT_JSON {id:1, name, d} ────│
  │<── EVENT_JSON {id:1, name, d} ────│
  │<── EVENT_BIN  [id:1][len][n][b] ──│  (if any binary events)
  │<── DONE {id:1, result}      ──────│  (terminal — id:1 freed)
  │                                   │
  │── REQUEST {id:2, ...}        ────>│
  │── CANCEL  {id:2}             ────>│  (client aborted mid-stream)
  │                                   │  AbortController.abort()
  │<── ERROR {id:2, code: 'aborted'} ─│  (terminal — id:2 freed)
```

Every call has exactly **one** terminal frame (`DONE` or `ERROR`), never both,
never neither.

## Validation errors

If the server receives a malformed REQUEST (invalid JSON, missing fields,
unknown `toolName`, args fail Zod validation), it replies with a single
ERROR frame and frees the id. **No HTTP-style 4xx; only ERROR**.

If the client violates the protocol (oversized frame, unknown type tag,
non-monotonic id), the server closes the connection. The Rust client
treats connection close as a "connection_lost" error sent to every
in-flight Channel.

## Cancellation

Client sends `CANCEL { id }` to abort. Server calls the per-call
`AbortController.abort()`. Tool fn must observe `ctx.signal.aborted` to
short-circuit. On abort, server emits `ERROR { code: 'aborted' }` as the
terminal frame.

Server-side aborts also fire on idle timeout (`idleTimeoutSec`) and
wall-clock timeout (`timeoutSec`), with `code: 'timeout'` / `'idle_timeout'`.

## Frame cap rationale

16 MiB is generous for normal events (chat deltas are <1 KiB, suggestions
<10 KiB, binary tiles maybe <2 MiB). Hard cap protects the receiver from
buffering attacks. If a real tool needs >16 MiB, design it to emit multiple
chunks with explicit ordering metadata.

## What this is NOT

- Not a replacement for HTTP+SSE — those stay for browser, MCP-spawned
  agents, and the non-Tauri webapp test surface.
- Not for spawned subprocesses — the trust-model rationale (in-boundary
  webview) does not apply to them. Subprocesses continue to use the
  signed-URL HTTP path.
- Not for cross-machine RPC — the design assumes both ends are in the
  same process tree on the same host. Use HTTP for anything else.
