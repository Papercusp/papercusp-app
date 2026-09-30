/**
 * work-item-prior-work — "has anyone worked this item BEFORE me?", answered at claim time.
 *
 * P-001 of fleet-leadership-continuity-and-actuation-2026-08-01. Closes the last hole in a
 * three-guard set that already existed but did not cover the case that actually bit us:
 *
 *   - EI-529  (`getClaimTimeCheckpointHint`) warns when a prior holder left a CHECKPOINT.
 *   - WI-5826 (`terminalClaimWarning`)       warns when the claimed row is already TERMINAL.
 *   - …neither fires for an item that is OPEN, UNASSIGNED, has NO checkpoint — and has
 *     nonetheless already been worked. That row is byte-indistinguishable from never-started.
 *
 * Observed live 2026-07-26 (fleet push-not-poll): WI-6096 read `state: open`, `assignee: NONE`,
 * checkpoint empty. Its prior holder had already built the entire feature — a type, a registry
 * field, inventory plumbing, a checker script, an npm script, AND the CI wiring — then compacted,
 * which released the claim and left the checkpoint unwritten. The next claimant (the fleet leader)
 * began implementing it from scratch and avoided rebuilding a finished, CI-wired feature ONLY by
 * happening to read the source first. The information needed to prevent that was in the row the
 * whole time: `last_released_by`, `last_released_at`, `attempts`, `worked_by_history`.
 *
 * This module is deliberately READ-ONLY presentation of columns we already store — no new state,
 * no new writes. Migration 806 records local claim/release transitions in the shared base table,
 * so the read-side half of D-001 can also report prior workers. P-002/P-003 make a checkpoint
 * more LIKELY to exist, this makes prior work visible even when one does not (a hard kill, an OOM,
 * a crash — the causes the platform cannot control).
 *
 * FAMILY NOTE: both feature- and issue-family rows now live in the shared `work_items` base table
 * with local release/history columns. The compatibility `engineer_issues` view omits those columns,
 * so this helper intentionally queries the base table rather than that view. Legacy rows may still
 * have an empty history; release provenance remains an independent fallback signal.
 */
import { getOrgPg } from '@papercusp/db-org';
import { resolveConcreteWorkspaceId } from './workspace-registry';

/** A claim-time prior-work hint: only present when the row shows the item was ACTUALLY worked before. */
export interface ClaimTimePriorWorkHint {
  /** The last agent to release a hold on this item, when recorded. */
  lastReleasedBy: string | null;
  /** Epoch ms of that release, when recorded. */
  releasedAtMs: number | null;
  /** Prior claim attempts recorded on the row (0 when never claimed). */
  attempts: number;
  /** Distinct prior workers parsed out of `worked_by_history`, best-effort. */
  priorWorkers: string[];
  /**
   * Whether a checkpoint ALSO exists. The caller passes this in rather than re-reading it —
   * claim.ts already has the EI-529 hint in hand. It is the single most important field here:
   * prior work WITHOUT a checkpoint is the dangerous shape, because nothing else on the row
   * hints that the item has a history.
   *
   * WI-6737: `'unknown'` is a THIRD state, not a nicety — it means the checkpoint store could
   * not be READ (a PG blip / unreachable datastore), as distinct from a read that ran and found
   * nothing. Every caller here fetches the checkpoint hint under a `.catch(() => null)`, so
   * before this existed a failed read collapsed into `false` and {@link priorWorkWarning} went
   * on to assert, in those words, that "NO checkpoint was ever written" — a transport failure
   * rendered as a confident claim about history, at the one moment the system knew least.
   * A boolean cannot represent "I could not ask", which is why the type has to carry it.
   */
  hasCheckpoint: boolean | 'unknown';
}

export interface PriorWorkRow {
  taken_by: string | null;
  attempts: number | string | null;
  last_released_by: string | null;
  last_released_at: string | Date | null;
  worked_by_history: unknown;
}

/**
 * EI-18765234433145274 — a deliberately narrow prompt to revalidate old, never-started-looking
 * issue-family work before building it.
 *
 * Age alone was measured against the live papercusp corpus and was far too broad. The extra signal
 * is affirmative, not inferred from absence: the authoring session has an `adv_sessions.ended_at`
 * row and no open continuation under that owner id. A missing activity/presence/session row stays
 * silent, which is important for federated authors and reaped presence.
 */
export const AUTHORSHIP_REVALIDATION_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

export interface ClaimTimeAuthorshipRevalidationHint {
  createdBy: string;
  itemCreatedAtMs: number;
  itemAgeMs: number;
  authorSessionEndedAtMs: number;
  authorSessionEndedBy: string | null;
}

export interface AuthorshipRevalidationRow {
  created_ts: number | string | null;
  created_by: string | null;
  attempts: number | string | null;
  last_released_at: string | Date | null;
  last_progress_at: string | Date | null;
  worked_by_history: unknown;
  author_session_ended_at: string | Date | null;
  author_session_ended_by: string | null;
  author_has_open_session: boolean | null;
}

/** Best-effort extraction of agent ids from `worked_by_history`, whose shape has drifted over time
 *  (array of strings, array of `{ owner|agent|ownerId }` objects, or null). Never throws: a shape we
 *  do not recognise yields no workers rather than failing the whole hint. */
export function parseWorkedByHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const v = entry.trim();
      if (v) out.push(v);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      const v = String(rec.owner ?? rec.ownerId ?? rec.agent ?? rec.by ?? '').trim();
      if (v) out.push(v);
    }
  }
  return [...new Set(out)];
}

/** Coerce a possibly-string/possibly-null count column to a non-negative integer. */
function toCount(v: number | string | null): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Coerce a timestamp column to epoch ms, or null. */
function toEpochMs(v: string | Date | null): number | null {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Remove the claimant's current post-claim history entry from the prior-worker signal.
 *
 * Migration 806 appends `taken_by` to `worked_by_history` in the same write that claims an
 * item. Claim-time callers therefore read the row AFTER that append. Without this seam, a
 * genuinely fresh claim looks like prior work by the claimant themselves. Keep the release
 * provenance fields separate: a claimant who previously released the item still has real prior
 * work and must remain eligible for the warning through `last_released_by`/`last_released_at`.
 */
export function excludeCurrentClaimant(
  priorWorkers: readonly string[],
  currentClaimant?: string | null,
): string[] {
  const claimant = currentClaimant?.trim();
  return claimant ? priorWorkers.filter((worker) => worker !== claimant) : [...priorWorkers];
}

/** Bigint epoch-ms columns arrive as either numbers or decimal strings. */
function epochBigintMs(v: number | string | null): number | null {
  const ms = typeof v === 'number' ? v : Number(v ?? NaN);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Pure qualification seam for the live SQL row. Exported so every exclusion in the measured
 * conjunction has a regression test instead of being trusted as opaque query prose.
 */
export function authorshipRevalidationHintFromRow(
  row: AuthorshipRevalidationRow | null,
  nowMs = Date.now(),
): ClaimTimeAuthorshipRevalidationHint | null {
  if (!row || !Number.isFinite(nowMs)) return null;
  const createdBy = String(row.created_by ?? '').trim();
  const itemCreatedAtMs = epochBigintMs(row.created_ts);
  const authorSessionEndedAtMs = toEpochMs(row.author_session_ended_at);
  if (!createdBy || itemCreatedAtMs == null || authorSessionEndedAtMs == null) return null;

  const itemAgeMs = nowMs - itemCreatedAtMs;
  if (itemAgeMs < AUTHORSHIP_REVALIDATION_MIN_AGE_MS || authorSessionEndedAtMs > nowMs) return null;

  // Never infer "untouched" through an unknown history shape. Null is a legacy empty value; a
  // concrete array must be empty. Anything else fails soft because silence is safer than a false
  // revalidation prompt at claim time.
  const noRecordedWorkers =
    row.worked_by_history == null || (Array.isArray(row.worked_by_history) && row.worked_by_history.length === 0);
  if (
    toCount(row.attempts) > 0 ||
    row.last_released_at != null ||
    row.last_progress_at != null ||
    !noRecordedWorkers ||
    row.author_has_open_session !== false
  ) {
    return null;
  }

  return {
    createdBy,
    itemCreatedAtMs,
    itemAgeMs,
    authorSessionEndedAtMs,
    authorSessionEndedBy: String(row.author_session_ended_by ?? '').trim() || null,
  };
}

/**
 * Read the narrow authorship-revalidation signal for one claimed item. The work-item claim has
 * already committed when callers invoke this, so this lookup is presentation-only and fail-soft.
 *
 * `adv_sessions` is intentionally joined on POSITIVE evidence (`ended_at IS NOT NULL`). We never
 * call a missing coord_presence/agent_activity row "dead": local retention and federation make
 * absence ambiguous. An open continuation suppresses an older ended row after a carry/respawn.
 */
export async function getClaimTimeAuthorshipRevalidationHint(ref: {
  harness: string | null;
  workItemId: string;
  workspaceId?: string;
  nowMs?: number;
}): Promise<ClaimTimeAuthorshipRevalidationHint | null> {
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws || !ref.workItemId) return null;
  try {
    const { sql } = getOrgPg();
    const harness = ref.harness == null || ref.harness === '' || ref.harness === '*' ? null : ref.harness;
    const rows = await sql<AuthorshipRevalidationRow[]>`
      SELECT w.created_ts,
             NULLIF(w.payload #>> '{_ei,created_by}', '') AS created_by,
             w.attempts,
             w.last_released_at,
             w.last_progress_at,
             w.worked_by_history,
             ended.ended_at AS author_session_ended_at,
             ended.ended_by AS author_session_ended_by,
             EXISTS (
               SELECT 1
                 FROM harness_shared.adv_sessions active
                WHERE active.workspace_id = ${ws}
                  AND active.coord_owner_id = NULLIF(w.payload #>> '{_ei,created_by}', '')
                  AND active.ended_at IS NULL
             ) AS author_has_open_session
        FROM harness_shared.work_items w
        LEFT JOIN LATERAL (
          SELECT s.ended_at, s.ended_by
            FROM harness_shared.adv_sessions s
           WHERE s.workspace_id = ${ws}
             AND s.coord_owner_id = NULLIF(w.payload #>> '{_ei,created_by}', '')
             AND s.ended_at IS NOT NULL
           ORDER BY s.ended_at DESC
           LIMIT 1
        ) ended ON TRUE
       WHERE w.workspace_id = ${ws}
         AND w.feature_id = ${ref.workItemId}
         AND (${harness}::text IS NULL OR w.harness_slug = ${harness})
       LIMIT 1`;
    return authorshipRevalidationHintFromRow(rows[0] ?? null, ref.nowMs ?? Date.now());
  } catch {
    return null;
  }
}

/** Render only what the row proves; this is a revalidation prompt, never a claim of dead authorship. */
export function authorshipRevalidationWarning(hint: ClaimTimeAuthorshipRevalidationHint | null): string | null {
  if (!hint) return null;
  const ageDays = Math.max(0, Math.floor(hint.itemAgeMs / (24 * 60 * 60 * 1_000)));
  const endedBy = hint.authorSessionEndedBy ? ` (recorded by ${hint.authorSessionEndedBy})` : '';
  return (
    `⚠ AUTHORSHIP REVALIDATION: this item is ${ageDays} days old; the row records no prior claim, ` +
    `release, or progress; and its authoring session ${hint.createdBy} is recorded ended at ` +
    `${new Date(hint.authorSessionEndedAtMs).toISOString()}${endedBy}. This signal does NOT say ` +
    `whether the requested work is missing or already done. Re-read the item and verify its premises ` +
    `against current source/tests before building. [EI-18765234433145274]`
  );
}

/**
 * Read the prior-work signals for one item. Returns `null` when the row shows NO evidence the item
 * was ever worked — which is the overwhelmingly common case, so a normal fresh claim's response is
 * completely unaffected.
 *
 * Fails SOFT by design (mirroring {@link getClaimTimeCheckpointHint}): a claim must never fail
 * because an advisory lookup did. A PG error yields `null`, i.e. "no hint", never a throw.
 */
export async function getClaimTimePriorWorkHint(ref: {
  harness: string | null;
  workItemId: string;
  workspaceId?: string;
  hasCheckpoint?: boolean | 'unknown';
  /** The holder written by the claim immediately before this post-claim read. */
  currentClaimant?: string | null;
}): Promise<ClaimTimePriorWorkHint | null> {
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws || !ref.workItemId) return null;
  try {
    const { sql } = getOrgPg();
    const harness = ref.harness == null || ref.harness === '' || ref.harness === '*' ? null : ref.harness;
    const rows = await sql<PriorWorkRow[]>`
      SELECT taken_by, attempts, last_released_by, last_released_at, worked_by_history
        FROM harness_shared.work_items
       WHERE workspace_id = ${ws}
         AND feature_id = ${ref.workItemId}
         AND (${harness}::text IS NULL OR harness_slug = ${harness})
       LIMIT 1`;
    return priorWorkHintFromRow(rows[0] ?? null, {
      currentClaimant: ref.currentClaimant,
      hasCheckpoint: ref.hasCheckpoint,
    });
  } catch {
    return null;
  }
}

/** Pure post-claim row fold used by the database reader and its regression tests. */
export function priorWorkHintFromRow(
  row: PriorWorkRow | null,
  opts: { currentClaimant?: string | null; hasCheckpoint?: boolean | 'unknown' } = {},
): ClaimTimePriorWorkHint | null {
  if (!row) return null;

  const attempts = toCount(row.attempts);
  const releasedAtMs = toEpochMs(row.last_released_at);
  const lastReleasedBy = String(row.last_released_by ?? '').trim() || null;
  const priorWorkers = excludeCurrentClaimant(parseWorkedByHistory(row.worked_by_history), opts.currentClaimant);

  // The no-signal check. `taken_by` is deliberately NOT a signal: it means the item is held
  // RIGHT NOW, which the claim path already reports as a conflict — it says nothing about
  // whether work happened before. Everything below is strictly historical. The current holder's
  // post-claim history entry is excluded above because migration 806 appends it before this read.
  if (attempts === 0 && releasedAtMs == null && lastReleasedBy == null && priorWorkers.length === 0) {
    return null;
  }
  return {
    lastReleasedBy,
    releasedAtMs,
    attempts,
    priorWorkers,
    hasCheckpoint: opts.hasCheckpoint === 'unknown' ? 'unknown' : opts.hasCheckpoint === true,
  };
}

/**
 * EI-20284291276800931 — the repeated-deferral threshold.
 *
 * Measured over the live papercusp backlog on 2026-09-05: of 4,485 non-terminal, non-observation
 * work-items, 123 (2.7%) already carry >= 3 distinct prior sessions, and the tail is long — WI-2944
 * sits `open` and unheld after 36 distinct sessions, WI-212675 after 26. Three is where the
 * population stops looking like ordinary hand-off churn and starts looking like a stall, and it is
 * rare enough that the escalated wording below cannot decay into background noise.
 */
export const REPEAT_DEFERRAL_MIN_DISTINCT_SESSIONS = 3;

/**
 * WI-2145689 — the quiet-time gate, and the reason the count alone is not enough.
 *
 * A durable finding retired distinct-worker churn as a stuck-item signal outright, 0-for-2: WI-35902
 * drew 14 distinct workers and 12 claims in THREE HOURS, was called a hot potato, and then completed
 * normally. A bare count cannot tell 14 workers in three hours from 36 over three weeks.
 *
 * Re-measured across the 123 qualifying papercusp items on 2026-09-05, that failure mode is real but
 * narrow — by age of `last_released_at`: <6h 1 item · 6-24h 14 · 1-3d 7 · 3-14d 88 · >14d 13. So 82%
 * are >= 3 days quiet and genuinely match the stall this escalation was written for, which is why the
 * threshold survives; but the recently-released tail is the WRONG shape, and its loudest member is the
 * worst possible one. The 26-worker row in the 6-24h bucket is WI-212675, the green-checkpoint gate
 * red. Many agents re-claiming a gate item within hours is CONTENTION, whose correct response is the
 * one-fixer stand-down (read `gate.greenCheckpoint.ownership`, send evidence once, stop) — the exact
 * opposite of "go re-judge the acceptance criterion". Firing there would pull against that rail.
 *
 * So: many sessions RECENTLY means contention, and many sessions then SILENCE means a stall. Only the
 * second one gets the inverted instruction.
 */
export const REPEAT_DEFERRAL_MIN_QUIET_MS = 24 * 60 * 60 * 1_000;

/**
 * Whether this row is quiet enough for the repeated-deferral reading to apply.
 *
 * A null `releasedAtMs` fails toward the escalation. That branch is UNEXERCISED by the live
 * population (all 123 qualifying items carried a release timestamp), so it is a judgement call and
 * not a measurement: the prompt is advisory and costs a claimant one question, whereas suppressing
 * it restores exactly the message this change exists to replace.
 */
export function repeatDeferralQuietEnough(releasedAtMs: number | null, nowMs = Date.now()): boolean {
  if (releasedAtMs == null) return true;
  return nowMs - releasedAtMs >= REPEAT_DEFERRAL_MIN_QUIET_MS;
}

/**
 * Distinct sessions recorded against this item, excluding the current claimant (already removed
 * upstream by {@link excludeCurrentClaimant}).
 *
 * `last_released_by` is UNIONED rather than added: it is an independent provenance column, so a
 * legacy row can carry a releaser with an empty history, while a present-day row carries that same
 * releaser inside the history too. Summing the two would double-count the common case and push
 * ordinary two-session churn over the threshold.
 */
export function distinctPriorSessionCount(hint: ClaimTimePriorWorkHint): number {
  const seen = new Set(hint.priorWorkers);
  if (hint.lastReleasedBy) seen.add(hint.lastReleasedBy);
  return seen.size;
}

/**
 * Render the hint as the warning an agent reads at claim time. Pure + exported so the guarantee is
 * directly testable and a future edit cannot silently weaken it — the same shape WI-5826 chose for
 * {@link terminalClaimWarning}, and for the same reason.
 *
 * The message ESCALATES on `hasCheckpoint: false`. That is the whole point: when a checkpoint
 * exists, EI-529 already tells the claimant what the prior holder was doing, so this is
 * supplementary context. When one does NOT exist, this is the only thing standing between the
 * claimant and rebuilding finished work, so it says so in those words and names the concrete
 * next action (read the source before building).
 */
export function priorWorkWarning(hint: ClaimTimePriorWorkHint | null, nowMs = Date.now()): string | null {
  if (!hint) return null;

  const facts: string[] = [];
  if (hint.lastReleasedBy) {
    const when = hint.releasedAtMs != null ? ` at ${new Date(hint.releasedAtMs).toISOString()}` : '';
    facts.push(`last released by ${hint.lastReleasedBy}${when}`);
  } else if (hint.releasedAtMs != null) {
    facts.push(`last released at ${new Date(hint.releasedAtMs).toISOString()}`);
  }
  if (hint.attempts > 0) facts.push(`${hint.attempts} prior claim attempt${hint.attempts === 1 ? '' : 's'}`);
  const others = hint.priorWorkers.filter((w) => w !== hint.lastReleasedBy);
  if (others.length > 0) facts.push(`previously worked by ${others.join(', ')}`);

  const detail = facts.length > 0 ? ` (${facts.join('; ')})` : '';

  const distinctSessions = distinctPriorSessionCount(hint);
  // Both conditions, never the count alone — see REPEAT_DEFERRAL_MIN_QUIET_MS for why a bare count
  // reads live contention (a hot gate item) as a stalled acceptance criterion.
  const repeatedlyDeferred =
    distinctSessions >= REPEAT_DEFERRAL_MIN_DISTINCT_SESSIONS &&
    repeatDeferralQuietEnough(hint.releasedAtMs, nowMs);

  // WI-6737: the checkpoint store could not be read. Say exactly that. The `false` branch below
  // is a claim about HISTORY ("nothing was ever written") and is only true when the read actually
  // ran; emitting it on a failed read manufactures certainty out of an outage — and it is the
  // most dangerous direction to be wrong in, because it tells the reader the row is safe to
  // rebuild from scratch.
  //
  // This branch is checked FIRST, and the EI-20284291276800931 escalation is APPENDED to it rather
  // than replacing it. That guarantee outranks the deferral prompt in both directions: its
  // instruction (do not rebuild, re-read once reachable) is the safe move during an outage, and the
  // deferral prompt asks the reader to judge an acceptance criterion they were just unable to read.
  if (hint.hasCheckpoint === 'unknown') {
    return (
      `⚠ PRIOR WORK on this item${detail}. The checkpoint store could NOT BE READ, so whether a ` +
      `checkpoint exists is UNKNOWN — this is not the same as there being none, and must not be ` +
      `treated as such. Do NOT start rebuilding: re-read this item once the datastore is reachable ` +
      `(work_items:get), and only then judge whether prior work needs redoing. [P-001/WI-6737]` +
      (repeatedlyDeferred
        ? ` Note also that ${distinctSessions} distinct sessions are already recorded against this ` +
          `item without finishing it — once the store is readable, judge the ACCEPTANCE CRITERION ` +
          `itself, not only the checkpoint. [EI-20284291276800931]`
        : '')
    );
  }

  // EI-20284291276800931: an item that N sessions have picked up and put back down needs the
  // OPPOSITE instruction from the one below. Each of those sessions read the checkpoint, re-derived
  // that its stated blocker was still unmet, and deferred — which is cheap and feels correct every
  // time, so a precisely-written blocker note strands an item HARDER than a vague one. Observed on
  // WI-6404: the criterion named one of four callers of a shared seam, so it was over-specified,
  // and the same property was verifiable through another caller the entire 11 days it sat open.
  if (repeatedlyDeferred) {
    const checkpointClause =
      hint.hasCheckpoint === true
        ? `A checkpoint exists — but READING IT IS NOT THE INSTRUCTION HERE: re-reading it, ` +
          `confirming the blocker it names is still unmet, and putting the item back down is ` +
          `precisely what stranded it.`
        : `NO checkpoint was ever written, so read the source before building — but that alone ` +
          `will not unstick this item.`;
    return (
      `⚠ REPEATEDLY DEFERRED: ${distinctSessions} distinct sessions are recorded against this ` +
      `item${detail}, and it is still not finished. That is a fact about this row's own history, ` +
      `not a report from any of them, so a confident checkpoint cannot talk it down. ` +
      `${checkpointClause} FIRST judge the ACCEPTANCE CRITERION itself, before attempting the ` +
      `work: is it satisfiable at all, and is it OVER-SPECIFIED relative to what this item ` +
      `actually asserts? If it is over-specified, say so on the item and settle it against what it ` +
      `actually asserts rather than deferring again. [EI-20284291276800931]`
    );
  }

  if (hint.hasCheckpoint === true) {
    return (
      `PRIOR WORK on this item${detail}. A checkpoint exists — read it (above) before starting; ` +
      `this item is NOT fresh work. [P-001]`
    );
  }
  return (
    `⚠ PRIOR WORK on this item${detail}, and NO checkpoint was ever written — so this row is ` +
    `indistinguishable from never-started even though it has been worked. READ THE SOURCE before ` +
    `building anything: the prior holder may have already finished it and lost the checkpoint to a ` +
    `compaction, a crash, or a hard kill. Rebuilding finished work is the failure this warning ` +
    `exists to prevent (observed live 2026-07-26 on WI-6096, a fully-built CI-wired feature that ` +
    `read as untouched). [P-001]`
  );
}
