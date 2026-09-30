//! Operator-voice session bus codec (pui client side) — the Rust mirror of
//! `packages/operator-core/lib/voice-node/operator-voice-bus.ts`
//! (universal-voice-interface-2026-06-05, P-009).
//!
//! The pui attaches to the ONE shared EL/operator voice session as a full
//! client over the local-audio-socket using the 0x10–0x1F frame block: it sends
//! HELLO / MIC / CONTROL and receives INPUT_TRANSCRIPT / RESPONSE_AUDIO /
//! RESPONSE_TRANSCRIPT / RESPONSE_TAG / SESSION_STATE. The framing itself is the
//! shared `[4B len BE][1B type][payload]` (`voice_stream::encode_frame`); these
//! type bytes + payload shapes must stay byte-identical to the TS codec.

use crate::voice_stream::encode_frame;

// inbound (client → host)
pub const OPV_HELLO: u8 = 0x10;
pub const OPV_MIC: u8 = 0x11;
pub const OPV_CONTROL: u8 = 0x12;
// outbound (host → clients)
pub const OPV_INPUT_TRANSCRIPT: u8 = 0x13;
pub const OPV_RESPONSE_AUDIO: u8 = 0x14;
pub const OPV_RESPONSE_TRANSCRIPT: u8 = 0x15;
pub const OPV_RESPONSE_TAG: u8 = 0x16;
pub const OPV_SESSION_STATE: u8 = 0x17;

pub const OPV_TYPE_MIN: u8 = 0x10;
pub const OPV_TYPE_MAX: u8 = 0x1f;

// RESPONSE_AUDIO format byte: 0x00 = raw PCM16 LE, 0x01 = encoded (mp3/…).
const AUDIO_FMT_ENCODED: u8 = 0x01;

/// True for a type byte in the operator-voice block — lets the reader route.
pub fn is_op_voice_frame_type(t: u8) -> bool {
    (OPV_TYPE_MIN..=OPV_TYPE_MAX).contains(&t)
}

// ───────────────────────── encoders (client → host) ─────────────────────────

/// `HELLO` — `clientId` is this client's voice-lease owner id, `clientKind` is
/// `"tui"` here.
pub fn encode_hello(client_id: &str, client_kind: &str, label: Option<&str>) -> Vec<u8> {
    let mut m = serde_json::json!({ "clientId": client_id, "clientKind": client_kind });
    if let Some(l) = label {
        m["label"] = serde_json::Value::String(l.to_string());
    }
    encode_frame(OPV_HELLO, m.to_string().as_bytes())
}

/// `MIC` — one chunk of raw PCM16 LE mono @16 kHz (the EL input format), framed
/// verbatim (no base64 — the host forwards the bytes to EL).
pub fn encode_mic(pcm16le: &[u8]) -> Vec<u8> {
    encode_frame(OPV_MIC, pcm16le)
}

fn encode_control(control: serde_json::Value) -> Vec<u8> {
    encode_frame(OPV_CONTROL, control.to_string().as_bytes())
}

pub fn control_start() -> Vec<u8> {
    encode_control(serde_json::json!({ "op": "start" }))
}

// The remaining control builders are the complete bus control surface (P-004:
// any attached client may mute/PTT/set-mode/stop, or force-host to take over
// playout). mute/ptt/set-mode/force-host are wired to pui keybindings via
// `voice_convai::ConvAiHandle::control` (M / v-hold / A / H while the shared
// session is live). `control_stop` alone stays unwired: the pui detaches by
// closing its socket (handleClientGone re-elects or tears down) rather than
// stopping the SHARED session for every surface — it's kept (allow(dead_code))
// so the codec mirror + tests stay byte-complete against the TS side.
#[allow(dead_code)]
pub fn control_stop() -> Vec<u8> {
    encode_control(serde_json::json!({ "op": "stop" }))
}
pub fn control_force_host() -> Vec<u8> {
    encode_control(serde_json::json!({ "op": "force-host" }))
}
pub fn control_mute(muted: bool) -> Vec<u8> {
    encode_control(serde_json::json!({ "op": "mute", "muted": muted }))
}
pub fn control_ptt(down: bool) -> Vec<u8> {
    encode_control(serde_json::json!({ "op": "ptt", "down": down }))
}
pub fn control_set_mode(mode: &str) -> Vec<u8> {
    encode_control(serde_json::json!({ "op": "set-mode", "mode": mode }))
}

// ───────────────────────── inbound (host → client) ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioFormat {
    Pcm,
    Encoded,
}

/// A decoded host→client operator-voice message. Unknown/foreign frames and
/// malformed payloads decode to `Unknown` (tolerant by design).
#[derive(Debug, Clone, PartialEq)]
pub enum OpVoiceIn {
    InputTranscript {
        text: String,
        is_final: bool,
    },
    ResponseAudio {
        format: AudioFormat,
        sample_rate: u32,
        audio: Vec<u8>,
    },
    ResponseTranscript {
        text: String,
    },
    ResponseTag {
        tag: String,
        value: String,
    },
    SessionState {
        status: String,
        muted: bool,
        mode: String,
        player_id: Option<String>,
        conversation_id: Option<String>,
        reason: Option<String>,
    },
    Unknown,
}

fn jstr(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn jopt(v: &serde_json::Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(str::to_string)
}

/// Decode one framed operator-voice message (the type byte + its payload).
pub fn decode_op_voice_frame(ty: u8, payload: &[u8]) -> OpVoiceIn {
    match ty {
        OPV_INPUT_TRANSCRIPT => match serde_json::from_slice::<serde_json::Value>(payload) {
            Ok(v) => OpVoiceIn::InputTranscript {
                text: jstr(&v, "text"),
                is_final: v.get("final").and_then(|x| x.as_bool()).unwrap_or(false),
            },
            Err(_) => OpVoiceIn::Unknown,
        },
        OPV_RESPONSE_AUDIO => {
            if payload.len() < 5 {
                return OpVoiceIn::Unknown;
            }
            let format = if payload[0] == AUDIO_FMT_ENCODED {
                AudioFormat::Encoded
            } else {
                AudioFormat::Pcm
            };
            let sample_rate = u32::from_be_bytes([payload[1], payload[2], payload[3], payload[4]]);
            OpVoiceIn::ResponseAudio {
                format,
                sample_rate,
                audio: payload[5..].to_vec(),
            }
        }
        OPV_RESPONSE_TRANSCRIPT => match serde_json::from_slice::<serde_json::Value>(payload) {
            Ok(v) => OpVoiceIn::ResponseTranscript {
                text: jstr(&v, "text"),
            },
            Err(_) => OpVoiceIn::Unknown,
        },
        OPV_RESPONSE_TAG => match serde_json::from_slice::<serde_json::Value>(payload) {
            Ok(v) => OpVoiceIn::ResponseTag {
                tag: jstr(&v, "tag"),
                value: jstr(&v, "value"),
            },
            Err(_) => OpVoiceIn::Unknown,
        },
        OPV_SESSION_STATE => match serde_json::from_slice::<serde_json::Value>(payload) {
            Ok(v) => OpVoiceIn::SessionState {
                status: {
                    let s = jstr(&v, "status");
                    if s.is_empty() {
                        "idle".into()
                    } else {
                        s
                    }
                },
                muted: v.get("muted").and_then(|x| x.as_bool()).unwrap_or(false),
                mode: jstr(&v, "mode"),
                player_id: jopt(&v, "playerId"),
                conversation_id: jopt(&v, "conversationId"),
                reason: jopt(&v, "reason"),
            },
            Err(_) => OpVoiceIn::Unknown,
        },
        _ => OpVoiceIn::Unknown,
    }
}

/// Decode `[fmt][rate BE][audio]` RESPONSE_AUDIO PCM bytes to i16 samples (LE
/// pairs) for the rodio player. Encoded payloads are handed to rodio whole.
pub fn pcm_bytes_to_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|p| i16::from_le_bytes([p[0], p[1]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_stream::FrameParser;

    /// Encode → push through the shared FrameParser → decode the one frame back.
    fn round_trip(framed: &[u8]) -> OpVoiceIn {
        let mut p = FrameParser::default();
        let frames = p.push(framed);
        assert_eq!(frames.len(), 1, "exactly one frame");
        decode_op_voice_frame(frames[0].0, &frames[0].1)
    }

    #[test]
    fn routes_only_its_own_block() {
        assert!(is_op_voice_frame_type(OPV_TYPE_MIN));
        assert!(is_op_voice_frame_type(OPV_TYPE_MAX));
        assert!(!is_op_voice_frame_type(0x0f)); // video/p2p growth
        assert!(!is_op_voice_frame_type(0x04)); // VIDEO
        assert!(!is_op_voice_frame_type(0x01)); // CTRL
        assert!(!is_op_voice_frame_type(0x20));
    }

    #[test]
    fn encodes_hello_with_and_without_label() {
        let mut p = FrameParser::default();
        let frames = p.push(&encode_hello("pui-1", "tui", Some("PUI")));
        assert_eq!(frames[0].0, OPV_HELLO);
        let v: serde_json::Value = serde_json::from_slice(&frames[0].1).unwrap();
        assert_eq!(v["clientId"], "pui-1");
        assert_eq!(v["clientKind"], "tui");
        assert_eq!(v["label"], "PUI");

        let mut p2 = FrameParser::default();
        let f2 = p2.push(&encode_hello("pui-2", "tui", None));
        let v2: serde_json::Value = serde_json::from_slice(&f2[0].1).unwrap();
        assert!(v2.get("label").is_none());
    }

    #[test]
    fn encodes_mic_as_raw_bytes() {
        let mut p = FrameParser::default();
        let frames = p.push(&encode_mic(&[1, 2, 3, 4, 250]));
        assert_eq!(frames[0].0, OPV_MIC);
        assert_eq!(frames[0].1, vec![1, 2, 3, 4, 250]);
    }

    #[test]
    fn encodes_every_control_op() {
        for (framed, want) in [
            (control_start(), serde_json::json!({ "op": "start" })),
            (control_stop(), serde_json::json!({ "op": "stop" })),
            (
                control_force_host(),
                serde_json::json!({ "op": "force-host" }),
            ),
            (
                control_mute(true),
                serde_json::json!({ "op": "mute", "muted": true }),
            ),
            (
                control_ptt(false),
                serde_json::json!({ "op": "ptt", "down": false }),
            ),
            (
                control_set_mode("always-on"),
                serde_json::json!({ "op": "set-mode", "mode": "always-on" }),
            ),
        ] {
            let mut p = FrameParser::default();
            let frames = p.push(&framed);
            assert_eq!(frames[0].0, OPV_CONTROL);
            let v: serde_json::Value = serde_json::from_slice(&frames[0].1).unwrap();
            assert_eq!(v, want);
        }
    }

    #[test]
    fn decodes_input_transcript() {
        // host frame: encode_frame(0x13, {"text":..,"final":..})
        let framed = encode_frame(
            OPV_INPUT_TRANSCRIPT,
            br#"{"text":"hello there","final":true}"#,
        );
        assert_eq!(
            round_trip(&framed),
            OpVoiceIn::InputTranscript {
                text: "hello there".into(),
                is_final: true
            }
        );
    }

    #[test]
    fn decodes_response_audio_pcm_and_encoded() {
        // pcm: [0x00][rate BE: 16000][audio bytes]
        let mut pcm = vec![0x00u8];
        pcm.extend_from_slice(&16_000u32.to_be_bytes());
        pcm.extend_from_slice(&[1, 2, 3, 4]);
        let framed = encode_frame(OPV_RESPONSE_AUDIO, &pcm);
        match round_trip(&framed) {
            OpVoiceIn::ResponseAudio {
                format,
                sample_rate,
                audio,
            } => {
                assert_eq!(format, AudioFormat::Pcm);
                assert_eq!(sample_rate, 16_000);
                assert_eq!(audio, vec![1, 2, 3, 4]);
                assert_eq!(
                    pcm_bytes_to_i16(&audio),
                    vec![i16::from_le_bytes([1, 2]), i16::from_le_bytes([3, 4])]
                );
            }
            other => panic!("expected response_audio, got {other:?}"),
        }

        let mut enc = vec![AUDIO_FMT_ENCODED];
        enc.extend_from_slice(&0u32.to_be_bytes());
        enc.extend_from_slice(&[9, 9, 9]);
        match round_trip(&encode_frame(OPV_RESPONSE_AUDIO, &enc)) {
            OpVoiceIn::ResponseAudio { format, audio, .. } => {
                assert_eq!(format, AudioFormat::Encoded);
                assert_eq!(audio, vec![9, 9, 9]);
            }
            other => panic!("expected encoded audio, got {other:?}"),
        }
    }

    #[test]
    fn decodes_transcript_tag_and_state() {
        assert_eq!(
            round_trip(&encode_frame(
                OPV_RESPONSE_TRANSCRIPT,
                br#"{"text":"<say>hi</say>"}"#
            )),
            OpVoiceIn::ResponseTranscript {
                text: "<say>hi</say>".into()
            }
        );
        assert_eq!(
            round_trip(&encode_frame(
                OPV_RESPONSE_TAG,
                br#"{"tag":"set_mode","value":"passive"}"#
            )),
            OpVoiceIn::ResponseTag {
                tag: "set_mode".into(),
                value: "passive".into()
            }
        );
        match round_trip(&encode_frame(
            OPV_SESSION_STATE,
            br#"{"status":"speaking","muted":false,"mode":"always-on","playerId":"pui-1","conversationId":"conv_1"}"#,
        )) {
            OpVoiceIn::SessionState { status, player_id, conversation_id, .. } => {
                assert_eq!(status, "speaking");
                assert_eq!(player_id.as_deref(), Some("pui-1"));
                assert_eq!(conversation_id.as_deref(), Some("conv_1"));
            }
            other => panic!("expected session_state, got {other:?}"),
        }
    }

    #[test]
    fn session_state_nulls_and_unknown_status_tolerated() {
        match round_trip(&encode_frame(
            OPV_SESSION_STATE,
            br#"{"status":"on-fire","muted":true,"mode":"","playerId":null,"conversationId":null}"#,
        )) {
            OpVoiceIn::SessionState {
                status, player_id, ..
            } => {
                // unknown statuses pass through as-is on the client (display-only)
                assert_eq!(status, "on-fire");
                assert_eq!(player_id, None);
            }
            other => panic!("expected session_state, got {other:?}"),
        }
    }

    #[test]
    fn foreign_and_malformed_frames_decode_to_unknown() {
        // a CTRL (0x01) frame is not ours
        assert_eq!(
            decode_op_voice_frame(0x01, br#"{"x":1}"#),
            OpVoiceIn::Unknown
        );
        // malformed JSON in an opvoice JSON slot
        assert_eq!(
            decode_op_voice_frame(OPV_INPUT_TRANSCRIPT, &[0xff, 0xfe]),
            OpVoiceIn::Unknown
        );
        // too-short response audio
        assert_eq!(
            decode_op_voice_frame(OPV_RESPONSE_AUDIO, &[0x00, 0x01]),
            OpVoiceIn::Unknown
        );
    }
}
