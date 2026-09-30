/**
 * (WI-39599) Stop a dead stdio peer from AMPLIFYING into a full-core spin.
 *
 * Every packaged sidecar is spawned with `stdio: ['ignore', 'pipe', 'pipe']`, so
 * its stdout/stderr are pipes whose READ ends belong to the operator that
 * spawned it. When that operator dies abruptly (SIGKILL — anything that skips
 * its graceful `shutdown_children` teardown) both read ends close, and every
 * subsequent write from the child fails with EPIPE.
 *
 * On its own that is harmless. What makes it a 1-core fire is the interaction
 * with the process-level fault handler in serve.ts, which DIAGNOSES BY WRITING:
 *
 *   1. a write to the now-broken stdout fails;
 *   2. the stream emits 'error' with NO listener, which Node throws as an
 *      uncaughtException;
 *   3. the `uncaughtException` handler reports it with `console.error(...)` —
 *      to the equally-broken stderr;
 *   4. that write fails too, re-entering step 2. Unbounded.
 *
 * The loop is self-sustaining and never blocks, so it burns a full core in
 * libuv's poll phase for as long as the orphan lives. ⚠ It does NOT starve the
 * event loop: timers keep firing at their normal cadence throughout (measured
 * 2026-08-17), which is why the parent-death watch's `managedSetInterval` is
 * NOT the broken part and why "the watch could not fire" is the wrong diagnosis.
 *
 * The fix is to break the loop at step 2 rather than to police step 3: an
 * attached 'error' listener makes a broken-pipe write an ordinary, absorbed
 * stream error instead of an uncaughtException, so the amplification cannot
 * start at all. Measured with everything else held identical: an unguarded
 * child burns ~1.00 core (state R) after its parent is SIGKILLed, a guarded one
 * ~0.001 (state S), and the guarded child stays fully responsive.
 *
 * ⚠ Deliberately does NOT terminate the process. "Our parent is gone, so we
 * should exit" is the parent-death watch's job (serve.ts `startParentDeathWatch`),
 * which has the launcher-declared parent identity needed to decide it correctly.
 * This guard only removes the amplifier; `peerGone()` is exposed so a caller
 * that wants to act on the signal can, without this module guessing for it.
 */

/**
 * Error codes that mean "the other end of our stdio is gone", as opposed to a
 * transient write failure worth surfacing. ECONNRESET appears instead of EPIPE
 * when the peer dies mid-write on a socket-backed stdio (a pty/socketpair
 * launcher rather than a plain pipe).
 */
const PEER_GONE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ECONNRESET"]);

/** True when `e` is a write failure caused by our stdio peer going away. */
export function isPeerGoneError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && PEER_GONE_CODES.has(code);
}

/** The subset of a stdio stream this guard needs — keeps the unit tests free of real fds. */
export interface GuardableStream {
  on(event: "error", listener: (err: Error) => void): unknown;
  off?(event: "error", listener: (err: Error) => void): unknown;
  listenerCount?(event: string): number;
}

export interface StdioPeerGuardHandle {
  /** True once a write to stdout or stderr has failed with a peer-gone error. */
  peerGone(): boolean;
  /** Per-stream count of absorbed errors — the falsifier a behavioural test asserts on. */
  absorbed(): { stdout: number; stderr: number; other: number };
  /** Detach the listeners this guard installed (tests; a caller re-taking ownership). */
  uninstall(): void;
}

let installed: StdioPeerGuardHandle | null = null;

/**
 * Attach absorbing 'error' listeners to stdout/stderr so a broken stdio pipe can
 * never become an uncaughtException. Idempotent: a second call returns the
 * handle from the first rather than stacking listeners.
 *
 * Streams are injectable so the behaviour can be unit-tested without a real
 * broken pipe; production callers pass nothing.
 */
export function installStdioPeerGuard(
  streams: { stdout?: GuardableStream; stderr?: GuardableStream } = {},
): StdioPeerGuardHandle {
  if (installed) return installed;

  const stdout = streams.stdout ?? (process.stdout as unknown as GuardableStream);
  const stderr = streams.stderr ?? (process.stderr as unknown as GuardableStream);

  let gone = false;
  const counts = { stdout: 0, stderr: 0, other: 0 };

  const absorb =
    (which: "stdout" | "stderr") =>
    (err: Error): void => {
      if (isPeerGoneError(err)) {
        gone = true;
        counts[which] += 1;
        return;
      }
      // A non-peer-gone stdio error is a genuine fault, but reporting it THROUGH
      // the stream that just failed is the bug this module exists to prevent.
      // Count it and stay silent; the fault still reaches anything watching the
      // handle, and a durable file sink (e.g. gatewayLogLine) is unaffected.
      counts.other += 1;
    };

  const onStdout = absorb("stdout");
  const onStderr = absorb("stderr");
  stdout.on("error", onStdout);
  stderr.on("error", onStderr);

  installed = {
    peerGone: () => gone,
    absorbed: () => ({ ...counts }),
    uninstall: () => {
      stdout.off?.("error", onStdout);
      stderr.off?.("error", onStderr);
      installed = null;
    },
  };
  return installed;
}

/** Test seam: forget the module-scoped install latch. */
export function _resetStdioPeerGuardForTests(): void {
  installed?.uninstall();
  installed = null;
}
