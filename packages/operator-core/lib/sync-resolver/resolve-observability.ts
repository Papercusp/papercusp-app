/**
 * Server-side visibility for sync reads that are SLOW or that FAIL
 * (EI-19375505819043214).
 *
 * ## The gap this closes
 *
 * `/zero-harness/rest-query` is the one path every `useSyncQuery` lands on, and
 * until now a read that took ten seconds and then 500'd the user left NO trace
 * on the server at all:
 *
 *   - the route's catch collapses every throw into `Response.json({ error },
 *     { status: 500 })` with no log, and
 *   - it sets `sampleRate: 0`, which (correctly) exempts a ~3s-polled transport
 *     from `route_invocations` telemetry — but that also removed the last place
 *     a slow read could show up.
 *
 * So the owner's report — "loading lots of things in the app is going slow…
 * several seconds… just displayed loading artifacts" — was structurally
 * unreproducible from the server side: measured 2026-08-02, a `learning.analyze`
 * call hung past the 10s RESOLVER_TIMEOUT_MS and returned a 500, while
 * `journalctl` over the previous 24h contained ZERO occurrences of the resolver
 * timeout string (against a 9,133-line/hour control, so the silence was real and
 * not a broken grep).
 *
 * A user-visible multi-second stall that leaves no evidence is a DETECTOR
 * failure as much as a performance one: every diagnosis has to start from a
 * human noticing, which is exactly how this one reached the owner.
 *
 * ## Why the rate limit is not optional
 *
 * This runs on a transport polled roughly every 3 seconds by every open client.
 * A single persistently-failing query (`learning.observations.counts` was
 * 500ing on EVERY call the same day) would otherwise emit a line per poll per
 * client — turning a diagnostic into a flood that buries itself. Repeats
 * collapse into a `suppressed=N` count on the next line for that key, so a
 * recurring fault stays one line a minute while remaining countable.
 */

/** A successful resolve at or above this is logged as slow. */
const SLOW_MS = Number(process.env.PAPERCUSP_SYNC_SLOW_RESOLVE_MS) || 2_000;

/** Minimum gap between two logged lines for the SAME key. */
const DEDUP_WINDOW_MS = 60_000;

/** Bound the key table — one entry per (kind, queryName), which is small and
 *  fixed by the registry, but a defensive cap costs nothing. */
const MAX_KEYS = 500;

interface Bucket {
  lastLoggedMs: number;
  suppressed: number;
}

const buckets = new Map<string, Bucket>();

/** Exported for tests: the module holds cross-call state by design. */
export function __resetResolveObservability(): void {
  buckets.clear();
}

/**
 * Rate-limit decision for `key`. Returns the number of occurrences suppressed
 * since the last logged line when it says to log, or null to stay silent.
 */
function admit(key: string, now: number): number | null {
  const bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_KEYS) buckets.clear();
    buckets.set(key, { lastLoggedMs: now, suppressed: 0 });
    return 0;
  }
  if (now - bucket.lastLoggedMs >= DEDUP_WINDOW_MS) {
    const suppressed = bucket.suppressed;
    bucket.lastLoggedMs = now;
    bucket.suppressed = 0;
    return suppressed;
  }
  bucket.suppressed += 1;
  return null;
}

/**
 * Collapse to ONE line and bound the length.
 *
 * Not cosmetic: a zod validation failure serialises as pretty-printed
 * multi-line JSON, so an un-collapsed message splits a single event across a
 * dozen journal lines — which breaks the `grep '[sync-error]'` this whole
 * module exists to make possible, and makes a repeat count meaningless.
 * Observed on the first live emit (learning.analyzeCycle, 2026-08-02).
 */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Args are query filters/ids, not payloads, but bound them anyway. */
function briefArgs(argsJson: string): string {
  const trimmed = oneLine(argsJson, 160);
  return trimmed === '{}' ? '' : ` args=${trimmed}`;
}

export interface ObserveResolveInput {
  name: string;
  argsJson: string;
  elapsedMs: number;
  /** The thrown value, when the resolve failed. */
  error?: unknown;
  /** Injectable for tests. */
  now?: number;
  /** Injectable for tests. */
  emit?: (line: string) => void;
}

/**
 * Record one resolve attempt. Emits at most one line per minute per
 * (kind, queryName); a fast success emits nothing.
 *
 * Never throws: observability must not be able to fail the read it observes.
 */
export function observeResolve(input: ObserveResolveInput): void {
  try {
    const { name, argsJson, elapsedMs, error } = input;
    const now = input.now ?? Date.now();
    const emit = input.emit ?? ((line: string) => console.warn(line));

    let kind: string;
    let detail = '';
    if (error !== undefined) {
      const err = error as { name?: string; message?: string } | undefined;
      const isTimeout = err?.name === 'QueryResolveTimeoutError';
      kind = isTimeout ? 'sync-timeout' : 'sync-error';
      detail = ` err=${oneLine(err?.message ?? String(error), 200)}`;
    } else if (elapsedMs >= SLOW_MS) {
      kind = 'sync-slow';
    } else {
      return; // the overwhelmingly common case: fast success, say nothing
    }

    const suppressed = admit(`${kind}:${name}`, now);
    if (suppressed === null) return;

    emit(
      `[${kind}] name=${name} ms=${Math.round(elapsedMs)}` +
        briefArgs(argsJson) +
        detail +
        (suppressed > 0 ? ` suppressed=${suppressed}` : ''),
    );
  } catch {
    /* observability must never break the request path */
  }
}

/** Exported so a test can assert against the real threshold rather than a
 *  hard-coded duplicate of it. */
export const SLOW_RESOLVE_MS = SLOW_MS;
export const RESOLVE_LOG_DEDUP_MS = DEDUP_WINDOW_MS;
