//! Rust mirror of the TS frame codec. Encoder output and decoder behavior must
//! match byte-for-byte.
//!
//! ⚠ The TS source of truth is `libs/generic/ipc-framing/src/index.ts`. It was
//! extracted there (papercusp-systems-abstraction-2026-05-29 P-030);
//! `packages/operator-core/lib/endpoint-ipc/framing.ts` is now only a
//! re-export shim, and the `apps/operator/...` path this comment used to name
//! no longer exists at all. The byte-for-byte contract is pinned by a shared
//! golden-vector test asserted on BOTH sides — see `golden_request_frame_matches_ts`
//! below and its twin in `libs/generic/ipc-framing/src/index.test.ts`.
//!
//! Frame format (per packages/operator-core/lib/endpoint-ipc/PROTOCOL.md):
//!   [4B length BE][1B type][payload (length bytes)]
//!
//! Big-endian for all multi-byte integers. 16 MiB per-frame cap.

#![allow(dead_code)] // wired in by endpoint_ipc.rs once that lands

use bytes::{Buf, BufMut, BytesMut};
use std::collections::VecDeque;

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameType {
    Request = 0x01,
    EventJson = 0x02,
    Done = 0x03,
    Error = 0x04,
    EventBin = 0x05,
    Cancel = 0x06,
    // 0x07 is RESERVED, not free. It was DATA, a client -> server frame added by
    // no-http-anywhere-2026-07-28 P-012 to make the channel full duplex. Removed
    // on that same plan (WI-7545): both of its stated consumers went away — P-014
    // (PTY/voice onto the shim) was refuted, and P-013 shipped a WebSocket GUARD
    // rather than a data-carrying shim, so nothing ever sent one. Do not reuse
    // 0x07 for a new frame type; `from_u8` rejects it and a test pins that.
}

impl FrameType {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0x01 => Some(Self::Request),
            0x02 => Some(Self::EventJson),
            0x03 => Some(Self::Done),
            0x04 => Some(Self::Error),
            0x05 => Some(Self::EventBin),
            0x06 => Some(Self::Cancel),
            _ => None,
        }
    }
}

pub const HEADER_BYTES: usize = 5;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub struct Frame {
    pub frame_type: FrameType,
    pub payload: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame payload too large: {0} bytes (cap {})", MAX_FRAME_BYTES)]
    TooLarge(usize),
    #[error("incoming frame length too large: {0} bytes (cap {})", MAX_FRAME_BYTES)]
    IncomingTooLarge(usize),
    #[error("unknown frame type: 0x{0:02x}")]
    UnknownType(u8),
    #[error("EVENT_BIN payload too short: {0} bytes")]
    EventBinTooShort(usize),
    #[error("EVENT_BIN nameLen={0} exceeds payload ({1} bytes)")]
    EventBinNameLenOverflow(u32, usize),
}

/// Encode a frame into a freshly-allocated Vec<u8>. Use when you want
/// to write to an `AsyncWrite` in one go.
pub fn encode_frame(frame_type: FrameType, payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(payload.len()));
    }
    let mut out = Vec::with_capacity(HEADER_BYTES + payload.len());
    out.put_u32(payload.len() as u32);
    out.put_u8(frame_type as u8);
    out.extend_from_slice(payload);
    Ok(out)
}

/// Encode an EVENT_BIN payload. Layout: [8B id BE][4B nameLen BE][name UTF-8][binary].
pub fn encode_event_bin_payload(id: u64, name: &str, binary: &[u8]) -> Vec<u8> {
    let name_bytes = name.as_bytes();
    let mut out = Vec::with_capacity(8 + 4 + name_bytes.len() + binary.len());
    out.put_u64(id);
    out.put_u32(name_bytes.len() as u32);
    out.extend_from_slice(name_bytes);
    out.extend_from_slice(binary);
    out
}

#[derive(Debug)]
pub struct DecodedEventBin {
    pub id: u64,
    pub name: String,
    pub binary: Vec<u8>,
}

/// Validate an EVENT_BIN payload and return only the call id used to route it.
///
/// The desktop reader forwards the original payload directly through Tauri's
/// raw channel response, so it must not allocate/copy the multi-megabyte binary
/// tail merely to discover which per-call channel owns it.
pub fn decode_event_bin_routing_id(payload: &[u8]) -> Result<u64, FrameError> {
    if payload.len() < 12 {
        return Err(FrameError::EventBinTooShort(payload.len()));
    }
    let id = u64::from_be_bytes(payload[0..8].try_into().expect("8-byte id slice"));
    let name_len = u32::from_be_bytes(payload[8..12].try_into().expect("4-byte name length"));
    if 12 + name_len as usize > payload.len() {
        return Err(FrameError::EventBinNameLenOverflow(name_len, payload.len()));
    }
    Ok(id)
}

pub fn decode_event_bin_payload(payload: &[u8]) -> Result<DecodedEventBin, FrameError> {
    decode_event_bin_routing_id(payload)?;
    let mut cursor = &payload[..];
    let id = cursor.get_u64();
    let name_len = cursor.get_u32();
    if 12 + name_len as usize > payload.len() {
        return Err(FrameError::EventBinNameLenOverflow(name_len, payload.len()));
    }
    let (name_bytes, rest) = cursor.split_at(name_len as usize);
    let name = String::from_utf8_lossy(name_bytes).into_owned();
    Ok(DecodedEventBin {
        id,
        name,
        binary: rest.to_vec(),
    })
}

/// Streaming decoder. Push bytes via `push`; drain ready frames via `drain`.
/// On `FrameError`, caller should close the underlying socket.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buf: BytesMut,
    ready: VecDeque<Frame>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<(), FrameError> {
        self.buf.extend_from_slice(chunk);
        loop {
            if self.buf.len() < HEADER_BYTES {
                break;
            }
            // Peek without consuming so we can return cleanly on partial frames.
            let len =
                u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if len > MAX_FRAME_BYTES {
                return Err(FrameError::IncomingTooLarge(len));
            }
            let total = HEADER_BYTES + len;
            if self.buf.len() < total {
                break;
            }
            // Now we have a full frame — advance.
            let _ = self.buf.split_to(4); // length
            let type_byte = self.buf.get_u8();
            let frame_type =
                FrameType::from_u8(type_byte).ok_or(FrameError::UnknownType(type_byte))?;
            let payload = self.buf.split_to(len).to_vec();
            self.ready.push_back(Frame {
                frame_type,
                payload,
            });
        }
        Ok(())
    }

    pub fn drain(&mut self) -> Vec<Frame> {
        self.ready.drain(..).collect()
    }

    pub fn buffered_bytes(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_frame_writes_len_be_type_payload() {
        let f = encode_frame(FrameType::Request, b"hello").unwrap();
        assert_eq!(f.len(), HEADER_BYTES + 5);
        assert_eq!(&f[0..4], &[0, 0, 0, 5]);
        assert_eq!(f[4], FrameType::Request as u8);
        assert_eq!(&f[5..], b"hello");
    }

    #[test]
    fn encode_frame_rejects_oversized() {
        let huge = vec![0u8; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            encode_frame(FrameType::EventBin, &huge),
            Err(FrameError::TooLarge(_)),
        ));
    }

    #[test]
    fn encode_frame_zero_length() {
        let f = encode_frame(FrameType::Cancel, b"").unwrap();
        assert_eq!(f.len(), HEADER_BYTES);
        assert_eq!(&f[0..4], &[0, 0, 0, 0]);
        assert_eq!(f[4], FrameType::Cancel as u8);
    }

    #[test]
    fn event_bin_payload_round_trip() {
        let payload = encode_event_bin_payload(
            123_456_789_012_345u64,
            "image_chunk",
            &[0xde, 0xad, 0xbe, 0xef],
        );
        let decoded = decode_event_bin_payload(&payload).unwrap();
        assert_eq!(
            decode_event_bin_routing_id(&payload).unwrap(),
            123_456_789_012_345u64
        );
        assert_eq!(decoded.id, 123_456_789_012_345u64);
        assert_eq!(decoded.name, "image_chunk");
        assert_eq!(decoded.binary, vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn event_bin_truncated_payload() {
        let bad = vec![1u8, 2, 3];
        assert!(matches!(
            decode_event_bin_payload(&bad),
            Err(FrameError::EventBinTooShort(_)),
        ));
    }

    #[test]
    fn event_bin_namelen_overflow() {
        let mut bad = Vec::with_capacity(16);
        bad.put_u64(1u64);
        bad.put_u32(999u32); // claim name is 999 bytes
        bad.extend_from_slice(b"name"); // but only 4 bytes follow
        assert!(matches!(
            decode_event_bin_payload(&bad),
            Err(FrameError::EventBinNameLenOverflow(999, _)),
        ));
    }

    #[test]
    fn event_bin_empty_binary_tail() {
        let payload = encode_event_bin_payload(1, "pulse", &[]);
        let decoded = decode_event_bin_payload(&payload).unwrap();
        assert!(decoded.binary.is_empty());
    }

    #[test]
    fn decoder_single_frame_in_one_chunk() {
        let mut dec = FrameDecoder::new();
        let frame = encode_frame(FrameType::Done, b"{\"id\":1}").unwrap();
        dec.push(&frame).unwrap();
        let out = dec.drain();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].frame_type, FrameType::Done);
        assert_eq!(out[0].payload, b"{\"id\":1}".to_vec());
    }

    #[test]
    fn decoder_multiple_frames_in_one_chunk() {
        let mut dec = FrameDecoder::new();
        let f1 = encode_frame(FrameType::EventJson, b"{\"id\":1}").unwrap();
        let f2 = encode_frame(FrameType::EventJson, b"{\"id\":1}").unwrap();
        let f3 = encode_frame(FrameType::Done, b"{\"id\":1}").unwrap();
        let mut combined = Vec::new();
        combined.extend_from_slice(&f1);
        combined.extend_from_slice(&f2);
        combined.extend_from_slice(&f3);
        dec.push(&combined).unwrap();
        let out = dec.drain();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].frame_type, FrameType::EventJson);
        assert_eq!(out[1].frame_type, FrameType::EventJson);
        assert_eq!(out[2].frame_type, FrameType::Done);
    }

    #[test]
    fn decoder_handles_byte_by_byte_chunks() {
        let mut dec = FrameDecoder::new();
        let payload_str = format!(r#"{{"id":42,"name":"big","data":"{}"}}"#, "x".repeat(500));
        let frame = encode_frame(FrameType::EventJson, payload_str.as_bytes()).unwrap();
        for byte in frame.iter() {
            dec.push(&[*byte]).unwrap();
        }
        let out = dec.drain();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].frame_type, FrameType::EventJson);
        assert_eq!(out[0].payload, payload_str.into_bytes());
    }

    #[test]
    fn decoder_buffers_partial_frame() {
        let mut dec = FrameDecoder::new();
        let frame = encode_frame(FrameType::EventJson, b"{\"id\":1}").unwrap();
        dec.push(&frame[..3]).unwrap();
        assert_eq!(dec.drain().len(), 0);
        assert_eq!(dec.buffered_bytes(), 3);
        dec.push(&frame[3..]).unwrap();
        let out = dec.drain();
        assert_eq!(out.len(), 1);
        assert_eq!(dec.buffered_bytes(), 0);
    }

    #[test]
    fn decoder_rejects_unknown_frame_type() {
        let mut dec = FrameDecoder::new();
        // length=0, type=0x99
        let bad = vec![0u8, 0, 0, 0, 0x99];
        assert!(matches!(dec.push(&bad), Err(FrameError::UnknownType(0x99)),));
    }

    #[test]
    fn decoder_rejects_oversized_length_in_header() {
        let mut dec = FrameDecoder::new();
        let mut bad = Vec::with_capacity(HEADER_BYTES);
        bad.put_u32((MAX_FRAME_BYTES + 1) as u32);
        bad.put_u8(FrameType::Request as u8);
        assert!(matches!(
            dec.push(&bad),
            Err(FrameError::IncomingTooLarge(_)),
        ));
    }

    #[test]
    fn drain_returns_only_newly_ready_frames() {
        let mut dec = FrameDecoder::new();
        dec.push(&encode_frame(FrameType::Cancel, b"{\"id\":1}").unwrap())
            .unwrap();
        assert_eq!(dec.drain().len(), 1);
        assert_eq!(dec.drain().len(), 0);
    }

    // ---- The cross-language byte-for-byte pin ----
    //
    // This module's binding requirement is that its encoder output matches the
    // TS codec byte-for-byte. GOLDEN_REQUEST_FRAME is the shared fixture:
    // libs/generic/ipc-framing/src/index.test.ts asserts the SAME bytes. If
    // either encoder changes, both suites fail together — which is the point.
    // Round-trip tests alone cannot catch a mirrored-but-wrong layout, because
    // each side would happily agree with itself.
    //
    // It pins REQUEST (0x01) because that is a frame this client actually
    // sends. It used to pin DATA (0x07), which was removed with the frame
    // (WI-7545) — the pin was re-pointed rather than dropped, so deleting dead
    // protocol surface did not silently cost the live frames their coverage.
    const GOLDEN_REQUEST_FRAME: &[u8] = &[
        0x00, 0x00, 0x00, 0x08, // length = 8
        0x01, // type = Request
        b'{', b'"', b'i', b'd', b'"', b':', b'1', b'}', // payload
    ];

    #[test]
    fn golden_request_frame_matches_ts() {
        let frame = encode_frame(FrameType::Request, br#"{"id":1}"#).unwrap();
        assert_eq!(frame.as_slice(), GOLDEN_REQUEST_FRAME);
    }

    #[test]
    fn removed_and_unassigned_tags_are_rejected() {
        // 0x07 was DATA and is RESERVED, not free — see the note on FrameType.
        // Reusing it would silently mean one thing to an old build and another
        // to a new one, so it must keep decoding as "unknown".
        assert_eq!(FrameType::from_u8(0x07), None);
        // 0x08 is still unassigned — guards against a silent tag collision if
        // someone adds a frame type without checking what is already taken.
        assert_eq!(FrameType::from_u8(0x08), None);
    }
}
