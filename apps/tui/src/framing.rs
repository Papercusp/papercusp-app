//! SSE→IPC pivot (SP-TUI). Mirror of `libs/generic/ipc-framing/src/index.ts`
//! and `papercusp-desktop/src-tauri/src/endpoint_ipc_framing.rs` — encoder output
//! and decoder behaviour must match byte-for-byte.
//!
//! The cross-language golden vector below pins this mirror to the shared TS
//! source and desktop Rust mirror, so drift fails all participating suites.
//! The `apps/operator/...` paths this header used to name have not existed
//! since the codec moved to `libs/generic/ipc-framing`.
//!
//! Frame format (per `packages/operator-core/lib/endpoint-ipc/PROTOCOL.md`):
//!   [4B length BE][1B type][payload (length bytes)]
//! Big-endian for all multi-byte integers. 16 MiB per-frame cap.
#![allow(dead_code)] // consumed by ipc.rs (next step of the SSE→IPC pivot).

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
    #[error("frame payload too large: {0} bytes (cap 16 MiB)")]
    TooLarge(usize),
    #[error("incoming frame length too large: {0} bytes (cap 16 MiB)")]
    IncomingTooLarge(usize),
    #[error("unknown frame type: 0x{0:02x}")]
    UnknownType(u8),
    #[error("EVENT_BIN payload too short: {0} bytes")]
    EventBinTooShort(usize),
    #[error("EVENT_BIN nameLen={0} exceeds payload ({1} bytes)")]
    EventBinNameLenOverflow(u32, usize),
}

/// Encode a frame into a freshly-allocated Vec<u8>.
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

#[derive(Debug)]
pub struct DecodedEventBin {
    pub id: u64,
    pub name: String,
    pub binary: Vec<u8>,
}

/// Decode an EVENT_BIN payload: [8B id BE][4B nameLen BE][name UTF-8][binary].
pub fn decode_event_bin_payload(payload: &[u8]) -> Result<DecodedEventBin, FrameError> {
    if payload.len() < 12 {
        return Err(FrameError::EventBinTooShort(payload.len()));
    }
    let mut cursor = payload;
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
/// On `FrameError`, the caller should close the underlying socket.
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
            let len =
                u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if len > MAX_FRAME_BYTES {
                return Err(FrameError::IncomingTooLarge(len));
            }
            let total = HEADER_BYTES + len;
            if self.buf.len() < total {
                break;
            }
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
    fn golden_request_frame_matches_ts_and_desktop_rust() {
        // Keep this byte vector identical to
        // libs/generic/ipc-framing/src/index.test.ts and
        // papercusp-desktop/src-tauri/src/endpoint_ipc_framing.rs.
        const GOLDEN_REQUEST_FRAME: &[u8] = &[
            0x00, 0x00, 0x00, 0x08, // length = 8
            0x01, // type = Request
            b'{', b'"', b'i', b'd', b'"', b':', b'1', b'}', // {"id":1}
        ];
        let frame = encode_frame(FrameType::Request, br#"{"id":1}"#).unwrap();
        assert_eq!(frame.as_slice(), GOLDEN_REQUEST_FRAME);
    }

    #[test]
    fn decoder_multiple_frames_then_partial() {
        let mut dec = FrameDecoder::new();
        let f1 = encode_frame(FrameType::EventJson, b"{\"id\":1}").unwrap();
        let f2 = encode_frame(FrameType::Done, b"{\"id\":1}").unwrap();
        let mut combined = Vec::new();
        combined.extend_from_slice(&f1);
        combined.extend_from_slice(&f2);
        combined
            .extend_from_slice(&encode_frame(FrameType::EventJson, b"{\"id\":2}").unwrap()[..3]);
        dec.push(&combined).unwrap();
        let out = dec.drain();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].frame_type, FrameType::EventJson);
        assert_eq!(out[1].frame_type, FrameType::Done);
        assert_eq!(dec.buffered_bytes(), 3); // partial third frame retained
    }

    #[test]
    fn decoder_byte_by_byte() {
        let mut dec = FrameDecoder::new();
        let frame = encode_frame(FrameType::EventJson, b"{\"id\":42}").unwrap();
        for b in frame.iter() {
            dec.push(&[*b]).unwrap();
        }
        let out = dec.drain();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].payload, b"{\"id\":42}".to_vec());
    }

    #[test]
    fn event_bin_round_trip() {
        // [8B id][4B nameLen][name][binary]
        let mut payload = Vec::new();
        payload.put_u64(7);
        payload.put_u32(4);
        payload.extend_from_slice(b"body");
        payload.extend_from_slice(&[1, 2, 3]);
        let d = decode_event_bin_payload(&payload).unwrap();
        assert_eq!(d.id, 7);
        assert_eq!(d.name, "body");
        assert_eq!(d.binary, vec![1, 2, 3]);
    }

    #[test]
    fn decoder_rejects_unknown_type() {
        let mut dec = FrameDecoder::new();
        let bad = vec![0u8, 0, 0, 0, 0x99];
        assert!(matches!(dec.push(&bad), Err(FrameError::UnknownType(0x99))));
    }
}
