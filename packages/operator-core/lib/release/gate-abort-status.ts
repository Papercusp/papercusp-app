/**
 * EI-21290961259437085: how a gate tick that ABORTED without rendering a verdict
 * should be described to a reader — and, specifically, whether re-firing would hit
 * the same wall.
 *
 * ## Why this is a shared table rather than two `if` chains
 *
 * An aborted tick is reported in TWO places, and they must agree:
 *
 *  - `git-pipeline-position.ts`'s `nextAction` — the ONE lever a reader acts on;
 *  - the same file's gate `detail`/`summary` sentence, which is what a reader
 *    actually reads first.
 *
 * They drifted, twice, in the same direction. `deadline-exceeded` (WI-39841) and
 * `infra-inconclusive` (EI-20767792192323374) each earned a specific `nextAction`
 * saying a re-fire is NOT blocked — while the summary sentence beside them kept
 * asserting, unconditionally, that "firing another run will abort the same way".
 * Fixing a lever without the sentence is what left the same defect half-closed on
 * two separate occasions, so both now derive from this table and cannot disagree.
 *
 * ## Why "clear the abort condition" is not a safe default
 *
 * The generic advice — *clear the condition, a re-fire aborts identically* — is
 * only true for an abort that names a STANDING condition. Applied to an abort that
 * merely RECORDS something that already happened, it tells the reader to clear a
 * condition that does not exist and warns them off the one action that would help.
 * Observed live on 2026-08-24: papercusp's gate sat at `inconclusive.status =
 * 'cancelled'` — an external SIGTERM, recorded, not latched — and every reader was
 * told to "clear the gate's abort condition (cancelled) ... re-firing aborts the
 * same way". Neither clause was true, and the advisory manufactured the paralysis
 * it described.
 *
 * ⚠ The inverse error is just as expensive, which is why this is a classification
 * and not a boolean: `disk-headroom` and `migrations-pending` genuinely ARE standing
 * conditions, and telling a reader to re-fire into one burns a ~55min suite to
 * reproduce a known abort. Do not "simplify" this into "aborts never block a
 * re-fire".
 */

import { formatIdleAge } from '../format/relative-time';

/**
 * The statuses that can actually reach a reader as `gate_health.inconclusive`.
 *
 * ⚠ This is deliberately NOT `classifyGateStallStatus`'s `'noop'` class, which is a
 * larger and different set. `'noop'` answers "should this tick disturb the red
 * streak?"; this answers "can this tick be SEEN by a reader as an abort?". Two noop
 * members (`skipped-locked`, `disk-headroom`) are never recorded as inconclusive and
 * so never reach `nextAction` by this path — routing on the noop class instead would
 * pull in statuses this advice does not fit.
 *
 * SINGLE SOURCE: `release-actions.ts` writes `gate_health.inconclusive` for exactly
 * these statuses and imports this constant to do it, so the recorded set and the
 * advised set cannot drift apart.
 */
export const RECORDED_INCONCLUSIVE_STATUSES = [
  'migrations-pending',
  // EI-22642378999251872: a measured standing preflight breach now counts as a no-verdict
  // and is recorded, so repeated hourly aborts cannot masquerade as harmless skipped work.
  'disk-headroom',
  'infra-inconclusive',
  'deadline-exceeded',
  'cancelled',
  'repair-in-progress',
  'repair-staging-mismatch',
  // EI-21462211894072863: a run that exited without publishing a parseable result marker and was
  // NOT killed by its own deadline or an external SIGTERM. It rendered no verdict, so it belongs
  // in the set a reader can be advised about — it was previously counted as a RED instead, which
  // is the defect that item exists to fix (see `classifyGateStallStatus`'s 'no-verdict' class).
  'error',
  // P-007 (green-main-fast-2026-08-25): the immutable dependency generation for the candidate's
  // exact input fingerprint was never published, so the selector refused (exit 74) before any
  // test ran. A named, MEASURED prerequisite — distinct from 'error', which is the unknown-cause
  // bucket. Recorded so a reader can be advised about it instead of reading an anonymous crash.
  'dependency-prewarm-missing',
  // P-006: sibling of the above on the same exit-74 contract — the selected generation exists but
  // is corrupt, superseded mid-validation, or gone. Also standing: it does not self-repair.
  'dependency-generation-unusable',
  // WI-10002039: the suite verdict was reached and the promotion push was then refused as
  // UNAUTHORIZED (HTTP 401/403). Recorded for the same reason as its neighbours — so a reader is
  // advised about a NAMED access problem instead of reading an anonymous crash. Before it had its
  // own status it arrived as 'error' and inherited the TRANSIENT lever, which told every reader
  // that "nothing is blocking a re-fire" about a refusal that blocks every re-fire permanently.
  'promotion-unauthorized',
] as const;

export type RecordedInconclusiveStatus = (typeof RECORDED_INCONCLUSIVE_STATUSES)[number];

export function isRecordedInconclusiveStatus(status: string): status is RecordedInconclusiveStatus {
  return (RECORDED_INCONCLUSIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * What KIND of thing the abort names — which is what decides the advice.
 *
 *  - `standing-condition` — a real blocker persists. Clear it; a re-fire hits it again.
 *  - `transient`          — the tick was killed or faulted by something that has already
 *                           happened. Nothing to clear, and a re-fire may well finish.
 *  - `peer-owned`         — progress is owned by someone else's in-flight run or repair.
 *                           Nothing for THIS reader to clear, and a re-fire contends.
 *  - `unknown`            — an unclassified status. Advice falls back to the conservative
 *                           generic wording; see `gateAbortRefireClause`.
 */
export type GateAbortKind = 'standing-condition' | 'transient' | 'peer-owned' | 'unknown';

const KIND_BY_STATUS: Record<RecordedInconclusiveStatus, Exclude<GateAbortKind, 'unknown'>> = {
  // The dev PG is behind the candidate: a real, standing precondition.
  'migrations-pending': 'standing-condition',
  // The post-GC re-sample still breached the write floor: re-firing before reclamation repeats it.
  'disk-headroom': 'standing-condition',
  // The repair queue's staging expectation does not match the tree: standing until reconciled.
  'repair-staging-mismatch': 'standing-condition',
  // The gate's own vite-node module cache was deleted mid-run — HOST weather, already past.
  'infra-inconclusive': 'transient',
  // SIGTERMd at the suite budget: it ran out of clock, it is not blocked.
  'deadline-exceeded': 'transient',
  // Externally SIGTERMed (exit 143) before publishing a marker. RECORDS a kill; latches nothing.
  cancelled: 'transient',
  // A repair phase owns progress outside the full-suite verdict path.
  'repair-in-progress': 'peer-owned',
  /**
   * EI-21462211894072863: exited without publishing a parseable marker, and NOT via its own
   * deadline or an external SIGTERM (those are 'deadline-exceeded' / 'cancelled').
   *
   * 'transient' by the same reasoning that already classifies `infra-inconclusive`, whose own
   * operator message says in as many words that its mechanism is unclassified: what makes an
   * abort transient here is not that we know the cause, it is that the tick was FAULTED by
   * something that has already happened and left NO condition to clear. That is exactly a crash —
   * and it is what separates 'error' from `migrations-pending` / `repair-staging-mismatch`, where
   * a named blocker genuinely persists and a re-fire would hit it again.
   *
   * ⚠ Do NOT "fix" this to 'unknown' on the grounds that a crash's cause is unrecorded. That
   * reads as the honest answer and is the one thing this table forbids: `'unknown'` is the
   * DEFAULTED sentinel, so a recorded status mapping to it is precisely the EI-21290961259437085
   * shape the guard test enumerates against — advice inherited rather than decided. The transient
   * lever already carries the right words for this case ("do NOT triage the files an earlier red
   * named" plus find the cause first, "or the next run dies the same way").
   */
  error: 'transient',
  /**
   * P-007 — 'standing-condition', and this is the whole point of giving it its own status.
   *
   * A missing prewarmed dependency generation is a NAMED blocker that genuinely persists: the
   * selector refuses the same fingerprint on every run until the producer publishes it
   * (WI-41491). That is the `migrations-pending` / `repair-staging-mismatch` shape exactly —
   * clear it, or a re-fire hits it again — and the OPPOSITE of the transient class.
   *
   * ⚠ Do NOT collapse this back into 'error'/'transient'. Measured 2026-08-26 on papercusp:
   * this outage arrived as an untyped crash, was therefore advised as transient ("a re-fire may
   * well finish"), and the re-fire that advice invited would have died on the identical
   * fingerprint — spending a scarce owner authorization to learn nothing. The transient lever's
   * words are actively wrong here; the standing-condition lever's ("clear it first") are right.
   */
  'dependency-prewarm-missing': 'standing-condition',
  /**
   * P-006 — 'standing-condition' for the same reason as its sibling above. An unusable generation
   * (no immutable token, replaced mid-validation, invalid marker, vanished before lease) is not
   * weather that passes: the selector keeps resolving to the same bad generation until the store
   * is repaired, so "nothing is blocking a re-fire" would be false here too.
   */
  'dependency-generation-unusable': 'standing-condition',
  /**
   * WI-10002039 — 'standing-condition', and this classification IS the fix.
   *
   * An unauthorized promotion push is the most standing condition in this table: a missing
   * dependency generation clears when a producer publishes it, a migration clears when it
   * applies, but a remote that refuses the pushing identity refuses it on every future tick
   * until a HUMAN changes the access. Nothing in the pipeline can clear it.
   *
   * ⚠ Do NOT collapse this back into 'error'/'transient'. That was its behaviour before this
   * entry existed, and the transient lever's words are the exact inverse of the truth here —
   * "nothing is blocking a re-fire, so release:checkpoint-run once you know what stopped it".
   * Measured 2026-09-20: 550 runs across 15 days took that path, each one inviting a re-fire
   * into an identical 403. This is the same mis-advice the module header opens with, in its
   * second direction: there, generic standing-condition advice was applied to a recorded
   * transient; here, transient advice was inherited by a permanent blocker.
   */
  'promotion-unauthorized': 'standing-condition',
};

export function classifyGateAbort(status: string): GateAbortKind {
  return isRecordedInconclusiveStatus(status) ? KIND_BY_STATUS[status] : 'unknown';
}

/**
 * The clause the gate's summary sentence appends after "it rendered NO verdict".
 *
 * Returns the FULL sentence fragment (leading space included) so the caller cannot
 * accidentally reintroduce the unconditional claim by concatenating around it.
 */
export function gateAbortRefireClause(status: string): string {
  switch (classifyGateAbort(status)) {
    case 'standing-condition':
      return ' and firing another run will abort the same way until that condition clears.';
    case 'transient':
      // The correction this module exists for: nothing latched, so do not warn the
      // reader off a re-fire — but do NOT promise the pipeline is otherwise clear.
      return (
        ' — this RECORDS what stopped the run, it does not latch anything, so nothing about it' +
        ' blocks a re-fire.'
      );
    case 'peer-owned':
      return ' and another owner is mid-progress, so a re-fire contends with them rather than clearing it.';
    case 'unknown':
    default:
      // Conservative: an unclassified status keeps the pre-existing generic wording
      // rather than inheriting either confident claim.
      return ' — see the green-checkpoint log for whether the condition still stands.';
  }
}

/**
 * The `nextAction` lever for a recorded abort that has no hand-written arm of its own.
 *
 * Callers keep their earned, status-specific arms (`migrations-pending`,
 * `infra-inconclusive`, `deadline-exceeded`) — those carry detail this table does not
 * try to reproduce. This covers the rest.
 */
export function gateAbortLever(status: string): string {
  switch (classifyGateAbort(status)) {
    case 'transient':
      return (
        `the last run was stopped before it recorded a verdict (${status}) — nothing is blocking a re-fire, ` +
        `so release:checkpoint-run once you know what stopped it; ⚠ do NOT triage the files an earlier red ` +
        `named, this tick judged no code at all. An external kill has a CAUSE worth finding first ` +
        `(a reaper, a pkill pattern, a scope stop, OOM), or the next run dies the same way`
      );
    case 'peer-owned':
      return (
        `wait for the owner of the in-flight repair to finish (${status}) — there is nothing for you to ` +
        `clear, and a re-fire contends with them; ⚠ do NOT triage the files an earlier red named, this tick ` +
        `judged no code at all`
      );
    case 'standing-condition':
    case 'unknown':
    default:
      return `clear the gate's abort condition (${status}) — it renders no verdict until then, and re-firing aborts the same way`;
  }
}

/**
 * WI-1752145: how old a recorded abort may be before a reader must stop reading it as a
 * description of NOW.
 *
 * ## Why the abort record needs its OWN vintage, separate from the verdict's
 *
 * `gate_health.inconclusive` is written by `jsonb_set` on the `{gate_health,inconclusive}`
 * PATH (release-actions.ts), deliberately NOT through the full-blob replace that every real
 * verdict takes. That is correct — an abort judged no code, so it must not disturb the
 * verdict counters — but it has a consequence nothing was reporting: **the top-level
 * `gate_health.observedAt` does not advance when a tick aborts.** The two vintages under one
 * payload therefore drift without bound, and `readAttestation.snapshotAgeMs` (derived from
 * the top-level stamp) describes the VERDICT, never the abort sitting beside it.
 *
 * Measured live 2026-08-31 across the green-checkpoint rows that carried an abort:
 *
 * | install     | top-level `observedAt` | `inconclusive.observedAtMs` | skew    |
 * |-------------|------------------------|-----------------------------|---------|
 * | portal      | 12:43:33Z              | 15:38:11Z                   | +2h55m  |
 * | hello-world-3 | 15:14:11Z            | 15:14:15Z                   | +4s     |
 * | oddsmith    | 2026-08-25 21:39Z      | 15:06:24Z                   | +5.7d   |
 * | readinglist | 2026-08-26 00:15Z      | 15:00:10Z                   | +5.6d   |
 *
 * The originating incident is the other direction of the same gap: an abort observed at
 * 11:23:52Z naming `migrations-pending` on migration 1044 was still being served ~1h after
 * 1044 APPLIED (11:27:20Z), and was repeated downstream as current fact. The record is
 * LATCHED — it persists until some later tick overwrites or clears it — so its age is the
 * one thing a reader needs and the one thing no surface printed.
 *
 * ## Why `stale` is nullable, and why that is the load-bearing part
 *
 * A blob written before `inconclusive.observedAtMs` existed carries no stamp at all. Such a
 * record MUST NOT render as `stale: false` — an unmeasured value presented as a clean
 * negative is exactly the failure this helper exists to stop, and it is worse than printing
 * nothing because it manufactures confidence. `null` means UNKNOWN VINTAGE and is reported as
 * such; only a real subtraction can produce `true` or `false`.
 */
export const GATE_ABORT_VINTAGE_STALE_MS = 90 * 60_000;

export interface GateAbortVintage {
  /** The abort record's own stamp, or null when the blob predates the field. */
  observedAtMs: number | null;
  /** Age at read time. Null ⇒ unknown vintage, never "fresh". */
  ageMs: number | null;
  /** Compact human age ("4s", "2h55m", "5d17h"). Null alongside `ageMs`. */
  age: string | null;
  /**
   * True past `staleAfterMs`, false within it, and **null when the vintage is unknown**.
   * Read `=== true` / `=== false`; a falsy check silently promotes unknown to fresh.
   */
  stale: boolean | null;
  /**
   * The sentence to append to a load-bearing abort claim. Non-null ONLY when the record is
   * provably stale or provably unstamped — a fresh abort is deliberately left undecorated,
   * because a disclosure that fires on every read is one a reader learns to skip.
   */
  warning: string | null;
}

export const GATE_ABORT_DETAIL_LIVENESS_MARKER =
  'This detail describes the recorded abort only; check `gate.checkpointRunInFlight` before acting on current runner liveness.';

/**
 * Pure: pair a recorded abort with its own age, so the claim and its vintage travel together.
 *
 * Callers pass `nowMs` explicitly rather than reading the clock here, so both the
 * `routines:list` attestation and the `dev:pipeline_position` sentence are deterministically
 * testable in both directions — fresh and stale — from one implementation.
 */
export function gateAbortVintage(args: {
  status: string;
  observedAtMs: number | null | undefined;
  nowMs: number;
  staleAfterMs?: number;
}): GateAbortVintage {
  const staleAfterMs = args.staleAfterMs ?? GATE_ABORT_VINTAGE_STALE_MS;
  const observedAtMs =
    typeof args.observedAtMs === 'number' && Number.isFinite(args.observedAtMs) ? args.observedAtMs : null;

  if (observedAtMs === null) {
    return {
      observedAtMs: null,
      ageMs: null,
      age: null,
      stale: null,
      warning:
        `⚠ This abort record (${args.status}) carries NO observation timestamp, so its age cannot be ` +
        `established — do not read it as current. The record is latched and persists until a later ` +
        `tick overwrites it; confirm the condition first-hand before acting on it.`,
    };
  }

  const ageMs = Math.max(0, args.nowMs - observedAtMs);
  const stale = ageMs > staleAfterMs;
  return {
    observedAtMs,
    ageMs,
    age: formatIdleAge(ageMs / 1000),
    stale,
    // Deliberately status-AGNOSTIC. An earlier draft named the originating incident's status
    // inline, which would have stamped 'migrations-pending' onto the disclosure for every OTHER
    // abort — a generic caveat that lies about the specific case in front of the reader is the
    // same defect one level down. The example lives in this module's header instead.
    warning: stale
      ? `⚠ This abort was observed ${formatIdleAge(ageMs / 1000)} ago and is LATCHED — it persists until a ` +
        `later tick overwrites it, so it describes THAT observation, not necessarily now. The condition it ` +
        `names may already have cleared. Confirm it first-hand before acting on it.`
      : null,
  };
}

export function gateAbortDetailAtRead(args: {
  status: string;
  detail: string | null;
  observedAtMs: number | null | undefined;
  nowMs: number;
}): string {
  const vintage = gateAbortVintage(args);
  const vintageNote = vintage.warning ?? `Abort observed ${vintage.age} ago.`;
  const detail = args.detail ?? 'See the green-checkpoint log for the blocking condition.';
  return `${detail} ${vintageNote} ${GATE_ABORT_DETAIL_LIVENESS_MARKER}`;
}
