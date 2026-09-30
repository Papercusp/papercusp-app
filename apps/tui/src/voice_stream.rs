//! Continuous voice-channel streaming to the LOCAL operator voice node
//! (holepunch-voice-channels-2026-06-05 P-005 / D-010).
//!
//! The operator owns the Opus codec + the P2P swarm; this client streams raw
//! 48 kHz mono PCM16 both ways over the dedicated voice unix socket
//! (`~/.papercusp/voice-ipc.json` discovery; `[4B len BE][1B type][payload]`):
//!   0x01 CTRL (JSON both ways) · 0x02 MIC (client→operator PCM) · 0x03 MIX
//!   (operator→client mixed PCM, one 20ms frame at a time).
//!
//! Mic capture (cpal) and playback (rodio) live on dedicated OS threads like
//! `voice.rs`; the testable seam is `push_pcm()` — tests inject synthetic PCM
//! and a mock unix server, no audio hardware involved.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};

pub const CTRL: u8 = 0x01;
pub const MIC: u8 = 0x02;
pub const MIX: u8 = 0x03;
pub const VOICE_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 960; // 20ms @ 48k mono

// ---------------------------------------------------------------- framing

pub fn encode_frame(ty: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.push(ty);
    out.extend_from_slice(payload);
    out
}

/// Incremental frame parser — tolerates arbitrary chunk boundaries.
#[derive(Default)]
pub struct FrameParser {
    buf: Vec<u8>,
}

impl FrameParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<(u8, Vec<u8>)> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            if self.buf.len() < 5 {
                break;
            }
            let len =
                u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if self.buf.len() < 5 + len {
                break;
            }
            let ty = self.buf[4];
            let payload = self.buf[5..5 + len].to_vec();
            self.buf.drain(..5 + len);
            frames.push((ty, payload));
        }
        frames
    }
}

// ---------------------------------------------------------------- DSP

/// Linear-interpolation resample (mono f32). Identity when rates match.
pub fn resample_linear(mono: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || mono.is_empty() {
        return mono.to_vec();
    }
    let ratio = src_rate as f64 / dst_rate as f64;
    let out_len = ((mono.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let i0 = pos.floor() as usize;
        let frac = (pos - i0 as f64) as f32;
        let a = mono[i0.min(mono.len() - 1)];
        let b = mono[(i0 + 1).min(mono.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

fn f32_to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0) as i16
}

// ---------------------------------------------------------------- status

/// Mirror of the operator's voice status payload (subset the UI needs).
#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub struct VoicePeer {
    pub id: String,
    pub label: String,
    pub muted: bool,
    pub speaking: bool,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub struct VoiceChannelInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub struct VoiceStatus {
    pub channel: Option<VoiceChannelInfo>,
    pub muted: bool,
    #[serde(default)]
    pub peers: Vec<VoicePeer>,
    /// True while the local agent brain is speaking a reply (P-011 indicator).
    #[serde(default, rename = "agentSpeaking")]
    pub agent_speaking: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum VoiceEvent {
    Status(VoiceStatus),
    Error(String),
    Disconnected,
}

// ---------------------------------------------------------------- client

#[derive(serde::Deserialize)]
struct Discovery {
    #[serde(rename = "socketPath")]
    socket_path: String,
}

/// Resolve the operator's voice socket path from the discovery file.
pub fn discover_socket_path() -> Result<std::path::PathBuf> {
    let home = std::env::var("HOME").context("HOME unset")?;
    let p = Path::new(&home).join(".papercusp").join("voice-ipc.json");
    let raw = std::fs::read_to_string(&p)
        .with_context(|| format!("voice discovery missing at {}", p.display()))?;
    let d: Discovery = serde_json::from_str(&raw).context("bad voice-ipc.json")?;
    Ok(std::path::PathBuf::from(d.socket_path))
}

/// Holds only Sync members (Mutex/atomics) so `Arc<VoiceStream>` is Send —
/// the cpal capture callback requires it. Event/mix receivers are returned by
/// `connect_to` instead of stored here (mpsc::Receiver is !Sync).
pub struct VoiceStream {
    writer: Arc<Mutex<UnixStream>>,
    mic_level_bits: Arc<AtomicU32>,
    mic_acc: Mutex<Vec<f32>>,
    tx_gate: Mutex<TxGate>,
}

/// Open-mic VAD transmit gate (P-010). When enabled, near-silent frames are
/// dropped — with a hangover so speech tails aren't clipped — so background
/// noise during silence isn't sent. A basic noise gate; PTT mode leaves it
/// disabled (the held key is the gate). Spectral noise-suppression + AEC are a
/// separate, operator-side DSP slice (D-013) whose efficacy needs real audio.
struct TxGate {
    enabled: bool,
    hangover: u32,
}

/// RMS threshold (0..1) a frame must exceed to open the gate — just above a
/// typical idle-mic noise floor.
const TX_GATE_THRESHOLD: f32 = 0.012;
/// Frames to keep transmitting after the last loud frame (20ms each → ~400ms)
/// so the natural tail of speech isn't clipped.
const TX_HANGOVER_FRAMES: u32 = 20;

/// The pure gate decision (extracted for unit tests): should this frame, with
/// the given RMS, be transmitted? Mutates the hangover counter.
fn tx_gate_decision(g: &mut TxGate, rms: f32) -> bool {
    if !g.enabled {
        return true;
    }
    if rms >= TX_GATE_THRESHOLD {
        g.hangover = TX_HANGOVER_FRAMES;
    } else if g.hangover > 0 {
        g.hangover -= 1;
    }
    g.hangover > 0
}

impl VoiceStream {
    /// Connect via the discovery file.
    pub fn connect() -> Result<(Self, Receiver<VoiceEvent>, Receiver<Vec<i16>>)> {
        Self::connect_to(&discover_socket_path()?)
    }

    pub fn connect_to(path: &Path) -> Result<(Self, Receiver<VoiceEvent>, Receiver<Vec<i16>>)> {
        let stream = UnixStream::connect(path)
            .with_context(|| format!("voice socket connect {}", path.display()))?;
        let reader = stream.try_clone().context("voice socket clone")?;
        let writer = Arc::new(Mutex::new(stream));
        let (ev_tx, ev_rx) = channel::<VoiceEvent>();
        let (mix_tx, mix_rx) = channel::<Vec<i16>>();
        std::thread::Builder::new()
            .name("pui-voice-stream-read".into())
            .spawn(move || read_loop(reader, ev_tx, mix_tx))
            .context("spawn voice reader")?;
        Ok((
            Self {
                writer,
                mic_level_bits: Arc::new(AtomicU32::new(0)),
                mic_acc: Mutex::new(Vec::new()),
                tx_gate: Mutex::new(TxGate {
                    enabled: false,
                    hangover: 0,
                }),
            },
            ev_rx,
            mix_rx,
        ))
    }

    fn send_ctrl(&self, msg: &serde_json::Value) -> Result<()> {
        let wire = encode_frame(CTRL, msg.to_string().as_bytes());
        self.writer
            .lock()
            .map_err(|_| anyhow!("voice writer poisoned"))?
            .write_all(&wire)
            .context("voice ctrl write")
    }

    pub fn join(&self, channel: &str) -> Result<()> {
        self.send_ctrl(&serde_json::json!({ "op": "join", "channel": channel }))
    }

    pub fn leave(&self) -> Result<()> {
        self.send_ctrl(&serde_json::json!({ "op": "leave" }))
    }

    pub fn set_muted(&self, muted: bool) -> Result<()> {
        self.send_ctrl(&serde_json::json!({ "op": "mute", "muted": muted }))
    }

    pub fn request_status(&self) -> Result<()> {
        self.send_ctrl(&serde_json::json!({ "op": "status" }))
    }

    /// Mic level 0..1 (RMS of the last pushed chunk) — status-line meter feed.
    pub fn mic_level(&self) -> f32 {
        f32::from_bits(self.mic_level_bits.load(Ordering::Relaxed))
    }

    /// Enable/disable the open-mic VAD transmit gate (P-010). Open-mic → on
    /// (drop near-silent frames); PTT → off (the held key is already the gate).
    pub fn set_tx_gate(&self, enabled: bool) {
        if let Ok(mut g) = self.tx_gate.lock() {
            g.enabled = enabled;
            if !enabled {
                g.hangover = 0;
            }
        }
    }

    /// The testable mic seam: push interleaved f32 PCM at any rate/channels.
    /// Mixes to mono, resamples to 48k, accumulates exact 20ms frames, and
    /// ships each as one MIC frame. `start_mic()` feeds this from cpal.
    pub fn push_pcm(&self, samples: &[f32], channels: u16, src_rate: u32) -> Result<()> {
        let mono = crate::voice::mix_to_mono(samples, channels);
        self.mic_level_bits
            .store(crate::voice::rms(&mono).to_bits(), Ordering::Relaxed);
        let at48k = resample_linear(&mono, src_rate, VOICE_RATE);
        let mut acc = self
            .mic_acc
            .lock()
            .map_err(|_| anyhow!("mic acc poisoned"))?;
        acc.extend_from_slice(&at48k);
        while acc.len() >= FRAME_SAMPLES {
            let frame: Vec<f32> = acc.drain(..FRAME_SAMPLES).collect();
            // Open-mic VAD gate (P-010): drop near-silent frames (with hangover)
            // so silence / background noise isn't transmitted. Disabled for PTT.
            let transmit = {
                let mut g = self
                    .tx_gate
                    .lock()
                    .map_err(|_| anyhow!("tx_gate poisoned"))?;
                tx_gate_decision(&mut g, crate::voice::rms(&frame))
            };
            if !transmit {
                continue;
            }
            let mut bytes = Vec::with_capacity(FRAME_SAMPLES * 2);
            for s in frame {
                bytes.extend_from_slice(&f32_to_i16(s).to_le_bytes());
            }
            let wire = encode_frame(MIC, &bytes);
            self.writer
                .lock()
                .map_err(|_| anyhow!("voice writer poisoned"))?
                .write_all(&wire)
                .context("voice mic write")?;
        }
        Ok(())
    }
}

fn read_loop(mut sock: UnixStream, ev_tx: Sender<VoiceEvent>, mix_tx: Sender<Vec<i16>>) {
    let mut parser = FrameParser::default();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match sock.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for (ty, payload) in parser.push(&buf[..n]) {
                    match ty {
                        CTRL => {
                            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&payload) {
                                match v.get("ev").and_then(|e| e.as_str()) {
                                    Some("status") => {
                                        if let Some(s) = v.get("status") {
                                            if let Ok(st) =
                                                serde_json::from_value::<VoiceStatus>(s.clone())
                                            {
                                                let _ = ev_tx.send(VoiceEvent::Status(st));
                                            }
                                        }
                                    }
                                    Some("error") => {
                                        let msg = v
                                            .get("message")
                                            .and_then(|m| m.as_str())
                                            .unwrap_or("?");
                                        let _ = ev_tx.send(VoiceEvent::Error(msg.to_string()));
                                    }
                                    _ => {}
                                }
                            }
                        }
                        MIX => {
                            let mut frame = Vec::with_capacity(payload.len() / 2);
                            for ch in payload.chunks_exact(2) {
                                frame.push(i16::from_le_bytes([ch[0], ch[1]]));
                            }
                            let _ = mix_tx.send(frame);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    let _ = ev_tx.send(VoiceEvent::Disconnected);
}

// ---------------------------------------------------------------- audio I/O
// Hardware lives in the sibling pui-audio process. These adapters preserve the
// voice-stream API while keeping cpal/rodio (and ALSA) out of the pui binary.

/// Drop to stop the continuous mic capture.
pub struct MicHandle {
    _capture: crate::voice::StreamCapture,
}

pub fn start_mic(vs: Arc<VoiceStream>) -> Result<MicHandle> {
    let capture = crate::voice::start_raw_stream(move |samples, channels, rate| {
        vs.push_pcm(samples, channels, rate)
    })?;
    Ok(MicHandle { _capture: capture })
}

/// Spawn the playback thread: mixed frames → rodio sink. Returns when the
/// output device is open. The thread ends when the mix channel closes.
pub fn start_playback(mix_rx: Receiver<Vec<i16>>) -> Result<()> {
    let player = crate::voice::Player::spawn_ready()?;
    std::thread::Builder::new()
        .name("pui-voice-stream-playback".into())
        .spawn(move || {
            while let Ok(frame) = mix_rx.recv() {
                player.append_realtime_pcm(frame, VOICE_RATE);
            }
        })
        .context("spawn voice playback")?;
    Ok(())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn resample_identity_and_ratio() {
        let mono: Vec<f32> = (0..480).map(|i| (i as f32) / 480.0).collect();
        assert_eq!(resample_linear(&mono, 48_000, 48_000).len(), 480);
        let up = resample_linear(&mono, 24_000, 48_000);
        assert!(
            (up.len() as i64 - 960).abs() <= 1,
            "24k→48k doubles: {}",
            up.len()
        );
        let down = resample_linear(&mono, 48_000, 16_000);
        assert!(
            (down.len() as i64 - 160).abs() <= 1,
            "48k→16k thirds: {}",
            down.len()
        );
        // monotone ramp stays monotone under linear interp
        assert!(up.windows(2).all(|w| w[1] >= w[0] - f32::EPSILON));
    }

    #[test]
    fn tx_gate_decision_gates_silence_with_hangover() {
        // Disabled gate (PTT): every frame transmits.
        let mut g = TxGate {
            enabled: false,
            hangover: 0,
        };
        assert!(tx_gate_decision(&mut g, 0.0));
        assert!(tx_gate_decision(&mut g, 0.5));
        // Enabled gate (open-mic): silence with no hangover is dropped.
        let mut g = TxGate {
            enabled: true,
            hangover: 0,
        };
        assert!(!tx_gate_decision(&mut g, 0.0));
        // A loud frame transmits and arms the hangover.
        assert!(tx_gate_decision(&mut g, 0.5));
        // The tail right after speech still transmits (hangover keeps it open).
        assert!(tx_gate_decision(&mut g, 0.0));
        // Sustained silence eventually gates transmit off.
        for _ in 0..TX_HANGOVER_FRAMES {
            tx_gate_decision(&mut g, 0.0);
        }
        assert!(!tx_gate_decision(&mut g, 0.0));
    }

    #[test]
    fn frame_parser_handles_fragmentation_and_coalescing() {
        let a = encode_frame(CTRL, br#"{"op":"status"}"#);
        let b = encode_frame(MIC, &[1, 2, 3, 4]);
        let mut joined = a.clone();
        joined.extend_from_slice(&b);
        // byte-at-a-time
        let mut p = FrameParser::default();
        let mut got = Vec::new();
        for byte in &joined {
            got.extend(p.push(&[*byte]));
        }
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, CTRL);
        assert_eq!(got[1], (MIC, vec![1, 2, 3, 4]));
    }

    /// Mock-operator loopback: CTRL join answered with a status, MIC frames
    /// echoed back as MIX — the full client pipeline without audio hardware.
    #[test]
    fn loopback_against_mock_operator() {
        let dir = std::env::temp_dir().join(format!("pui-voice-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("voice.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        // mock operator: parse frames; join → status; MIC → echo as MIX
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut writer = sock.try_clone().unwrap();
            let mut parser = FrameParser::default();
            let mut buf = [0u8; 4096];
            let mut mic_frames = 0usize;
            loop {
                let n = match sock.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                for (ty, payload) in parser.push(&buf[..n]) {
                    match ty {
                        CTRL => {
                            let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
                            if v["op"] == "join" {
                                let status = serde_json::json!({
                                    "ev": "status",
                                    "status": {
                                        "channel": { "id": "vc-1", "name": v["channel"] },
                                        "muted": false,
                                        "peers": [{ "id": "B", "label": "Bob", "muted": false, "speaking": true }],
                                    }
                                });
                                writer
                                    .write_all(&encode_frame(CTRL, status.to_string().as_bytes()))
                                    .unwrap();
                            }
                        }
                        MIC => {
                            mic_frames += 1;
                            writer.write_all(&encode_frame(MIX, &payload)).unwrap();
                        }
                        _ => {}
                    }
                }
                if mic_frames >= 2 {
                    break;
                }
            }
            mic_frames
        });

        let (vs, events, mix) = VoiceStream::connect_to(&path).unwrap();
        vs.join("standup").unwrap();

        let ev = events
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        match ev {
            VoiceEvent::Status(st) => {
                assert_eq!(st.channel.as_ref().unwrap().id, "vc-1");
                assert_eq!(st.peers.len(), 1);
                assert!(st.peers[0].speaking);
            }
            other => panic!("expected status, got {other:?}"),
        }

        // push 2.5 frames of 48k mono; expect exactly 2 MIC frames shipped,
        // echoed back as 2 MIX frames of FRAME_SAMPLES each.
        let pcm: Vec<f32> = (0..(FRAME_SAMPLES * 5 / 2))
            .map(|i| ((i % 100) as f32) / 200.0)
            .collect();
        vs.push_pcm(&pcm, 1, VOICE_RATE).unwrap();
        assert!(vs.mic_level() > 0.0);

        let f1 = mix.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
        let f2 = mix.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
        assert_eq!(f1.len(), FRAME_SAMPLES);
        assert_eq!(f2.len(), FRAME_SAMPLES);
        assert_eq!(server.join().unwrap(), 2);

        // half-frame remainder completes on the next push → a third frame
        // would need another server loop; parser-side already covered above.
        let _ = std::fs::remove_file(&path);
    }

    /// P-013 reconnect-on-drop: a dropped operator socket surfaces a
    /// `Disconnected` event (which the run loop turns into clearing its
    /// `voice_chan`), and a fresh `connect_to` afterwards works cleanly — there
    /// is no lingering per-process state that would block reconnection.
    #[test]
    fn disconnect_emits_event_then_reconnect_works() {
        use std::time::Duration;
        let dir = std::env::temp_dir().join(format!("pui-voice-recon-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("voice.sock");
        let _ = std::fs::remove_file(&path);

        // First operator: accept once, hold briefly, then close the connection.
        let listener = UnixListener::bind(&path).unwrap();
        let srv1 = std::thread::spawn(move || {
            let (sock, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(50));
            drop(sock); // close → the client read_loop sees EOF → Disconnected
        });
        let (vs1, events1, _mix1) = VoiceStream::connect_to(&path).unwrap();
        // The drop surfaces as a Disconnected event.
        loop {
            match events1.recv_timeout(Duration::from_secs(3)).unwrap() {
                VoiceEvent::Disconnected => break,
                _ => continue,
            }
        }
        srv1.join().unwrap();
        drop(vs1); // emulate the run loop releasing voice_chan on Disconnected

        // Reconnect: fresh listener on the same path, fresh VoiceStream.
        let _ = std::fs::remove_file(&path);
        let listener2 = UnixListener::bind(&path).unwrap();
        let srv2 = std::thread::spawn(move || {
            let (mut sock, _) = listener2.accept().unwrap();
            let mut writer = sock.try_clone().unwrap();
            let mut parser = FrameParser::default();
            let mut buf = [0u8; 4096];
            'outer: loop {
                let n = match sock.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                for (ty, payload) in parser.push(&buf[..n]) {
                    if ty == CTRL {
                        let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
                        if v["op"] == "join" {
                            let status = serde_json::json!({
                                "ev": "status",
                                "status": {
                                    "channel": { "id": "vc-1", "name": v["channel"] },
                                    "muted": false,
                                    "peers": [],
                                }
                            });
                            writer
                                .write_all(&encode_frame(CTRL, status.to_string().as_bytes()))
                                .unwrap();
                            break 'outer;
                        }
                    }
                }
            }
        });
        let (vs2, events2, _mix2) = VoiceStream::connect_to(&path).unwrap();
        vs2.join("standup").unwrap();
        let ev = events2.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(
            matches!(ev, VoiceEvent::Status(_)),
            "reconnected + got status"
        );
        srv2.join().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn push_pcm_resamples_foreign_rates_into_exact_frames() {
        // 44.1k stereo in → 48k mono frames out; verify via a mock socket pair.
        let dir = std::env::temp_dir().join(format!("pui-voice-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("voice.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut parser = FrameParser::default();
            let mut buf = [0u8; 8192];
            let mut frames = Vec::new();
            // 4410 mono samples @44.1k resample to exactly 4800 @48k = 5 frames.
            while frames.len() < 5 {
                let n = match sock.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                for (ty, payload) in parser.push(&buf[..n]) {
                    if ty == MIC {
                        frames.push(payload.len());
                    }
                }
            }
            frames
        });
        let (vs, _events, _mix) = VoiceStream::connect_to(&path).unwrap();
        // 44.1k stereo: 2 interleaved channels → 4410 mono samples → 4800 @48k
        let stereo: Vec<f32> = (0..(4410 * 2)).map(|i| ((i % 7) as f32) / 10.0).collect();
        vs.push_pcm(&stereo, 2, 44_100).unwrap();
        let sizes = server.join().unwrap();
        assert_eq!(
            sizes.len(),
            5,
            "expected exactly 5 MIC frames, got {}",
            sizes.len()
        );
        assert!(
            sizes.iter().all(|s| *s == FRAME_SAMPLES * 2),
            "exact 1920B frames: {sizes:?}"
        );
        let _ = std::fs::remove_file(&path);
    }
}
