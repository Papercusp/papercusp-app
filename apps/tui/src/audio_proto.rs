//! Framed stdio protocol shared by `pui` and the optional `pui-audio` helper.

use std::io::{self, Read, Write};

pub const READY: u8 = 0x01;
pub const RAW: u8 = 0x02;
pub const PLAY_REPLACE: u8 = 0x10;
pub const PLAY_APPEND_PCM: u8 = 0x11;
pub const PLAY_APPEND_ENCODED: u8 = 0x12;
pub const PLAY_STOP: u8 = 0x13;
pub const STATE: u8 = 0x14;
pub const PLAY_REALTIME_PCM: u8 = 0x15;
pub const DEVICES: u8 = 0x20;
pub const ERROR: u8 = 0x7f;

const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CaptureInfo {
    pub device: String,
    pub rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PlaybackState {
    pub playing: bool,
    pub error: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub payload: Vec<u8>,
}

pub fn write_frame(mut writer: impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pui-audio frame exceeds 32 MiB",
        ));
    }
    writer.write_all(&[kind])?;
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

pub fn read_frame(mut reader: impl Read) -> io::Result<Option<Frame>> {
    let mut kind = [0_u8; 1];
    match reader.read_exact(&mut kind) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut len = [0_u8; 4];
    reader.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("pui-audio frame length {len} exceeds 32 MiB"),
        ));
    }
    let mut payload = vec![0_u8; len];
    reader.read_exact(&mut payload)?;
    Ok(Some(Frame {
        kind: kind[0],
        payload,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_and_partial_eof() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, PLAY_APPEND_ENCODED, b"abc\0def").unwrap();
        assert_eq!(
            read_frame(bytes.as_slice()).unwrap(),
            Some(Frame {
                kind: PLAY_APPEND_ENCODED,
                payload: b"abc\0def".to_vec(),
            })
        );
        assert!(read_frame([READY].as_slice()).is_err());
        assert_eq!(read_frame([].as_slice()).unwrap(), None);
    }

    #[test]
    fn refuses_oversized_and_truncated_payloads_before_reading_them() {
        let mut oversized = vec![RAW];
        oversized.extend_from_slice(&((MAX_FRAME_BYTES + 1) as u32).to_le_bytes());
        assert_eq!(
            read_frame(oversized.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let mut truncated = vec![RAW];
        truncated.extend_from_slice(&8_u32.to_le_bytes());
        truncated.extend_from_slice(&[0; 4]);
        assert_eq!(
            read_frame(truncated.as_slice()).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
