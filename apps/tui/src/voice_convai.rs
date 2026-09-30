//! Realtime operator voice — a CLIENT of the ONE shared EL/operator session
//! (universal-voice-interface-2026-06-05, P-009; supersedes the per-pui EL
//! WebSocket of voice-realtime-tui-2026-06-05).
//!
//! Topology change (D-002/D-003): the pui no longer owns the ElevenLabs
//! WebSocket. The single EL/operator session is hosted by the voice SERVICE
//! (the operator's `OperatorVoiceSession`); desktop + tui both ATTACH to it as
//! full clients over the local-audio-socket using the operator-voice bus
//! (`operator_voice_bus`, 0x10–0x1F frames). This client:
//!   • sends HELLO (attach as a `tui` client) + a `start` control (open/host),
//!   • streams mic chunks as MIC frames ONLY while it is the elected player
//!     (single mic capture, P-007 — the host also drops non-player mic),
//!   • renders RESPONSE_AUDIO to the shared rodio `Player` ONLY while elected
//!     (single playout, Model A / P-006); other clients receive the same frames
//!     but stay display-only,
//!   • surfaces INPUT_TRANSCRIPT / RESPONSE_TRANSCRIPT / SESSION_STATE as
//!     [`ConvAiUpdate`]s so the shared chat + the live badge stay in lock-step
//!     across surfaces.
//!
//! The brain loop (`ask_operator`), the EL signed-URL mint, the lease heartbeat,
//! and turn persistence all moved to the host — this surface is a thin client.
//! Detaching (toggle voice off → close the socket) lets the host re-elect or
//! tear down; the session + any other attached client survive (P-011).
//!
//! Public surface is unchanged (`start_session` / [`ConvAiHandle`] /
//! [`ConvAiUpdate`]) so `main.rs` + the `app.rs` reducer are untouched.

use crate::event::Event;
use crate::operator_voice_bus::{
    control_start, decode_op_voice_frame, encode_hello, encode_mic, is_op_voice_frame_type,
    pcm_bytes_to_i16, AudioFormat, OpVoiceIn,
};
use crate::voice::{self, Player};
use crate::voice_stream::{discover_socket_path, FrameParser};
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// Mic chunk cadence (ms). ~250 ms balances EL VAD latency against framing
/// overhead; the host re-bases the bytes into EL's `user_audio_chunk`s.
pub const MIC_CHUNK_MS: u32 = 250;

// ───────────────────────── utterance tags ─────────────────────────

/// `<set_mode>…</set_mode>` from an agent utterance — the one voice side effect
/// the TUI surfaces (as a toast). Mirrors operator-converse-voice.ts: `<say>` is
/// never re-rendered (EL spoke it), `<sleep>` is ignored on this surface. The
/// `app.rs` reducer calls this on the raw RESPONSE_TRANSCRIPT text.
pub fn utterance_set_mode(raw: &str) -> Option<String> {
    let start = raw.find("<set_mode>")? + "<set_mode>".len();
    let end = raw[start..].find("</set_mode>")? + start;
    let mode = raw[start..end].trim();
    (!mode.is_empty()).then(|| mode.to_string())
}

// ───────────────────────── session updates → App ─────────────────────────

/// Reducer-facing session updates (wrapped in `Event::ConvAi`). Unchanged shape
/// so the `app.rs` reducer is untouched by the bus-client migration.
#[derive(Debug, Clone)]
pub enum ConvAiUpdate {
    /// The shared session is live (EL connected) — the badge flips to Live.
    Connected { conversation_id: String },
    /// Host-broadcast shared-session state.
    SessionState {
        muted: bool,
        mode: String,
        is_player: bool,
    },
    /// A finished user turn (EL's STT), shown in the shared chat.
    UserTranscript(String),
    /// The agent's utterance text (raw — may carry tags; reducer strips).
    AgentText(String),
    /// The session ended for this surface (user toggle, host close). Terminal.
    Ended { reason: String },
    /// Setup or mid-session failure. Terminal.
    Error(String),
}

/// Run-loop handle (main.rs owns it; `stop()` detaches this surface).
pub struct ConvAiHandle {
    stop_tx: UnboundedSender<()>,
    writer: Arc<Mutex<Option<UnixStream>>>,
}

impl ConvAiHandle {
    pub fn stop(&self) {
        let _ = self.stop_tx.send(());
    }

    pub fn control(&self, control: ConvAiControl) {
        let frame = match control {
            ConvAiControl::Mute(muted) => crate::operator_voice_bus::control_mute(muted),
            ConvAiControl::Ptt(down) => crate::operator_voice_bus::control_ptt(down),
            ConvAiControl::SetMode(mode) => crate::operator_voice_bus::control_set_mode(mode),
            ConvAiControl::ForceHost => crate::operator_voice_bus::control_force_host(),
        };
        let _ = write_frame(&self.writer, &frame);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvAiControl {
    Mute(bool),
    Ptt(bool),
    SetMode(&'static str),
    ForceHost,
}

/// Spawn the session client. `owner` is the pui's coordination identity (the
/// voice-lease owner id, also the bus client id); `player` is the shared
/// playback handle.
pub fn start_session(owner: String, player: Player, tx: UnboundedSender<Event>) -> ConvAiHandle {
    let (stop_tx, stop_rx) = unbounded_channel::<()>();
    let writer = Arc::new(Mutex::new(None));
    let task_writer = writer.clone();
    tokio::spawn(session_task(owner, player, tx, stop_rx, task_writer));
    ConvAiHandle { stop_tx, writer }
}

fn write_frame(writer: &Arc<Mutex<Option<UnixStream>>>, frame: &[u8]) -> std::io::Result<()> {
    match writer.lock() {
        Ok(mut w) => match w.as_mut() {
            Some(sock) => sock.write_all(frame),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "voice session not connected",
            )),
        },
        Err(_) => Err(std::io::Error::other("voice writer poisoned")),
    }
}

async fn session_task(
    owner: String,
    player: Player,
    tx: UnboundedSender<Event>,
    mut stop_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
    writer: Arc<Mutex<Option<UnixStream>>>,
) {
    let fail = |msg: String| {
        let _ = tx.send(Event::ConvAi(ConvAiUpdate::Error(msg)));
    };

    // Attach to the host-owned voice bus (the operator's local-audio-socket —
    // the EL session lives THERE now, not here).
    let path = match discover_socket_path() {
        Ok(p) => p,
        Err(e) => return fail(format!("voice: {e}")),
    };
    let stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => return fail(format!("voice connect: {e}")),
    };
    let reader_sock = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => return fail(format!("voice clone: {e}")),
    };
    if let Ok(mut slot) = writer.lock() {
        *slot = Some(stream);
    } else {
        return fail("voice writer poisoned".into());
    }

    let elected = Arc::new(AtomicBool::new(false));
    let muted = Arc::new(AtomicBool::new(false));
    let stopping = Arc::new(AtomicBool::new(false));
    // Reader → supervisor wake-up when the session ends host-side (or the socket
    // drops). The terminal ConvAiUpdate is sent by the reader; this just frees
    // the supervisor from its await so it can stop the mic + playout.
    let (ended_tx, mut ended_rx) = unbounded_channel::<()>();

    // Attach, then request host+start (this client is the opener → the host
    // elects it player; if a session is already live, the host keeps the current
    // host and we stay a receive+display client — a plain start never steals).
    let _ = write_frame(&writer, &encode_hello(&owner, "tui", None));
    let _ = write_frame(&writer, &control_start());

    // Reader thread: decode host→client frames, drive the player (gated by the
    // elected flag), surface transcripts/state.
    let reader_thread = {
        let owner = owner.clone();
        let player = player.clone();
        let tx = tx.clone();
        let elected = elected.clone();
        let muted = muted.clone();
        let stopping = stopping.clone();
        let ended_tx = ended_tx.clone();
        std::thread::Builder::new()
            .name("pui-opvoice-read".into())
            .spawn(move || {
                reader_loop(
                    reader_sock,
                    owner,
                    player,
                    tx,
                    elected,
                    muted,
                    stopping,
                    ended_tx,
                )
            })
            .ok()
    };

    // Mic capture → MIC frames, only while elected + unmuted (P-007). A mic
    // failure is non-fatal: we can still receive + display the shared session.
    let mut capture = match voice::start_stream_capture(MIC_CHUNK_MS) {
        Ok(c) => Some(c),
        Err(e) => {
            fail(format!("voice mic: {e}"));
            None
        }
    };
    if let Some(cap) = capture.as_mut() {
        if let Some(chunks) = cap.take_chunks() {
            let writer = writer.clone();
            let elected = elected.clone();
            let muted = muted.clone();
            let stopping = stopping.clone();
            std::thread::Builder::new()
                .name("pui-opvoice-mic".into())
                .spawn(move || {
                    while let Ok(chunk) = chunks.recv() {
                        if stopping.load(Ordering::Relaxed) {
                            break;
                        }
                        if elected.load(Ordering::Relaxed)
                            && !muted.load(Ordering::Relaxed)
                            && write_frame(&writer, &encode_mic(&chunk)).is_err()
                        {
                            break;
                        }
                    }
                })
                .ok();
        }
    }

    // Live until the user toggles voice off OR the host ends the session.
    tokio::select! {
        _ = stop_rx.recv() => {}
        _ = ended_rx.recv() => {}
    }
    stopping.store(true, Ordering::Relaxed);
    if let Some(cap) = capture.as_ref() {
        cap.stop();
    }
    player.stop();
    // Detach: closing the socket is what tells the host this client is gone
    // (handleClientGone → re-elect or teardown). The reader emits the terminal
    // ConvAiUpdate (Ended/Error) — on a user stop it sees `stopping` and reports
    // "voice off".
    if let Ok(mut w) = writer.lock() {
        if let Some(sock) = w.as_mut() {
            let _ = sock.shutdown(Shutdown::Both);
        }
    }
    if let Some(h) = reader_thread {
        let _ = h.join();
    }
}

#[allow(clippy::too_many_arguments)]
fn reader_loop(
    mut sock: UnixStream,
    owner: String,
    player: Player,
    tx: UnboundedSender<Event>,
    elected: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    ended_tx: UnboundedSender<()>,
) {
    let mut parser = FrameParser::default();
    let mut buf = [0u8; 16 * 1024];
    let mut connected = false;

    loop {
        let n = match sock.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for (ty, payload) in parser.push(&buf[..n]) {
            if !is_op_voice_frame_type(ty) {
                continue; // P2P-channel / status frames — not ours
            }
            match decode_op_voice_frame(ty, &payload) {
                OpVoiceIn::InputTranscript { text, is_final } => {
                    if is_final && !text.trim().is_empty() {
                        let _ = tx.send(Event::ConvAi(ConvAiUpdate::UserTranscript(text)));
                    }
                }
                OpVoiceIn::ResponseTranscript { text } => {
                    if !text.trim().is_empty() {
                        let _ = tx.send(Event::ConvAi(ConvAiUpdate::AgentText(text)));
                    }
                }
                OpVoiceIn::ResponseAudio {
                    format,
                    sample_rate,
                    audio,
                } => {
                    // Single playout (Model A): only the elected player renders.
                    if elected.load(Ordering::Relaxed) {
                        match format {
                            AudioFormat::Pcm => {
                                let rate = if sample_rate == 0 {
                                    16_000
                                } else {
                                    sample_rate
                                };
                                player.append_pcm(pcm_bytes_to_i16(&audio), rate);
                            }
                            AudioFormat::Encoded => player.append_encoded(audio),
                        }
                    }
                }
                OpVoiceIn::SessionState {
                    status,
                    mode,
                    player_id,
                    muted: m,
                    conversation_id,
                    reason,
                } => {
                    let is_player = player_id.as_deref() == Some(owner.as_str());
                    let was = elected.swap(is_player, Ordering::Relaxed);
                    muted.store(m, Ordering::Relaxed);
                    if was && !is_player {
                        player.stop(); // lost the player role → cut local playout
                    }
                    let _ = tx.send(Event::ConvAi(ConvAiUpdate::SessionState {
                        muted: m,
                        mode,
                        is_player,
                    }));
                    match status.as_str() {
                        "idle" | "listening" | "speaking" => {
                            if !connected {
                                connected = true;
                                let _ = tx.send(Event::ConvAi(ConvAiUpdate::Connected {
                                    conversation_id: conversation_id.unwrap_or_default(),
                                }));
                            }
                            if status == "listening" {
                                player.stop(); // barge-in: user speaking → silence
                            }
                        }
                        "error" => {
                            let _ = tx.send(Event::ConvAi(ConvAiUpdate::Error(
                                reason.unwrap_or_else(|| "voice error".into()),
                            )));
                            let _ = ended_tx.send(());
                            return;
                        }
                        "ended" => {
                            let _ = tx.send(Event::ConvAi(ConvAiUpdate::Ended {
                                reason: reason.unwrap_or_else(|| "voice session closed".into()),
                            }));
                            let _ = ended_tx.send(());
                            return;
                        }
                        // "off" / "connecting" = not yet live (e.g. the initial
                        // hello echo) — wait, don't treat as terminal.
                        _ => {}
                    }
                }
                OpVoiceIn::ResponseTag { .. } | OpVoiceIn::Unknown => {}
            }
        }
    }

    // Socket EOF (host gone, or our own shutdown on stop).
    let reason = if stopping.load(Ordering::Relaxed) {
        "voice off"
    } else {
        "voice session closed"
    };
    let _ = tx.send(Event::ConvAi(ConvAiUpdate::Ended {
        reason: reason.into(),
    }));
    let _ = ended_tx.send(());
}

// ───────────────────────────────── tests ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_mode_extraction_is_strict() {
        assert_eq!(
            utterance_set_mode("<say>ok</say><set_mode>passive</set_mode>"),
            Some("passive".into())
        );
        assert_eq!(utterance_set_mode("<say>ok</say>"), None);
        assert_eq!(utterance_set_mode("<set_mode></set_mode>"), None);
    }
}
