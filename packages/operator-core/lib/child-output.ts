/**
 * Chunk-boundary-safe accumulation of a child process's (or any Readable's)
 * text output.
 *
 * ## The bug this exists to make unrepeatable (WI-6728)
 *
 * The idiom that grew independently at ~111 sites in this tree is
 *
 * ```ts
 * child.stdout.on('data', (d) => (stdout += String(d)));
 * ```
 *
 * which decodes **each chunk in isolation**. A multi-byte UTF-8 character
 * whose bytes straddle two `data` events is therefore decoded as two invalid
 * fragments and becomes U+FFFD replacement characters on both sides — silent
 * corruption with no error, no throw, and no exit-code change.
 *
 * It is invisible for ASCII plumbing (oids, refs, `rev-parse`), and real for
 * `git log` with a non-ASCII author or subject, for `git status` on a path with
 * non-ASCII characters, and for anything echoing user- or repo-supplied text.
 * Chunk boundaries fall wherever the kernel and the stream's highWaterMark put
 * them, so whether a given run corrupts is a function of output SIZE and
 * TIMING, not of the text — which is why it survives casual testing.
 *
 * `StringDecoder` fixes it by holding an incomplete trailing sequence back
 * until the bytes that complete it arrive.
 *
 * ## Why a shared helper rather than the fix at each site
 *
 * The two prior fixes in this class (WI-6404, WI-6699) each hand-rolled their
 * own `new StringDecoder('utf8')` at the call site. That is correct code, but
 * it leaves the NEXT site to rediscover the bug — and it did, repeatedly. A
 * single seam means a site is either routed through it or it is not, which is
 * a property a guard can actually check (see child-output-guard.test.ts).
 */
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';

export interface TextCollector {
  /**
   * Append literal text that did NOT come off the stream — a timeout note, a
   * `String(error)`. Deliberately separate from the decoded path so it is
   * obvious at the call site which bytes are being decoded and which are ours.
   */
  append(text: string): void;
  /**
   * The accumulated text, with any partial trailing multi-byte sequence
   * flushed. Idempotent: repeated reads with no intervening chunk return the
   * same string, and a chunk arriving after a read re-arms the flush — so
   * reading early (in a timeout handler) cannot truncate a later read.
   *
   * ⚠ "Cannot TRUNCATE" is not "cannot CORRUPT", and the difference matters on
   * exactly one usage: calling this on EVERY `data` event. The flush is
   * `decoder.end()`, which emits the held-back bytes of a straddling character
   * as U+FFFD *and resets the decoder*, so the continuation bytes in the next
   * chunk then decode as invalid too. Per-chunk polling therefore reproduces
   * the precise corruption this module exists to prevent — measured: a `⚠`
   * split across two chunks reads back as three replacement characters when
   * polled, and intact when read once at the end.
   *
   * For an incremental read — "has the landmark appeared yet?" — use
   * {@link peek}. Use `text()` for a TERMINAL read (a close/exit handler, a
   * timeout's diagnostic), where flushing is what you want.
   */
  text(): string;
  /**
   * The safely-decoded text so far, WITHOUT flushing. Safe to call on every
   * `data` event, which is what makes an incremental watcher expressible
   * through this helper instead of a hand-rolled accumulator.
   *
   * A character whose bytes have not all arrived is simply not visible yet —
   * the right answer for a needle search, since those bytes have not formed a
   * character to match against. The next `write` completes it.
   */
  peek(): string;
  /**
   * Start decoding a stream into this collector.
   *
   * For the shape where the collector must exist BEFORE the stream does — a
   * failure path that appends a reason and resolves without ever spawning, then
   * the spawn on the success path. Null/undefined is a no-op, so an un-piped fd
   * needs no guard. Attaching more than one stream is allowed and interleaves
   * them, which is only ever what you want for a merged stdout+stderr capture.
   */
  attach(stream: NodeJS.ReadableStream | null | undefined): void;
  /** Bytes decoded off the stream so far — excludes {@link append} text. */
  readonly bytes: number;
}

/**
 * A collector, optionally attached to a stream in the same breath.
 *
 * The stream argument is nullable on purpose: `child.stdout` is `null` whenever
 * that fd was not piped (`'ignore'`, `'inherit'`, or an fd handoff), and every
 * call site would otherwise need the same guard.
 */
export function createTextCollector(
  stream?: NodeJS.ReadableStream | null,
  options: { maxChars?: number } = {},
): TextCollector {
  const maxChars = options.maxChars;
  if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 1)) {
    throw new RangeError('maxChars must be a positive integer');
  }
  const decoder = new StringDecoder('utf8');
  let acc = '';
  let flushed = false;
  let bytes = 0;
  const trimTail = (): void => {
    if (maxChars === undefined || acc.length <= maxChars) return;
    acc = acc.slice(-maxChars);
    // A UTF-16 slice can start at the low half of an emoji; drop that half.
    const first = acc.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) acc = acc.slice(1);
  };

  const onData = (chunk: Buffer | string): void => {
    if (typeof chunk === 'string') {
      // An encoding was set on the stream, so Node already decoded it — and it
      // did so with its OWN StringDecoder, which is boundary-safe. Re-decoding
      // would be wrong; take the string as given.
      acc += chunk;
      trimTail();
      bytes += Buffer.byteLength(chunk);
      return;
    }
    bytes += chunk.length;
    acc += decoder.write(chunk);
    trimTail();
    flushed = false;
  };

  const collector: TextCollector = {
    append(text: string): void {
      acc += text;
      trimTail();
    },
    text(): string {
      if (!flushed) {
        acc += decoder.end();
        trimTail();
        flushed = true;
      }
      return acc;
    },
    peek(): string {
      // Deliberately just `acc`: every byte the decoder has resolved into a
      // character is already here, and the bytes of an incomplete trailing
      // character are still held inside the decoder. Reading them out is
      // precisely what would corrupt them, so peek() must not flush.
      return acc;
    },
    attach(s: NodeJS.ReadableStream | null | undefined): void {
      s?.on('data', onData);
    },
    get bytes(): number {
      return bytes;
    },
  };

  collector.attach(stream);
  return collector;
}

/**
 * The dominant shape: capture both of a child's output streams.
 *
 * Returns collectors rather than strings because the output is not complete
 * until the child closes — read `.text()` inside your `close`/`error` handler.
 */
export function collectChildOutput(child: ChildProcess): {
  stdout: TextCollector;
  stderr: TextCollector;
} {
  return {
    stdout: createTextCollector(child.stdout),
    stderr: createTextCollector(child.stderr),
  };
}
