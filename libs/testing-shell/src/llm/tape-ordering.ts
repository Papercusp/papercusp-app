/**
 * SSE tape-ordering helpers for assertions that depend on event order.
 *
 * Plan: operator-behavior-tests-2026-05-14.md §4.3.
 *
 * The framework's `TurnResult` flattens text and tool calls into
 * separate fields. For assertions like "no prose after the
 * chat:ask_choice tool call" we need to walk the raw SSE tape and
 * inspect what events came after a named one.
 */

import type { SseEvent } from './types';

/**
 * Return every event AFTER the first occurrence of `eventName`,
 * matched by either the SseEvent.name OR (for `tool_call`) the
 * data.name field. If no matching event is found, returns [].
 *
 * @param eventName Either an SSE event name (`done`, `tool_call`,
 *                  etc.) OR a "tool_call:<toolName>" composite that
 *                  matches `tool_call` events whose `data.name`
 *                  equals `<toolName>`.
 */
export function findEventsAfter(rawSseTape: SseEvent[], eventName: string): SseEvent[] {
  const colonIdx = eventName.indexOf(':');
  let baseName: string;
  let toolName: string | null = null;
  if (colonIdx > 0) {
    baseName = eventName.slice(0, colonIdx);
    toolName = eventName.slice(colonIdx + 1);
  } else {
    baseName = eventName;
  }

  for (let i = 0; i < rawSseTape.length; i++) {
    const ev = rawSseTape[i];
    if (ev.name !== baseName) continue;
    if (toolName !== null) {
      const d = ev.data as { name?: unknown } | null | undefined;
      if (!d || typeof d !== 'object' || d.name !== toolName) continue;
    }
    return rawSseTape.slice(i + 1);
  }
  return [];
}

/**
 * Convenience: returns the substring of all `delta`-event text that
 * appears AFTER the named event, joined. Used by assertions like
 * "no trailing prose after chat:ask_choice".
 */
export function deltaTextAfter(rawSseTape: SseEvent[], eventName: string): string {
  const tail = findEventsAfter(rawSseTape, eventName);
  return tail
    .filter((e) => e.name === 'delta')
    .map((e) => extractDeltaText(e.data))
    .join('');
}

function extractDeltaText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const obj = data as { text?: unknown; delta?: unknown };
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.delta === 'string') return obj.delta;
  }
  return '';
}
