//! Transcript copy contract — `y` / `Shift-Y` (P-007, PUBLIC_RELEASE_UX.md § Agent Chat).
//!
//! The release UX contract says, verbatim:
//!
//! > Transcript selection uses `y` to copy the focused rendered block and
//! > `Shift-Y` to copy its raw payload when available. Copy success is
//! > acknowledged without moving selection. Secrets and redacted fields stay
//! > redacted in both forms.
//!
//! and, for change cards: "Change cards open an in-PUI scrollable diff with
//! file/path/hunk context and **the same y/Shift-Y copy contract**."
//!
//! # Why OSC 52 and not `xclip` / `wl-copy` / `pbcopy`
//!
//! The approved release matrix is Linux x86_64, macOS arm64/x86_64, and Windows
//! 11 via WSL2 — plus the PUI is expected to be usable over SSH and inside a
//! multiplexer. A shelled-out clipboard helper is exactly the thing that is
//! ABSENT on a bare WSL2 image, a headless remote box, or a Wayland session
//! without the matching tool; worse, it fails by writing to the *server's*
//! clipboard when you are sitting at a different machine. OSC 52 is the
//! terminal-native escape: the emulator the human is actually looking at
//! performs the copy, so remote and local behave identically, and it needs no
//! new dependency (`base64` is already a dep, pulled in for voice WAV frames).
//!
//! Multiplexers each need their own envelope, and getting this wrong is SILENT —
//! the sequence is swallowed and the clipboard simply never changes:
//!   * tmux   — DCS passthrough, with every ESC in the payload doubled;
//!   * screen — DCS, chunked, because screen truncates a long DCS string;
//!   * zellij — forwards OSC 52 natively; wrapping it BREAKS it.
//!
//! # Redaction
//!
//! The RENDERED form is what the server already chose to display, so it is
//! already redacted upstream. The RAW form is the real exposure: it carries
//! verbatim tool arguments and results, which is precisely where a bearer token
//! or an API key lives. Both forms are passed through [`redact_text`] anyway —
//! the contract says "in both forms", and a redactor that only runs on the
//! dangerous path is one refactor away from not running at all.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{Map, Value};

use crate::models::ChatMessage;

/// What the copy key asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyForm {
    /// `y` — the block as rendered in the transcript.
    Rendered,
    /// `Shift-Y` — the underlying payload, when the block has one.
    Raw,
}

impl CopyForm {
    pub fn label(self) -> &'static str {
        match self {
            CopyForm::Rendered => "rendered",
            CopyForm::Raw => "raw",
        }
    }
}

/// Terminals commonly cap an OSC 52 payload; an oversized copy is silently
/// dropped, which is the worst possible failure for a clipboard. Truncate
/// deliberately and SAY SO in the acknowledgement instead.
pub const MAX_COPY_BYTES: usize = 96 * 1024;

/// The marker a redacted value is replaced with. Deliberately not empty: a
/// reader of the pasted text must be able to tell "a secret was here" from
/// "this field was absent".
pub const REDACTED: &str = "[redacted]";

/// One focusable transcript block, resolved into both copy forms.
#[derive(Debug, Clone, PartialEq)]
pub struct CopyBlock {
    /// Index into `chat_messages` — carried so the caller can prove the
    /// acknowledgement did not move the selection.
    pub index: usize,
    /// Short human label for the toast, e.g. `assistant message`.
    pub label: String,
    pub rendered: String,
    /// `None` when the block has no payload beyond what is already rendered —
    /// a plain user message, for instance. `Shift-Y` on such a block must
    /// acknowledge "no raw payload", never silently copy the rendered form.
    pub raw: Option<String>,
}

impl CopyBlock {
    /// The text for a form, or `None` when this block has no such form.
    pub fn text(&self, form: CopyForm) -> Option<&str> {
        match form {
            CopyForm::Rendered => Some(self.rendered.as_str()),
            CopyForm::Raw => self.raw.as_deref(),
        }
    }
}

/// The outcome of a copy request — everything the acknowledgement needs.
#[derive(Debug, Clone, PartialEq)]
pub enum CopyOutcome {
    Copied {
        /// The escape sequence to write to the terminal.
        sequence: String,
        /// Toast text, e.g. `Copied assistant message rendered (412 chars)`.
        ack: String,
        /// Byte length actually sent (post-truncation).
        bytes: usize,
        truncated: bool,
    },
    /// The block exists but has no payload in the requested form.
    Unavailable { ack: String },
    /// Nothing is focused.
    NoSelection { ack: String },
}

// ---------------------------------------------------------------------------
// Block resolution
// ---------------------------------------------------------------------------

/// Resolve message `idx` into its two copy forms.
pub fn block_at(messages: &[ChatMessage], idx: usize) -> Option<CopyBlock> {
    let m = messages.get(idx)?;

    let label = format!("{} message", role_label(&m.role));

    // --- rendered -----------------------------------------------------------
    let mut out = String::new();
    out.push_str(role_label(&m.role));
    if let Some(p) = &m.provenance {
        // Provenance is part of what the transcript shows, so it is part of
        // what `y` copies — a pasted assistant block that does not say which
        // engine/model/account produced it is not the block the human saw.
        let mut bits: Vec<&str> = Vec::new();
        for b in [
            p.engine.as_str(),
            p.model.as_str(),
            p.account_route.as_str(),
        ] {
            if !b.is_empty() {
                bits.push(b);
            }
        }
        if !bits.is_empty() {
            out.push_str(" · ");
            out.push_str(&bits.join(" · "));
        }
    }
    out.push_str(":\n");
    if !m.content.is_empty() {
        out.push_str(m.content.trim_end());
        out.push('\n');
    }
    if !m.reasoning.is_empty() {
        out.push_str("\nreasoning:\n");
        out.push_str(m.reasoning.trim_end());
        out.push('\n');
    }
    for t in &m.tools {
        out.push_str(&format!("\n  tool {} → {:?}", t.name, t.outcome));
        if t.needs_approval {
            out.push_str(" (awaiting approval)");
        }
        out.push('\n');
    }
    let rendered = redact_text(out.trim_end());

    // --- raw ----------------------------------------------------------------
    // "when available": a block whose only content is the text already rendered
    // has no second form. Tools, reasoning and provenance are what make a raw
    // payload meaningfully different from the rendered one.
    let has_raw = !m.tools.is_empty() || !m.reasoning.is_empty() || m.provenance.is_some();
    let raw = if has_raw {
        let mut obj = Map::new();
        obj.insert("role".into(), Value::String(m.role.clone()));
        obj.insert("content".into(), Value::String(m.content.clone()));
        if !m.reasoning.is_empty() {
            obj.insert("reasoning".into(), Value::String(m.reasoning.clone()));
        }
        if let Some(p) = &m.provenance {
            let mut pv = Map::new();
            pv.insert("engine".into(), Value::String(p.engine.clone()));
            pv.insert("model".into(), Value::String(p.model.clone()));
            pv.insert(
                "accountRoute".into(),
                Value::String(p.account_route.clone()),
            );
            obj.insert("provenance".into(), Value::Object(pv));
        }
        if !m.tools.is_empty() {
            let tools: Vec<Value> = m
                .tools
                .iter()
                .map(|t| {
                    let mut tv = Map::new();
                    tv.insert("name".into(), Value::String(t.name.clone()));
                    if let Some(id) = &t.id {
                        tv.insert("id".into(), Value::String(id.clone()));
                    }
                    tv.insert("outcome".into(), Value::String(format!("{:?}", t.outcome)));
                    tv.insert("needsApproval".into(), Value::Bool(t.needs_approval));
                    if let Some(i) = &t.input {
                        tv.insert("input".into(), i.clone());
                    }
                    if let Some(r) = &t.result {
                        tv.insert("result".into(), r.clone());
                    }
                    Value::Object(tv)
                })
                .collect();
            obj.insert("tools".into(), Value::Array(tools));
        }
        let redacted = redact_value(&Value::Object(obj));
        Some(serde_json::to_string_pretty(&redacted).unwrap_or_else(|_| String::from("{}")))
    } else {
        None
    };

    Some(CopyBlock {
        index: idx,
        label,
        rendered,
        raw,
    })
}

fn role_label(role: &str) -> &str {
    match role {
        "user" => "you",
        "assistant" => "assistant",
        "system" => "system",
        other => other,
    }
}

// ---------------------------------------------------------------------------
// The copy action
// ---------------------------------------------------------------------------

/// Resolve a copy request end-to-end: pick the block, pick the form, redact,
/// truncate, and build the terminal sequence plus its acknowledgement.
///
/// Never mutates anything — "acknowledged without moving selection" is enforced
/// by this function having no way to move it.
pub fn copy(
    messages: &[ChatMessage],
    focus: Option<usize>,
    form: CopyForm,
    pt: Passthrough,
) -> CopyOutcome {
    let no_selection = || CopyOutcome::NoSelection {
        // `{` / `}` — NOT j/k, which stay the transcript's line-wise scroll.
        // An acknowledgement that names the wrong keys is worse than none: it
        // sends the reader to a gesture that does something else entirely.
        ack: "Nothing selected — { } to focus a block, then y to copy".to_string(),
    };
    let Some(idx) = focus else {
        return no_selection();
    };
    let Some(block) = block_at(messages, idx) else {
        return no_selection();
    };
    copy_block(&block, form, pt)
}

/// The second half of [`copy`], over an ALREADY-RESOLVED block.
///
/// Split out so every copyable surface — transcript messages today, change
/// cards next door — shares ONE redact/truncate/encode/acknowledge path. A
/// second copy path is how the redaction or the truncation cap ends up applied
/// on one surface and not the other.
pub fn copy_block(block: &CopyBlock, form: CopyForm, pt: Passthrough) -> CopyOutcome {
    let Some(text) = block.text(form) else {
        return CopyOutcome::Unavailable {
            ack: format!(
                "No raw payload on this {} — y copies the rendered block",
                block.label
            ),
        };
    };
    if text.is_empty() {
        return CopyOutcome::Unavailable {
            ack: format!("Nothing to copy on this {}", block.label),
        };
    }

    let (payload, truncated) = truncate_on_char_boundary(text, MAX_COPY_BYTES);
    let sequence = osc52(payload, pt);
    let ack = if truncated {
        format!(
            "Copied {} {} ({} chars, truncated at {} KiB)",
            block.label,
            form.label(),
            payload.chars().count(),
            MAX_COPY_BYTES / 1024
        )
    } else {
        format!(
            "Copied {} {} ({} chars)",
            block.label,
            form.label(),
            payload.chars().count()
        )
    };
    CopyOutcome::Copied {
        sequence,
        ack,
        bytes: payload.len(),
        truncated,
    }
}

/// Truncate to at most `max` BYTES without splitting a UTF-8 char.
fn truncate_on_char_boundary(s: &str, max: usize) -> (&str, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], true)
}

// ---------------------------------------------------------------------------
// OSC 52
// ---------------------------------------------------------------------------

/// Which multiplexer envelope the sequence needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Passthrough {
    /// A plain terminal — or zellij, which forwards OSC 52 itself. Wrapping a
    /// zellij sequence is what BREAKS it, so zellij deliberately lands here.
    None,
    Tmux,
    Screen,
}

/// Decide the envelope from the environment. Takes a lookup so it is testable
/// without mutating the process environment (which races every other test in
/// the binary).
pub fn detect_passthrough<F>(env: F) -> Passthrough
where
    F: Fn(&str) -> Option<String>,
{
    let nonempty = |k: &str| env(k).filter(|v| !v.is_empty());
    // zellij FIRST: a zellij pane can also carry an inherited TMUX var from the
    // shell that launched it, and wrapping there would break a working copy.
    if nonempty("ZELLIJ").is_some() || nonempty("ZELLIJ_SESSION_NAME").is_some() {
        return Passthrough::None;
    }
    if nonempty("TMUX").is_some() {
        return Passthrough::Tmux;
    }
    if nonempty("STY").is_some() {
        return Passthrough::Screen;
    }
    Passthrough::None
}

/// Read the envelope from the real process environment.
pub fn passthrough_from_env() -> Passthrough {
    detect_passthrough(|k| std::env::var(k).ok())
}

/// GNU screen truncates a DCS string; 768 bytes per chunk is the conventional
/// safe bound.
const SCREEN_CHUNK: usize = 768;

/// Build the clipboard escape sequence for `text`.
pub fn osc52(text: &str, pt: Passthrough) -> String {
    let b64 = B64.encode(text.as_bytes());
    let bare = format!("\x1b]52;c;{b64}\x07");
    match pt {
        Passthrough::None => bare,
        // tmux DCS passthrough: every ESC inside the payload must be doubled or
        // tmux terminates the passthrough at the first one.
        Passthrough::Tmux => format!("\x1bPtmux;{}\x1b\\", bare.replace('\x1b', "\x1b\x1b")),
        Passthrough::Screen => {
            let mut out = String::new();
            let bytes = bare.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                let end = (i + SCREEN_CHUNK).min(bytes.len());
                out.push_str("\x1bP");
                out.push_str(&String::from_utf8_lossy(&bytes[i..end]));
                out.push_str("\x1b\\");
                i = end;
            }
            out
        }
    }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/// Key fragments, already normalized (lowercased, non-alphanumerics stripped).
const SECRET_KEY_FRAGMENTS: &[&str] = &[
    "secret",
    "token",
    "password",
    "passwd",
    "apikey",
    "authorization",
    "credential",
    "privatekey",
    "accesskey",
    "sessionkey",
    "cookie",
    "bearer",
    "pat",
];

fn normalize_key(k: &str) -> String {
    k.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Does this JSON key name a secret-bearing field?
pub fn key_is_secret(key: &str) -> bool {
    let n = normalize_key(key);
    // `pat` is short enough to hit innocent words ("path", "pattern", "patch"),
    // so it only counts as a whole normalized key or a `githubPat` style
    // compound suffix — never as a bare substring.
    SECRET_KEY_FRAGMENTS.iter().any(|f| {
        if *f == "pat" {
            n == "pat" || n.ends_with("pat")
        } else {
            n.contains(f)
        }
    })
}

/// Recursively redact a JSON value.
///
/// Only STRING values are redacted by key. That is deliberate: `tokensUsed:
/// 1200` and `maxTokens: 4096` are numbers, are not secrets, and are exactly
/// the fields a human copies a raw payload in order to read.
pub fn redact_value(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, val) in map {
                let redacted = if key_is_secret(k) && val.is_string() {
                    Value::String(REDACTED.to_string())
                } else {
                    redact_value(val)
                };
                out.insert(k.clone(), redacted);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_value).collect()),
        Value::String(s) => Value::String(redact_text(s)),
        other => other.clone(),
    }
}

fn is_token_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '+' | '=' | ':')
}

/// Does this bare run of characters LOOK like a credential?
///
/// The prefixes are assembled from fragments on purpose: a literal full-length
/// example of any of them in a tree file trips the repo secrets guard AND the
/// pot-git publish guard, and the latter then refuses every later publish
/// permanently — its baseline never advances past a refused range, and editing
/// the file afterwards does not remove the blob from history.
pub fn token_is_secret(tok: &str) -> bool {
    let lower = tok.to_ascii_lowercase();
    let prefixes: [String; 15] = [
        format!("{}-", "sk"),
        format!("{}_", "sk"),
        format!("{}_live_", "pk"),
        format!("{}_", "ghp"),
        format!("{}_", "gho"),
        format!("{}_", "ghu"),
        format!("{}_", "ghs"),
        format!("{}_", "ghr"),
        format!("{}_{}_", "github", "pat"),
        format!("{}-", "xoxb"),
        format!("{}-", "xoxp"),
        format!("{}-", "xoxa"),
        format!("{}-", "glpat"),
        format!("{}_", "npm"),
        // A JWT always begins `eyJ` (base64 of `{"`).
        "eyj".to_string(),
    ];
    if tok.len() >= 16 && prefixes.iter().any(|p| lower.starts_with(p.as_str())) {
        return true;
    }
    // AWS access key id: AKIA/ASIA + 16 uppercase alnum.
    let aws_a = format!("{}{}", "AK", "IA");
    let aws_b = format!("{}{}", "AS", "IA");
    if (tok.starts_with(&aws_a) || tok.starts_with(&aws_b))
        && tok.len() == 20
        && tok[4..]
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return true;
    }
    false
}

/// Redact the value half of a `KEY=value` run.
///
/// `=`, `-` and `_` are all token characters, so an assignment arrives as ONE
/// maximal run: `ANTHROPIC_API_KEY=sk-…` is a single token beginning
/// `anthropic`, which matches no credential prefix and is preceded by no
/// auth keyword — so the scanner above passed it through INTACT. That is the
/// exact shape of a `.env` line, a `docker run -e`, a `curl -H`, and a query
/// string, which makes it the likeliest secret in a copied transcript or a
/// change card, not an edge case. Measured 2026-09-11 against a change card
/// writing a `.env` file: the key survived both `redact_text` and the whole
/// rendered copy path.
///
/// Splitting on `=` and judging each half recovers both readings a bare
/// prefix scan misses: a secret-shaped KEY redacts whatever it is assigned,
/// and a credential-shaped VALUE redacts itself whatever it is called. The key
/// NAME is deliberately kept — `REDACTED` exists so a reader can tell "a
/// secret was here" from "this field was absent", and which secret it was is
/// part of that.
///
/// Returns `None` when nothing matched, so the caller keeps the original run
/// byte-for-byte rather than paying a rebuild on every ordinary token.
fn redact_assignment(run: &str) -> Option<String> {
    if !run.contains('=') {
        return None;
    }
    let mut parts: Vec<String> = run.split('=').map(str::to_string).collect();
    let mut hit = false;
    for i in 1..parts.len() {
        // Trailing `=` is base64 padding, not an empty assignment.
        if parts[i].is_empty() {
            continue;
        }
        if key_is_secret(&parts[i - 1]) || token_is_secret(&parts[i]) {
            parts[i] = REDACTED.to_string();
            hit = true;
        }
    }
    hit.then(|| parts.join("="))
}

fn prev_run_is_auth_keyword(prev: Option<&str>) -> bool {
    prev.map(|p| {
        let n = normalize_key(p);
        n == "bearer" || n == "authorization" || n == "token" || n == "apikey"
    })
    .unwrap_or(false)
}

/// Redact credential-shaped content from free text.
///
/// Scans maximal runs of token characters so surrounding punctuation, JSON
/// quoting and prose are preserved; a run is dropped when it is
/// credential-shaped, or when the PREVIOUS run was an authorization keyword
/// (`Bearer <token>`, `Authorization: <token>`).
/// The conversation as plain text for the terminal's own scrollback
/// (pui-chat-first-ux-2026-09-28 P-004, "clean scrollback"). The chat-first PUI
/// draws on the alternate screen, which takes the conversation with it on
/// exit; `main` prints this to the normal screen afterwards so the transcript
/// stays scrollable and selectable in the terminal, as a Claude Code or Codex
/// session does. Only what the chat showed — the owner's lines, the replies,
/// and the tools that ran — through the same [`redact_text`] as copy. A reply
/// still streaming at exit holds raw delta text, so it is marked, not dumped.
pub fn plain_transcript(messages: &[ChatMessage]) -> Option<String> {
    let mut out = String::new();
    for m in messages {
        let body = if m.streaming { "" } else { m.content.trim_end() };
        if body.trim().is_empty() && m.tools.is_empty() && !m.streaming {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        if m.role == "user" {
            for (i, line) in body.lines().enumerate() {
                out.push_str(if i == 0 { "> " } else { "  " });
                out.push_str(line);
                out.push('\n');
            }
            continue;
        }
        if !body.trim().is_empty() {
            out.push_str(body);
            out.push('\n');
        }
        for t in &m.tools {
            out.push_str(&format!("  ⚙ {}\n", t.name));
        }
        if m.streaming {
            out.push_str("  (reply interrupted when pui exited)\n");
        }
    }
    (!out.is_empty()).then(|| redact_text(&out))
}

pub fn redact_text(s: &str) -> String {
    let s = redact_pem(s);
    let mut out = String::with_capacity(s.len());
    let mut prev_token: Option<String> = None;
    let mut cur = String::new();

    fn flush(cur: &mut String, out: &mut String, prev: &mut Option<String>) {
        if cur.is_empty() {
            return;
        }
        if token_is_secret(cur) || (prev_run_is_auth_keyword(prev.as_deref()) && cur.len() >= 12) {
            out.push_str(REDACTED);
        } else if let Some(repaired) = redact_assignment(cur) {
            out.push_str(&repaired);
        } else {
            out.push_str(cur);
        }
        *prev = Some(std::mem::take(cur));
    }

    for c in s.chars() {
        if is_token_char(c) {
            cur.push(c);
        } else {
            flush(&mut cur, &mut out, &mut prev_token);
            out.push(c);
        }
    }
    flush(&mut cur, &mut out, &mut prev_token);
    out
}

/// Replace whole PEM private-key blocks. A PEM body is base64, so the
/// token-run scanner above would leave most of it intact.
fn redact_pem(s: &str) -> String {
    const BEGIN: &str = "-----BEGIN";
    let Some(start) = s.find(BEGIN) else {
        return s.to_string();
    };
    // Only private material; a certificate or public key is not a secret.
    let header_end = s[start..].find("-----\n").map(|i| start + i + 6);
    let header = header_end.map(|e| &s[start..e]).unwrap_or("");
    if !header.to_ascii_uppercase().contains("PRIVATE KEY") {
        return s.to_string();
    }
    let end_marker = "-----END";
    let Some(end_start) = s[start..].find(end_marker).map(|i| start + i) else {
        // Unterminated block: redact to end of string rather than leaking the tail.
        return format!("{}{}", &s[..start], REDACTED);
    };
    let end = s[end_start..]
        .find("-----\n")
        .map(|i| end_start + i + 6)
        .or_else(|| s[end_start..].rfind("-----").map(|i| end_start + i + 5))
        .unwrap_or(s.len());
    format!("{}{}{}", &s[..start], REDACTED, redact_pem(&s[end..]))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod plain_transcript_tests {
    use super::*;
    use crate::models::{ChatMessage, ChatToolCall};

    #[test]
    fn the_scrollback_transcript_shows_what_the_chat_showed() {
        let mut reply = ChatMessage::assistant("Here is the **plan**.\n");
        reply.reasoning = "internal chain of thought".into();
        reply.tools.push(ChatToolCall::plain("Read".into()));
        let msgs = vec![ChatMessage::user("first line\nsecond line"), reply];
        let text = plain_transcript(&msgs).expect("non-empty transcript");
        assert_eq!(
            text,
            "> first line\n  second line\n\nHere is the **plan**.\n  ⚙ Read\n"
        );
        assert!(!text.contains("chain of thought"), "reasoning stays out");
    }

    #[test]
    fn a_streaming_reply_is_marked_and_secrets_are_redacted() {
        // Assembled at runtime, like the copy tests' fixture, so the tree never
        // holds a key-shaped literal.
        let key = format!("{}{}", "sk-", "ant-abcdefghijklmnopqrstuvwxyz0123");
        let mut live = ChatMessage::assistant("<say>partial");
        live.streaming = true;
        let msgs = vec![ChatMessage::user(&format!("my key is {key}")), live];
        let text = plain_transcript(&msgs).unwrap();
        assert!(text.contains("(reply interrupted when pui exited)"));
        assert!(!text.contains("<say>"));
        assert!(!text.contains(&key), "{text}");
        assert_eq!(plain_transcript(&[]), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ChatMessage, ChatProvenance, ChatToolCall};
    use serde_json::json;

    // Every credential-shaped fixture below is ASSEMBLED AT RUNTIME, never
    // written as a literal — see the note on `token_is_secret`. The split is
    // not cosmetic: a literal here freezes the hive publish plane.
    fn fake_anthropic_key() -> String {
        format!("{}{}", "sk-", "ant-abcdefghijklmnopqrstuvwxyz0123")
    }
    fn fake_github_pat() -> String {
        format!("{}{}", "ghp", "_0123456789abcdefghijklmnopqrstuvwxyz")
    }
    fn fake_aws_key_id() -> String {
        format!("{}{}", "AK", "IAIOSFODNN7EXAMPLE")
    }
    fn pem_marker(word: &str, kind: &str) -> String {
        format!("{}{} {}{}", "-----", word, kind, "-----")
    }

    fn assistant_with_tool() -> ChatMessage {
        let mut m = ChatMessage::assistant("Here is the result.");
        m.provenance = Some(ChatProvenance {
            engine: "claude".into(),
            model: "sonnet".into(),
            account_route: "auto".into(),
        });
        let mut t = ChatToolCall::plain("http:get".into());
        t.input = Some(json!({
            "url": "https://example.test/v1/things",
            "headers": { "Authorization": format!("Bearer {}", fake_anthropic_key()) },
            "apiKey": fake_github_pat(),
            "tokensUsed": 1200,
            "timeoutMs": 5000
        }));
        m.tools = vec![t];
        m
    }

    // --- CALIBRATION -------------------------------------------------------
    // If these fail, every "the secret was removed" assertion below is vacuous:
    // a redactor that eats everything also eats every secret.

    #[test]
    fn calibration_non_secret_prose_survives_byte_for_byte() {
        let plain = "The quick brown fox jumps over the lazy dog. path=/etc/hosts pattern=abc";
        assert_eq!(redact_text(plain), plain);
    }

    #[test]
    fn calibration_pat_lookalike_keys_are_not_treated_as_secrets() {
        for k in ["path", "pattern", "patch", "compatible", "filePath"] {
            assert!(!key_is_secret(k), "{k} must not be treated as a secret key");
        }
        // ...while a real one still is.
        assert!(key_is_secret("githubPat"));
        assert!(key_is_secret("api_key"));
        assert!(key_is_secret("Authorization"));
    }

    #[test]
    fn calibration_numeric_token_fields_are_not_redacted() {
        let v = json!({ "tokensUsed": 1200, "maxTokens": 4096 });
        let r = redact_value(&v);
        assert_eq!(r["tokensUsed"], json!(1200));
        assert_eq!(r["maxTokens"], json!(4096));
    }

    // --- redaction ---------------------------------------------------------

    #[test]
    fn secret_shaped_tokens_are_redacted_in_free_text() {
        let pat = fake_github_pat();
        let s = format!("use {pat} then stop");
        let out = redact_text(&s);
        assert!(!out.contains(&pat), "got {out}");
        assert!(out.contains(REDACTED));
        assert!(out.starts_with("use ") && out.ends_with(" then stop"));
    }

    #[test]
    fn key_equals_value_assignments_are_redacted_on_both_readings() {
        // REGRESSION (measured 2026-09-11, this was LEAKING): `=`, `-` and `_`
        // are all token characters, so an assignment is ONE maximal run that
        // begins with the key. No credential prefix matches it and no auth
        // keyword precedes it, so the scanner passed the whole thing through.
        // This is the `.env` / `-e` / query-string shape — the likeliest
        // secret in a copied transcript, not an edge case.
        let key = fake_anthropic_key();

        // (a) credential-shaped VALUE, under an innocent key.
        let out = redact_text(&format!("ran with FOO={key} today"));
        assert!(!out.contains(&key), "value-shaped secret leaked: {out}");
        assert!(out.contains("FOO="), "the key name must survive: {out}");

        // (b) secret-shaped KEY, over a shapeless opaque value.
        let out = redact_text("ANTHROPIC_API_KEY=totallyOpaqueValue0123456789");
        assert!(
            !out.contains("totallyOpaqueValue"),
            "keyed secret leaked: {out}"
        );
        assert!(
            out.contains("ANTHROPIC_API_KEY="),
            "which secret it was is part of the signal: {out}"
        );
    }

    #[test]
    fn calibration_ordinary_assignments_survive_byte_for_byte() {
        // The falsifying control for the test above: if `redact_assignment`
        // were widened to redact any `k=v`, BOTH tests would still pass on the
        // leak half while quietly destroying every diff line and query string
        // in the transcript. This is the half that would catch that.
        for s in [
            "let x=1",
            "sort_key=name",
            "?page=2&limit=50",
            "-D CMAKE_BUILD_TYPE=Release",
            "content-type=application/json",
        ] {
            assert_eq!(redact_text(s), s, "ordinary assignment was mangled");
        }
    }

    #[test]
    fn bearer_value_is_redacted_even_when_shapeless() {
        let out = redact_text("Authorization: Bearer aVeryLongOpaqueValue123456");
        assert!(!out.contains("aVeryLongOpaqueValue"), "got {out}");
        assert!(out.contains(REDACTED));
    }

    #[test]
    fn aws_access_key_id_is_redacted_but_lookalikes_are_not() {
        assert!(token_is_secret(&fake_aws_key_id()));
        assert!(!token_is_secret(&format!("{}{}", "AK", "IASHORT")));
        assert!(!token_is_secret(&format!(
            "{}{}",
            "AS", "IAlowercasetail1234"
        )));
    }

    #[test]
    fn pem_private_key_block_is_removed_whole() {
        let body = format!("{}{}", "MIIEpAIBAAKCAQEA", "1234\nabcd");
        let s = format!(
            "before\n{}\n{body}\n{}\nafter",
            pem_marker("BEGIN", "RSA PRIVATE KEY"),
            pem_marker("END", "RSA PRIVATE KEY"),
        );
        let out = redact_text(&s);
        assert!(!out.contains("MIIEpAIBAAKCAQEA"), "got {out}");
        assert!(out.contains("before") && out.contains("after"));
    }

    #[test]
    fn public_pem_is_left_alone() {
        let s = format!(
            "{}\nMIIBkTCB+wIJAKZ\n{}\n",
            pem_marker("BEGIN", "CERTIFICATE"),
            pem_marker("END", "CERTIFICATE"),
        );
        assert_eq!(redact_text(&s), s);
    }

    #[test]
    fn secret_keys_are_redacted_by_name_in_nested_json() {
        let v = json!({ "outer": { "apiKey": "whatever-value-here", "note": "keep me" } });
        let r = redact_value(&v);
        assert_eq!(r["outer"]["apiKey"], json!(REDACTED));
        assert_eq!(r["outer"]["note"], json!("keep me"));
    }

    // --- block resolution --------------------------------------------------

    #[test]
    fn rendered_block_carries_provenance_and_tools() {
        let msgs = vec![assistant_with_tool()];
        let b = block_at(&msgs, 0).expect("block");
        assert_eq!(b.index, 0);
        assert!(
            b.rendered.contains("assistant · claude · sonnet · auto"),
            "got {}",
            b.rendered
        );
        assert!(b.rendered.contains("Here is the result."));
        assert!(b.rendered.contains("tool http:get"));
    }

    #[test]
    fn raw_payload_is_present_for_a_tool_bearing_block_and_is_redacted() {
        let msgs = vec![assistant_with_tool()];
        let b = block_at(&msgs, 0).expect("block");
        let raw = b.raw.as_deref().expect("raw available");
        // The useful tool arguments survive...
        assert!(raw.contains("https://example.test/v1/things"), "got {raw}");
        assert!(raw.contains("5000"));
        assert!(raw.contains("1200"));
        // ...but neither credential does — one caught by KEY, one by SHAPE.
        assert!(!raw.contains(&fake_github_pat()), "leaked pat: {raw}");
        assert!(!raw.contains(&fake_anthropic_key()), "leaked key: {raw}");
    }

    #[test]
    fn a_plain_user_message_has_no_raw_form() {
        let msgs = vec![ChatMessage::user("hello")];
        let b = block_at(&msgs, 0).expect("block");
        assert!(b.raw.is_none());
        assert_eq!(b.text(CopyForm::Raw), None);
        assert_eq!(b.text(CopyForm::Rendered), Some(b.rendered.as_str()));
        assert!(b.rendered.starts_with("you:"));
    }

    #[test]
    fn out_of_range_focus_resolves_to_nothing() {
        let msgs = vec![ChatMessage::user("hello")];
        assert!(block_at(&msgs, 9).is_none());
    }

    // --- copy() ------------------------------------------------------------

    #[test]
    fn shift_y_on_a_block_without_raw_is_unavailable_not_a_silent_rendered_copy() {
        let msgs = vec![ChatMessage::user("hello")];
        match copy(&msgs, Some(0), CopyForm::Raw, Passthrough::None) {
            CopyOutcome::Unavailable { ack } => assert!(ack.contains("No raw payload"), "{ack}"),
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn copy_with_no_focus_reports_no_selection() {
        let msgs = vec![ChatMessage::user("hello")];
        assert!(matches!(
            copy(&msgs, None, CopyForm::Rendered, Passthrough::None),
            CopyOutcome::NoSelection { .. }
        ));
    }

    #[test]
    fn copy_acknowledges_and_emits_an_osc52_sequence() {
        let msgs = vec![ChatMessage::user("hello")];
        match copy(&msgs, Some(0), CopyForm::Rendered, Passthrough::None) {
            CopyOutcome::Copied {
                sequence,
                ack,
                truncated,
                ..
            } => {
                assert!(sequence.starts_with("\x1b]52;c;"), "{sequence:?}");
                assert!(sequence.ends_with('\x07'));
                assert!(ack.starts_with("Copied you message rendered"), "{ack}");
                assert!(!truncated);
            }
            other => panic!("expected Copied, got {other:?}"),
        }
    }

    #[test]
    fn an_oversized_block_is_truncated_and_says_so() {
        let big = "x".repeat(MAX_COPY_BYTES + 5_000);
        let msgs = vec![ChatMessage::user(&big)];
        match copy(&msgs, Some(0), CopyForm::Rendered, Passthrough::None) {
            CopyOutcome::Copied {
                bytes,
                truncated,
                ack,
                ..
            } => {
                assert!(truncated);
                assert!(bytes <= MAX_COPY_BYTES);
                assert!(ack.contains("truncated"), "{ack}");
            }
            other => panic!("expected Copied, got {other:?}"),
        }
    }

    #[test]
    fn truncation_never_splits_a_utf8_char() {
        // A 3-byte char straddling the cap is the case a naive `&s[..max]` panics on.
        let s = "あ".repeat(MAX_COPY_BYTES);
        let (cut, truncated) = truncate_on_char_boundary(&s, MAX_COPY_BYTES);
        assert!(truncated);
        assert!(cut.len() <= MAX_COPY_BYTES);
        assert!(cut.chars().all(|c| c == 'あ'));
    }

    // --- OSC 52 envelopes --------------------------------------------------

    #[test]
    fn plain_terminal_sequence_round_trips_the_payload() {
        let seq = osc52("hi there", Passthrough::None);
        let b64 = seq
            .trim_start_matches("\x1b]52;c;")
            .trim_end_matches('\x07');
        assert_eq!(B64.decode(b64).unwrap(), b"hi there");
    }

    #[test]
    fn tmux_wrap_doubles_every_escape() {
        let seq = osc52("hi", Passthrough::Tmux);
        assert!(seq.starts_with("\x1bPtmux;"), "{seq:?}");
        assert!(seq.ends_with("\x1b\\"), "{seq:?}");
        // The inner OSC introducer must be escaped; an unescaped one would
        // terminate the passthrough and the copy would silently do nothing.
        assert!(seq.contains("\x1b\x1b]52;c;"), "{seq:?}");
    }

    #[test]
    fn screen_wrap_chunks_a_long_payload() {
        let seq = osc52(&"y".repeat(4096), Passthrough::Screen);
        assert!(seq.starts_with("\x1bP"));
        assert!(seq.matches("\x1bP").count() > 1, "expected >1 DCS chunk");
    }

    #[test]
    fn zellij_is_not_wrapped_even_when_tmux_is_also_set() {
        let z = |k: &str| match k {
            "ZELLIJ" => Some("0".to_string()),
            "TMUX" => Some("/tmp/tmux-1000/default,123,0".to_string()),
            _ => None,
        };
        assert_eq!(detect_passthrough(z), Passthrough::None);

        let t = |k: &str| match k {
            "TMUX" => Some("/tmp/tmux-1000/default,123,0".to_string()),
            _ => None,
        };
        assert_eq!(detect_passthrough(t), Passthrough::Tmux);
    }

    #[test]
    fn empty_env_vars_do_not_select_an_envelope() {
        let e = |k: &str| match k {
            "TMUX" => Some(String::new()),
            "STY" => Some(String::new()),
            _ => None,
        };
        assert_eq!(detect_passthrough(e), Passthrough::None);
    }

    #[test]
    fn screen_is_detected_from_sty() {
        let e = |k: &str| match k {
            "STY" => Some("4242.pts-0.host".to_string()),
            "TERM" => Some("screen.xterm-256color".to_string()),
            _ => None,
        };
        assert_eq!(detect_passthrough(e), Passthrough::Screen);
    }

    #[test]
    fn copy_resolves_the_block_it_was_given_and_nothing_else() {
        // The contract is "acknowledged without moving selection". `copy` takes
        // focus by value and returns no new focus, so the only way a caller
        // could move it is by doing so itself — this pins that the resolved
        // block index still names the block that was focused.
        let msgs = vec![ChatMessage::user("a"), assistant_with_tool()];
        let b = block_at(&msgs, 1).unwrap();
        assert_eq!(b.index, 1);
        assert_eq!(b, block_at(&msgs, 1).unwrap());
    }
}
