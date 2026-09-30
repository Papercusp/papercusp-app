/**
 * write-stdout-sync.mjs — write to stdout/stderr SYNCHRONOUSLY, so a following
 * `process.exit()` cannot truncate the output.
 *
 * WHY THIS EXISTS. Writes to a PIPE are asynchronous in Node and `process.exit()`
 * does not drain them, so `console.log(big); process.exit(0)` silently loses
 * everything that had not yet flushed. Measured 2026-08-10 (EI-20055889379250637),
 * deterministic across 3 runs each:
 *
 *     node -e "console.log('x'.repeat(N)); process.exit(0)" | wc -c
 *       N=8000 -> 8001 (survives)    N=16384 -> 8192    N=200000 -> 8192
 *
 * It survives a `> file` redirect (file writes are synchronous) and a TTY, so the bug
 * is INVISIBLE to every interactive test and only appears once someone pipes the
 * output. When the payload is a measurement, the truncated prefix parses as FEWER
 * FINDINGS — a false clean rather than a loud error.
 *
 * ⚠ The cut-off is NOT the 64 KiB pipe buffer and NOT a constant: what escapes is
 * "whatever drained before exit", which is timing-dependent (8192 above with a
 * continuously-consuming reader; 65,536 was observed with a slower `| cat > file`).
 * Assume ~8 KiB is already unsafe.
 *
 * PREFER `process.exitCode = N` over this helper wherever control flow allows it — it
 * needs no import, lets the process end naturally with the stream fully drained, and
 * preserves the exit status (verified). Reach for `writeStdoutSync` when you must exit
 * immediately, or at ESM top level where `return` is not available.
 *
 * `fs.writeSync` on a NON-BLOCKING pipe can short-write or raise EAGAIN, so both are
 * handled: loop until the whole buffer is out. EPIPE is swallowed — a downstream
 * `| head` closing the pipe is normal, not an error worth crashing over.
 */

import fs from "node:fs";

function writeFdSync(fd, s, appendNewline) {
  const text = typeof s === "string" ? s : String(s);
  const buf = Buffer.from(
    appendNewline && !text.endsWith("\n") ? `${text}\n` : text,
  );
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (err) {
      if (err && err.code === "EAGAIN") continue; // non-blocking pipe: retry
      if (err && err.code === "EPIPE") return; // reader went away (e.g. `| head`)
      throw err;
    }
  }
}

/** Write to stdout synchronously (adds a trailing newline if absent). */
export const writeStdoutSync = (s) => writeFdSync(1, s, true);

/** Write to stdout synchronously without changing the payload bytes. */
export const writeStdoutExactSync = (s) => writeFdSync(1, s, false);

/** Write to stderr synchronously (adds a trailing newline if absent). */
export const writeStderrSync = (s) => writeFdSync(2, s, true);
