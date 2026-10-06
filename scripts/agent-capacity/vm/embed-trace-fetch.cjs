// Who keeps the per-tenant embed sidecar busy? (plan agent-capacity-and-cost-gcp-2026-09-30, P-532b,
// WI-10005523; moved from .papercusp/scratch/p532b/trace-fetch.cjs by WI-10006497.)
// Preloaded via NODE_OPTIONS=--require=<this file> into a TEST-VM Papercusp Server by
// sidecar-idle-soak.sh. Wraps globalThis.fetch and logs one line per POST to an /embed or /rerank URL:
// time, pid, thread, route, text count, chars, an 80-char excerpt of the first text, and the JS call
// stack (async frames included). Measurement only; never shipped. sidecar-idle-probe.sh counts the
// EMBED_CALL lines (probeEmbedSidecar frames are health probes, every other frame is a real embed).
'use strict';
const fs = require('fs');
let threadId = 0;
try { threadId = require('worker_threads').threadId; } catch {}
const uid = typeof process.getuid === 'function' ? process.getuid() : 'x';
const OUT = process.env.EMBED_TRACE_OUT || `/tmp/embtrace-${uid}.log`;
const write = (line) => { try { fs.appendFileSync(OUT, line + '\n'); } catch {} };
write(`TRACE_PRELOAD t=${new Date().toISOString()} pid=${process.pid} thread=${threadId} argv=${process.argv.slice(1, 3).join(' ')} sidecarMode=${process.env.PAPERCUSP_EMBED_SIDECAR_MODE || ''}`);
const orig = globalThis.fetch;
if (typeof orig === 'function') {
  globalThis.fetch = function tracedFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
      const m = /\/(embed|rerank)(\?|$)/.exec(url);
      if (m) {
        let n = '?', chars = '?', excerpt = '';
        try {
          const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
          if (body) {
            const texts = Array.isArray(body.texts) ? body.texts : Array.isArray(body.documents) ? body.documents : Array.isArray(body.docs) ? body.docs : [];
            n = texts.length;
            chars = texts.reduce((a, t) => a + (typeof t === 'string' ? t.length : 0), 0);
            const first = typeof body.query === 'string' ? `q:${body.query}` : typeof texts[0] === 'string' ? texts[0] : '';
            excerpt = JSON.stringify(first.slice(0, 80));
            if (body.model || body.kind) excerpt = `${body.model || ''}:${body.kind || ''} ${excerpt}`;
          }
        } catch {}
        const prev = Error.stackTraceLimit;
        Error.stackTraceLimit = 60;
        const stack = new Error().stack || '';
        Error.stackTraceLimit = prev;
        const frames = stack.split('\n').slice(2).map((l) => l.trim().replace(/^at /, '').replace(/file:\/\/\/usr\/lib\/Papercusp Server\/sidecar\//g, '')).join(' <- ');
        write(`EMBED_CALL t=${new Date().toISOString()} pid=${process.pid} thread=${threadId} route=${m[1]} n=${n} chars=${chars} ${excerpt} :: ${frames}`);
      }
    } catch {}
    return orig.apply(this, arguments);
  };
}
