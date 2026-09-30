/**
 * work-items-hold-open.ts — the HOLD-OPEN lease reaper (WI-4531).
 *
 * THE BUG: `work_items:hold_open` stamps `payload.held_open_by` / `held_open_at`
 * (setWorkItemClaimHold) alongside `_claimHold`, which does TWO things:
 *   1. excludes the item from claim_next / scheduler:get_next self-select, and
 *   2. refuses a TERMINAL transition by anyone but the holder (setWorkItemState's
 *      held-open guard, EI-8993).
 * A hold had NO expiry and NO liveness check, so it outlived its holder forever.
 * WI-4445 sat blocked behind a hold placed by su-0efdd444 — an agent so gone that
 * `coord:send` to it returned `unknown_recipient` — and the only way through was a
 * leader force-clear the blocked agent had to go discover. Measured live before this
 * fix: 64 held-open rows, 50 of them NON-TERMINAL (i.e. 50 items silently starved out
 * of the claimable pool), across 21 distinct holders — of which exactly ONE still
 * existed in coord_presence.
 *
 * THE ASYMMETRY IT FIXES: a CLAIM — the WEAKER block — has a full reclaim policy
 * (work-items-stale-claims.ts: live grace, parked grace, requeue cap, a 60s sweep).
 * A HOLD — the STRONGER block — had none.
 *
 * ── Why this is a LEASE model and not a copy of the claim reaper ──────────────
 * The claim reaper's WI-1999 rule ("a holder this node has NEVER seen might be a LIVE
 * agent on another hive node — work_items federate, coord_presence does not — so don't
 * presume it dead until a 24h fallback") does NOT transplant onto holds:
 *
 *   - The presence RETENTION reaper (presenceReaperTtlMs, default 4h) DELETES an
 *     "ended" coord_presence row 4h past its last heartbeat, while a "parked"
 *     (wakeable) row is NEVER reaped. So for a holder, absence from coord_presence is
 *     not "unknown, possibly remote" — it is positive evidence of a session that ENDED
 *     and was reaped. Measured: 20 of 21 hold-holders were absent. Copying the claim
 *     rule would therefore make the liveness leg dead code and degenerate the whole
 *     thing into a blunt 24h TTL — which would NOT have unblocked the 7.7h-stale hold
 *     that motivated this item.
 *   - The COST of being wrong is inverted. Wrongly reaping a claim requeues an item
 *     somebody is actively working: duplicated work, discarded in-flight state. Wrongly
 *     clearing a hold merely lets normal lifecycle resume — nothing is destroyed, the
 *     holder is broadcast-notified, and a still-live holder can simply re-hold. A hold
 *     can therefore afford a far more aggressive expiry than a claim.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * A hold is EXPIRED iff ALL of:
 *   (a) its holder has NO fresh heartbeat (the shared mig-225 alias-aware
 *       {@link liveHolderFragment} — presence beat OR a RUNNING/RESTARTING nursery row
 *       on any alias), AND
 *   (b) its holder is not a briefly-parked/resumable session ({@link parkedHolderFragment}
 *       — the WI-2689 churn guard, same window claims get), AND
 *   (c) the hold itself is older than `holdOpenGraceMs` (default 2h).
 *
 * LIVENESS EXTENDS THE LEASE — it does not merely delay it. A hold whose holder is LIVE
 * is never expired, no matter how old: the long-running leader gate (the WI-3548 class
 * hold_open exists for) keeps working exactly as before. (c) is the guard against a
 * transiently-invisible holder — a hold placed seconds ago is never reaped just because
 * its session's presence row has not appeared yet.
 *
 * ACCEPTED TRADE (documented, not overlooked): a hold placed by a LIVE agent on ANOTHER
 * hive node is invisible here and will expire after the grace. That is bounded and
 * self-correcting (the gate lapses; the holder is notified and may re-hold; no work is
 * lost) and is the deliberate price of not leaving 50 items starved out of the pool
 * indefinitely. `holdOpenGraceMs` is live-configurable (coord-liveness-config) if a
 * multi-node deployment wants it longer.
 *
 * Wired into the existing 60s `stale-claim-sweep` tick (dbos/in-process-periodic) beside
 * the claim reapers, and enforced INLINE at the setWorkItemState chokepoint via
 * {@link isHoldOpenExpired} so a dead holder's hold never blocks a terminal transition
 * even if the sweep is wedged or has not ticked yet.
 */

import type { Sql, TransactionSql } from 'postgres';
import { liveHolderFragment, parkedHolderFragment, STALE_CLAIM_GRACE_MS } from './work-items-stale-claims';
import { POLICY_GATE_REASON_SQL_PATTERNS, recordBulkHoldClearAudit } from './work-items';

type Db = Sql | TransactionSql;

/**
 * How long a hold survives once its holder stops looking alive. Measured from
 * `held_open_at`, NOT from the holder's death (we cannot see the death of a session whose
 * presence row was already reaped) — so this doubles as the guard against reaping a hold
 * whose holder is only transiently invisible.
 *
 * Why 2h works from either side of the presence-retention TTL: a holder still IN
 * coord_presence with a stale beat is already judged dead by (a)+(b), and a holder ALREADY
 * reaped from coord_presence has by construction been gone ≥4h. So 2h measured from the
 * hold's own timestamp is long enough that a live holder's heartbeat (10m window) or parked
 * beat (30m window) will have re-asserted the hold, and short enough that a dead holder's
 * gate lifts within the same working session rather than the next day. The motivating
 * incident (a 7.7h-stale hold blocking a real terminal transition) clears comfortably.
 */
export const HOLD_OPEN_GRACE_MS = 2 * 60 * 60 * 1000;

/** The parked-holder churn window — same value claims get (WI-2689). Clamped ≥ live grace. */
export const HOLD_OPEN_PARKED_GRACE_MS = 30 * 60 * 1000;

/** A hold-open the sweep lifted. */
export interface ExpiredHoldOpen {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind: string;
  status: string;
  /** The dead holder whose gate was lifted. */
  former_holder: string;
  /** Their stated reason, for the audit trail / broadcast. */
  former_reason: string | null;
  /** When the hold was stamped. */
  held_open_at: string;
}

export interface HoldOpenSweepResult {
  expired: ExpiredHoldOpen[];
}

/**
 * `payload->>'held_open_at'` is always written by us as `new Date().toISOString()`, but a
 * malformed/legacy value must never abort the sweep with a cast error — and Postgres does
 * not guarantee a WHERE clause is evaluated before a SELECT-list cast. CASE *does* guarantee
 * its branches are only evaluated when the condition holds, so guard the cast inside one.
 * A missing/unparseable timestamp yields NULL, which the predicates below treat as
 * PAST-grace (a hold with no anchor cannot be shown to be recent — and, like the claim
 * reaper's NULL taken_at, it is still only reaped when its holder is independently dead).
 */
export const HELD_AT_EXPR = `CASE
        WHEN w.payload->>'held_open_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}'
        THEN (w.payload->>'held_open_at')::timestamptz
      END`;

/**
 * Lift every EXPIRED hold-open (holder not live, not briefly-parked, hold past grace) —
 * clearing `_claimHold` + the `held_open_*` stamps so the item returns to BOTH normal
 * self-select AND normal terminal transition. Returns the lifted rows for logging /
 * broadcast. One atomic statement; FOR UPDATE SKIP LOCKED so it never blocks a live
 * transaction, and the UPDATE re-checks via the CTE so a hold re-stamped between snapshot
 * and update is left alone.
 *
 * Terminal rows are swept too (a hold on an already-resolved item is pure residue), which
 * is why `status` is returned rather than filtered on.
 */
export async function reclaimStaleHoldOpens(
  sql: Db,
  opts: {
    /** Fresh-heartbeat window (default STALE_CLAIM_GRACE_MS = 10m) — same as claims. */
    graceMs?: number;
    /** Briefly-parked/resumable holder window (default 30m; clamped ≥ graceMs). */
    parkedGraceMs?: number;
    /** How old a hold must be before a dead-looking holder expires it (default 2h). */
    holdOpenGraceMs?: number;
  } = {},
): Promise<HoldOpenSweepResult> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const parkedGraceSec = Math.max(
    graceSec,
    Math.round((opts.parkedGraceMs ?? HOLD_OPEN_PARKED_GRACE_MS) / 1000),
  );
  const holdGraceSec = Math.max(1, Math.round((opts.holdOpenGraceMs ?? HOLD_OPEN_GRACE_MS) / 1000));

  const expired = await sql<ExpiredHoldOpen[]>`
    WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
    parked_holder AS (${parkedHolderFragment(sql, parkedGraceSec)}),
    stale AS (
      SELECT w.workspace_id, w.feature_id,
             w.harness_slug, w.item_kind, w.status,
             w.payload->>'held_open_by'     AS former_holder,
             w.payload->>'held_open_reason' AS former_reason,
             w.payload->>'held_open_at'     AS held_open_at
        FROM harness_shared.work_items w
       WHERE w.payload->>'held_open_by' IS NOT NULL
         AND w.payload->>'held_open_by' <> ''
         -- (a) no fresh heartbeat on any alias (the shared mig-225 liveness rule)
         AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = w.payload->>'held_open_by')
         -- (b) not a briefly-parked/resumable session (WI-2689 churn guard)
         AND NOT EXISTS (SELECT 1 FROM parked_holder p WHERE p.alias = w.payload->>'held_open_by')
         -- (c) the hold itself is past grace (NULL/unparseable held_open_at ⇒ past grace)
         AND COALESCE(
               ${sql.unsafe(HELD_AT_EXPR)} < now() - make_interval(secs => ${holdGraceSec}),
               true)
         -- (d) WI-6774: a POLICY-TIER gate (D-NNN decision id / triageDecision:"gate" /
         -- literal "policy-tier" in the reason) must NEVER be auto-lifted by mere holder
         -- liveness expiry — it is deliberately set to survive ordinary session churn and
         -- may only be cleared via the audited, ownerOverride-gated work_items:hold_open
         -- clear path (looksLikePolicyGate). Same pattern list as that JS predicate, kept
         -- in one shared constant so the two cannot drift.
         AND NOT COALESCE(w.payload->>'held_open_reason', '') ~* ANY(${POLICY_GATE_REASON_SQL_PATTERNS})
         FOR UPDATE OF w SKIP LOCKED
    )
    UPDATE harness_shared.work_items w
       -- A durable PARK (claim_hold_by, from release {claimHold:true}) may coexist with the
       -- dead lease being lifted — it is deliberately NOT liveness-bound, so lift only the
       -- held_open_* lease and keep _claimHold when the park is present.
       SET payload = CASE
             WHEN COALESCE(w.payload, '{}'::jsonb) ? 'claim_hold_by'
             THEN COALESCE(w.payload, '{}'::jsonb)
                    - 'held_open_by' - 'held_open_reason' - 'held_open_at'
             ELSE COALESCE(w.payload, '{}'::jsonb)
                    - '_claimHold' - 'held_open_by' - 'held_open_reason' - 'held_open_at'
           END,
           updated_ts = ${Date.now()}
      FROM stale s
     WHERE w.workspace_id = s.workspace_id AND w.feature_id = s.feature_id
    RETURNING s.workspace_id, s.harness_slug, s.feature_id, s.item_kind, s.status,
              s.former_holder, s.former_reason, s.held_open_at`;

  // WI-6774: this bulk liveness clear previously left NO audit_log row anywhere — the ONLY
  // trace was the best-effort coord broadcast below, itself tagged 'service-health' and so
  // excluded from a holder's default inbox view. Structural now: every lift is audit-visible.
  void recordBulkHoldClearAudit(
    sql,
    expired.map((e) => ({ id: e.feature_id, workspaceId: e.workspace_id, formerHolder: e.former_holder })),
    { actor: 'hold-open-sweep', sweepName: 'reclaimStaleHoldOpens' },
  );

  return { expired };
}

/**
 * The INLINE chokepoint test (setWorkItemState's held-open guard): is this hold expired,
 * i.e. must it NOT block a non-holder's terminal transition?
 *
 * The 60s sweep above is the durable cleanup, but a guard that depends on a sweep having
 * run is a guard that fails exactly when the sweep is wedged — which is the failure mode
 * this item is about. So the refusal path re-derives the SAME rule live, and the caller
 * clears the dead hold inline. Deliberately reuses the same fragments (never a second
 * liveness rule that can drift from the sweep's).
 *
 * Returns true ⇒ the hold is dead residue; treat the item as unheld.
 */
export async function isHoldOpenExpired(
  sql: Db,
  holder: string,
  heldOpenAt: string | null,
  opts: { graceMs?: number; parkedGraceMs?: number; holdOpenGraceMs?: number } = {},
): Promise<boolean> {
  if (!holder.trim()) return false;
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const parkedGraceSec = Math.max(
    graceSec,
    Math.round((opts.parkedGraceMs ?? HOLD_OPEN_PARKED_GRACE_MS) / 1000),
  );
  const holdGraceSec = Math.max(1, Math.round((opts.holdOpenGraceMs ?? HOLD_OPEN_GRACE_MS) / 1000));

  // (c) age is decided in JS — the value is already in hand, so no cast-safety dance.
  const heldMs = heldOpenAt ? Date.parse(heldOpenAt) : NaN;
  const pastGrace = Number.isNaN(heldMs) ? true : Date.now() - heldMs > holdGraceSec * 1000;
  if (!pastGrace) return false;

  const rows = await sql<{ alive: boolean }[]>`
    WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
    parked_holder AS (${parkedHolderFragment(sql, parkedGraceSec)})
    SELECT (
      EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = ${holder})
      OR EXISTS (SELECT 1 FROM parked_holder p WHERE p.alias = ${holder})
    ) AS alive`;
  return rows[0] ? !rows[0].alive : false;
}
