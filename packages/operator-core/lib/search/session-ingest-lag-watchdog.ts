/**
 * session-ingest-lag-watchdog.ts — the transcript-ingest silent-degradation
 * guard (session-turn-storage-2026-07-28 P-007, D-005).
 *
 * THE BUG THIS EXISTS TO CATCH, and the reason it is NOT a lag threshold.
 *
 * On 2026-07-28 the corpus read: claude 59 s behind, codex 2 d 9 h behind, omp
 * 6 d 8 h behind. That looks like two dead adapters. It was not — P-005 checked
 * the disk and found ZERO codex rollouts modified since the codex cursor and
 * ZERO omp transcripts modified in 45 days. Both adapters were healthy and
 * fully caught up; nobody had run those clients.
 *
 * That is the whole design constraint. **A quiet adapter and a wedged adapter
 * are INDISTINGUISHABLE in the lag column**, so a watchdog thresholding on
 * `now() - max(ts)` would have paged twice that morning for nothing — and, far
 * worse, would have trained everyone to ignore it before the day a real wedge
 * showed up. Alert fatigue on a silent-degradation guard is not a nuisance, it
 * defeats the guard.
 *
 * So the condition is SOURCE-RELATIVE, not clock-relative: alert only when
 * there are bytes ON DISK that the adapter has NOT consumed and has not
 * consumed for longer than the threshold. That is unambiguous — the work
 * exists, the worker is not doing it — and it stays silent forever on an
 * adapter nobody uses, which is the correct behavior.
 *
 * Same chassis as the sibling watchdogs (rubric-staleness,
 * release-deploy-staleness): a PURE decider unit-tested with no DB or fs, a
 * thin sweep wired into routinesTick as one durable step, fail-soft
 * throughout, an env `<=0` kill switch, and the shared fires-ledger debounce.
 */
import { open, stat } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { recentWatchdogFires, recordFire } from '../pot/watchdog';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

/** How long an adapter may sit on unconsumed on-disk bytes before this
 *  watchdog alerts. Default 1 h — comfortably longer than the 2-min ingest
 *  cron plus the per-tick file/byte caps, so normal backlog drain is never
 *  mistaken for a wedge. `<=0` DISABLES the sweep (kill switch). */
export function ingestLagThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_INGEST_LAG_THRESHOLD_SEC ?? 3_600);
  return Number.isFinite(n) ? n : 3_600;
}

/** Ignore a backlog smaller than this — a transcript's last line is written
 *  incrementally, so a live session ALWAYS has a few hundred unconsumed bytes
 *  (readNewLines deliberately stops at the last complete line). Without this
 *  floor every busy session would look like a wedge.
 *
 *  ⚠ APPLIED PER FILE, in observeAdapterLag, BEFORE aggregating
 *  (EI-19280389878453845). It was originally tested only against the
 *  per-ADAPTER sum, which defeated it: this floor's whole premise is
 *  per-file ("a live session ALWAYS has a few hundred unconsumed bytes"), and
 *  summing enough of those sub-floor tails always crosses it. Measured
 *  2026-08-01, with claude ingest demonstrably healthy: 20 files behind /
 *  537 KB summed, but only 2 individually at the floor — so 18 files that this
 *  constant exists to ignore were being counted, and the adapter was reported
 *  WEDGED. evaluateIngestLag still re-checks the sum, which is now redundant
 *  for observeAdapterLag's own output but keeps a hand-built observation
 *  honest. */
export const INGEST_LAG_MIN_BACKLOG_BYTES = 64 * 1024;

/** How much of a file's unconsumed remainder to probe when deciding whether it
 *  contains a complete line. A remainder larger than this is taken as real
 *  backlog without reading: a single JSONL record above 1 MB is possible but
 *  vanishingly rare, and erring toward ALERTING on a huge remainder is the
 *  right direction for a wedge guard. */
const MAX_TAIL_PROBE_BYTES = 1024 * 1024;

/**
 * PURE: does a file's unconsumed remainder represent work the adapter could
 * actually consume?
 *
 * Two independent reasons a remainder is NOT consumable work:
 *   1. it is below the per-file floor — the ordinary partially-written tail;
 *   2. it contains no complete line at all — `readNewLines` stops at the last
 *      newline by design, so a remainder with no newline is BY CONSTRUCTION
 *      unconsumable, and will stay unconsumed forever once the session ends
 *      mid-line. That is the shape that made the age counter run away: the
 *      state row stops advancing precisely because there is nothing valid to
 *      consume, so `now - updated_at` grows without bound and eventually
 *      crosses any threshold.
 */
export function remainderIsConsumableWork(
  remainderBytes: number,
  remainderHasCompleteLine: boolean,
): boolean {
  if (remainderBytes < INGEST_LAG_MIN_BACKLOG_BYTES) return false;
  return remainderHasCompleteLine;
}

/** One adapter's observed state: its most-stale unconsumed file. */
export interface AdapterLagObservation {
  sourceKind: string;
  /** Files with on-disk bytes past their stored byte_offset. */
  behindFiles: number;
  /** Total unconsumed bytes across those files. */
  backlogBytes: number;
  /** Age (ms) of the OLDEST unconsumed backlog — how long the adapter has been
   *  sitting on work, measured from that file's ingest-state updated_at. */
  oldestBacklogAgeMs: number;
  /** The worst offender, for the alert body. */
  worstPath: string | null;
  /** Files skipped as ordinary partially-written tails (below the per-file
   *  floor). Optional so hand-built observations in tests stay valid. */
  ignoredTailFiles?: number;
  /** Files skipped because their remainder holds no complete line — by
   *  construction unconsumable, not a wedge. */
  ignoredIncompleteFiles?: number;
}

export interface IngestLagVerdict {
  wedged: boolean;
  reason: string;
}

/**
 * PURE: is this adapter WEDGED (as opposed to merely quiet)?
 *
 * Deliberately makes no reference to wall-clock lag or to `max(ts)`. The only
 * question asked is: does unconsumed work exist, is it big enough to be real,
 * and has it been sitting there past the threshold?
 */
export function evaluateIngestLag(obs: AdapterLagObservation, thresholdMs: number): IngestLagVerdict {
  if (thresholdMs <= 0) return { wedged: false, reason: 'kill switch (thresholdMs <= 0)' };
  if (obs.behindFiles === 0) {
    // Say what was ignored and why. A bare "fully caught up" while 20 files
    // sit behind is exactly the kind of verdict nobody can audit, and it is
    // what made EI-19280389878453845 take a live investigation to unpick.
    const tails = obs.ignoredTailFiles ?? 0;
    const incomplete = obs.ignoredIncompleteFiles ?? 0;
    const ignored = tails + incomplete
      ? ` Ignored ${tails} sub-floor tail(s) and ${incomplete} file(s) whose remainder holds no ` +
        `complete line — both are normal steady state, not backlog.`
      : '';
    return {
      wedged: false,
      reason:
        `${obs.sourceKind}: fully caught up — no consumable bytes past the cursor.${ignored} ` +
        `(An adapter nobody is running looks exactly like this, and that is correct: ` +
        `wall-clock lag is NOT evidence of a wedge — D-005.)`,
    };
  }
  if (obs.backlogBytes < INGEST_LAG_MIN_BACKLOG_BYTES) {
    return {
      wedged: false,
      reason:
        `${obs.sourceKind}: ${obs.backlogBytes} unconsumed byte(s) across ${obs.behindFiles} file(s) — ` +
        `below the ${INGEST_LAG_MIN_BACKLOG_BYTES}-byte floor (a live session's partially-written last line).`,
    };
  }
  if (obs.oldestBacklogAgeMs < thresholdMs) {
    const mins = Math.round(obs.oldestBacklogAgeMs / 60_000);
    return {
      wedged: false,
      reason:
        `${obs.sourceKind}: ${obs.backlogBytes} unconsumed byte(s), oldest ${mins}m — ` +
        `inside the threshold window (normal bounded-tick drain).`,
    };
  }
  const hours = (obs.oldestBacklogAgeMs / 3_600_000).toFixed(1);
  const mb = (obs.backlogBytes / 1_048_576).toFixed(1);
  return {
    wedged: true,
    reason:
      `${obs.sourceKind} ingest is WEDGED: ${mb} MB across ${obs.behindFiles} transcript file(s) has sat ` +
      `unconsumed past the adapter's byte_offset for ${hours}h. The work exists on disk and the adapter is ` +
      `not consuming it — this is NOT a quiet client. Worst offender: ${obs.worstPath ?? 'unknown'}.`,
  };
}

const INGEST_LAG_IDENTITY: AgentIdentity = {
  ownerId: 'session-ingest-lag-watchdog',
  ownerLabel: 'system · session-ingest-lag-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface IngestLagSweepResult {
  sourceKind: string;
  outcome: 'alerted' | 'healthy' | 'debounced' | 'skipped' | 'error';
  reason: string;
}

export interface IngestLagSweepDeps {
  observe?: () => Promise<AdapterLagObservation[]>;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  now?: number;
}

/**
 * Read each adapter's unconsumed-backlog state.
 *
 * Bounded on purpose: only bookkeeping rows touched inside the ingest window
 * are considered, and only the N most recently-updated per source_kind are
 * stat()ed. The corpus is ~13k claude rows — stat()ing all of them every
 * routines tick would be a fleet-visible fs storm for a health check, and a
 * wedge that affects only cold files nobody is appending to is not a wedge.
 */
/**
 * Does the unconsumed remainder of `path` contain at least one complete line?
 *
 * Bounded: probes at most MAX_TAIL_PROBE_BYTES, and a remainder larger than
 * that is taken as real backlog without reading. Fail-soft — an unreadable
 * file is treated as NOT consumable, so an fs error can never manufacture a
 * wedge alert.
 */
async function remainderHasCompleteLine(
  path: string,
  byteOffset: number,
  remainderBytes: number,
): Promise<boolean> {
  if (remainderBytes > MAX_TAIL_PROBE_BYTES) return true;
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.allocUnsafe(remainderBytes);
    const { bytesRead } = await fh.read(buf, 0, remainderBytes, byteOffset);
    return buf.subarray(0, bytesRead).includes(0x0a); // '\n'
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function observeAdapterLag(): Promise<AdapterLagObservation[]> {
  const { sql } = getOrgPg();
  const MAX_FILES_PER_KIND = 250;
  const rows = await sql<Array<{
    source_kind: string; file_path: string; byte_offset: string | number; updated_at: string;
  }>>`
    SELECT source_kind, file_path, byte_offset, updated_at::text AS updated_at
      FROM (
        SELECT source_kind, file_path, byte_offset, updated_at,
               row_number() OVER (PARTITION BY source_kind ORDER BY updated_at DESC) AS rn
          FROM harness_shared.session_ingest_state
         WHERE file_path <> '__hwm__'
           AND updated_at > now() - interval '45 days'
      ) ranked
     WHERE rn <= ${MAX_FILES_PER_KIND}
  `;
  const byKind = new Map<string, AdapterLagObservation>();
  const now = Date.now();
  for (const r of rows) {
    const obs = byKind.get(r.source_kind) ?? {
      sourceKind: r.source_kind, behindFiles: 0, backlogBytes: 0, oldestBacklogAgeMs: 0, worstPath: null,
    };
    byKind.set(r.source_kind, obs);
    let size: number;
    try {
      const s = await stat(r.file_path);
      if (!s.isFile()) continue;
      size = s.size;
    } catch {
      // Archived/deleted after its state row was written — not a backlog.
      continue;
    }
    const behind = size - Number(r.byte_offset);
    if (behind <= 0) continue;
    // EI-19280389878453845: filter PER FILE before aggregating. Both of these
    // shapes are normal steady state, and counting them reported a healthy
    // adapter as WEDGED — the alert-fatigue failure D-005/D-006 exist to
    // prevent, reintroduced by aggregation.
    if (behind < INGEST_LAG_MIN_BACKLOG_BYTES) {
      obs.ignoredTailFiles = (obs.ignoredTailFiles ?? 0) + 1;
      continue;
    }
    if (!(await remainderHasCompleteLine(r.file_path, Number(r.byte_offset), behind))) {
      obs.ignoredIncompleteFiles = (obs.ignoredIncompleteFiles ?? 0) + 1;
      continue;
    }
    const ageMs = Math.max(0, now - Date.parse(r.updated_at));
    obs.behindFiles += 1;
    obs.backlogBytes += behind;
    if (ageMs > obs.oldestBacklogAgeMs) {
      obs.oldestBacklogAgeMs = ageMs;
      obs.worstPath = r.file_path;
    }
  }
  // Every source_kind with a bookkeeping row is seeded above BEFORE the
  // stat(), so an adapter with zero backlog still reports a healthy verdict
  // rather than silently vanishing from the sweep.
  return [...byKind.values()];
}

/**
 * The ingest-lag sweep. Debounced per source_kind via the shared fires ledger
 * (one alert per threshold window); fail-soft per adapter AND overall.
 * Kill switch: PAPERCUSP_INGEST_LAG_THRESHOLD_SEC <= 0.
 */
export async function sessionIngestLagSweep(
  opts: { workspaceId?: string; installSlug?: string } = {},
  deps: IngestLagSweepDeps = {},
): Promise<IngestLagSweepResult[]> {
  const thresholdSec = ingestLagThresholdSec();
  if (thresholdSec <= 0) return [{ sourceKind: '*', outcome: 'skipped', reason: 'kill switch' }];
  const thresholdMs = thresholdSec * 1_000;
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? 'papercusp';
  const results: IngestLagSweepResult[] = [];
  try {
    const observations = await (deps.observe ?? observeAdapterLag)();
    for (const obs of observations) {
      try {
        const verdict = evaluateIngestLag(obs, thresholdMs);
        if (!verdict.wedged) {
          results.push({ sourceKind: obs.sourceKind, outcome: 'healthy', reason: verdict.reason });
          continue;
        }
        const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
        const firedRecently =
          (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
            workspaceId, installSlug, windowHours, 'session-ingest-lag', obs.sourceKind,
          )) > 0;
        if (firedRecently) {
          results.push({ sourceKind: obs.sourceKind, outcome: 'debounced', reason: 'fires-ledger debounce' });
          continue;
        }
        console.warn(`[session-ingest-lag] ALERT: ${verdict.reason}`);
        await (deps.recordFire ?? recordFire)({
          workspaceId, installSlug, source: 'session-ingest-lag', reason: verdict.reason, wakeAt: null,
        });
        await (deps.openEscalation ?? openEscalation)(INGEST_LAG_IDENTITY, {
          severity: 'advisory',
          summary: `Transcript ingest wedged for source_kind '${obs.sourceKind}'`,
          body:
            `${verdict.reason}\n\n` +
            `Why this is trustworthy: the condition is SOURCE-RELATIVE, not a lag threshold — it fires only ` +
            `because unconsumed bytes exist on disk, so a quiet client can never trigger it (D-005).\n\n` +
            `To diagnose: read harness_shared.session_ingest_state for this source_kind (last_error, ` +
            `byte_offset, updated_at) and compare against the file on disk. A stuck byte_offset with a ` +
            `recurring last_error is a parse/DB failure; a stuck offset with NO error is usually the sweep ` +
            `not reaching this adapter (per-tick file/byte caps, or an enumerate failure earlier in the ` +
            `adapter loop). Force one pass with ingestFileNow on the worst path to surface the real error.`,
        });
        results.push({ sourceKind: obs.sourceKind, outcome: 'alerted', reason: verdict.reason });
      } catch (e) {
        results.push({
          sourceKind: obs.sourceKind, outcome: 'error', reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    results.push({ sourceKind: '*', outcome: 'error', reason: e instanceof Error ? e.message : String(e) });
  }
  return results;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE COMPLEMENT GUARD — a WRITER that produces nothing while the adapter
 * happily advances (session-turn-storage-2026-07-28 D-008).
 *
 * The lag sweep above asks "is unconsumed work piling up?". It structurally
 * CANNOT catch the failure that actually happened on 2026-07-28, because that
 * failure had no backlog at all: bg-host was running a module-cached build
 * predating the parts writer, so it consumed every byte on schedule, wrote the
 * text turns, and wrote ZERO parts. `behindFiles` was 0, so the lag sweep
 * correctly reported "fully caught up" on every tick, all night.
 *
 * These two conditions are complements, and this one is the WORSE half:
 *   * lag wedge      — cursor stalls, bytes wait. RECOVERABLE: rewind
 *                      byte_offset and the bytes are re-read.
 *   * writer silence — cursor advances, writer emits nothing. PERMANENT:
 *                      consumed bytes are never re-read, so every byte
 *                      ingested while the writer was dead is missing from the
 *                      parts store forever. Nothing backfills it.
 *
 * That asymmetry is the whole justification for a second guard: the cheap
 * failure is the one that alarms today, and the expensive one was invisible.
 *
 * It inherits the anti-alert-fatigue discipline D-006 imposed on its sibling,
 * and needs it MORE, because "part_count is 0" is the correct steady state for
 * three of the four adapters. So it judges an adapter only when BOTH:
 *   1. the adapter actually implements `parseParts` (derived from
 *      FILE_ADAPTERS, never hardcoded — the day omp or codex gains a parts
 *      parser this guard starts covering it with no edit here), and
 *   2. the adapter demonstrably DID work in the window (turns > 0) — so a
 *      quiet client is silent here exactly as it is in the lag sweep.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Window over which "did the writer produce anything?" is asked. Default 1 h:
 *  long enough that a genuinely idle hour on a busy adapter is rare, short
 *  enough that a dead writer is caught in one hour rather than one night.
 *  `<=0` DISABLES the sweep (kill switch), matching its sibling. */
export function partsWriterWindowSec(): number {
  const n = Number(process.env.PAPERCUSP_PARTS_WRITER_WINDOW_SEC ?? 3_600);
  return Number.isFinite(n) ? n : 3_600;
}

export interface PartsWriterObservation {
  sourceKind: string;
  /** Does this adapter implement `parseParts`? Only these are judged. */
  expectsParts: boolean;
  /** Turns ingested inside the window — the PROOF the adapter did work. */
  turnsInWindow: number;
  /** Parts written inside the window. */
  partsInWindow: number;
}

export interface PartsWriterVerdict {
  degraded: boolean;
  reason: string;
}

/**
 * PURE: is this adapter's parts WRITER silently dead?
 *
 * Deliberately says nothing about volume or ratios. A ratio test would have to
 * model how many parts a turn "should" yield, which varies enormously by
 * session shape (a tool-heavy turn yields many, a chat turn yields one) — and a
 * wrong model here produces exactly the false alarms D-006 forbids. The only
 * question asked is the unambiguous one: it did work, and produced nothing.
 */
export function evaluatePartsWriter(obs: PartsWriterObservation): PartsWriterVerdict {
  if (!obs.expectsParts) {
    return {
      degraded: false,
      reason:
        `${obs.sourceKind}: no parseParts adapter — storing zero parts is this adapter's CORRECT ` +
        `steady state, not a regression. (Judging it would alarm forever on three of four adapters, ` +
        `which is the alert-fatigue failure D-006 exists to prevent.)`,
    };
  }
  if (obs.turnsInWindow === 0) {
    return {
      degraded: false,
      reason:
        `${obs.sourceKind}: no turns ingested in the window — nothing was consumed, so the writer ` +
        `cannot be judged. A quiet client is silent here exactly as in the lag sweep.`,
    };
  }
  if (obs.partsInWindow > 0) {
    return {
      degraded: false,
      reason:
        `${obs.sourceKind}: writer healthy — ${obs.partsInWindow} part(s) alongside ` +
        `${obs.turnsInWindow} turn(s) in the window.`,
    };
  }
  return {
    degraded: true,
    reason:
      `${obs.sourceKind} parts writer is SILENTLY DEAD: ${obs.turnsInWindow} turn(s) were ingested in ` +
      `the window and ZERO parts were written. The adapter is consuming bytes and the faithful-parts ` +
      `writer is producing nothing. This is NOT a quiet client and NOT a backlog — the lag sweep reads ` +
      `"fully caught up" while this happens, which is why it needs its own guard. ` +
      `⚠ THE LOSS IS PERMANENT: consumed bytes are never re-read, so every byte ingested while this ` +
      `persists is missing from session_turn_parts forever. Fix it NOW, not at the next deploy.`,
  };
}

const PARTS_WRITER_IDENTITY: AgentIdentity = {
  ownerId: 'session-parts-writer-watchdog',
  ownerLabel: 'system · session-parts-writer-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Read per-adapter turn/part counts inside the window. One query, two counts. */
async function observePartsWriter(windowMs: number): Promise<PartsWriterObservation[]> {
  const { sql } = getOrgPg();
  const { FILE_ADAPTERS } = await import('./session-ingest');
  // Derived, never hardcoded: the guard's scope tracks the adapter registry.
  const expects = new Set(
    FILE_ADAPTERS.filter((a) => typeof a.parseParts === 'function').map((a) => a.sourceKind as string),
  );
  const seconds = Math.max(1, Math.round(windowMs / 1_000));
  const rows = await sql<Array<{ source_kind: string; turns: string | number; parts: string | number }>>`
    WITH t AS (
      SELECT source_kind, count(*) AS turns
        FROM harness_shared.session_turns
       WHERE ingested_at > now() - make_interval(secs => ${seconds})
       GROUP BY source_kind
    ), p AS (
      SELECT source_kind, count(*) AS parts
        FROM harness_shared.session_turn_parts
       WHERE ingested_at > now() - make_interval(secs => ${seconds})
       GROUP BY source_kind
    )
    SELECT COALESCE(t.source_kind, p.source_kind) AS source_kind,
           COALESCE(t.turns, 0) AS turns,
           COALESCE(p.parts, 0) AS parts
      FROM t FULL OUTER JOIN p ON t.source_kind = p.source_kind
  `;
  // Seed every parts-capable adapter even with no rows at all, so a wholly
  // silent adapter still gets an explicit verdict instead of vanishing.
  const byKind = new Map<string, PartsWriterObservation>();
  for (const k of expects) {
    byKind.set(k, { sourceKind: k, expectsParts: true, turnsInWindow: 0, partsInWindow: 0 });
  }
  for (const r of rows) {
    byKind.set(r.source_kind, {
      sourceKind: r.source_kind,
      expectsParts: expects.has(r.source_kind),
      turnsInWindow: Number(r.turns),
      partsInWindow: Number(r.parts),
    });
  }
  return [...byKind.values()];
}

export interface PartsWriterSweepDeps {
  observe?: (windowMs: number) => Promise<PartsWriterObservation[]>;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
}

/**
 * The parts-writer sweep. Same chassis as its sibling: debounced per
 * source_kind through the shared fires ledger, fail-soft per adapter and
 * overall, env kill switch.
 *
 * Deliberately a SEPARATE sweep rather than another branch inside
 * sessionIngestLagSweep: it asks a different question of different tables, and
 * folding it in would have meant a second un-stubbed DB read inside a function
 * whose existing tests inject only `observe` — silently turning ten pure unit
 * tests into ones that need Postgres.
 */
export async function sessionPartsWriterSweep(
  opts: { workspaceId?: string; installSlug?: string } = {},
  deps: PartsWriterSweepDeps = {},
): Promise<IngestLagSweepResult[]> {
  const windowSec = partsWriterWindowSec();
  if (windowSec <= 0) return [{ sourceKind: '*', outcome: 'skipped', reason: 'kill switch' }];
  const windowMs = windowSec * 1_000;
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? 'papercusp';
  const results: IngestLagSweepResult[] = [];
  try {
    const observations = await (deps.observe ?? observePartsWriter)(windowMs);
    for (const obs of observations) {
      try {
        const verdict = evaluatePartsWriter(obs);
        if (!verdict.degraded) {
          results.push({ sourceKind: obs.sourceKind, outcome: 'healthy', reason: verdict.reason });
          continue;
        }
        const windowHours = Math.max(1, Math.round(windowSec / 3_600));
        const firedRecently =
          (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
            workspaceId, installSlug, windowHours, 'session-parts-writer', obs.sourceKind,
          )) > 0;
        if (firedRecently) {
          results.push({ sourceKind: obs.sourceKind, outcome: 'debounced', reason: 'fires-ledger debounce' });
          continue;
        }
        console.warn(`[session-parts-writer] ALERT: ${verdict.reason}`);
        await (deps.recordFire ?? recordFire)({
          workspaceId, installSlug, source: 'session-parts-writer', reason: verdict.reason, wakeAt: null,
        });
        await (deps.openEscalation ?? openEscalation)(PARTS_WRITER_IDENTITY, {
          // 'advisory', same rung as the lag sweep, though this condition is
          // strictly worse (permanent loss vs deferred work). The escalation
          // vocabulary is only blocker | question | advisory, and 'blocker'
          // would be a lie — this loses data but blocks nobody's work. Rather
          // than inflate the severity, the urgency is carried where a reader
          // will actually act on it: the body leads with the permanence and
          // names the exact lever.
          severity: 'advisory',
          summary: `Session parts writer silently dead for source_kind '${obs.sourceKind}'`,
          body:
            `${verdict.reason}\n\n` +
            `MOST LIKELY CAUSE, from the incident that motivated this guard (D-008): a long-lived host ` +
            `is running a module-cached build older than the tree it loads from. The session ingest runs ` +
            `on papercup-bg-host, whose WorkingDirectory is the STAGING tree and which executes tsx from ` +
            `it — NOT from papercup-release. So a DEPLOY DOES NOT FIX THIS. Check ` +
            `\`systemctl --user show papercup-bg-host.service -p ExecMainStartTimestamp\` against the ` +
            `commit time of session-ingest.ts; if the host is older, restart it: ` +
            `dev:restart { target: 'bg-host', confirm: true, authorize: true }.\n\n` +
            `Other candidates: the parts INSERT failing every tick (it is best-effort by contract and ` +
            `swallows its own error, so check the sweep's errorSample and the '+N part(s)' figure in the ` +
            `[session-ingest] log line), or migration 702 not applied on this database.`,
        });
        results.push({ sourceKind: obs.sourceKind, outcome: 'alerted', reason: verdict.reason });
      } catch (e) {
        results.push({
          sourceKind: obs.sourceKind, outcome: 'error', reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    results.push({ sourceKind: '*', outcome: 'error', reason: e instanceof Error ? e.message : String(e) });
  }
  return results;
}
