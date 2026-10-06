/**
 * carry-respawn-outcome — read back what ACTUALLY happened to this session's
 * last carry-respawn, so `session:request-compaction` can report the EFFECT
 * instead of only the acknowledgement (EI-19480099650947832).
 *
 * WHY THIS EXISTS. `session:request-compaction` returns `respawn: true` when the
 * socket write to the psu-pty host succeeded. That is a statement about a
 * REQUEST being accepted, not about a cut occurring — and the two genuinely
 * diverge. The host's carry-respawn has to win a busy-gate: it waits for the
 * agent's pty to go quiet for OUTPUT_QUIET_MS, re-polls across successive
 * windows, and can still end in `respawn-carry-dropped` (busy-gate-expired /
 * carry-stale / superseded / rearm-error). Every one of those outcomes is
 * written to the per-owner host event log — a JSONL file that, until this
 * module, NO tool read. So the failure mode is silent in the worst possible
 * direction: the caller is told the cut is queued, correctly stops working, and
 * keeps accumulating context past its ceiling until a FORCE compaction seizes a
 * turn mid-thought — which is precisely what self-compaction exists to prevent.
 *
 * Measured 2026-08-04 on session su-4a6e2255-… (the filing that commissioned
 * this): `respawn-rearm-queued` at 00:28:00 → the re-poll ran fruitlessly for
 * 14+ minutes → a second request-compaction was terminally dropped at 00:38:29,
 * and the agent learned none of it.
 *
 * SECOND FAILURE, SAME SHAPE (P-009, fleet-lead-instrumentation-audit-2026-08-09):
 * an attempt can be PRE-EMPTED instead of refused — an internal claude re-exec or
 * a host restart takes the pending cut with it — and then NO verdict row is ever
 * written. The reader reported `pending` indefinitely and every warning here was
 * gated on `dropped`, so the one case with no evidence to quote was also the one
 * case that said nothing. The stamped `capMs` bounds ONE wait, however: the
 * production controller retries across multiple windows. Elapsed time can
 * establish a DELAY, never prove that the controller died or lost its request.
 *
 * The derivation is PURE and exported separately from the IO so it can be
 * unit-tested without a host. The row reader is the EXISTING
 * `readOwnerHostEvents` — deliberately not a second reader of the same file.
 */
import { readOwnerHostEvents, type ColdBootDrillHostEvent } from './cold-boot-drill-live';

/** Host event kinds that constitute the carry-respawn lifecycle, in the order a
 *  successful respawn emits them. Anything else in the log (wake deferrals,
 *  stale-fire drops, shutdown rows) is NOT a verdict about a respawn. */
const RESPAWN_TERMINAL_OK = new Set(['respawn-carry-delivered']);
// `respawn-failed` is emitted when the host cannot build/spawn the successor
// (for example a missing per-session Codex AGENTS.md). It is terminal for this
// carry attempt just like `respawn-carry-dropped`; omitting it makes the reader
// report an already-failed request as `pending` forever.
const RESPAWN_TERMINAL_FAIL = new Set(['respawn-carry-dropped', 'respawn-failed']);
/** Non-terminal: an attempt is still re-polling for an idle window. */
const RESPAWN_IN_FLIGHT = new Set(['respawn-rearm-queued', 'respawn-rearm-superseded']);

/**
 * `respawn-carry-dropped {reason:'superseded'}` is the host RETIRING a moot request, not
 * losing a continuation (WI-10005752). The host decides it with
 * `isCarryRespawnSuperseded(request.receivedAtMs, lastRespawnAtMs)` (psu-pty-host.mjs):
 * a respawn already happened AFTER the request arrived, so a newer child exists and
 * "must retire their pending wake suppression without another cut". The newer child
 * writes its OWN verdict rows (`respawned` / `respawn-carry-delivered` / a real drop),
 * so the retirement row adds no loss evidence. It is written LATE (at the stale
 * re-poll's next attempt), i.e. AFTER the successor's delivery row, which is why a
 * newest-first scan that trusted it told the successor its own creating respawn had
 * been "DROPPED just now". Measured 2026-10-03 over 4,263 owner logs: 5,433 such rows
 * across 558 owners, ~73% written after a delivery with no cut since.
 */
const RESPAWN_RETIRED_REASON = 'superseded';

export type PriorRespawnOutcome = 'delivered' | 'dropped' | 'pending' | 'none';

export interface PriorRespawn {
  /** delivered = the successor received its continuation; dropped = it
   * terminally failed; pending = the cut or its first prompt is still awaiting
   * delivery; none = this session has no respawn history. */
  outcome: PriorRespawnOutcome;
  /** The host's own reason string on a drop (busy-gate-expired / carry-stale /
   *  rearm-error / turn-start-unverified), when it recorded one. `superseded` never
   *  appears here: the host writes it to RETIRE a moot request, which is not a drop
   *  verdict (see RESPAWN_RETIRED_REASON). */
  reason?: string;
  /** ISO timestamp of the deciding row. */
  ts?: string;
  /** How long ago that row was written, ms (null when the row carried no ts). */
  ageMs?: number | null;
  /** One wait interval stamped by the host. Production can retry across several
   * intervals, so this is NOT the request lifetime or proof of controller death. */
  capMs?: number | null;
}

/**
 * PURE: given this owner's host event rows (oldest→newest, as the log is
 * appended), decide what happened to the MOST RECENT carry-respawn.
 *
 * Newest-first scan, first lifecycle row wins — so a `respawn-carry-delivered`
 * that followed a `respawn-carry-dropped` correctly reports `delivered`, and a
 * `dropped` verdict means no respawn has succeeded since it, however old it is.
 */
export function deriveLastRespawnOutcome(
  rows: ColdBootDrillHostEvent[],
  opts: { now?: number } = {},
): PriorRespawn {
  const now = opts.now ?? Date.now();
  // Set once a retirement row is crossed: the in-flight (`respawn-rearm-*`) rows OLDER than
  // it belong to the request it retired, so they are retired too — otherwise the same-ms
  // `respawn-rearm-queued` just before it would read as a fresh `pending` and, once
  // capMs + grace elapsed, raise a spurious DELAYED banner for a request that no longer exists.
  let retiringInFlight = false;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const kind = String(row?.kind ?? '');
    if (!kind) continue;
    if (kind === 'respawn-carry-dropped' && row.reason === RESPAWN_RETIRED_REASON) {
      retiringInFlight = true;
      continue;
    }
    let outcome: PriorRespawnOutcome | null = null;
    if (RESPAWN_TERMINAL_FAIL.has(kind)) outcome = 'dropped';
    else if (RESPAWN_TERMINAL_OK.has(kind)) outcome = 'delivered';
    // A spawned process is not a delivered continuation. WI-10001066 opened a
    // fresh Codex child but dropped its first prompt minutes later. Keep that
    // interval pending until the host's native-turn verification settles it.
    // Other respawn modes remain unrelated lifecycle noise (WI-41504).
    else if (kind === 'respawned' && row.mode === 'carry-respawn') outcome = 'pending';
    else if (RESPAWN_IN_FLIGHT.has(kind)) outcome = 'pending';
    if (!outcome) continue;
    if (retiringInFlight) {
      if (RESPAWN_IN_FLIGHT.has(kind)) continue;
      retiringInFlight = false;
    }
    const ts = typeof row.ts === 'string' ? row.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    const capMs = typeof row.capMs === 'number' && Number.isFinite(row.capMs) ? row.capMs : null;
    return {
      outcome,
      ...(row.reason ? { reason: String(row.reason) } : {}),
      ...(ts ? { ts } : {}),
      ageMs: Number.isFinite(parsed) ? now - parsed : null,
      capMs,
    };
  }
  return { outcome: 'none' };
}

/** IO wrapper: read this owner's host event log and derive the verdict. Never
 *  throws — an unreadable/absent log is reported as `none`, exactly like a
 *  session that has never respawned. */
export async function readPriorRespawnOutcome(
  ownerId: string,
  opts: { dir?: string; now?: number } = {},
): Promise<PriorRespawn> {
  try {
    const rows = opts.dir ? await readOwnerHostEvents(ownerId, opts.dir) : await readOwnerHostEvents(ownerId);
    return deriveLastRespawnOutcome(rows, { now: opts.now });
  } catch {
    return { outcome: 'none' };
  }
}

/**
 * A lost carry-respawn older than this is history, not news. The agent has
 * demonstrably kept taking turns since, so repeating the warning every turn
 * would be noise — and a warning that is always on is one nobody reads.
 */
export const LOST_RESPAWN_AMBIENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Fallback wait interval used to surface a delayed continuation when an older
 * event omitted capMs. This is not the lifetime of a multi-window request.
 */
export const PENDING_RESPAWN_DEFAULT_CAP_MS = 360_000;

/**
 * Slack before surfacing delay. The historical name is retained for import
 * compatibility; crossing this interval does not establish orphaning.
 */
export const PENDING_RESPAWN_ORPHAN_GRACE_MS = 120_000;

/**
 * PURE: has pending delivery exceeded one observed wait interval plus slack?
 * This is a liveness warning, not a terminal outcome. Interactive owner turns
 * can arrive while the host keeps a retry pending, and production retries span
 * several capMs windows. Inspect host/controller evidence to establish loss;
 * an elapsed timer alone cannot do so. Unknown ages never manufacture a delay.
 */
export function isDelayedPendingRespawn(prior: PriorRespawn | null | undefined): boolean {
  if (!prior || prior.outcome !== 'pending') return false;
  if (prior.ageMs == null || !Number.isFinite(prior.ageMs)) return false;
  const cap =
    typeof prior.capMs === 'number' && Number.isFinite(prior.capMs) && prior.capMs > 0
      ? prior.capMs
      : PENDING_RESPAWN_DEFAULT_CAP_MS;
  return prior.ageMs > cap + PENDING_RESPAWN_ORPHAN_GRACE_MS;
}

/** @deprecated Historical misnomer: this measures delay, NOT orphaning. */
export const isOrphanedPendingRespawn = isDelayedPendingRespawn;

/**
 * The AMBIENT warning line, for the per-turn coord injection block
 * (EI-19326331501849713, owner-directed 2026-08-09).
 *
 * WHY THIS IS SEPARATE FROM {@link priorRespawnNote}. That note rides the
 * `session:request-compaction` REPLY, so it is only ever read by an agent that
 * calls the tool AGAIN — and the whole failure mode is that a dropped respawn
 * gives you no reason to call again. You are told "queued", you correctly settle,
 * and you learn nothing. Measured on session bd819348 (2026-08-09): the owner
 * experienced this as "the successor got an error", when in fact no successor
 * existed and no error was ever raised.
 *
 * So this line answers the question the reply cannot: it reaches the agent on the
 * next TURN rather than the next REQUEST. Wording is deliberately concrete about
 * the observable — if your transcript is still intact, the cut did not happen —
 * because the failure is otherwise indistinguishable from a successful respawn
 * whose successor simply looks like you.
 *
 * PURE. Returns null unless the last respawn was LOST within
 * {@link LOST_RESPAWN_AMBIENT_MAX_AGE_MS} — either terminally DROPPED, or
 * delayed while pending ({@link isDelayedPendingRespawn}).
 * `delivered`, `none`, a still-live `pending`, and a loss of unknown age are all
 * silent (a warning is only ever emitted on evidence — the same rule
 * {@link priorRespawnNote} follows).
 */
export function lostRespawnAmbientLine(
  prior: PriorRespawn | null | undefined,
  opts: { maxAgeMs?: number } = {},
): string | null {
  if (!prior) return null;
  const delayed = isDelayedPendingRespawn(prior);
  if (prior.outcome !== 'dropped' && !delayed) return null;
  const maxAge = opts.maxAgeMs ?? LOST_RESPAWN_AMBIENT_MAX_AGE_MS;
  // An unknown age is NOT treated as recent: `ageMs` is null when the host row
  // carried no parseable timestamp, and guessing "recent" there would nag
  // forever on exactly the rows we know least about.
  if (prior.ageMs == null || !Number.isFinite(prior.ageMs) || prior.ageMs > maxAge) return null;
  // The two losses differ in what the host KNOWS, so they must not read alike: a
  // drop has a verdict you can quote back, an orphan has none — and telling an
  // agent the host "recorded" something it never recorded is the manufactured
  // certainty this whole module exists to remove.
  const head = delayed
    ? `⚠ carry-respawn DELAYED ${humanAge(prior.ageMs)}` +
      ` — your last session:request-compaction was acknowledged and the host queued a re-poll` +
      `${prior.reason ? ` (${prior.reason})` : ''}, with no recorded terminal outcome. One wait interval` +
      ` (${Math.round((prior.capMs ?? PENDING_RESPAWN_DEFAULT_CAP_MS) / 1000)}s) has elapsed; the controller` +
      ` may still be retrying. This does not prove that the request was lost or the host restarted.` +
      ` Inspect the current host and native transcript before retrying.`
    : `⚠ carry-respawn DROPPED ${humanAge(prior.ageMs)}` +
      `${prior.reason ? ` (reason: ${prior.reason})` : ''} — your last session:request-compaction was` +
      ` acknowledged but its continuation was not delivered. The process may already have respawned.`;
  return (
    `${head} Flush durable state (work_items:checkpoint / loop:checkpoint / facts:assert),` +
    ` verify which native session is running and whether a recovery already owns the next action,` +
    ` then retry session:request-compaction at a clean stopping point only if still needed.`
  );
}

function humanAge(ageMs: number | null | undefined): string {
  if (ageMs == null || !Number.isFinite(ageMs)) return 'unknown age';
  // Sub-minute is decided on the raw value, not a rounded one: Math.round would
  // render 30s as "1m ago", which is a small lie in the direction of making a
  // just-now failure look older than it is.
  if (ageMs < 60_000) return 'just now';
  const min = Math.round(ageMs / 60_000);
  if (min < 90) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

/**
 * The note fragment `session:request-compaction` appends when this session's
 * PREVIOUS carry-respawn did not land. Empty string when the last respawn
 * delivered, when there is no history, or when the outcome cannot be decided —
 * a warning is only ever emitted on evidence.
 */
export function priorRespawnNote(prior: PriorRespawn | null | undefined): string {
  if (!prior) return '';
  if (prior.outcome === 'dropped') {
    return (
      ` ⚠ prior-respawn-DROPPED: your PREVIOUS carry continuation was not delivered —` +
      ` the host recorded \`respawn-carry-dropped\`${prior.reason ? ` (reason: ${prior.reason})` : ''}` +
      ` ${humanAge(prior.ageMs)}. The successor process may already exist: spawning and submitting its` +
      ` first turn are separate steps. Verify the native continuation rather than the acknowledgement; keep flushing state` +
      ` durably (work_items:checkpoint / loop:checkpoint) rather than relying on the carry.`
    );
  }
  if (prior.outcome === 'pending') {
    // A per-attempt cap cannot decide whether a multi-window retry still exists.
    if (isDelayedPendingRespawn(prior)) {
      return (
        ` ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued` +
        ` ${humanAge(prior.ageMs)} (host recorded \`${prior.reason ? `${prior.reason}` : 'respawn-rearm-queued'}\`)` +
        ` with no recorded terminal outcome. Its wait interval` +
        ` (${Math.round((prior.capMs ?? PENDING_RESPAWN_DEFAULT_CAP_MS) / 1000)}s) is not the request lifetime.` +
        ` The controller may still be retrying and may adopt this newer carry. Inspect its current state` +
        ` and verify the native continuation before inferring loss, delivery, or a new attempt.` +
        ` Keep flushing state durably rather than relying on the carry.`
      );
    }
    return (
      ` ⚠ prior-respawn-STILL-PENDING: an earlier carry-respawn is still awaiting its cut or first-turn delivery` +
      ` (host recorded \`${prior.reason ? `${prior.reason}` : 'pending'}\`` +
      ` ${humanAge(prior.ageMs)}). This request SUPERSEDES it — the in-flight re-poll adopts this newer` +
      ` carry document — but the cut still only fires once your pty actually goes quiet.`
    );
  }
  return '';
}
