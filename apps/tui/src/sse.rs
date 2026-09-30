//! Minimal SSE (text/event-stream) line parser for the reactivity layer
//! (D-003, "no polling"). The operator's `/api/zero-harness/sse` is reached
//! OVER IPC via the `sys:http` tool, which delivers the upstream SSE wire text
//! as repeated `sse-chunk` strings; we accumulate those and parse complete
//! frames here. Each frame carries an `event:` name (default "message") and the
//! joined `data:` lines.

/// One parsed SSE frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: String,
    pub data: String,
}

/// Parse complete frames out of `buf` (frames are blank-line-terminated).
/// Returns the frames plus the unconsumed remainder (an incomplete trailing
/// frame to prepend to the next chunk).
pub fn parse_sse_frames(buf: &str) -> (Vec<SseFrame>, String) {
    let norm = buf.replace("\r\n", "\n");
    let mut frames = Vec::new();
    let mut rest = norm.as_str();
    while let Some(idx) = rest.find("\n\n") {
        let block = &rest[..idx];
        let mut event = String::from("message");
        let mut data_lines: Vec<&str> = Vec::new();
        for line in block.split('\n') {
            if let Some(v) = line.strip_prefix("event:") {
                event = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("data:") {
                data_lines.push(v.strip_prefix(' ').unwrap_or(v));
            }
            // `id:` and `:`-comment lines are ignored.
        }
        if !data_lines.is_empty() || event != "message" {
            frames.push(SseFrame {
                event,
                data: data_lines.join("\n"),
            });
        }
        rest = &rest[idx + 2..];
    }
    (frames, rest.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_heartbeat_and_invalidate() {
        let buf = "event: heartbeat\ndata: {\"tsMs\":1}\n\nevent: invalidate\ndata: {\"name\":\"roster\"}\n\n";
        let (frames, rest) = parse_sse_frames(buf);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].event, "heartbeat");
        assert_eq!(frames[1].event, "invalidate");
        assert_eq!(frames[1].data, "{\"name\":\"roster\"}");
        assert_eq!(rest, "");
    }

    #[test]
    fn keeps_partial_frame_as_remainder() {
        let (frames, rest) = parse_sse_frames("event: invalidate\ndata: {\"name\":\"pl");
        assert!(frames.is_empty());
        assert_eq!(rest, "event: invalidate\ndata: {\"name\":\"pl");
    }

    #[test]
    fn incremental_reassembly() {
        let (f1, rest1) = parse_sse_frames("event: update\ndata: {\"name\":\"x");
        assert!(f1.is_empty());
        let (f2, rest2) = parse_sse_frames(&format!("{rest1}\"}}\n\n"));
        assert_eq!(f2.len(), 1);
        assert_eq!(f2[0].event, "update");
        assert_eq!(f2[0].data, "{\"name\":\"x\"}");
        assert_eq!(rest2, "");
    }

    #[test]
    fn crlf_and_multiline_data() {
        let (frames, _) = parse_sse_frames("event: m\r\ndata: a\r\ndata: b\r\n\r\n");
        assert_eq!(frames[0].data, "a\nb");
    }
}
