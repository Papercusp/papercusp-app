/**
 * Minimal spec-compliant SSE parser.
 *
 * Implements the wire-format consumer side of
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
 *
 * Spec'd behaviors:
 *   - Field names: id, event, data, retry (others ignored)
 *   - Newlines: \r\n, \r, \n all accepted as separators
 *   - Comments: lines starting with ':' are dropped
 *   - Multi-line data: each `data:` line concatenated with \n
 *   - Empty line dispatches the buffered event
 *   - Stripped leading space after the colon (only one)
 *   - BOM at stream start is consumed
 *
 * Vendored rather than depending on `eventsource-parser` (npm) because the
 * production sync path treats wire-format as a stability contract and we
 * want full control over the parser. ~80 lines, MIT-licensed equivalent.
 */

export interface ParserEvent {
  id?: string;
  event: string;
  data: string;
  retry?: number;
}

export interface Parser {
  /** Feed UTF-8 text. Yields zero or more dispatched events. */
  feed(chunk: string): ParserEvent[];
  /** Force any pending partial line to be discarded. */
  reset(): void;
}

const NAME_FIELDS = new Set(['id', 'event', 'data', 'retry']);

export function createParser(): Parser {
  // Per-event accumulator. Reset after dispatch.
  let id: string | undefined;
  let eventName = '';
  let data = '';
  let retry: number | undefined;

  // Cross-feed buffer for partial trailing line.
  let lineBuf = '';
  // BOM handling.
  let sawAnyChar = false;

  function dispatch(): ParserEvent | null {
    // Spec: dispatch the event if data is non-empty; otherwise discard.
    // We loosen this to also dispatch empty-data events with an explicit
    // `event:` field — that's the heartbeat shape we use.
    if (data.length === 0 && eventName === '') {
      // Truly empty record — discard.
      resetAccum();
      return null;
    }
    // Strip a single trailing \n that the multi-line aggregator added.
    const out = data.endsWith('\n') ? data.slice(0, -1) : data;
    const ev: ParserEvent = {
      event: eventName || 'message',
      data: out,
    };
    if (id !== undefined) ev.id = id;
    if (retry !== undefined) ev.retry = retry;
    resetAccum();
    return ev;
  }

  function resetAccum() {
    eventName = '';
    data = '';
    retry = undefined;
    // id persists across events per spec — only reset on explicit `id:`.
  }

  function processLine(line: string): ParserEvent | null {
    if (line === '') {
      return dispatch();
    }
    if (line.startsWith(':')) {
      return null; // comment
    }
    let field: string;
    let value: string;
    const colon = line.indexOf(':');
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1); // strip one leading space
    }
    if (!NAME_FIELDS.has(field)) return null;
    if (field === 'event') eventName = value;
    else if (field === 'data') data += value + '\n';
    else if (field === 'id') id = value;
    else if (field === 'retry') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) retry = n;
    }
    return null;
  }

  return {
    feed(chunk: string): ParserEvent[] {
      let text = lineBuf + chunk;
      lineBuf = '';

      // BOM (only at the very start of the stream).
      if (!sawAnyChar && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      if (text.length > 0) sawAnyChar = true;

      const out: ParserEvent[] = [];
      let i = 0;
      while (i < text.length) {
        // Find next newline (\r\n, \r, or \n).
        let nl = -1;
        let nlLen = 0;
        for (let j = i; j < text.length; j++) {
          const c = text.charCodeAt(j);
          if (c === 0x0A) { nl = j; nlLen = 1; break; }            // \n
          if (c === 0x0D) {
            nl = j;
            nlLen = (text.charCodeAt(j + 1) === 0x0A) ? 2 : 1;     // \r or \r\n
            break;
          }
        }
        if (nl === -1) {
          // No newline — buffer the rest as a partial line.
          lineBuf = text.slice(i);
          break;
        }
        const line = text.slice(i, nl);
        const ev = processLine(line);
        if (ev) out.push(ev);
        i = nl + nlLen;
      }
      return out;
    },
    reset() {
      lineBuf = '';
      sawAnyChar = false;
      id = undefined;
      resetAccum();
    },
  };
}
