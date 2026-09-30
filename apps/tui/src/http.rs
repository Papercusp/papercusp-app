//! HTTP+bearer backend transport (D-009). The remote counterpart to the IPC
//! transport: when there's no local Unix socket (a remote box / the SP3 Claude
//! Code plugin), `pui` talks to the operator over HTTP, reading the base URL +
//! bearer token from `~/.papercusp/operator.json` (the file SP1's `serve`
//! writes). `/api/*` calls are direct requests; SSE is a streaming GET whose
//! bytes feed the shared `sse.rs` parser. No raw-IPC assumptions — same typed
//! client surface, different wire.
#![allow(dead_code)] // selected at runtime; unused on a box that resolves IPC.

use crate::sse::{parse_sse_frames, SseFrame};
use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::fmt;
use std::time::Duration;
use tokio::sync::mpsc;

/// A non-success HTTP response, preserved as a typed error so callers can
/// distinguish authentication failures from network/transport failures.
#[derive(Debug)]
pub struct HttpStatusError {
    pub method: String,
    pub path: String,
    pub status: u16,
    pub body: String,
}

impl fmt::Display for HttpStatusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {} -> {}: {}",
            self.method,
            self.path,
            self.status,
            self.body.chars().take(200).collect::<String>()
        )
    }
}

impl std::error::Error for HttpStatusError {}

fn http_status_error(method: &str, path: &str, status: u16, bytes: &[u8]) -> anyhow::Error {
    let body: String = String::from_utf8_lossy(bytes)
        .chars()
        .take(65_536)
        .collect();
    anyhow::Error::new(HttpStatusError {
        method: method.to_string(),
        path: path.to_string(),
        status,
        body,
    })
}

// ─── R2: fail-loud rendezvous classification ────────────────────────────────
//
// An explicitly-selected operator that does not answer must produce an error
// the user can ACT on. Four failures need four DIFFERENT actions, and a single
// "connection failed" collapses all of them into a dead end:
//
//   unreachable       → wrong host/port, operator down, or firewalled
//   tls               → we reached it, but the handshake never completed
//   auth              → it answered and rejected this client's credential
//   identity-mismatch → it answered, but it is not the backend we selected
//
// The classifier reads TYPED errors out of the chain — `IdentityMismatchError`,
// `HttpStatusError`, `reqwest::Error` — rather than matching on prose, with one
// deliberate and documented exception at `tls_marker_in_chain`.

/// A backend that ANSWERED but is not the backend we selected or expect.
/// Typed so the classifier never has to recognise it by its message text.
#[derive(Debug, Clone)]
pub struct IdentityMismatchError {
    pub endpoint: String,
    pub detail: String,
}

impl fmt::Display for IdentityMismatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "operator {} is not the selected backend: {}",
            self.endpoint, self.detail
        )
    }
}

impl std::error::Error for IdentityMismatchError {}

/// The operator SELECTION is not valid, so no rendezvous was ever attempted.
///
/// Distinct from every transport failure: there is no endpoint to diagnose,
/// and advice about reachability is nonsense. Typed so the classifier reports
/// it as such instead of describing a conversation that never happened.
#[derive(Debug, Clone)]
pub struct SelectionError {
    pub selector: String,
    pub reason: String,
}

impl fmt::Display for SelectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.reason)
    }
}

impl std::error::Error for SelectionError {}

/// The bounded rendezvous probe budget expired (R2's headline clause).
///
/// Typed, because this failure arises from a `tokio::time::timeout` rather than
/// from the transport, so nothing in the error chain would otherwise identify
/// it — and the fallback classification ("answered, but not usably") is exactly
/// backwards for a probe that never got an answer.
#[derive(Debug, Clone)]
pub struct ProbeTimeout {
    pub endpoint: String,
    pub budget: Duration,
}

impl fmt::Display for ProbeTimeout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "operator identity probe timed out after {:?} ({})",
            self.budget, self.endpoint
        )
    }
}

impl std::error::Error for ProbeTimeout {}

/// How a rendezvous with the selected operator failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendezvousFailure {
    /// The selection itself is invalid — nothing was ever dialled.
    Selection,
    /// No usable TCP conversation: refused, timed out, DNS failure, no route.
    Unreachable,
    /// Reached the host, but the TLS handshake failed.
    Tls,
    /// The operator answered and rejected this client's credential.
    Auth,
    /// The operator answered, but it is not the backend we selected.
    IdentityMismatch,
    /// Answered, but not in a way we can use (bad status, undecodable body).
    Protocol,
}

impl RendezvousFailure {
    pub fn label(self) -> &'static str {
        match self {
            Self::Selection => "invalid-selection",
            Self::Unreachable => "unreachable",
            Self::Tls => "tls",
            Self::Auth => "auth",
            Self::IdentityMismatch => "identity-mismatch",
            Self::Protocol => "protocol",
        }
    }

    /// Every variant, so a guard can assert the whole surface stays actionable
    /// instead of only the variants a test author happened to remember.
    pub const ALL: [RendezvousFailure; 6] = [
        Self::Selection,
        Self::Unreachable,
        Self::Tls,
        Self::Auth,
        Self::IdentityMismatch,
        Self::Protocol,
    ];

    /// The kind a [`RendezvousError::status_line`] was rendered from. The app
    /// receives the failure as that one line; setup reads the kind back to
    /// choose wording for the screen it is on (P-021).
    pub fn of_status_line(line: &str) -> Option<Self> {
        let label = line.strip_prefix("operator ")?.split(" · ").next()?;
        Self::ALL.into_iter().find(|kind| kind.label() == label)
    }
}

/// A classified rendezvous failure: what kind, against which endpoint, and the
/// concrete repair. Rendered by `pui doctor` and the launch path.
#[derive(Debug, Clone)]
pub struct RendezvousError {
    pub kind: RendezvousFailure,
    pub endpoint: String,
    pub detail: String,
}

impl RendezvousError {
    pub fn new(
        kind: RendezvousFailure,
        endpoint: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            endpoint: endpoint.into(),
            detail: detail.into(),
        }
    }

    /// The concrete next action — never "check your connection". Each names the
    /// endpoint, because on a multi-operator box the FIRST question a user has
    /// is which backend this message is even about.
    pub fn repair(&self) -> String {
        let e = &self.endpoint;
        match self.kind {
            RendezvousFailure::Selection => format!(
                "{e} is not a valid operator selection, so nothing was contacted. \
                 PUI_OPERATOR must be a full http(s) URL such as https://host:9443 — and it \
                 must not embed credentials."
            ),
            RendezvousFailure::Unreachable => format!(
                "nothing answered at {e}. Confirm an operator is running and reachable there \
                 (`curl {e}/api/health`), or select a different one with \
                 PUI_OPERATOR=<url>. No operator on this computer? `pui --connect-login \
                 --connect` signs in to Papercusp cloud and runs PUI there. pui will NOT \
                 silently fall back to a local operator — an explicit selection is honoured \
                 or it fails."
            ),
            RendezvousFailure::Tls => format!(
                "reached {e} but the TLS handshake failed. Check the scheme first — an \
                 http-only operator selected as https:// fails in exactly this way — then that \
                 the certificate is valid and issued for that host name."
            ),
            RendezvousFailure::Auth => format!(
                // Accurate in BOTH directions: in the common remote case pui
                // sent no credential at all, so asserting that {e} "rejected
                // yours" would describe a request that never carried one.
                "{e} returned an authentication failure. If no credential is provisioned for \
                 {e}, set {OPERATOR_TOKEN_ENV} — pui deliberately never sends the local \
                 ~/.papercusp/operator.json bearer to a different operator, so an \
                 unprovisioned remote produces exactly this. If {OPERATOR_TOKEN_ENV} IS set, \
                 then {e} rejected it: check that the token was issued by that operator."
            ),
            RendezvousFailure::IdentityMismatch => format!(
                "{e} answered, but it is not the backend this session is bound to — continuing \
                 would read and write the WRONG store. Relaunch with PUI_OPERATOR pointed at the \
                 intended operator, or close the bound session before switching."
            ),
            RendezvousFailure::Protocol => format!(
                "{e} answered, but not with a usable operator response. Confirm {e} is a \
                 papercusp operator (`curl {e}/api/tui/identity`) and that its build is \
                 compatible with this pui."
            ),
        }
    }

    /// The one-line form the status bar and setup receive: the failure kind and
    /// endpoint first, so a clipped line still says where to look.
    pub fn status_line(&self) -> String {
        format!(
            "operator {} · {} — {}",
            self.kind.label(),
            self.endpoint,
            self.repair()
        )
    }

    /// Classify a failed rendezvous against `endpoint`.
    ///
    /// Ordering is load-bearing: the typed identity and status errors are more
    /// specific than any transport signal, and TLS must be tested BEFORE
    /// `is_connect()` because a handshake failure is itself reported as a
    /// connect error — testing connect first would swallow every TLS case.
    pub fn classify(endpoint: &str, err: &anyhow::Error) -> Self {
        // FIRST: an invalid selection means no rendezvous was attempted at all,
        // so every downstream classification would describe a conversation that
        // never happened — and name a "host" that is not one.
        if let Some(selection) = err
            .chain()
            .find_map(|cause| cause.downcast_ref::<SelectionError>())
        {
            return Self::new(
                RendezvousFailure::Selection,
                selection.selector.clone(),
                selection.reason.clone(),
            );
        }
        if let Some(mismatch) = err
            .chain()
            .find_map(|cause| cause.downcast_ref::<IdentityMismatchError>())
        {
            return Self::new(
                RendezvousFailure::IdentityMismatch,
                endpoint,
                mismatch.detail.clone(),
            );
        }
        if let Some(timeout) = err
            .chain()
            .find_map(|cause| cause.downcast_ref::<ProbeTimeout>())
        {
            return Self::new(
                RendezvousFailure::Unreachable,
                endpoint,
                timeout.to_string(),
            );
        }
        if let Some(status) = err
            .chain()
            .find_map(|cause| cause.downcast_ref::<HttpStatusError>())
        {
            let kind = match status.status {
                401 | 403 => RendezvousFailure::Auth,
                _ => RendezvousFailure::Protocol,
            };
            return Self::new(kind, endpoint, status.to_string());
        }
        if let Some(req) = err
            .chain()
            .find_map(|cause| cause.downcast_ref::<reqwest::Error>())
        {
            if tls_marker_in_chain(req) {
                return Self::new(RendezvousFailure::Tls, endpoint, describe_chain(req));
            }
            // Every OTHER reqwest error is a transport failure, so it is
            // `Unreachable` — not a fall-through to `Protocol`.
            //
            // This holds because of how this client is built: it never asks
            // reqwest to interpret a response. Statuses are turned into
            // `HttpStatusError` by `sys_http`, and bodies are decoded
            // separately by the caller, so reqwest is never the thing that
            // reports an unusable answer — only a conversation that failed.
            //
            // Testing `is_connect()` alone missed two REAL cases, both of which
            // then claimed the operator "answered": a socket accepted from a
            // dying listener's backlog and reset (`SendRequest ... Connection
            // reset by peer`), and one accepted then closed before replying
            // (`Canceled ... connection closed before message completed` — how
            // a TLS-only port responds to plaintext, among other causes).
            return Self::new(
                RendezvousFailure::Unreachable,
                endpoint,
                describe_chain(req),
            );
        }
        Self::new(RendezvousFailure::Protocol, endpoint, format!("{err:#}"))
    }
}

impl fmt::Display for RendezvousError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} — operator {}: {}\n  repair: {}",
            self.kind.label(),
            self.endpoint,
            self.detail,
            self.repair()
        )
    }
}

impl std::error::Error for RendezvousError {}

/// Flatten an error's source chain into one line of detail.
fn describe_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    parts.join(": ")
}

/// `reqwest` exposes `is_connect()` but no `is_tls()`, and a rustls handshake
/// failure surfaces as a connect error, so the source chain's own text is the
/// only available discriminator. This is the one place the classifier reads
/// prose, and the markers below are validated by a test that drives a REAL
/// rustls handshake failure rather than by assumption.
///
/// Scanning starts BELOW the reqwest error itself: only that top frame carries
/// the request URL, so including it would classify every refusal against a host
/// named e.g. `tls.example.com` as a TLS failure.
fn tls_marker_in_chain(err: &reqwest::Error) -> bool {
    const MARKERS: &[&str] = &[
        "tls",
        "ssl",
        "certificate",
        "handshake",
        "corrupt message",
        "unknownissuer",
        "notvalidfor",
    ];
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        let text = cause.to_string().to_ascii_lowercase();
        if MARKERS.iter().any(|marker| text.contains(marker)) {
            return true;
        }
        source = cause.source();
    }
    false
}

#[derive(Clone)]
pub struct HttpClient {
    base: String, // operator httpUrl, no trailing slash
    token: Option<String>,
    http: reqwest::Client,
}

impl HttpClient {
    /// Resolve base URL + bearer from `~/.papercusp/operator.json`.
    pub fn from_discovery() -> Result<Self> {
        let (base, token) = discover_operator()?;
        Ok(Self::new(base, token))
    }

    /// Bounded connect budget: an explicitly-selected operator that is
    /// unreachable must fail FAST with an actionable error rather than hang on
    /// the OS TCP default (which can stall a launch for minutes and reads to
    /// the user as a frozen cockpit).
    ///
    /// Deliberately `connect_timeout`, NOT a whole-request `timeout`: SSE
    /// subscriptions here are long-lived streams that stay open for the life of
    /// the session, so a total request timeout would cut the cockpit off
    /// mid-session. Connection establishment is the leg that must be bounded —
    /// it is exactly the unreachable-host case.
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

    pub fn new(base: String, token: Option<String>) -> Self {
        // Fall back to the default client if the builder ever fails, so a
        // transport-construction edge can never take the cockpit down; the
        // bounded-connect property is asserted by test below.
        let http = reqwest::Client::builder()
            .connect_timeout(Self::CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            base: base.trim_end_matches('/').to_string(),
            token,
            http,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<reqwest::Response> {
        let mut req = match method {
            "GET" => self.http.get(self.url(path)),
            "POST" => self.http.post(self.url(path)),
            "PUT" => self.http.put(self.url(path)),
            "DELETE" => self.http.delete(self.url(path)),
            other => return Err(anyhow!("unsupported method {other}")),
        };
        if let Some(t) = &self.token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.header("content-type", "application/json").body(b);
        }
        req.send().await.with_context(|| format!("{method} {path}"))
    }

    /// `/api/*` request; returns the body bytes, erroring on non-2xx/3xx.
    pub async fn sys_http(
        &self,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<Vec<u8>> {
        let resp = self.send(method, path, body).await?;
        let status = resp.status();
        let bytes = resp.bytes().await.context("read body")?;
        if !(status.is_success() || status.is_redirection()) {
            return Err(http_status_error(method, path, status.as_u16(), &bytes));
        }
        Ok(bytes.to_vec())
    }

    async fn checked_sse_response(
        method: &str,
        path: &str,
        resp: reqwest::Response,
    ) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        let status = resp.status();
        if !status.is_success() {
            // A launch/converse refusal is often the only actionable clue the
            // operator can give the PUI. Preserve that body through the same
            // typed status seam as ordinary HTTP instead of reducing it to a
            // bare status code before the Agent Chat footer renders it.
            let bytes = resp.bytes().await.context("read SSE error body")?;
            return Err(http_status_error(method, path, status.as_u16(), &bytes));
        }
        Ok(stream_response(resp))
    }

    /// Subscribe to an SSE route (GET); yields parsed `SseFrame`s until the
    /// stream ends.
    pub async fn subscribe_sse(&self, path: &str) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        let resp = self.send("GET", path, None).await?;
        Self::checked_sse_response("GET", path, resp).await
    }

    /// Subscribe to an SSE route via a streaming POST (the operator-converse
    /// turn rides POST + a request body and replies `text/event-stream`). Same
    /// chunk → `SseFrame` pipeline as the GET path.
    pub async fn subscribe_sse_post(
        &self,
        path: &str,
        body: String,
    ) -> Result<mpsc::UnboundedReceiver<SseFrame>> {
        let resp = self.send("POST", path, Some(body)).await?;
        Self::checked_sse_response("POST", path, resp).await
    }
}

/// Drain a streaming `reqwest::Response` into a uniform `SseFrame` channel,
/// handling chunk boundaries that split multi-byte UTF-8 and partial frames.
fn stream_response(mut resp: reqwest::Response) -> mpsc::UnboundedReceiver<SseFrame> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut pending = String::new(); // text not yet forming complete frames
        let mut tail: Vec<u8> = Vec::new(); // incomplete trailing UTF-8 bytes
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    tail.extend_from_slice(&chunk);
                    let (decoded, rest) = decode_utf8_prefix(std::mem::take(&mut tail));
                    tail = rest;
                    pending.push_str(&decoded);
                    let (frames, rest) = parse_sse_frames(&pending);
                    pending = rest;
                    for f in frames {
                        if tx.send(f).is_err() {
                            return;
                        }
                    }
                }
                Ok(None) | Err(_) => return, // stream ended / dropped
            }
        }
    });
    rx
}

/// Decode the valid UTF-8 prefix of `buf`, returning it plus any trailing bytes
/// of an incomplete multi-byte sequence (to prepend to the next network chunk).
fn decode_utf8_prefix(buf: Vec<u8>) -> (String, Vec<u8>) {
    match std::str::from_utf8(&buf) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid = e.valid_up_to();
            // The prefix is valid by construction, so lossy == exact here.
            let s = String::from_utf8_lossy(&buf[..valid]).into_owned();
            (s, buf[valid..].to_vec())
        }
    }
}

fn discover_operator() -> Result<(String, Option<String>)> {
    let home = dirs::home_dir().context("no home dir")?;
    let p = home.join(".papercusp").join("operator.json");
    let txt = std::fs::read_to_string(&p).with_context(|| format!("read {}", p.display()))?;
    let v: Value = serde_json::from_str(&txt).context("parse operator.json")?;
    let base = v
        .get("httpUrl")
        .and_then(|x| x.as_str())
        .context("operator.json missing httpUrl")?
        .to_string();
    let token = v
        .get("token")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok((base, token))
}

// NOTE: there is deliberately NO unscoped `discovered_token()` here.
//
// An endpoint-blind accessor returning the local `~/.papercusp/operator.json`
// bearer is a credential-leak footgun: paired with an explicitly selected
// remote operator it transmits a locally-provisioned secret to a host that has
// no business seeing it. Because this module carries `#![allow(dead_code)]`,
// such a helper attracts no unused warning and can sit here looking sanctioned
// until some future caller reaches for the shorter name.
//
// Use `discovered_token_for(base)` — it is endpoint-scoped by construction and
// returns `None` rather than leaking across operators.

/// Return the discovered bearer only when `operator.json` describes the SAME
/// canonical endpoint. Borrowing a token from a different operator is a hidden
/// cross-operator fallback even if the eventual request happens to reject it.
pub fn discovered_token_for(base: &str) -> Option<String> {
    let (discovered_base, token) = discover_operator().ok()?;
    token_if_same_endpoint(&discovered_base, token, base)
}

/// The endpoint-scoping decision itself, lifted out of the disk read so it can
/// be guarded with a POSITIVE control. Testing only "an unrelated operator gets
/// no token" against the real `operator.json` is hollow: on a box without that
/// file every lookup returns `None` and the guard passes while proving nothing.
fn token_if_same_endpoint(
    discovered_base: &str,
    token: Option<String>,
    selected: &str,
) -> Option<String> {
    let discovered = base_for_selection(discovered_base).ok()?;
    let selected = base_for_selection(selected).ok()?;
    (discovered == selected).then_some(token).flatten()
}

/// The env seam carrying a credential for an EXPLICITLY selected operator.
/// Scoped by construction: it is supplied alongside `PUI_OPERATOR`, so it
/// describes that endpoint and no other.
pub const OPERATOR_TOKEN_ENV: &str = "PUI_OPERATOR_TOKEN";

/// Resolve the bearer to send to `base`.
///
/// An explicitly supplied token wins, and is the ONLY way to authenticate to a
/// remote operator: `discovered_token_for` is endpoint-scoped on purpose, so
/// the local `~/.papercusp/operator.json` bearer is never borrowed for a
/// different operator (R3). Without this seam that scoping is a dead end —
/// every remote request goes out anonymous and can only ever 401.
pub fn resolve_token_for(base: &str, explicit: Option<&str>) -> Option<String> {
    if let Some(token) = explicit.map(str::trim).filter(|t| !t.is_empty()) {
        return Some(token.to_string());
    }
    discovered_token_for(base)
}

/// `resolve_token_for` against the process environment.
pub fn token_for_endpoint(base: &str) -> Option<String> {
    resolve_token_for(base, std::env::var(OPERATOR_TOKEN_ENV).ok().as_deref())
}

/// Map an explicit operator selection to a base URL (P-001 refit): the
/// well-known names `staging` (:3170, runs the staging tree) and `release`
/// (:3070, runs green `main`), or any full http(s) URL. Anything else is an
/// error — explicit means explicit, no guessing.
pub fn base_for_selection(sel: &str) -> Result<String> {
    let sel = sel.trim().trim_end_matches('/');
    let sel = sel
        .strip_suffix("/api/mcp")
        .unwrap_or(sel)
        .trim_end_matches('/');
    let invalid = |reason: String| {
        anyhow::Error::new(SelectionError {
            selector: sel.to_string(),
            reason,
        })
    };
    let raw = match sel {
        "staging" => "http://127.0.0.1:3170".to_string(),
        "release" => "http://127.0.0.1:3070".to_string(),
        s if s.starts_with("http://") || s.starts_with("https://") => s.to_string(),
        other => {
            return Err(invalid(format!(
                "PUI_OPERATOR must be `staging`, `release`, or an http(s) URL — got {other:?}"
            )))
        }
    };
    let mut url = reqwest::Url::parse(&raw)
        .map_err(|e| invalid(format!("PUI operator URL is unparseable: {e}")))?;
    if !url.username().is_empty() || url.password().is_some() {
        // MASK before reporting. The classified failure echoes its selector
        // back to the terminal (and into any log or screenshot of it), so
        // reporting this one verbatim would publish the embedded password —
        // which is the very thing being rejected.
        let mut masked = url.clone();
        let _ = masked.set_username("***");
        let _ = masked.set_password(Some("***"));
        return Err(anyhow::Error::new(SelectionError {
            selector: masked.as_str().trim_end_matches('/').to_string(),
            reason: "PUI operator URL must not contain credentials".to_string(),
        }));
    }
    if url.host_str() == Some("localhost") {
        url.set_host(Some("127.0.0.1"))
            .map_err(|_| anyhow!("normalize localhost operator URL"))?;
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Recurrence guard for the bounded probe budget (R2).
    ///
    /// This is a SOURCE invariant, deliberately, and the reason is worth
    /// keeping: the obvious behavioural test — dial an unroutable host and
    /// assert it fails quickly — is HOLLOW on any machine whose routing policy
    /// refuses the address immediately. Measured here: dialling 203.0.113.1
    /// (TEST-NET-3, RFC 5737) returned in well under a millisecond, so an
    /// `elapsed < N` assertion passes identically with and without
    /// `connect_timeout` and guards nothing. `reqwest` exposes no way to read a
    /// configured timeout back off a built `Client`, so the construction site
    /// itself is the only environment-independent thing left to assert.
    ///
    /// Falsifiable by construction: delete or rename the `.connect_timeout(..)`
    /// call in `HttpClient::new` and this test fails.
    #[test]
    fn http_client_is_constructed_with_a_bounded_connect_timeout() {
        let src = include_str!("http.rs");
        let ctor = src
            .split_once("pub fn new(base: String, token: Option<String>) -> Self {")
            .expect("HttpClient::new constructor not found — did it get renamed?")
            .1;
        let ctor_body = ctor
            .split_once("\n    }")
            .expect("could not delimit HttpClient::new body")
            .0;

        assert!(
            ctor_body.contains(".connect_timeout(Self::CONNECT_TIMEOUT)"),
            "HttpClient::new must build its reqwest client with \
             .connect_timeout(Self::CONNECT_TIMEOUT). Without it an unreachable \
             explicitly-selected operator hangs on OS TCP defaults (~130s of SYN \
             retries on Linux), which presents to the user as a frozen cockpit. \
             Constructor body was:\n{ctor_body}"
        );
        assert!(
            HttpClient::CONNECT_TIMEOUT <= Duration::from_secs(30),
            "CONNECT_TIMEOUT {:?} is too loose to be a probe budget",
            HttpClient::CONNECT_TIMEOUT
        );
    }

    /// Companion smoke check: an unroutable operator must ERROR rather than
    /// report success. Says nothing about timing — see the guard above for why
    /// a timing assertion here would be meaningless on this host.
    #[tokio::test]
    async fn unroutable_operator_errors_rather_than_succeeding() {
        let client = HttpClient::new("http://203.0.113.1:9443".to_string(), None);
        let result = client.sys_http("GET", "/api/health", None).await;
        assert!(
            result.is_err(),
            "an unroutable operator must not report success"
        );
    }

    /// R2: a closed port is UNREACHABLE, not a generic failure.
    ///
    /// Binds then DROPS the listener, so the connect is refused immediately by
    /// the kernel — the classification is exercised without depending on this
    /// host's routing policy or on any timeout elapsing.
    #[tokio::test]
    async fn closed_port_classifies_as_unreachable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);

        let client = HttpClient::new(addr.clone(), None);
        let err = client
            .sys_http("GET", "/api/health", None)
            .await
            .unwrap_err();
        let failure = RendezvousError::classify(&addr, &err);
        assert_eq!(
            failure.kind,
            RendezvousFailure::Unreachable,
            "detail was: {}\nchain: {err:#}",
            failure.detail
        );
    }

    /// R2: an operator that is not there does not always fail during CONNECT.
    ///
    /// This is the deterministic form of a flake that caught a real defect: a
    /// socket accepted from a dying listener's backlog and then reset is
    /// reported by reqwest as a REQUEST error, so an `is_connect()`-only check
    /// classified it `Protocol` — telling the user to verify the endpoint is a
    /// papercusp operator when in fact nothing is serving there.
    #[tokio::test]
    async fn a_connection_closed_before_any_response_classifies_as_unreachable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                drop(stream); // close without ever answering
            }
        });

        let client = HttpClient::new(addr.clone(), None);
        let err = client
            .sys_http("GET", "/api/health", None)
            .await
            .unwrap_err();
        let failure = RendezvousError::classify(&addr, &err);
        assert_eq!(
            failure.kind,
            RendezvousFailure::Unreachable,
            "a connection closed before any response must read as unreachable, \
             not as a protocol failure.\ndetail: {}\nchain: {err:#}",
            failure.detail
        );
    }

    /// R2: a REAL rustls handshake failure must classify as `tls`, not as the
    /// generic connect failure reqwest also reports it as.
    ///
    /// Drives an actual handshake against a plain-HTTP listener — no
    /// certificates or fixtures needed, and it is precisely the mistake a user
    /// makes (selecting an http-only operator as `https://`). This test is what
    /// validates `tls_marker_in_chain`'s marker set against reality; the
    /// assertion prints the observed chain so a miss names the real text.
    #[tokio::test]
    async fn plain_http_operator_selected_as_https_classifies_as_tls() {
        let (addr, _r) = spawn_http("200 OK", "", "{}").await;
        let https = addr.replacen("http://", "https://", 1);

        let client = HttpClient::new(https.clone(), None);
        let err = client
            .sys_http("GET", "/api/health", None)
            .await
            .unwrap_err();
        let failure = RendezvousError::classify(&https, &err);
        assert_eq!(
            failure.kind,
            RendezvousFailure::Tls,
            "a failed TLS handshake must classify as tls, not fall through to a \
             generic connect failure.\nobserved detail: {}\nfull chain: {err:#}",
            failure.detail
        );
    }

    /// R2: a rejected credential is AUTH — distinct from unreachable, because
    /// the repair (provision a token for this operator) is completely different.
    #[tokio::test]
    async fn rejected_credential_classifies_as_auth() {
        for status_line in ["401 Unauthorized", "403 Forbidden"] {
            let (addr, _r) = spawn_http(status_line, "", "denied").await;
            let client = HttpClient::new(addr.clone(), Some("wrong-token".into()));
            let err = client
                .sys_http("GET", "/api/tui/identity", None)
                .await
                .unwrap_err();
            let failure = RendezvousError::classify(&addr, &err);
            assert_eq!(
                failure.kind,
                RendezvousFailure::Auth,
                "{status_line} must classify as auth; detail was: {}",
                failure.detail
            );
        }
    }

    /// The auth classification must stay NARROW: any other non-2xx is a
    /// protocol failure, and calling it "auth" would send the user off
    /// provisioning credentials for a backend that never asked for any.
    #[tokio::test]
    async fn other_non_2xx_classifies_as_protocol_not_auth() {
        let (addr, _r) = spawn_http("404 Not Found", "", "nope").await;
        let client = HttpClient::new(addr.clone(), None);
        let err = client
            .sys_http("GET", "/api/tui/identity", None)
            .await
            .unwrap_err();
        assert_eq!(
            RendezvousError::classify(&addr, &err).kind,
            RendezvousFailure::Protocol
        );
    }

    /// An invalid SELECTOR must not be described as a failed conversation.
    ///
    /// Found by running `pui doctor` with `PUI_OPERATOR=prod`: it reported a
    /// `protocol` failure and told the user to
    /// `curl (unresolved selector "prod")/api/tui/identity` — advice that
    /// cannot be followed, about a host that does not exist. Nothing is dialled
    /// when the selection itself is rejected, so it is its own class.
    #[test]
    fn an_invalid_selector_classifies_as_a_selection_failure() {
        for selector in ["prod", "", "http://user:secret@localhost:3070"] {
            let err = base_for_selection(selector)
                .unwrap_err()
                .context("resolve canonical PUI operator endpoint");
            let failure = RendezvousError::classify("ignored-label", &err);

            assert_eq!(
                failure.kind,
                RendezvousFailure::Selection,
                "selector {selector:?} must classify as a selection failure, \
                 not as a failed rendezvous; detail: {}",
                failure.detail
            );
            let repair = failure.repair();
            assert!(
                !repair.contains("curl") || !repair.contains(selector),
                "the repair must not tell the user to curl a non-endpoint: {repair}"
            );
            assert!(
                repair.contains("PUI_OPERATOR must be"),
                "the repair must state the valid selector forms: {repair}"
            );
        }
    }

    /// A rejected selector is echoed back to the terminal, so an embedded
    /// password must be masked first — otherwise the diagnostic for "your URL
    /// must not contain credentials" is itself what publishes them.
    #[test]
    fn a_rejected_selector_never_echoes_an_embedded_credential() {
        let err = base_for_selection("http://alice:hunter2@127.0.0.1:3070").unwrap_err();
        let failure = RendezvousError::classify("ignored-label", &err);
        let rendered = format!("{}\n{}", failure, failure.repair());

        assert!(
            !rendered.contains("hunter2"),
            "the embedded password must never be echoed back: {rendered}"
        );
        // Positive control: the guard is looking at text that really does
        // describe this selector, so the absence above is meaningful.
        assert!(
            rendered.contains("127.0.0.1:3070"),
            "the masked selector should still identify the host: {rendered}"
        );
    }

    /// R2's headline clause: an expired probe budget is an UNREACHABLE
    /// operator. It arrives from a `tokio` timeout rather than the transport,
    /// so without its own type it would land in the fallback bucket and tell
    /// the user the operator "answered" — the opposite of what happened.
    #[test]
    fn an_expired_probe_budget_classifies_as_unreachable() {
        let err = anyhow::Error::new(ProbeTimeout {
            endpoint: "https://op.example:9443".into(),
            budget: Duration::from_secs(3),
        })
        .context("probe canonical PUI operator/store identity");

        let failure = RendezvousError::classify("https://op.example:9443", &err);
        assert_eq!(failure.kind, RendezvousFailure::Unreachable);
        assert!(
            failure.detail.contains("timed out"),
            "the detail must say the budget expired: {}",
            failure.detail
        );
    }

    /// R2: a backend that answers but is the WRONG backend is its own class,
    /// recognised by a typed error rather than by matching on its message.
    #[test]
    fn identity_mismatch_classifies_from_its_typed_error() {
        let err = anyhow::Error::new(IdentityMismatchError {
            endpoint: "https://op.example:9443".into(),
            detail: "store pg-b, but this session is bound to pg-a".into(),
        })
        .context("probe canonical PUI operator/store identity");

        let failure = RendezvousError::classify("https://op.example:9443", &err);
        assert_eq!(failure.kind, RendezvousFailure::IdentityMismatch);
        assert!(
            failure.detail.contains("pg-b") && failure.detail.contains("pg-a"),
            "the mismatch detail must survive classification: {}",
            failure.detail
        );
    }

    /// The whole point of classifying is the repair text, so guard EVERY
    /// variant — including ones added later — rather than the few a test author
    /// happened to think of.
    #[test]
    fn every_failure_kind_repairs_by_naming_the_endpoint_and_an_action() {
        for kind in RendezvousFailure::ALL {
            let failure = RendezvousError::new(kind, "https://op.example:9443", "detail");
            let repair = failure.repair();
            assert!(
                repair.contains("https://op.example:9443"),
                "{kind:?} repair must name the endpoint it is about: {repair}"
            );
            assert!(
                repair.len() > 60,
                "{kind:?} repair is too thin to be actionable: {repair}"
            );
            let rendered = failure.to_string();
            assert!(
                rendered.contains(kind.label()) && rendered.contains("repair:"),
                "{kind:?} must render as a labelled, repairable failure: {rendered}"
            );
        }
    }

    /// R3: the explicit token is what makes a REMOTE operator reachable at all,
    /// and it must not be confused with the endpoint-scoped local discovery.
    #[test]
    fn explicit_operator_token_supplies_the_remote_credential() {
        assert_eq!(
            resolve_token_for("https://op.example:9443", Some("remote-token")),
            Some("remote-token".to_string())
        );
        // Blank/whitespace is NOT a credential — treating it as one would send
        // an empty bearer and turn a missing-token mistake into an opaque 401.
        assert_eq!(
            resolve_token_for("https://op.example:9443", Some("   ")),
            None
        );
        assert_eq!(
            resolve_token_for("https://op.example:9443", Some("  padded  ")),
            Some("padded".to_string())
        );
    }

    /// R3: the local bearer reaches its OWN operator and no other. Both halves
    /// are asserted — the positive control is what makes the negative half
    /// meaningful, since a lookup that always returned `None` would satisfy the
    /// leak check on its own.
    #[test]
    fn the_local_bearer_is_scoped_to_the_endpoint_that_issued_it() {
        let issued = || Some("local-bearer".to_string());

        // Same operator, written differently (localhost is normalized): yes.
        assert_eq!(
            token_if_same_endpoint("http://localhost:3070", issued(), "http://127.0.0.1:3070"),
            Some("local-bearer".to_string()),
            "the bearer must still reach the operator that issued it"
        );
        // A remote operator: never.
        assert_eq!(
            token_if_same_endpoint("http://127.0.0.1:3070", issued(), "https://op.example:9443"),
            None
        );
        // A DIFFERENT local operator is just as much a leak: :3070 and :3170
        // are separate backends with separate stores.
        assert_eq!(
            token_if_same_endpoint("http://127.0.0.1:3070", issued(), "http://127.0.0.1:3170"),
            None
        );
    }

    #[test]
    fn base_for_selection_maps_names_and_urls() {
        assert_eq!(
            base_for_selection("staging").unwrap(),
            "http://127.0.0.1:3170"
        );
        assert_eq!(
            base_for_selection("release").unwrap(),
            "http://127.0.0.1:3070"
        );
        assert_eq!(
            base_for_selection("https://op.example:9443/").unwrap(),
            "https://op.example:9443"
        );
        assert_eq!(
            base_for_selection("http://localhost:3070/api/mcp").unwrap(),
            "http://127.0.0.1:3070"
        );
        assert!(base_for_selection("prod").is_err());
        assert!(base_for_selection("").is_err());
        assert!(base_for_selection("http://user:secret@localhost:3070").is_err());
    }
    use tokio::net::TcpListener;

    #[test]
    fn decode_utf8_prefix_splits_multibyte() {
        // "é" = 0xC3 0xA9; feed it split across two chunks.
        let (s1, tail1) = decode_utf8_prefix(vec![b'a', 0xC3]);
        assert_eq!(s1, "a");
        assert_eq!(tail1, vec![0xC3]);
        let mut next = tail1;
        next.push(0xA9);
        let (s2, tail2) = decode_utf8_prefix(next);
        assert_eq!(s2, "é");
        assert!(tail2.is_empty());
    }

    /// Minimal one-shot HTTP server; returns its addr + a channel delivering the
    /// raw request text (for header assertions).
    async fn spawn_http(
        status_line: &'static str,
        headers: &'static str,
        body: &'static str,
    ) -> (String, tokio::sync::oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        let (rtx, rrx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap_or(0);
            let _ = rtx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            let resp = format!(
                "HTTP/1.1 {status_line}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = s.write_all(resp.as_bytes()).await;
            let _ = s.flush().await;
        });
        (addr, rrx)
    }

    #[tokio::test]
    async fn sys_http_get_sends_bearer_and_returns_body() {
        let (addr, req_rx) = spawn_http(
            "200 OK",
            "Content-Type: application/json\r\n",
            r#"{"ok":true}"#,
        )
        .await;
        let client = HttpClient::new(addr, Some("secret-token".into()));
        let bytes = client.sys_http("GET", "/api/x", None).await.unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], serde_json::json!(true));
        let req = req_rx.await.unwrap();
        assert!(req.starts_with("GET /api/x "));
        assert!(
            req.contains("authorization: Bearer secret-token")
                || req.contains("Authorization: Bearer secret-token")
        );
    }

    #[tokio::test]
    async fn sys_http_put_sends_json_body_and_returns_body() {
        let (addr, req_rx) = spawn_http(
            "200 OK",
            "Content-Type: application/json\r\n",
            r#"{"title":"P8 renamed"}"#,
        )
        .await;
        let client = HttpClient::new(addr, None);
        let bytes = client
            .sys_http(
                "PUT",
                "/api/harness/papercusp/agent-chats/chat-1",
                Some(r#"{"title":"P8 renamed"}"#.into()),
            )
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["title"], serde_json::json!("P8 renamed"));
        let req = req_rx.await.unwrap();
        assert!(req.starts_with("PUT /api/harness/papercusp/agent-chats/chat-1 "));
        assert!(req.contains(r#"{"title":"P8 renamed"}"#));
    }

    #[tokio::test]
    async fn sys_http_errors_on_non_2xx() {
        let (addr, _r) = spawn_http("404 Not Found", "", "nope").await;
        let client = HttpClient::new(addr, None);
        let err = client
            .sys_http("GET", "/api/missing", None)
            .await
            .unwrap_err();
        let status = err
            .downcast_ref::<HttpStatusError>()
            .expect("non-success responses preserve their typed status");
        assert_eq!(status.status, 404);
        assert_eq!(status.method, "GET");
        assert_eq!(status.path, "/api/missing");
        assert_eq!(status.body, "nope");
    }

    #[tokio::test]
    async fn subscribe_sse_post_preserves_non_success_body() {
        let (addr, request) = spawn_http(
            "503 Service Unavailable",
            "Content-Type: application/json\r\n",
            r#"{"error":"startup connection interrupted"}"#,
        )
        .await;
        let client = HttpClient::new(addr, None);
        let err = client
            .subscribe_sse_post("/api/adv/sessions/launch-su?stream=1", "{}".into())
            .await
            .unwrap_err();
        let status = err
            .downcast_ref::<HttpStatusError>()
            .expect("SSE non-success responses preserve their typed status and body");
        assert_eq!(status.status, 503);
        assert_eq!(status.method, "POST");
        assert_eq!(status.path, "/api/adv/sessions/launch-su?stream=1");
        assert_eq!(status.body, r#"{"error":"startup connection interrupted"}"#);
        assert!(request
            .await
            .unwrap()
            .starts_with("POST /api/adv/sessions/launch-su?stream=1 "));
    }

    /// P-001 asks for authenticated HTTP *and SSE* to the selected operator.
    /// The HTTP half is asserted above; the streaming half rides the same
    /// `send()` and so is easy to assume rather than check — but a remote
    /// operator that authenticates reads but not its event stream would leave
    /// the cockpit silently empty, not visibly broken.
    #[tokio::test]
    async fn subscribe_sse_sends_the_bearer_for_the_selected_operator() {
        let (addr, req_rx) = spawn_http(
            "200 OK",
            "Content-Type: text/event-stream\r\n",
            "event: heartbeat\ndata: {}\n\n",
        )
        .await;
        let client = HttpClient::new(addr, Some("remote-token".into()));
        let _rx = client.subscribe_sse("/api/zero-harness/sse").await.unwrap();

        let req = req_rx.await.unwrap();
        assert!(
            req.contains("authorization: Bearer remote-token")
                || req.contains("Authorization: Bearer remote-token"),
            "the SSE subscription must carry the selected operator's \
             credential, or a remote cockpit authenticates its reads and then \
             streams nothing:\n{req}"
        );
    }

    #[tokio::test]
    async fn subscribe_sse_parses_streamed_frames() {
        let (addr, _r) = spawn_http(
            "200 OK",
            "Content-Type: text/event-stream\r\n",
            "event: heartbeat\ndata: {}\n\nevent: invalidate\ndata: {\"name\":\"roster\"}\n\n",
        )
        .await;
        let client = HttpClient::new(addr, None);
        let mut rx = client.subscribe_sse("/api/zero-harness/sse").await.unwrap();
        let f1 = rx.recv().await.unwrap();
        let f2 = rx.recv().await.unwrap();
        assert_eq!(f1.event, "heartbeat");
        assert_eq!(f2.event, "invalidate");
        assert_eq!(f2.data, "{\"name\":\"roster\"}");
    }
}

#[cfg(test)]
mod live_tests {
    //! LIVE verification against a real headless `papercusp serve` (SP1 —
    //! closes the tui-workbench "HTTP-remote verify blocked on no remote
    //! `serve` infra" deferral). Boot one isolated instance first:
    //!
    //!   HOME=<tmp-home> PAPERCUSP_HONO_PORT=<port> PAPERCUSP_PG_PORT=<port> \
    //!     node sidecar/serve.mjs        # or: npm --prefix apps/operator run serve
    //!
    //! then run with that HOME so `~/.papercusp/operator.json` resolves:
    //!
    //!   HOME=<tmp-home> cargo test --bin pui http_live -- --ignored
    use super::*;
    use serde_json::Value;
    use std::io::ErrorKind;

    fn discovery_file_is_unavailable(err: &anyhow::Error) -> bool {
        err.chain().any(|cause| {
            cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == ErrorKind::NotFound)
        })
    }

    #[tokio::test]
    #[ignore = "requires a live headless `papercusp serve` (reads ~/.papercusp/operator.json)"]
    async fn http_live_read_surface_against_headless_serve() {
        let client = match HttpClient::from_discovery() {
            Ok(client) => client,
            Err(err) if discovery_file_is_unavailable(&err) => {
                eprintln!(
                    "SKIP http_live_read_surface_against_headless_serve: \
                     ~/.papercusp/operator.json is unavailable ({err:#}); \
                     start an isolated `papercusp serve` with its HOME to exercise this smoke"
                );
                return;
            }
            Err(err) => panic!("operator.json discovery: {err:#}"),
        };
        let health = client
            .sys_http("GET", "/api/health", None)
            .await
            .expect("GET /api/health over HTTP+bearer");
        let v: Value = serde_json::from_slice(&health).expect("health JSON");
        assert_eq!(v["ok"], serde_json::json!(true), "health body: {v}");
        // A real pui read-surface route (workbench persistence, D-013).
        let layouts = client
            .sys_http(
                "GET",
                "/api/tui/layouts?owner=http-live-test@papercusp",
                None,
            )
            .await
            .expect("GET /api/tui/layouts");
        let v: Value = serde_json::from_slice(&layouts).expect("layouts JSON");
        assert!(v.get("layouts").is_some(), "layouts shape: {v}");
    }
}
