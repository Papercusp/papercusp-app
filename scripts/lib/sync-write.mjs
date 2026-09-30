// Ordering-safe synchronous stdout/stderr writes for the test runners.
//
// EI-10542 root cause: scripts/affected-tests.mjs labels each workspace's
// output with a `>>> <ws> :: ...` header (a `console.log`), then runs the suite
// as a child with `stdio: 'inherit'` (the child writes SYNCHRONOUSLY straight
// to fd 1). When fd 1 is NOT a TTY — a pipe or file, e.g. the green-checkpoint
// gate captures this runner's output — Node makes `console.log` /
// `process.stdout.write` ASYNCHRONOUS: the bytes are buffered and flushed on an
// event-loop turn. But `spawnSync` BLOCKS the event loop, so a header queued
// before the child cannot flush until AFTER the child has already written its
// suite output directly to the same fd. The result: one workspace's suite
// output prints under a DIFFERENT workspace's header (operator-vite's 143 test
// files appeared under the `@papercusp/web` header, with a failure misattributed
// to the wrong workspace).
//
// The fix is to emit the runner's OWN lines synchronously to the same raw fd, so
// every header/status line is glued to the child output it labels — regardless
// of whether fd 1/2 is a TTY, a pipe, or a redirected file. On a TTY `console`
// is already synchronous, so this is behaviour-neutral there; on a pipe/file it
// removes the async buffer that caused the misattribution.
import { closeSync, openSync, writeSync } from "node:fs";

/**
 * Write `text` FULLY and SYNCHRONOUSLY to `fd`, draining partial writes and
 * transient EAGAIN (a momentarily-full non-blocking pipe). Accepts a string or
 * Buffer; a null/empty value is a no-op.
 *
 * @param {number} fd - Target file descriptor (1 = stdout, 2 = stderr).
 * @param {unknown} text - Buffer written as-is; anything else via `String(text)`.
 * @returns {void}
 */
export function writeAllSync(fd, text) {
  if (text == null || text === "") return;
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      // A non-blocking pipe whose consumer hasn't drained yet throws EAGAIN;
      // retry (writeSync makes progress once the reader consumes). Any other
      // error is real — rethrow so a broken fd fails loudly, not silently.
      if (e && e.code === "EAGAIN") continue;
      throw e;
    }
  }
}

/**
 * Append a record assembled from several parts without yielding the event loop.
 *
 * This is intentionally the file analogue of {@link writeAllSync}: callers that
 * must publish durable evidence before exposing a completion pulse cannot use a
 * stream, whose buffered writes may still be pending when the process is signalled.
 * Keeping one fd open also prevents another append from being interleaved between
 * a record's header, body, and footer.
 *
 * @param {string} path - File opened with append semantics.
 * @param {Iterable<unknown>} parts - Record fragments, written in order.
 * @returns {void}
 */
export function appendAllSync(path, parts) {
  const fd = openSync(path, "a");
  try {
    for (const part of parts) writeAllSync(fd, part);
  } finally {
    closeSync(fd);
  }
}

/**
 * `console.log`-shaped synchronous stdout line (fd 1, appends a newline).
 *
 * @param {unknown} [msg] - Interpolated via a template literal, so any value is accepted.
 * @returns {void}
 */
export function outSync(msg = "") {
  writeAllSync(1, `${msg}\n`);
}

/**
 * `console.error`/`console.warn`-shaped synchronous stderr line (fd 2, appends a newline).
 *
 * @param {unknown} [msg] - Interpolated via a template literal, so any value is accepted.
 * @returns {void}
 */
export function errSync(msg = "") {
  writeAllSync(2, `${msg}\n`);
}
