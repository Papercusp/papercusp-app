/**
 * Process-local voice-debug ring buffer.
 *
 * In-memory log of voice-state events the browser pushes, queryable
 * server-side so we can diagnose 'voice silently broken' reports
 * without a real-time browser session.
 *
 * Module-local state so the legacy route at
 * /api/agent-mcp/voice-debug and the MCP tool at agent-tools/operator/
 * voice_debug share the same buffer.
 */

export interface VoiceDebugEvent {
  ts: number;
  event: string;
  detail?: unknown;
}

const RING: VoiceDebugEvent[] = [];
const MAX = 200;

export function appendVoiceDebugEvent(input: { event?: string; detail?: unknown; ts?: number }): number {
  const evt: VoiceDebugEvent = {
    ts: typeof input.ts === 'number' ? input.ts : Date.now(),
    event: typeof input.event === 'string' ? input.event : '(no-event)',
    detail: input.detail,
  };
  RING.push(evt);
  if (RING.length > MAX) RING.splice(0, RING.length - MAX);
  return RING.length;
}

export function readVoiceDebugEvents(since?: number): VoiceDebugEvent[] {
  const events = since ? RING.filter((e) => e.ts > since) : RING;
  return events.slice(-100).reverse();
}

export function clearVoiceDebugEvents(): void {
  RING.splice(0, RING.length);
}
