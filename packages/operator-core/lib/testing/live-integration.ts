/**
 * live-integration.ts — shared hardening for `itLive`-against-a-running-operator
 * integration smokes (EI-52).
 *
 * The pattern duplicated across `*.integration.test.ts` files that hit a real
 * `:3070`/`:3170` operator host is: probe reachability once at file load,
 * `const itLive = reachable ? it : it.skip`. That protects against the host
 * being fully DOWN, but not against it being UP-but-DEGRADED (a wedged
 * write/MCP path that hangs past the probe's own bound, or degrades *after*
 * the file-load probe ran) — in that state the suite goes RED instead of
 * SKIP, and the integration gate's red/green starts tracking the background
 * operator's health instead of the code under test. See EI-52 for the full
 * writeup of the four affected files.
 *
 * This module supplies the two pieces needed to fix that without adding a
 * new probe-boilerplate variant per file:
 *
 *  - `isLiveTransient` — is this error a network/timeout failure against a
 *    degraded/unreachable host, as opposed to a real assertion/logic bug?
 *  - `liveTest` — wrap an `itLive` test body so a live-transient failure
 *    dynamically SKIPS the test (via Vitest's `TestContext.skip()`) instead
 *    of failing it. Use for tests whose own network calls can wedge even
 *    when the file-load probe passed.
 */

/**
 * True when `e` looks like the host is unreachable/degraded (timeout,
 * connection refused/reset, abort) rather than a real test failure.
 */
export function isLiveTransient(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|fetch failed|network|socket hang up/i.test(
    e.message,
  );
}

/** The subset of Vitest's `TestContext` this module needs. */
export interface SkippableTestContext {
  skip: (note?: string) => never;
}

/**
 * Wrap an `itLive` test body: on a live-transient error, dynamically skip
 * the test instead of failing it. Pass the wrapped fn straight to `itLive`
 * (or `it`) — Vitest supplies the `TestContext` argument.
 *
 * ```ts
 * itLive('acquire: returns ok + lock_id', liveTest(async () => {
 *   const r = await callTool(...);
 *   expect(r.ok).toBe(true);
 * }), 15_000);
 * ```
 */
export function liveTest(
  fn: () => Promise<void>,
): (ctx: SkippableTestContext) => Promise<void> {
  return async (ctx: SkippableTestContext) => {
    try {
      await fn();
    } catch (e) {
      if (isLiveTransient(e)) {
        ctx.skip(`live host degraded mid-test: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      throw e;
    }
  };
}

/**
 * Bounded reachability probe: run `check()` (expected to resolve `true`/
 * `false`) but treat a hang past `timeoutMs`, or any thrown error, as
 * unreachable. Prefer probing a REPRESENTATIVE operation (the same kind of
 * call the suite's tests actually make — e.g. a real `tools/call`, not just
 * `tools/list`) so a wedged write/MCP path is caught at probe time rather
 * than surfacing as a per-test timeout later.
 */
export async function probeLive(
  check: () => Promise<boolean>,
  timeoutMs = 4000,
): Promise<boolean> {
  try {
    return await Promise.race<boolean>([
      check(),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('probe_timeout')), timeoutMs),
      ),
    ]);
  } catch {
    return false;
  }
}
