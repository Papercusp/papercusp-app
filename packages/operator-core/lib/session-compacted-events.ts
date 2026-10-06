/**
 * session-compacted-events — bridge a completed context cut to the await primitive
 * (event-await-discoverability-and-coverage-2026-07-03 P-103).
 *
 * When a psu session's context is cut, fire an awaitable key so a peer can
 *
 *   events:await { event: "session:compacted:su-94b69…" }   // wake when THAT session recompacts
 *
 * instead of polling. The ownerId lives IN the key (a required param), so a waiter
 * for one owner wakes only for THAT owner's compaction — no payload filtering.
 *
 * WIRE (grounded, not the plan's prose): since P-022 (2026-07-18, native
 * compaction retired) the only context cut is the CARRY-RESPAWN, and the ONLY
 * place its completion is observable is the psu-pty host's recycleChild — after
 * the fresh child spawns successfully, the host fires this event (focus:
 * 'carry-respawn'). `session:request-compaction` (server-side) only SENDS the
 * respawn and returns; it never sees completion. The host is a standalone Node
 * process with no PG pool / no operator HTTP client, so it cannot call
 * `emitAwaitedEvent` in-process — it spawns the emit-session-compacted CLI.
 * This module is the SERVER-side core of that path: one tested, fire-and-forget
 * emit that never breaks the resume.
 */

import { emitAwaitedEvent } from './events/await/engine';

/**
 * Errors that are EXPECTED for a best-effort, fire-and-forget notification and so must
 * never warn (vitest-fail-on-console would then flake any rig test): a partial test schema
 * (a projection table the emit touches is absent → "… does not exist"), or the emit's async
 * query outliving the Postgres pool it ran on (a rig tearing down mid-emit → postgres.js
 * CONNECTION_ENDED/CONNECTION_DESTROYED). Anything else is a real surprise.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[session-compacted-events] ${scope} emit failed: ${msg}`);
}

/** Injectable seam for tests. */
export interface SessionCompactedEventsDeps {
  emit?: typeof emitAwaitedEvent;
  /** Exact successor identity supplied by the native-proof-gated host. */
  sessionId?: string;
}

/**
 * AWAITABLE core: build + fire `session:compacted:<owner>` and resolve once the emit
 * has committed (awaits fired atomically + wake deliveries durably queued in PG).
 * `owner` is the coord ownerId (PAPERCUSP_SID) whose /compact just finished; it lives
 * IN the key, so a waiter wakes only for that owner. `detail` (the compaction focus,
 * when any) rides the summary + payload so a woken peer sees the focus without a
 * follow-up read.
 *
 * The bridge CLI (apps/operator/scripts/emit-session-compacted.ts) awaits THIS, then
 * exits — a standalone detached process must not race the emit against its own
 * teardown. This variant MAY reject (the CLI wraps it fail-soft); in-process callers
 * that must never throw use the void wrapper below.
 */
export async function emitSessionCompactedEventAsync(
  owner: string,
  detail?: string,
  deps: SessionCompactedEventsDeps = {},
): Promise<void> {
  const emit = deps.emit ?? emitAwaitedEvent;
  const key = `session:compacted:${owner}`;
  const summary = `session ${owner} finished /compact${detail ? ` — ${detail}` : ''}`;
  await emit({
    key, summary,
    payload: { owner, detail: detail ?? null, ...(deps.sessionId ? { sessionId: deps.sessionId } : {}) },
    source: 'session',
  });
}

/**
 * Fire-and-forget wrapper for IN-PROCESS callers — never throws, so an emit failure
 * can never break the resume turn. (The detached CLI uses the awaitable core above so
 * it can await-then-exit.)
 */
export function emitSessionCompactedEvent(
  owner: string,
  detail?: string,
  deps: SessionCompactedEventsDeps = {},
): void {
  void emitSessionCompactedEventAsync(owner, detail, deps).catch((e: unknown) =>
    failSoft(`compacted-event for ${owner}`, e),
  );
}

/**
 * Parse the bridge CLI's argv — `[execPath, scriptPath, <ownerId>, <focus?>]` — into
 * the emit args. Pure + exported so it is unit-testable without spawning the CLI.
 * Returns null when no ownerId is present (the CLI then no-ops and exits 0). The host
 * passes the focus as `String(focus ?? '')`, so a missing focus arrives as '' and
 * collapses back to undefined here.
 */
export function parseSessionCompactedArgv(
  argv: string[],
): { owner: string; focus?: string; sessionId?: string } | null {
  const owner = (argv[2] ?? '').trim();
  if (!owner) return null;
  const rawFocus = argv[3];
  const focus = rawFocus != null && rawFocus.trim() !== '' ? rawFocus.trim() : undefined;
  const rawSessionId = argv[4];
  const sessionId = rawSessionId != null && rawSessionId.trim() !== '' ? rawSessionId.trim() : undefined;
  return { owner, focus, sessionId };
}
