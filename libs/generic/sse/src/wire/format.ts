/**
 * SSE wire-format primitives.
 *
 * Encodes a single SSE frame to its on-the-wire bytes per the spec at
 * https://html.spec.whatwg.org/multipage/server-sent-events.html. The exact
 * byte layout is a STABILITY CONTRACT — see README.md "Wire-format stability
 * contract" + `wire-format-snapshot.test.ts`. Changing anything in this file
 * requires a coordinated migration of every shipped desktop client.
 */

const TEXT_ENCODER = new TextEncoder();

export interface SseFrame {
  /** Optional event id. When present, sent as `id: <value>` line. */
  id?: number | string;
  /** Optional event name. When omitted or 'message', the `event:` line is suppressed (spec default). */
  event?: string;
  /** Required payload. May contain \n; we emit one `data:` line per split. */
  data: string;
  /** Optional reconnect retry override (ms). Almost always absent — the resilient client manages its own backoff. */
  retry?: number;
}

/**
 * Serialize a frame to its UTF-8 bytes. Always terminated by `\n\n`.
 *
 * Field order is fixed: id → event → data → retry. The spec doesn't mandate
 * order but consumers (and the snapshot test) depend on this ordering.
 */
export function encodeFrame(frame: SseFrame): Uint8Array {
  let out = '';
  if (frame.id !== undefined) {
    out += `id: ${frame.id}\n`;
  }
  if (frame.event !== undefined && frame.event !== 'message') {
    out += `event: ${frame.event}\n`;
  }
  // Per spec: each \n in data → new `data:` line. Empty string → one
  // empty data: line (consumers see an empty data string).
  const dataLines = frame.data.length === 0 ? [''] : frame.data.split('\n');
  for (const line of dataLines) {
    out += `data: ${line}\n`;
  }
  if (frame.retry !== undefined) {
    out += `retry: ${frame.retry}\n`;
  }
  out += '\n';
  return TEXT_ENCODER.encode(out);
}

/**
 * Build a heartbeat frame: `event: heartbeat\ndata: {"tsMs":<now>}\n\n`. No
 * id — heartbeats are not part of the resumable event log.
 */
export function heartbeatFrame(now: number = Date.now()): Uint8Array {
  return encodeFrame({ event: 'heartbeat', data: JSON.stringify({ tsMs: now }) });
}

/**
 * Build a comment line: `: <text>\n\n`. Invisible to EventSource listeners.
 * Use sparingly; prefer `heartbeatFrame` for keepalive.
 */
export function commentFrame(text: string): Uint8Array {
  return TEXT_ENCODER.encode(`: ${text}\n\n`);
}
