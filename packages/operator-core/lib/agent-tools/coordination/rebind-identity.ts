/**
 * rebind-identity — migrate every ownerId-keyed coordination surface from one
 * PAPERCUSP_SID to another (compaction-continuity-hardening-2026-07-07 P-007).
 *
 * WHY: a session's durable state is keyed by its coord ownerId (the sid). When
 * a relaunch/recovery mints a NEW sid while the transcript + config dir carry
 * on (psu resume under a fresh id, a raw `claude` relaunch in a parked config
 * dir), the live session silently loses everything the old id owned: its armed
 * loop keeps firing wakes at a dead owner, the carry-note (+ P-006 walls) is
 * unreadable, claims lapse, standing awaits never wake it, fleet membership
 * orphans, held work-items vanish from its carry brief. This module moves all
 * of it in one idempotent pass — cold P-004's violated assumption, closed.
 *
 * SHAPE: per-surface best-effort, NOT one transaction — every step is an
 * idempotent from→to move, so a partial failure is safely completed by simply
 * re-running; per-surface results beat an all-or-nothing rollback that leaves
 * the caller with nothing. A sid is globally unique (UUID-derived), so the
 * moves deliberately carry NO workspace predicate — matching the from-id can
 * never cross tenants, and scoping would silently strand rows written under a
 * different partition (the raw-SQL-plan-reads trap inverted).
 *
 * SAFETY: refuses while the from-id resolves to a LIVE-ish `sessionState`
 * through the shared liveness oracle — rebinding a live peer's identity steals
 * its loop and claims. `force` is only an override when the predecessor has no
 * protected coordination state; it never bypasses the oracle or a protected
 * claim/presence/membership/leadership row.
 *
 * ⚠ This guard used to read the RAW HEARTBEAT AGE (`heartbeat_at` within a
 * 180s window ⇒ "live"), and that was wrong in the exact case the module was
 * written for. A heartbeat is process-keepalive freshness, NOT a liveness
 * verdict: a session that has ENDED keeps a warm beat for up to
 * PRESENCE_STALE_MS, so the canonical relaunch — predecessor dead seconds ago,
 * live successor holding a new sid — hit `from_appears_live` and could only be
 * repaired with `force:true`. Putting the HAPPY PATH behind the override
 * taught callers to pass `force` reflexively, which hollowed the guard out for
 * the case it actually exists to protect (a genuinely live peer). Gating on
 * the derived `sessionState` instead makes the legitimate rebind need no
 * force, and keeps `force` meaningful. See REBIND_BLOCKING_SESSION_STATES.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { loopRoutineId, loopRoutineName } from '../../harness/routines/loop';
import { WORK_ITEM_NON_REQUEUE_STATES } from '../../work-items-stale-claims';
import { ISSUE_TERMINAL_STATES } from '../../work-item-dispatch-states';
// TYPE-ONLY (erased at runtime): the liveness oracle statically pulls
// presence.ts, adv-sessions and psu-pty-discovery, and this module is imported
// by hermetic unit tests and the recovery hook's HTTP path. The runtime edge is
// a dynamic import inside `defaultResolveLiveness` below — the same
// keep-it-off-the-static-graph discipline readPeerRelations uses for its IO deps.
import type { SessionState } from './presence-wakeability';

/**
 * Derived from-id states that BLOCK an unforced rebind. Each one means the old
 * id can still take a turn (`live`), can be woken into one (`parked`), is
 * winding down with a wake still armed (`draining`), or is authoritatively
 * alive per the session log (`recorded`).
 *
 * `ended` and `suspect` are DELIBERATELY absent: they are precisely the states
 * this module exists to repair. A warm-dead predecessor — heartbeat still
 * fresh, turn over, inbox-wake await cancelled — derives `ended`, and an
 * abruptly-killed one (await stranded, beat warm) derives `suspect`/`ended`
 * via the oracle's pid probe + PRESENCE_DEAD_MS ceiling. Both now rebind with
 * NO force.
 */
export const REBIND_BLOCKING_SESSION_STATES = ['live', 'parked', 'draining', 'recorded'] as const;

/** The liveness facts this guard acts on — a projection of the oracle's verdict. */
export interface FromLivenessVerdict {
  sessionState: SessionState;
  /** RAW heartbeat freshness. Reported for diagnosis; NEVER the gate (see header). */
  heartbeatFresh?: boolean;
}

/**
 * OwnerId-keyed state that makes a predecessor unsafe to override, even when a
 * caller supplied `force`. The probe deliberately spans both claim
 * representations and both live/durable fleet representations: any one of
 * these rows can still be acted on by the predecessor or can be stolen by the
 * successor.
 */
export interface FromProtectionState {
  claimsHeld: boolean;
  workItemsHeld: boolean;
  issueItemsHeld: boolean;
  presenceHeld: boolean;
  membershipHeld: boolean;
  leadershipHeld: boolean;
  protected: boolean;
}

/**
 * Resolve the from-id's verdict through THE shared oracle, so this guard cannot
 * drift from what coord:presence / fleet:status / the send-miss path report for
 * the same agent (presence-derivation-unification-2026-07-17 D-001: one
 * derivation, many lenses). `hydratePerId` fills heartbeat/stale/host/pid/source
 * from the subject's own presence row, which is what enables the pid probe.
 */
async function defaultResolveLiveness(
  from: string,
  hints: { claimsHeld: boolean; nowMs: number },
): Promise<FromLivenessVerdict | null> {
  const { resolveSessionStates } = await import('./liveness-oracle');
  const verdicts = await resolveSessionStates([{ ownerId: from, claimsHeld: hints.claimsHeld }], {
    nowMs: hints.nowMs,
    hydratePerId: true,
  });
  const v = verdicts.get(from);
  // EI-18771777750306094: `null` is the oracle's in-band unknown, which folds
  // into this function's EXISTING "no reading" return rather than being
  // reported as a state. Rebinding an identity off an unmeasured verdict is
  // exactly the confident-false-verdict this must not make.
  return v && v.sessionState != null
    ? { sessionState: v.sessionState, heartbeatFresh: v.heartbeatFresh }
    : null;
}

/**
 * Read every ownerId-keyed predecessor surface that must block an override.
 * This is one query so the liveness verdict and the protection decision are
 * based on the same snapshot. It is intentionally fail-soft at the caller:
 * an unavailable read must not prevent the ordinary idempotent rebind path,
 * but a successful read must never omit a protected surface.
 */
async function readProtectionState(sql: Sql, f: string): Promise<FromProtectionState> {
  const rows = await sql<
    Array<{
      claims_held: boolean;
      work_items_held: boolean;
      issue_items_held: boolean;
      presence_held: boolean;
      membership_held: boolean;
      leadership_held: boolean;
    }>
  >`
    SELECT
      (EXISTS (SELECT 1 FROM harness_shared.work_item_claims WHERE owner = ${f})
       OR EXISTS (SELECT 1 FROM harness_shared.plan_item_claims WHERE owner = ${f})) AS claims_held,
      EXISTS (
        SELECT 1 FROM harness_shared.work_items
         WHERE taken_by = ${f} AND status <> ALL(${WORK_ITEM_NON_REQUEUE_STATES}::text[])
      ) AS work_items_held,
      EXISTS (
        SELECT 1 FROM harness_shared.engineer_issues
         WHERE assignee = ${f} AND state <> ALL(${WORK_ITEM_NON_REQUEUE_STATES}::text[])
      ) AS issue_items_held,
      EXISTS (
        SELECT 1 FROM harness_shared.coord_presence
         WHERE owner_id = ${f}
      ) AS presence_held,
      EXISTS (
        SELECT 1
          FROM harness_shared.fleet_membership_events current_membership
         WHERE current_membership.owner_id = ${f}
           AND current_membership.id = (
             SELECT max(latest_membership.id)
               FROM harness_shared.fleet_membership_events latest_membership
              WHERE latest_membership.owner_id = ${f}
           )
           AND current_membership.fleet_slug IS NOT NULL
      ) AS membership_held,
      EXISTS (
        SELECT 1 FROM harness_shared.agent_fleets
         WHERE leader_owner_id = ${f}
      ) AS leadership_held
  `;
  const row = rows[0];
  const state = {
    claimsHeld: row?.claims_held === true,
    workItemsHeld: row?.work_items_held === true,
    issueItemsHeld: row?.issue_items_held === true,
    presenceHeld: row?.presence_held === true,
    membershipHeld: row?.membership_held === true,
    leadershipHeld: row?.leadership_held === true,
  };
  return { ...state, protected: Object.values(state).some(Boolean) };
}

/**
 * Recover the launcher's resolved fleet when membership facts were never
 * stamped.  `adv_sessions.launch_spec` is the durable launch-time record and
 * is deliberately read through `to_jsonb`: older operators may not have the
 * additive migration yet, in which case this leg fails soft with the rest of
 * the fleet-membership surface.
 */
async function readLaunchSpecFleet(
  sql: Sql,
  ownerId: string,
): Promise<{
  workspace_id: string;
  owner_label: string | null;
  fleet_slug: string | null;
  fleet_role: string | null;
} | null> {
  const rows = await sql<
    Array<{
      workspace_id: string;
      owner_label: string | null;
      fleet_slug: string | null;
      fleet_role: string | null;
    }>
  >`
    SELECT workspace_id,
           label AS owner_label,
           to_jsonb(adv)->'launch_spec'->'fleet'->>'slug' AS fleet_slug,
           to_jsonb(adv)->'launch_spec'->'fleet'->>'role' AS fleet_role
      FROM harness_shared.adv_sessions AS adv
     WHERE coord_owner_id = ${ownerId}
     ORDER BY started_at DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface RebindSurfaceResult {
  surface: string;
  /** Rows re-keyed from → to. */
  moved: number;
  /** From-rows discarded because the to-side already holds a fresher/equal row. */
  dropped?: number;
  /** Active awaits cancelled instead of moved (an identical active to-await exists). */
  cancelled?: number;
  /** Append-only rows written (fleet membership facts). */
  appended?: number;
  /** Retained-history rows re-keyed alongside their live row (claim-spec revisions,
   *  migration 810). Counted separately from `moved` because it is a different
   *  population: `moved` is live state the agent is about to act on, this is the
   *  superseded versions behind it. Summing them would overstate what was re-homed. */
  movedHistory?: number;
  error?: string;
}

export interface RebindIdentityResult {
  ok: boolean;
  from: string;
  to: string;
  refused?: 'bad_args' | 'from_appears_live';
  /** The from-id's derived sessionState when the guard resolved one (null =
   *  the oracle returned no verdict, so the guard failed OPEN — see header). */
  fromSessionState?: SessionState | null;
  /** RAW heartbeat freshness of the from-id. Diagnostic ONLY — a warm beat on
   *  an `ended` session is exactly why this is not the gate. */
  fromHeartbeatFresh?: boolean;
  surfaces: RebindSurfaceResult[];
  totalMoved: number;
}

export interface RebindIdentityOpts {
  /** Skip the from-is-live liveness guard (caller has verified the old session is dead). */
  force?: boolean;
  sql?: Sql;
  now?: number;
  /** DI seam for the liveness guard — defaults to the shared oracle
   *  (`resolveSessionStates`, dynamically imported). Injected by unit tests so
   *  the guard stays hermetic; the oracle's own IO does NOT go through `sql`. */
  resolveLiveness?: (
    from: string,
    hints: { claimsHeld: boolean; nowMs: number },
  ) => Promise<FromLivenessVerdict | null>;
  /**
   * SU-locks (file locks + lock waiters) owner rebind (EI-8999 / P-002,
   * fleet-reliability-verification-2026-07-10) — injected because
   * `@papercusp/locks` owns a SEPARATE side-database (`papercusp_su`),
   * untouched by the `sql` above (which only ever points at `harness_shared`
   * in the main org db). Left undefined here (the default), the 'file-locks'
   * surface is skipped entirely — this keeps `rebindIdentity` itself free of
   * any real network I/O beyond the one `sql` handle callers already control,
   * so a caller that doesn't pass it (every existing unit test) stays fully
   * hermetic. The production `coord:rebind-identity` tool handler wires the
   * real `rebindLockOwner` from `@papercusp/locks` — see tools/rebind-identity.ts.
   */
  rebindLockOwner?: (from: string, to: string) => Promise<{ fileLocksMoved: number; waitersMoved: number }>;
}

/** Carry-note scopes that embed the ownerId as their last `:`-segment. */
const OWNER_SCOPE_PREFIXES = ['loop:', 'loopnag:'];

export async function rebindIdentity(
  from: string,
  to: string,
  opts: RebindIdentityOpts = {},
): Promise<RebindIdentityResult> {
  const f = from.trim();
  const t = to.trim();
  const base: RebindIdentityResult = { ok: false, from: f, to: t, surfaces: [], totalMoved: 0 };
  if (!f || !t || f === t) return { ...base, refused: 'bad_args' };

  const sql = opts.sql ?? getOrgPg().sql;
  const now = opts.now ?? Date.now();

  let fromSessionState: SessionState | null = null;
  let fromHeartbeatFresh: boolean | undefined;
  let protection: FromProtectionState | null = null;
  // Read the protection snapshot separately so a degraded SQL leg does not
  // suppress the liveness oracle. The oracle is always consulted, including
  // for force=true; force only changes the outcome when the read was
  // successful and found no protected predecessor state.
  try {
    protection = await readProtectionState(sql, f);
  } catch {
    /* fail open for the idempotent rebind path */
  }
  try {
    const verdict = await (opts.resolveLiveness ?? defaultResolveLiveness)(f, {
      claimsHeld: protection?.claimsHeld ?? false,
      nowMs: now,
    });
    fromSessionState = verdict?.sessionState ?? null;
    fromHeartbeatFresh = verdict?.heartbeatFresh;
    if (
      verdict &&
      (REBIND_BLOCKING_SESSION_STATES as readonly SessionState[]).includes(verdict.sessionState) &&
      (!opts.force || protection?.protected === true)
    ) {
      return {
        ...base,
        refused: 'from_appears_live',
        fromSessionState: verdict.sessionState,
        ...(verdict.heartbeatFresh === undefined ? {} : { fromHeartbeatFresh: verdict.heartbeatFresh }),
      };
    }
  } catch {
    /* fail open */
  }

  const surfaces: RebindSurfaceResult[] = [];
  const run = async (surface: string, fn: (r: RebindSurfaceResult) => Promise<void>): Promise<void> => {
    const r: RebindSurfaceResult = { surface, moved: 0 };
    try {
      await fn(r);
    } catch (err) {
      r.error = err instanceof Error ? err.message : String(err);
    }
    surfaces.push(r);
  };

  // 1. Armed loop routine — id + name derive from the ownerId, so the row is
  //    re-keyed wholesale; payload_template embeds the sid textually (the arm-time
  //    interpolation of {ownerId} into the wake kickoff), hence the text replace.
  //    If the new id already armed its OWN loop, the from-loop is a ghost firing
  //    wakes at a dead owner — drop it rather than clobber the live one.
  await run('loop-routine', async (r) => {
    const loops = await sql<Array<{ id: string; install_slug: string }>>`
      SELECT id, install_slug FROM harness_shared.routines
       WHERE target_owner_id = ${f} AND reschedule_interval_sec IS NOT NULL
    `;
    for (const loop of loops) {
      const newId = loopRoutineId(loop.install_slug, t);
      const existing = await sql<Array<{ id: string }>>`
        SELECT id FROM harness_shared.routines WHERE id = ${newId}
      `;
      if (existing.length > 0) {
        await sql`DELETE FROM harness_shared.routines WHERE id = ${loop.id}`;
        r.dropped = (r.dropped ?? 0) + 1;
      } else {
        await sql`
          UPDATE harness_shared.routines
             SET id = ${newId},
                 name = ${loopRoutineName(t)},
                 target_owner_id = ${t},
                 payload_template = CASE WHEN payload_template IS NULL THEN NULL
                                         ELSE replace(payload_template::text, ${f}, ${t})::jsonb END,
                 updated_at = now()
           WHERE id = ${loop.id}
        `;
        r.moved += 1;
      }
    }
  });

  // 2. Loop carry-note (+ the P-006 walls riding in it) and the loopnag row —
  //    scope's last segment is the ownerId. On a scope collision the NEWER
  //    updated_ts wins (walls carry-forward means the fresher note is the truth).
  await run('carry-note', async (r) => {
    const notes = await sql<Array<{ workspace_id: string; scope: string; updated_ts: string | Date }>>`
      SELECT workspace_id, scope, updated_ts FROM harness_shared.carry_notes
       WHERE (scope LIKE 'loop:%' OR scope LIKE 'loopnag:%') AND scope LIKE ${'%:' + f}
    `;
    for (const note of notes) {
      if (!OWNER_SCOPE_PREFIXES.some((p) => note.scope.startsWith(p)) || !note.scope.endsWith(':' + f)) continue;
      const target = note.scope.slice(0, note.scope.length - f.length) + t;
      const clash = await sql<Array<{ updated_ts: string | Date }>>`
        SELECT updated_ts FROM harness_shared.carry_notes
         WHERE workspace_id = ${note.workspace_id} AND scope = ${target}
      `;
      if (clash.length > 0 && new Date(clash[0].updated_ts).getTime() >= new Date(note.updated_ts).getTime()) {
        await sql`DELETE FROM harness_shared.carry_notes
                   WHERE workspace_id = ${note.workspace_id} AND scope = ${note.scope}`;
        r.dropped = (r.dropped ?? 0) + 1;
        continue;
      }
      if (clash.length > 0) {
        await sql`DELETE FROM harness_shared.carry_notes
                   WHERE workspace_id = ${note.workspace_id} AND scope = ${target}`;
      }
      await sql`
        UPDATE harness_shared.carry_notes SET scope = ${target}
         WHERE workspace_id = ${note.workspace_id} AND scope = ${note.scope}
      `;
      r.moved += 1;
    }
  });

  // 3. Presence — the from-row is a ghost (its session is dead by the guard
  //    above); the live session's own beat creates the to-row. Drop, not move:
  //    a moved row would carry a stale label + counters the beat immediately
  //    overwrites, and a lingering ghost row shows a dead duplicate on rosters.
  await run('presence', async (r) => {
    const gone = await sql<Array<{ owner_id: string }>>`
      DELETE FROM harness_shared.coord_presence WHERE owner_id = ${f} RETURNING owner_id
    `;
    r.dropped = gone.length;
  });

  // 4. Fleet membership — APPEND-ONLY facts (WI-1345: never UPDATE/DELETE):
  //    close the old id's membership with a leave-fact and open the same
  //    fleet+role under the new id, unless the new id already sits there.
  //    A fresh launch persists its resolved fleet in adv_sessions.launch_spec
  //    before the first presence turn. If the predecessor died before the
  //    boot-time membership stamp, that record is the only durable fleet
  //    evidence available to the rebind and must seed the successor.
  await run('fleet-membership', async (r) => {
    const latest = await sql<
      Array<{ workspace_id: string; owner_label: string | null; fleet_slug: string | null; fleet_role: string | null }>
    >`
      SELECT workspace_id, owner_label, fleet_slug, fleet_role FROM harness_shared.fleet_membership_events
       WHERE owner_id = ${f} ORDER BY id DESC LIMIT 1
    `;
    const cur = latest[0];
    // A latest leave-fact is an explicit no-fleet decision and must win over
    // the older launch snapshot. Only a genuinely absent membership history
    // qualifies for launch_spec recovery.
    const launchFleet = !cur ? await readLaunchSpecFleet(sql, f) : null;
    const recovered = cur ?? launchFleet;
    if (!recovered?.fleet_slug) return;
    const fleetRole = recovered.fleet_role ?? 'member';
    const toLatest = await sql<Array<{ fleet_slug: string | null }>>`
      SELECT fleet_slug FROM harness_shared.fleet_membership_events
       WHERE owner_id = ${t} ORDER BY id DESC LIMIT 1
    `;
    if (toLatest[0]?.fleet_slug !== recovered.fleet_slug) {
      await sql`
        INSERT INTO harness_shared.fleet_membership_events (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
        VALUES (${recovered.workspace_id}, ${t}, ${recovered.owner_label}, ${recovered.fleet_slug}, ${fleetRole},
                ${fleetRole === 'leader' ? 'lead' : 'join'})
      `;
      r.appended = (r.appended ?? 0) + 1;
    }
    // There is no predecessor fact to close on the launch_spec-only path.
    if (cur) {
      await sql`
        INSERT INTO harness_shared.fleet_membership_events (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
        VALUES (${cur.workspace_id}, ${f}, ${cur.owner_label}, NULL, NULL, 'leave')
      `;
      r.appended = (r.appended ?? 0) + 1;
    }
  });

  // 5. Fleet leadership pointer.
  await run('fleet-leadership', async (r) => {
    const led = await sql<Array<{ fleet_slug: string }>>`
      UPDATE harness_shared.agent_fleets SET leader_owner_id = ${t}
       WHERE leader_owner_id = ${f} RETURNING fleet_slug
    `;
    r.moved = led.length;
  });

  // 6. Scheduler claim-spec — PK (workspace_id, bee_id); the live id's own
  //    spec (if the Queen already re-set one) wins over the ghost's.
  await run('claim-spec', async (r) => {
    const dropped = await sql<Array<{ bee_id: string }>>`
      DELETE FROM harness_shared.cup_claim_specs fspec
       USING harness_shared.cup_claim_specs tspec
       WHERE fspec.bee_id = ${f} AND tspec.bee_id = ${t}
         AND tspec.workspace_id = fspec.workspace_id
       RETURNING fspec.bee_id
    `;
    r.dropped = dropped.length;
    const moved = await sql<Array<{ bee_id: string }>>`
      UPDATE harness_shared.cup_claim_specs SET bee_id = ${t}
       WHERE bee_id = ${f} RETURNING bee_id
    `;
    r.moved = moved.length;
    // The lane's HISTORY follows the lane (migration 810). Left behind, it would be
    // orphaned under a dead id — and the failure is silent in the worst way: the
    // rebound agent's `scheduler:get_claim_spec { cupId, history }` returns an EMPTY
    // window, which reads as "this lane has no history" rather than "its history is
    // filed under the id you no longer are". The undo would be missing for exactly
    // the agent who just survived a fork.
    //
    // MUST RUN LAST in this block. The DELETE above fires migration 810's retention
    // trigger, which writes a fresh revision row keyed on the GHOST's bee_id — so
    // moving history any earlier would strand the row this very rebind just created.
    // (The bee_id UPDATE above fires nothing: the trigger's WHEN clause tests spec
    // and revision, neither of which a re-key touches.)
    //
    // No collision handling is needed here, unlike the parent's PK: revision history
    // is deliberately keyed on a surrogate `id`, so both identities' rows coexist and
    // interleave correctly under `ORDER BY superseded_at DESC`.
    const movedHistory = await sql<Array<{ id: string }>>`
      UPDATE harness_shared.cup_claim_spec_revisions SET bee_id = ${t}
       WHERE bee_id = ${f} RETURNING id
    `;
    r.movedHistory = movedHistory.length;
  });

  // 7. Standing awaits (wakeOnReply etc.) — ACTIVE rows only; the event_key can
  //    itself embed the sid (reply/inbox-wake keys), hence the per-row rewrite.
  //    An identical active await already armed by the new id (the engine re-arms
  //    its own inbox wake) turns the from-row into a duplicate wake source —
  //    cancel it instead of moving it.
  await run('awaits', async (r) => {
    const awaits = await sql<Array<{ id: number; workspace_id: string; event_key: string }>>`
      SELECT id, workspace_id, event_key FROM harness_shared.event_awaits
       WHERE subscriber_id = ${f} AND fired_at IS NULL AND cancelled_at IS NULL
    `;
    for (const a of awaits) {
      const newKey = a.event_key.split(f).join(t);
      const dup = await sql<Array<{ id: number }>>`
        SELECT id FROM harness_shared.event_awaits
         WHERE workspace_id = ${a.workspace_id} AND subscriber_id = ${t} AND event_key = ${newKey}
           AND fired_at IS NULL AND cancelled_at IS NULL
         LIMIT 1
      `;
      if (dup.length > 0) {
        await sql`UPDATE harness_shared.event_awaits SET cancelled_at = now() WHERE id = ${a.id}`;
        r.cancelled = (r.cancelled ?? 0) + 1;
      } else {
        await sql`
          UPDATE harness_shared.event_awaits SET subscriber_id = ${t}, event_key = ${newKey}
           WHERE id = ${a.id}
        `;
        r.moved += 1;
      }
    }
  });

  // 7b. Interest watches (migration 839) — the PARENT registry row of the
  //     standing-await surface directly above. A watch:create row "serves both
  //     delivery modes: a paired event_awaits row (wake:true) and/or a
  //     coord_entity_subscriptions inject row (wake:false)" (839's own header),
  //     and delivery selects those CHILDREN — so leaving the parent behind does
  //     not silently stop wakes, which is exactly why this was easy to miss when
  //     839 landed. What it DOES break is the upsert identity: interest-watch.ts
  //     re-finds an agent's existing watch by (owner_id, event_key) before
  //     inserting, so a rebound agent whose children moved but whose parent did
  //     not no longer matches its own row — it inserts a DUPLICATE watch and the
  //     original lingers under the dead sid, swept forever and cancellable by
  //     nobody. Re-key ACTIVE rows only, mirroring the awaits rule above: an
  //     inactive watch is spent, not live claim state. No dedup pass is needed —
  //     the sole unique index is the uuid PK, so a re-key cannot collide.
  await run('interest-watches', async (r) => {
    const moved = await sql<Array<{ id: string }>>`
      UPDATE harness_shared.interest_watches SET owner_id = ${t}
       WHERE owner_id = ${f} AND active RETURNING id
    `;
    r.moved = moved.length;
  });

  // 7c. Actionable consult participant ownership — consult verbs authorize by
  //     comparing the caller directly with consult_state.requester_id /
  //     responder_id. Most visibly, consult:close admits an expired row's late
  //     disposition ONLY when the caller equals requester_id. Without this
  //     re-key, a successor that has otherwise recovered every coordination
  //     surface is no longer a participant and cannot finish the conversation
  //     that survived its identity change (EI-21457373491665728).
  //
  //     Open rows follow the live identity, as do expired rows because expiry
  //     deliberately preserves one requester-only action: late close. Fully
  //     dispositioned history stays attributed to the session that authored
  //     it, matching held-items / held-work-items above and below. `closed_at`
  //     is the future-proof open-state discriminator; the explicit expired
  //     exception is the authorization seam this migration repairs.
  await run('consult-participants', async (r) => {
    const moved = await sql<Array<{ conversation_id: string }>>`
      UPDATE harness_shared.consult_state
         SET requester_id = CASE WHEN requester_id = ${f} THEN ${t} ELSE requester_id END,
             responder_id = CASE WHEN responder_id = ${f} THEN ${t} ELSE responder_id END
       WHERE (requester_id = ${f} OR responder_id = ${f})
         AND (closed_at IS NULL OR state = 'expired')
       RETURNING conversation_id
    `;
    r.moved = moved.length;
  });

  // 8-9. Plan-item + work-item claims — owner is not part of either PK, so a
  //      straight re-key; lease expiry is time-based and unaffected.
  await run('plan-claims', async (r) => {
    const moved = await sql<Array<{ owner: string }>>`
      UPDATE harness_shared.plan_item_claims SET owner = ${t}
       WHERE owner = ${f} RETURNING owner
    `;
    r.moved = moved.length;
  });
  await run('work-claims', async (r) => {
    const moved = await sql<Array<{ owner: string }>>`
      UPDATE harness_shared.work_item_claims SET owner = ${t}
       WHERE owner = ${f} RETURNING owner
    `;
    r.moved = moved.length;
  });

  // 10. Watermarks — PK (workspace_id, owner_id); if the live id already
  //     settled a turn (has its own row) its read-pointers are current, keep them.
  await run('watermarks', async (r) => {
    const dropped = await sql<Array<{ owner_id: string }>>`
      DELETE FROM harness_shared.coord_watermarks fwm
       USING harness_shared.coord_watermarks twm
       WHERE fwm.owner_id = ${f} AND twm.owner_id = ${t}
         AND twm.workspace_id = fwm.workspace_id
       RETURNING fwm.owner_id
    `;
    r.dropped = dropped.length;
    const moved = await sql<Array<{ owner_id: string }>>`
      UPDATE harness_shared.coord_watermarks SET owner_id = ${t}
       WHERE owner_id = ${f} RETURNING owner_id
    `;
    r.moved = moved.length;
  });

  // 11. Held work-items — the carry brief's readHeldWorkItems keys on
  //     engineer_issues.assignee; only OPEN items follow the live id (resolved
  //     history stays attributed to the id that did the work). NOTE: this view
  //     is scoped to item_kind IN ('bug','change','task') only (its INSTEAD OF
  //     trigger writes through to work_items.taken_by for exactly that subset)
  //     — kept for the narrower engineer_issues-specific fields it still reads
  //     (state literal), but see step 11b below for the surface that actually
  //     covers every item_kind.
  await run('held-items', async (r) => {
    const moved = await sql<Array<{ issue_id: string }>>`
      UPDATE harness_shared.engineer_issues SET assignee = ${t}
       WHERE assignee = ${f} AND NOT (state = ANY(${[...ISSUE_TERMINAL_STATES]}::text[]))
       RETURNING issue_id
    `;
    r.moved = moved.length;
  });

  // 11b. Held work-items, ALL item_kinds (WI-3642) — the P-010 unified base table
  //      directly. Step 11 above only re-keys via the engineer_issues COMPAT VIEW,
  //      which is filtered to item_kind IN ('bug','change','task'); FEATURE-family
  //      claims (feature/research-task/chunk — the majority of live work-item
  //      claims) were NEVER re-keyed by this module. Root cause of WI-3642: after
  //      step 3 deletes the from-id's presence row, a feature-family claim still
  //      held by the (now presence-less) from-id looks exactly like an abandoned
  //      claim to the NEXT stale-claims reap sweep (work-items-stale-claims.ts) —
  //      which then legitimately (from ITS point of view) frees/requeues it out
  //      from under the still-live session that just got a new sid. Only
  //      non-terminal rows follow the live id; terminal history keeps its author.
  await run('held-work-items', async (r) => {
    const moved = await sql<Array<{ feature_id: string }>>`
      UPDATE harness_shared.work_items SET taken_by = ${t}
       WHERE taken_by = ${f} AND status <> ALL(${WORK_ITEM_NON_REQUEUE_STATES}::text[])
       RETURNING feature_id
    `;
    r.moved = moved.length;
  });

  // 12. Owner-scoped facts — folded into every future brief/orient by scopeRef.
  //     A key the live id already re-asserted wins (drop the ghost's copy first
  //     so the re-key can't violate the per-scope uniqueness).
  await run('owner-facts', async (r) => {
    const dropped = await sql<Array<{ key: string }>>`
      DELETE FROM harness_shared.agent_facts ffact
       USING harness_shared.agent_facts tfact
       WHERE ffact.scope = 'owner' AND ffact.scope_ref = ${f}
         AND tfact.scope = 'owner' AND tfact.scope_ref = ${t}
         AND tfact.workspace_id = ffact.workspace_id AND tfact.key = ffact.key
       RETURNING ffact.key
    `;
    r.dropped = dropped.length;
    const moved = await sql<Array<{ key: string }>>`
      UPDATE harness_shared.agent_facts SET scope_ref = ${t}
       WHERE scope = 'owner' AND scope_ref = ${f} RETURNING key
    `;
    r.moved = moved.length;
  });

  // 12b. Open owner directives — these are CURRENT control instructions for
  //      the session, not attribution history. They are rendered on every
  //      wake/orient/compaction recovery until dispositioned, so leaving an
  //      open row under the dead sid would silently drop the owner's binding
  //      instruction after an identity rebind. Dispositioned rows stay on the
  //      originating sid as immutable history; only live instructions follow.
  //      WI-10002452: this surface re-keys `recorded_by`, NOT `owner_id`. The
  //      two columns' roles are inverted relative to their names, and until
  //      that was measured this UPDATE ran against `owner_id` — where it could
  //      never match a row, because that column holds the HUMAN owner label
  //      ('owner' ×181, 'owner' ×22 across all 203 live rows; zero session-shaped,
  //      never equal to recorded_by). `recorded_by` is the column that says
  //      which SESSION the owner was addressing, and it is what `orders:*` and
  //      the turn-start Orientation banner key on — so it is the one that has
  //      to follow a re-bound agent. The intent above was always right; only
  //      the column was wrong.
  await run('owner-directives', async (r) => {
    const moved = await sql<Array<{ id: number }>>`
      UPDATE harness_shared.owner_directives SET recorded_by = ${t}
       WHERE recorded_by = ${f} AND dispositioned_at IS NULL
       RETURNING id
    `;
    r.moved = moved.length;
  });

  // 11c. PER-SESSION directive agenda (migration 1195, plan
  // directive-visibility-and-ownership-2026-09-22 / D-008). Which directives
  // THIS session has cleared from its own banner.
  //
  // Like surface 12b above, this one genuinely matches rows: the column holds
  // coord session ids. (12b USED to target `owner_directives.owner_id`, which
  // holds the HUMAN owner label and so could never match; that was WI-10002452
  // and is now fixed — 12b re-keys `recorded_by` instead, and the inventory's
  // classification was corrected to match.)
  //
  // This MUST follow the agent: agenda state is what stops a session being
  // re-nagged by directives it already cleared, so stranding it under a dead
  // sid re-delivers every cleared row to the successor — the precise nuisance
  // per-session agenda exists to remove.
  await run('directive-agenda', async (r) => {
    // The successor may already have acted on the same directive. Its own
    // decision is fresher, so drop the predecessor row rather than clobber it
    // — same precedent as the agent-modes surface below, and required anyway
    // because (workspace_id, directive_id, owner_id) is the primary key and a
    // bare UPDATE would violate it.
    await sql`
      DELETE FROM harness_shared.owner_directive_agenda AS predecessor
       WHERE predecessor.owner_id = ${f}
         AND EXISTS (
           SELECT 1 FROM harness_shared.owner_directive_agenda AS successor
            WHERE successor.owner_id = ${t}
              AND successor.workspace_id = predecessor.workspace_id
              AND successor.directive_id = predecessor.directive_id
         )
    `;
    const moved = await sql<Array<{ directive_id: number }>>`
      UPDATE harness_shared.owner_directive_agenda SET owner_id = ${t}
       WHERE owner_id = ${f}
       RETURNING directive_id
    `;
    r.moved = moved.length;
  });

  // 12c. Current mode posture — unlike agent_mode_changes, this is live
  // per-owner state, not attribution history. Re-key every non-colliding axis
  // wholesale so GOAL's subject, lease epoch, and bounded handoff fields stay
  // attached to the cold-carry successor alongside AUTO/DRAIN/other posture.
  // If the successor already asserted that axis, its current row wins: drop the
  // predecessor row rather than clobbering a fresher successor decision.
  await run('agent-modes', async (r) => {
    const dropped = await sql<Array<{ axis_key: string }>>`
      DELETE FROM harness_shared.agent_modes AS from_mode
       USING harness_shared.agent_modes AS to_mode
       WHERE from_mode.owner_id = ${f}
         AND to_mode.owner_id = ${t}
         AND to_mode.workspace_id = from_mode.workspace_id
         AND to_mode.axis_key = from_mode.axis_key
       RETURNING from_mode.axis_key
    `;
    r.dropped = dropped.length;
    const moved = await sql<Array<{ axis_key: string }>>`
      UPDATE harness_shared.agent_modes
         SET owner_id = ${t}
       WHERE owner_id = ${f}
       RETURNING axis_key
    `;
    r.moved = moved.length;
  });

  // 13b. Server-side read cursors (P-004 fleet-deltas-leader-primitives,
  //      migration 537) — PK (workspace_id, owner_id, surface), same shape and
  //      same non-monotonic-cursor-survival rationale as the 'watermarks' step
  //      above (coord_watermarks): if the live id already re-acked its OWN
  //      cursor for a surface post-rebind, its fresher committed/pending state
  //      wins over the ghost's. Found + fixed live by the EI-8999 static
  //      inventory guard the moment migration 537 landed (identity-keyed-
  //      state-inventory.test.ts) — exactly the class of gap it exists to catch.
  await run('read-cursors', async (r) => {
    const dropped = await sql<Array<{ owner_id: string }>>`
      DELETE FROM harness_shared.coord_read_cursors fcur
       USING harness_shared.coord_read_cursors tcur
       WHERE fcur.owner_id = ${f} AND tcur.owner_id = ${t}
         AND tcur.workspace_id = fcur.workspace_id AND tcur.surface = fcur.surface
       RETURNING fcur.owner_id
    `;
    r.dropped = dropped.length;
    const moved = await sql<Array<{ owner_id: string }>>`
      UPDATE harness_shared.coord_read_cursors SET owner_id = ${t}
       WHERE owner_id = ${f} RETURNING owner_id
    `;
    r.moved = moved.length;
  });

  // 13. Staged (manual-mode) wakes — pending-wakes.ts (D-005/migration 204) reads
  //     PURELY by owner_id, no fallback: `listPendingWakes(ownerId)` is the sole
  //     read path the agent's pane and the wake-count sync query use. A wake
  //     staged for the from-id before a compaction rebind (a manual-mode agent's
  //     inbox-wake queued right before the sid changes) would otherwise sit
  //     invisibly under the dead sid forever — the owner's pane never surfaces
  //     it and the (now differently-sid'd) live agent never sees it queued
  //     (EI-8999: the WI-3642 lesson generalized — found via a sweep of every
  //     owner_id-keyed table that a presence-tied reader/reaper touches).
  await run('pending-wakes', async (r) => {
    const moved = await sql<Array<{ id: number }>>`
      UPDATE harness_shared.pending_wakes SET owner_id = ${t}
       WHERE owner_id = ${f} RETURNING id
    `;
    r.moved = moved.length;
  });

  // 14. SU-locks file locks + lock waiters (EI-8999/P-002) — a genuinely
  //     SEPARATE side-database from every surface above; opt-in via
  //     opts.rebindLockOwner (see the option's doc). A file lock stranded
  //     under a dead sid blocks every other agent from that path until its
  //     TTL lapses (up to 20 min) — the WI-3642 class of bug, on a
  //     different database. Only recorded when the caller wired it, so the
  //     surface never appears (and never attempts I/O) for a caller that
  //     didn't ask for it.
  if (opts.rebindLockOwner) {
    await run('file-locks', async (r) => {
      const res = await opts.rebindLockOwner!(f, t);
      r.moved = res.fileLocksMoved + res.waitersMoved;
    });
  }

  const totalMoved = surfaces.reduce(
    (n, s) => n + s.moved + (s.dropped ?? 0) + (s.cancelled ?? 0) + (s.appended ?? 0),
    0,
  );
  return {
    ok: surfaces.every((s) => !s.error),
    from: f,
    to: t,
    fromSessionState,
    ...(fromHeartbeatFresh === undefined ? {} : { fromHeartbeatFresh }),
    surfaces,
    totalMoved,
  };
}
