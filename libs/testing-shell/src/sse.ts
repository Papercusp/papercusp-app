/**
 * Shared SSE log-stream reader (P-011 of testing-shell-cross-project-2026-06-01).
 *
 * Ported from Restart's `apps/web/lib/sse.ts` so any host `TestingDataSource`
 * can implement the optional `streamRun` path with one helper instead of
 * re-rolling frame parsing. A backend that streams `data: <json>\n\n` frames
 * (the k6 / load-test live-terminal shape) feeds its run output to
 * <DomainTestPanel> through this.
 *
 * The frame split + parse are factored out as pure functions so they can be
 * unit-tested without constructing a live stream.
 */

export interface SSEEvent {
  type: string;
  message?: string;
  code?: number;
  [key: string]: unknown;
}

/**
 * Pure: split a decoded buffer on the SSE frame terminator (`\n\n`),
 * returning the complete frames and the trailing partial remainder (which the
 * caller carries into the next read).
 */
export function splitSSEFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts, rest };
}

/**
 * Pure: parse one frame's `data: <json>` line into an event. Returns null when
 * the frame has no data line or the JSON is malformed (those frames are
 * skipped, matching the original behavior).
 */
export function parseSSEFrame(frame: string): SSEEvent | null {
  const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice('data:'.length).trim()) as SSEEvent;
  } catch {
    return null;
  }
}

/**
 * Read an SSE response body to completion, invoking `onEvent` for every parsed
 * frame. Resolves when the stream ends. Aborting the underlying fetch rejects
 * the `reader.read()` with an AbortError, which propagates to the caller.
 */
export async function readSSEStream(
  res: Response,
  onEvent: (evt: SSEEvent) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { frames, rest } = splitSSEFrames(buf);
    buf = rest;
    for (const f of frames) {
      const evt = parseSSEFrame(f);
      if (evt) onEvent(evt);
    }
  }
  // Flush a final frame that arrived without a trailing blank line.
  const tail = parseSSEFrame(buf);
  if (tail) onEvent(tail);
}
