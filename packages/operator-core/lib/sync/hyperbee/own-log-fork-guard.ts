/**
 * own-log-fork-guard — edge-triggered detector for the own-log hypercore
 * equivocation loop.
 *
 * Plan: p2p-parity-parallel-lanes-2026-07-09 P-003 (WI-3535). Mirrors
 * replication-liveness.ts's shape (a process-local registry + an
 * edge-triggered episode reporter that escalates to a durable EI via
 * own-log-fork-ei.ts, the sibling of replication-stall-ei.ts), scoped to
 * a DIFFERENT failure class:
 *
 * A writable own-log (peer-log.ts `openOwnLog`) hits Hypercore's
 * equivocation loop when the local disk state disagrees with a signed
 * proof another party presents for the SAME length (two conflicting
 * signatures for one length — "two live keys at once" WI-1891 class, or a
 * corrupted/rolled-back local store that re-signed different content over
 * history it already published). Hypercore's own `core.js` prints
 * `[hypercore] conflict detected in <discoveryKey> (writable=…)` and then
 * calls `closeAllSessions(err)` — every open session to that core (incl.
 * the merge loop's own writer) throws SESSION_CLOSED on its next op. Until
 * this guard, that failure was SILENT: no boot-history event, no EI, no
 * health-verdict signal — just a crash (or a caught-and-retried boot) that
 * re-opens the SAME corrupted on-disk core and re-triggers the same
 * conflict on the next reconnect (the observed boot loop; old key
 * e06b8704 cost hours before anyone noticed the actual cause).
 *
 * Unlike replication-liveness's per-log verdict ladder (a stall can
 * recover on its own once a peer reconnects), an own-log fork does NOT
 * self-heal: the writable core's on-disk state is the wrong shape now, and
 * appending more ops to it just signs more history under a keypair every
 * OTHER peer already has conflicting proof for. So this module's registry
 * is a simple LATCH per (workspace, harness) — set once (edge-triggered:
 * first conflict per process), cleared ONLY by an explicit
 * `clearOwnLogForkState` call from whatever completes the supported
 * recovery (a per-harness store reset — see own-log-fork-ei.ts's EI body).
 *
 * Pure in-process state: no PG, no timers, no fetch, no Hypercore import.
 * `attachOwnLogForkListener` (below) is the only piece that touches a real
 * core, and it degrades to a no-op when the passed-in core doesn't expose
 * `.on` (test fakes, and any future non-Hypercore CoreLike).
 */

import { trackDetached } from '../../detached-imports';

/** One detected own-log fork ("conflict") episode. */
export interface OwnLogForkEpisode {
  workspaceId: string;
  harnessSlug: string;
  /** 64-char hex hypercore key of the (writable) own log that forked. */
  keyHex: string;
  /** Human-readable one-liner for the boot event / EI body. */
  detail: string;
}

interface ForkState {
  keyHex: string;
  detectedAtMs: number;
  detail: string;
}

/** Read-time view of one harness's own-log-fork state. */
export interface OwnLogForkState {
  forked: boolean;
  keyHex: string | null;
  detectedAtMs: number | null;
  detail: string | null;
}

/** Registry: `${workspaceId}::${harnessSlug}` → latched fork state (or absent = healthy). */
const registry = new Map<string, ForkState>();

const hKey = (workspaceId: string, harnessSlug: string): string =>
  `${workspaceId}::${harnessSlug}`;

/**
 * Module-level episode reporter seam (mirrors replication-liveness.ts).
 * Production default: a loud console line (grep-able, same rationale as
 * replication-liveness's Leg 0) + a durable EI via a LAZY dynamic import so
 * this module stays pure/PG-free for unit tests and non-PG callers.
 */
let episodeReporter: ((episode: OwnLogForkEpisode) => void) | null = null;

export function setOwnLogForkEpisodeReporterForTests(
  fn: ((episode: OwnLogForkEpisode) => void) | null,
): void {
  episodeReporter = fn;
}

function defaultEpisodeReporter(episode: OwnLogForkEpisode): void {
  try {

    console.error(
      `[own-log-fork-guard] own_log_forked harness=${episode.harnessSlug} ${episode.detail}`,
    );
  } catch {
    /* diagnostic-only */
  }
  // Lazy import so the pure module never statically links PG (same pattern
  // as replication-liveness.ts's defaultEpisodeReporter).
  void trackDetached(import('./own-log-fork-ei'))
    .then((m) => m.fileOwnLogForkEi(episode))
    .catch(() => {
      /* escalation is best-effort; the registry state still surfaces it */
    });
}

function reportEpisode(episode: OwnLogForkEpisode): void {
  try {
    (episodeReporter ?? defaultEpisodeReporter)(episode);
  } catch {
    /* never let a reporter throw back into the caller (the Hypercore 'conflict'
     * listener, or the merge pass) */
  }
}

export interface ReportOwnLogForkOpts {
  /** Test seam — clock override. */
  nowMs?: number;
  /** Episode sink override. Omit for the module default (console + durable EI). */
  onEpisode?: (episode: OwnLogForkEpisode) => void;
}

/**
 * Report one own-log conflict observation. EDGE-TRIGGERED: the first call
 * for a given (workspaceId, harnessSlug) latches the fork state and fires
 * the reporter; every subsequent call for the SAME (workspace, harness)
 * before a `clearOwnLogForkState` is a silent no-op (Hypercore's own
 * `closeAllSessions` means a real conflict fires at most a handful of times
 * per process anyway — this just keeps re-entrant callers, or a caller that
 * observes the same closed-session error from multiple await sites, from
 * spamming the reporter). A DIFFERENT keyHex overwrites the latch (a fresh
 * own log — e.g. after a manual recovery — that ALSO forks is a new, worth-
 * reporting episode). Never throws.
 */
export function reportOwnLogForkConflict(
  episode: OwnLogForkEpisode,
  opts: ReportOwnLogForkOpts = {},
): void {
  const now = opts.nowMs ?? Date.now();
  const onEpisode = opts.onEpisode ?? reportEpisode;
  const key = hKey(episode.workspaceId, episode.harnessSlug);
  const existing = registry.get(key);
  if (existing && existing.keyHex === episode.keyHex) return; // already latched — edge-triggered
  registry.set(key, { keyHex: episode.keyHex, detectedAtMs: now, detail: episode.detail });
  try {
    onEpisode(episode);
  } catch {
    /* never let a reporter throw back into the caller */
  }
}

/** Read-time snapshot for a (workspace, harness) — what health.ts consumes. */
export function getOwnLogForkState(workspaceId: string, harnessSlug: string): OwnLogForkState {
  const st = registry.get(hKey(workspaceId, harnessSlug));
  if (!st) return { forked: false, keyHex: null, detectedAtMs: null, detail: null };
  return { forked: true, keyHex: st.keyHex, detectedAtMs: st.detectedAtMs, detail: st.detail };
}

/**
 * Clear a latched fork state — call ONLY after the supported recovery
 * (per-harness store reset → fresh corestore primary key) has actually
 * completed and the harness has re-booted onto a NEW own-log key. Does
 * NOT itself perform any recovery (see own-log-fork-ei.ts /
 * own-log-fork-recovery.ts for the flag-gated, default-OFF sketch) —
 * this is purely the registry-side "the fork is gone" acknowledgement so a
 * future re-boot's health reads 'healthy' again and a future fork on the
 * NEW key can latch fresh.
 */
export function clearOwnLogForkState(workspaceId: string, harnessSlug: string): void {
  registry.delete(hKey(workspaceId, harnessSlug));
}

/**
 * Minimal structural view of the Hypercore session's monitor-event surface
 * this module needs — feature-detected so a test fake `CoreLike` (peer-log.ts)
 * that doesn't implement EventEmitter never breaks. Real Hypercore sessions
 * (`store.get(...)` in corestore.ts) satisfy this: `.on('conflict', …)` lazily
 * registers the session as a Hypercore "monitor" (see node_modules/hypercore
 * lib/core.js `_onconflict` → `s.emit('conflict', length, fork, proof)`).
 */
export interface ConflictEmittingCore {
  on(event: 'conflict', handler: (length: number, fork: number, proof: unknown) => void): unknown;
}

/**
 * Wire a REAL Hypercore session's `'conflict'` event to this detector. Call
 * once per own-log open (boot.ts, right after `openOwnLog(store)`) — a no-op
 * when the core doesn't expose `.on` (defensive; never throws). This is what
 * actually closes the "fails SILENTLY" gap: without it, the pure
 * `reportOwnLogForkConflict` above is only ever exercised by tests passing a
 * faked signal, and a REAL conflict still silently boot-loops.
 */
export function attachOwnLogForkListener(
  core: unknown,
  workspaceId: string,
  harnessSlug: string,
  keyHex: string,
): void {
  if (core == null) return; // defensive — never throws on a null/undefined core
  const c = core as Partial<ConflictEmittingCore>;
  if (typeof c.on !== 'function') return; // feature-detected — a test fake CoreLike no-ops here
  try {
    c.on('conflict', (length: number, fork: number) => {
      reportOwnLogForkConflict({
        workspaceId,
        harnessSlug,
        keyHex,
        detail:
          `[hypercore] conflict detected in own log ${keyHex.slice(0, 12)}… — two ` +
          `conflicting signatures exist for length ${length} (fork ${fork}). The writable ` +
          `core lost history but kept its keypair; Hypercore is closing every open session ` +
          `to this core (SESSION_CLOSED on the next op) — a re-boot will re-open the SAME ` +
          `corrupted core and re-fork on the next reconnect unless the store is reset.`,
      });
    });
  } catch {
    /* best-effort: a listener-attach failure must never wedge the boot path */
  }
}

/** Test seam — wipe the registry + reporter between tests. */
export function _resetOwnLogForkGuardForTests(): void {
  registry.clear();
  episodeReporter = null;
}

/**
 * WI-3684 send-side twin: detect a Hypercore `SESSION_CLOSED` error — thrown
 * by every open session to a core once Hypercore's equivocation guard (the
 * conflict handler above) or an explicit close tears it down (see the
 * `attachOwnLogForkListener` doc comment + health.ts's `ownLogFork` field).
 * Structural (checks `.code`), so it matches both a real `hypercore-errors`
 * `HypercoreError` and a plain test fake that just sets `.code =
 * 'SESSION_CLOSED'`. Callers (outbox-drain.ts, presence-announce.ts) use this
 * to distinguish "this session is permanently dead, stop blind-retrying and
 * signal for a re-wire" from an ordinary transient append/PG failure that the
 * next poll tick should keep retrying as before.
 */
export function isSessionClosedError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === 'SESSION_CLOSED'
  );
}
