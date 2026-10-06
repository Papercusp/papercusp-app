/**
 * Mode store — reads/writes harness_shared.agent_modes (+ the append-only
 * agent_mode_changes audit) with the axis semantics enforced at the write
 * (modes-and-intake-ux-2026-07-05 P-006, D-003, D-006).
 *
 * Semantics enforced HERE (not in the tool layer), so every caller gets them:
 *   - AUTO-SWITCH: setting a mode replaces the same-axis incumbent in one
 *     upsert (PK (workspace_id, owner_id, axis_key)); the displaced mode is
 *     returned as `switchedFrom` and audited as its own transition.
 *   - OWNER-STICKY (D-003): a row with owner_directed=true can only be
 *     changed by its own agent (self) or an owner-directed write; a peer's
 *     attempt returns { stickyConflict: true } and writes NOTHING — the tool
 *     layer downgrades it to a request message.
 *   - AUDIT: every applied transition (set / clear / auto-switch displacement)
 *     appends an agent_mode_changes row.
 *
 * Injectable `sql` seam for unit tests (same discipline as the rest of the
 * coordination layer: pure logic testable without PG).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { modeById, axisKeyFor, resolveImpliedModes, modeRequiresSubject, type ModeDef } from './registry';
import { notifyAgentOrdersChanged } from '../agent-orders-notify';
import { GOAL_MODE } from './goal-session';

/** The only permitted overlap between two effective GOAL sessions. */
export const GOAL_HOLDER_HANDOFF_SECONDS = 120;

export interface GoalModeElectionReceipt {
  ownerId: string;
  goalId: string;
  epoch: number;
  predecessorOwnerId: string | null;
  handoffExpiresAt: string | null;
}

/**
 * A recovery caller's compare-and-set proof. Ordinary first acquisition needs
 * no proof; a current elected holder can hand off because its `setBy` identity
 * is checked under the same advisory lock; verified owner authority may also
 * replace the current lease. Every other replacement must carry this exact
 * elected lease identity so a stale recovery read cannot steal a newer lease.
 */
export interface GoalModeElectionExpectation {
  ownerId: string;
  epoch: number | null;
}

export interface GoalModeElectionConflict {
  goalId: string;
  electedOwnerId: string;
  electedEpoch: number | null;
}

/** The mode transition that caused a derived posture row to exist. */
export interface ModeImplicationProvenance {
  mode: string;
  subject: string | null;
}

export interface ModeRow {
  workspaceId: string;
  ownerId: string;
  axisKey: string;
  mode: string;
  reason: string;
  setBy: string;
  ownerDirected: boolean;
  setAt: string;
  /**
   * WHAT this mode is about — mode-defined and optional (migration 767,
   * goal-mode-2026-08-07 P-016). GOAL stores the `harness_shared.goals.id` the
   * session is running, which is how goal provenance is stamped from SESSION
   * CONTEXT rather than agent self-report. Deliberately generic: DRAIN's scope
   * or GRADE's rubric ref fit the same slot, which is why this is not named
   * `goalId` and is not a foreign key. A dangling value must degrade to "no
   * stamp", never to a failed write.
  */
  subject: string | null;
  /** The source mode/subject when this row was inserted by an implication cascade. */
  impliedBy: ModeImplicationProvenance | null;
  /** GOAL-only effective-holder election fields (migration 1032). */
  goalLeaseEpoch?: number | null;
  goalHandoffFromOwnerId?: string | null;
  goalHandoffExpiresAt?: string | null;
}

export interface SetModeOpts {
  workspaceId: string;
  /** The agent whose mode changes. */
  ownerId: string;
  modeId: string;
  /** false ⇒ exit the mode (clear its row if currently set). */
  enabled: boolean;
  reason: string;
  /** The caller (self-set when === ownerId). */
  setBy: string;
  /** The human owner explicitly instructed this — arms the sticky flag. */
  ownerDirected?: boolean;
  /**
   * The CALLER is a verified owner-authority channel even though this is a
   * peer-set (setBy !== ownerId) — e.g. the human's admin coord/mode UI
   * acting on the owner's behalf to set a mode on the agent session they're
   * chatting with (gui-chat-session-controls-2026-07-25 P-003/P-004). Set
   * ONLY by the tool layer after verifying the caller identity — never
   * derived from client-supplied args. Self-set already carries owner
   * authority implicitly; this widens it to that one additional verified
   * channel, not to arbitrary agent peers.
   */
  callerIsOwnerAuthority?: boolean;
  /**
   * WHAT this mode is about — see ModeRow.subject. Tri-state on purpose:
   *   undefined → leave the incumbent's subject untouched (a reason-only
   *               refresh must not silently erase which goal is running);
   *   null      → clear it explicitly;
   *   string    → set it.
   * Ignored when `enabled: false`, since clearing a mode deletes the row and
   * the subject cannot outlive the mode it parameterises.
   */
  subject?: string | null;
  /** Internal recovery CAS proof; never exposed as a client-supplied tool arg. */
  goalElectionExpectation?: GoalModeElectionExpectation;
  sql?: Sql;
}

/**
 * What the cascade did about ONE implied mode (D-003).
 *
 * Four outcomes, all reported rather than any being silent, because the whole
 * point of the mechanism is that the agent can SEE what it now holds:
 *   - `set`        — the axis was empty and this mode now occupies it;
 *   - `already-on` — the agent was already in it (an idempotent re-entry);
 *   - `axis-held`  — a DIFFERENT mode holds that axis and was left alone
 *                    (`by` names it: cold-auto satisfies "implies auto", and
 *                    replacing it with plain auto would be a downgrade nobody
 *                    asked for);
 *   - `skipped`    — refused on purpose; `error` says why.
 *   - `failed`     — the write errored; `error` carries it.
 */
export type ImpliedModeStatus = 'set' | 'already-on' | 'axis-held' | 'skipped' | 'failed';

export interface ImpliedModeOutcome {
  mode: string;
  status: ImpliedModeStatus;
  /** The mode occupying that axis instead — only on `axis-held`. */
  by?: string;
  error?: string;
}

export interface SetModeResult {
  ok: boolean;
  /** The write was refused because the incumbent is owner-directed and the caller is a peer. */
  stickyConflict?: boolean;
  /** The same-axis mode that was displaced by this set (auto-switch, D-006). */
  switchedFrom?: string | null;
  /** True when the write changed nothing (already in / already out). */
  noop?: boolean;
  mode?: ModeDef;
  /**
   * The modes this one IMPLIES and what became of each (D-003). Present on any
   * successful ENABLE of a mode that declares `implies` — including a `noop`
   * re-entry, which is deliberately how a missing implied row gets REPAIRED.
   */
  implied?: ImpliedModeOutcome[];
  /** Present only when this write elected a new effective GOAL holder. */
  goalElection?: GoalModeElectionReceipt;
  /** Present when a GOAL election was refused without writing or allocating an epoch. */
  goalElectionConflict?: GoalModeElectionConflict;
  error?: string;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

function toImpliedBy(value: unknown): ModeImplicationProvenance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as { mode?: unknown; subject?: unknown };
  if (typeof source.mode !== 'string' || source.mode.length === 0) return null;
  return {
    mode: source.mode,
    subject: typeof source.subject === 'string' ? source.subject : null,
  };
}

function toRow(r: Record<string, unknown>): ModeRow {
  return {
    workspaceId: String(r.workspace_id),
    ownerId: String(r.owner_id),
    axisKey: String(r.axis_key),
    mode: String(r.mode),
    reason: String(r.reason ?? ''),
    setBy: String(r.set_by ?? ''),
    ownerDirected: Boolean(r.owner_directed),
    setAt: r.set_at instanceof Date ? r.set_at.toISOString() : String(r.set_at),
    subject: r.subject == null || r.subject === '' ? null : String(r.subject),
    impliedBy: toImpliedBy(r.implied_by),
    goalLeaseEpoch:
      r.goal_lease_epoch == null || r.goal_lease_epoch === '' ? null : Number(r.goal_lease_epoch),
    goalHandoffFromOwnerId:
      r.goal_handoff_from_owner_id == null || r.goal_handoff_from_owner_id === ''
        ? null
        : String(r.goal_handoff_from_owner_id),
    goalHandoffExpiresAt:
      r.goal_handoff_expires_at == null || r.goal_handoff_expires_at === ''
        ? null
        : r.goal_handoff_expires_at instanceof Date
          ? r.goal_handoff_expires_at.toISOString()
          : String(r.goal_handoff_expires_at),
  };
}

/**
 * The subject of one specific mode, or null when the agent is not in it —
 * the read half of ModeRow.subject.
 *
 * Returns null rather than throwing for every "not applicable" case (unknown
 * mode id, not in the mode, in it with no subject) because every caller is a
 * STAMPING path: the correct behaviour when provenance cannot be resolved is
 * to write no stamp, never to fail the creation the stamp was decorating.
 */
export async function getModeSubject(
  workspaceId: string,
  ownerId: string,
  modeId: string,
  sql?: Sql,
): Promise<string | null> {
  const def = modeById(modeId);
  if (!def || !workspaceId || !ownerId) return null;
  const rows = await pg(sql)`
    SELECT subject FROM harness_shared.agent_modes
    WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
      AND axis_key = ${axisKeyFor(def)} AND mode = ${def.id}
    LIMIT 1`;
  const raw = rows.length ? (rows[0] as { subject?: unknown }).subject : null;
  return raw == null || raw === '' ? null : String(raw);
}

/** Current modes for one agent. */
export async function getModes(workspaceId: string, ownerId: string, sql?: Sql): Promise<ModeRow[]> {
  const rows = await pg(sql)`
    SELECT * FROM harness_shared.agent_modes
    WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
    ORDER BY axis_key`;
  return rows.map(toRow);
}

/** Current modes for many agents in one round-trip — the presence/orient fan-in. */
export async function getModesForOwners(
  workspaceId: string,
  ownerIds: readonly string[],
  sql?: Sql,
): Promise<Map<string, ModeRow[]>> {
  const out = new Map<string, ModeRow[]>();
  if (!ownerIds.length) return out;
  const rows = await pg(sql)`
    SELECT * FROM harness_shared.agent_modes
    WHERE workspace_id = ${workspaceId} AND owner_id IN ${pg(sql)(ownerIds as string[])}
    ORDER BY axis_key`;
  for (const r of rows) {
    const row = toRow(r);
    const list = out.get(row.ownerId) ?? [];
    list.push(row);
    out.set(row.ownerId, list);
  }
  return out;
}

async function audit(
  sql: Sql,
  o: {
    workspaceId: string;
    ownerId: string;
    axisKey: string;
    oldMode: string | null;
    newMode: string | null;
    reason: string;
    setBy: string;
    ownerDirected: boolean;
    /** Mode subject at this transition (the goal id for GOAL). */
    subject?: string | null;
    /**
     * The epoch a GOAL holder election minted (WI-10005240). This row is the
     * durable lease high-water: the election reads MAX over these rows as well
     * as the live agent_modes rows, so an epoch is never re-issued after its
     * holder's row is gone. Must be written in the election's transaction.
     */
    goalLeaseEpoch?: number | null;
  },
): Promise<void> {
  // New columns are appended LAST: positional readers of this VALUES list
  // (store.test.ts's mock) keep their meaning.
  await sql`
    INSERT INTO harness_shared.agent_mode_changes
      (workspace_id, owner_id, axis_key, old_mode, new_mode, reason, set_by, owner_directed,
       subject, goal_lease_epoch)
    VALUES (${o.workspaceId}, ${o.ownerId}, ${o.axisKey}, ${o.oldMode}, ${o.newMode},
            ${o.reason}, ${o.setBy}, ${o.ownerDirected},
            ${o.subject ?? null}, ${o.goalLeaseEpoch ?? null}::bigint)`;
}

/**
 * ── THE IMPLICATION CASCADE (D-003) ─────────────────────────────────────────
 *
 * [owner 2026-08-10, interactive: "make sure goal mode implies both auto and
 * ideate mode. Does that need to be added to the prompt or just part of the
 * system?"] — Both, but THIS is the real fix. The contract used to end with
 * "GOAL implies AUTO: if the autonomy axis is empty, also mode:set auto", i.e. an
 * instruction to the agent to perform a second call. A directive that depends on
 * an agent remembering to call a tool is exactly what gets dropped at a
 * compaction — and every guard downstream (`modeImpliesAutonomy`) meanwhile
 * treated the session as autonomous whether or not the row was ever written.
 *
 * WHY IT LIVES IN THE STORE AND NOT IN THE `mode:set` TOOL. Three doors enter a
 * mode — the tool, `goals:start` (which mints a GOAL agent before it is even
 * spawned), and `bootstrap-su.syncLaunchModeToRegistry` (the launch-flag sync) —
 * and only one of them is the tool. Putting the cascade one layer down means a
 * door cannot forget it, the same structural argument P-004's launch resolver
 * won: the reliable mechanism is the one no caller has to remember.
 *
 * FILL AN EMPTY AXIS, NEVER DISPLACE. Expressed as a single INSERT … ON CONFLICT
 * DO NOTHING rather than a read-then-`setMode`, for two reasons that are both
 * about correctness, not brevity:
 *   - ATOMIC. A check-then-write races another writer through the gap, and the
 *     ordinary upsert would then DISPLACE what it found. DO NOTHING cannot.
 *   - SEMANTICALLY DIFFERENT from `setMode`. "Enter this mode, replacing the
 *     same-axis incumbent" and "adopt this mode only if that axis is free" are
 *     genuinely different operations. cold-auto already satisfies "implies
 *     auto"; overwriting it with plain auto would silently downgrade a posture
 *     the agent (or owner) deliberately chose.
 *
 * NOT MIRRORED ON EXIT, on purpose. Leaving GOAL does not clear auto/ideate: the
 * agent may well have been in AUTO before it ever entered GOAL, and revoking a
 * posture the owner set independently is a destructive guess. The implication is
 * "entering this means entering those", not "these belong to me".
 */
async function applyImpliedModes(
  sql: Sql,
  o: {
    workspaceId: string;
    ownerId: string;
    modeId: string;
    reason: string;
    setBy: string;
    subject: string | null;
  },
): Promise<ImpliedModeOutcome[]> {
  const out: ImpliedModeOutcome[] = [];
  for (const id of resolveImpliedModes(o.modeId)) {
    const def = modeById(id);
    if (!def) continue; // unreachable — resolveImpliedModes drops unknown ids
    /* A mode that is ABOUT something cannot be implied: the cascade has no
       subject to give it, and entering it unattributed is the exact silent
       zeroing EI-20015592992797890 documents (work_items.goal_id stops stamping
       while every surface still looks healthy). Refuse loudly instead. The
       registry test asserts no such declaration exists, so this is the belt to
       that braces. */
    if (modeRequiresSubject(def.id)) {
      out.push({
        mode: def.id,
        status: 'skipped',
        error: `'${def.id}' requires a subject, which an implication cannot supply — declare it explicitly, not via implies`,
      });
      continue;
    }
    const axisKey = axisKeyFor(def);
    const reason = `implied by '${o.modeId}' — ${o.reason}`;
    /* An implied row is DERIVED posture, not a second owner instruction. The
       triggering mode may be owner-directed, but copying that bit would claim
       the owner explicitly directed every mode in the cascade and would arm
       the owner-sticky guard on rows the owner never named. */
    const impliedOwnerDirected = false;
    try {
      const inserted = await sql`
        INSERT INTO harness_shared.agent_modes
          (workspace_id, owner_id, axis_key, mode, reason, set_by, owner_directed, set_at, subject, implied_by)
        VALUES (${o.workspaceId}, ${o.ownerId}, ${axisKey}, ${def.id}, ${reason},
                ${o.setBy}, ${impliedOwnerDirected}, now(), ${null},
                ${JSON.stringify({ mode: o.modeId, subject: o.subject })}::jsonb)
        ON CONFLICT (workspace_id, owner_id, axis_key) DO NOTHING
        RETURNING mode`;
      if (inserted.length) {
        // Audited like any other transition: an implied entry is a real posture
        // change and must be as traceable as a hand-set one — "who put this
        // agent in AUTO" has to answer "the goal cascade", not nothing.
        await audit(sql, {
          workspaceId: o.workspaceId, ownerId: o.ownerId, axisKey,
          oldMode: null, newMode: def.id, reason, setBy: o.setBy, ownerDirected: impliedOwnerDirected,
        });
        out.push({ mode: def.id, status: 'set' });
        continue;
      }
      // The axis was already occupied. Read WHO for the report only — the write
      // decision above was already made atomically, so this cannot race into a
      // wrong action, only into a slightly stale label.
      const held = await sql`
        SELECT mode FROM harness_shared.agent_modes
        WHERE workspace_id = ${o.workspaceId} AND owner_id = ${o.ownerId} AND axis_key = ${axisKey}
        LIMIT 1`;
      const by = held.length ? String((held[0] as { mode: unknown }).mode) : null;
      out.push(
        by && by !== def.id
          ? { mode: def.id, status: 'axis-held', by }
          : { mode: def.id, status: 'already-on' },
      );
    } catch (e) {
      /* Return the failed leg. GOAL's outer transaction converts it into a
         rollback of the primary and implied rows; other modes keep their
         visible fail-soft behavior. */
      out.push({ mode: def.id, status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * Remove only posture rows derived from one exact source mode/subject pair.
 *
 * A direct mode write clears `implied_by`, so an independently chosen posture
 * cannot be mistaken for a stale cascade row. Matching the two provenance keys
 * rather than the whole JSON object leaves room for future provenance fields
 * without widening the cleanup to unrelated rows.
 */
export async function clearImpliedModes(o: {
  workspaceId: string;
  ownerId: string;
  source: ModeImplicationProvenance;
  reason: string;
  setBy: string;
  sql?: Sql;
}): Promise<string[]> {
  const sql = pg(o.sql);
  const rows = await sql<Array<{ axis_key: string; mode: string; owner_directed: boolean }>>`
    DELETE FROM harness_shared.agent_modes
    WHERE workspace_id = ${o.workspaceId}
      AND owner_id = ${o.ownerId}
      AND implied_by->>'mode' = ${o.source.mode}
      AND implied_by->>'subject' IS NOT DISTINCT FROM ${o.source.subject}
    RETURNING axis_key, mode, owner_directed`;
  for (const row of rows) {
    await audit(sql, {
      workspaceId: o.workspaceId,
      ownerId: o.ownerId,
      axisKey: String(row.axis_key),
      oldMode: String(row.mode),
      newMode: null,
      reason: o.reason,
      setBy: o.setBy,
      ownerDirected: Boolean(row.owner_directed),
    });
  }
  if (rows.length) await notifyAgentOrdersChanged(o.ownerId);
  return rows.map((row) => String(row.mode));
}

/**
 * `set_by` stamped on a row the RECONCILE created, so a backfilled row is
 * distinguishable from one the agent (or a human) authored.
 *
 * This marker and `implied_by` answer DIFFERENT questions and neither replaces
 * the other. `implied_by` (migration 1075) records WHICH mode/subject derived a
 * row, which is what makes retire-by-implication safe — see `clearImpliedModes`.
 * This one records WHO wrote it, the question a reader of the population
 * actually asks: "did the agent do this, or did the system?" A reconcile-created
 * row carries both; an agent's own cascade write carries only `implied_by`.
 * Grading depends on the distinction: goal-mode-e2e's
 * `mode-and-subject-integrity` reads these rows, and a backfilled row credited
 * to the agent would be evidence of compliance the agent never performed.
 */
export const RECONCILE_SET_BY = 'mode-implies-reconcile';

/**
 * ── THE RECONCILE (WI-37856) ────────────────────────────────────────────────
 *
 * The cascade above fires on the WRITE that enters a mode. Nothing revisits a
 * row written EARLIER — so an agent that entered a mode before that mode
 * declared an implication keeps a mode set the contract says is impossible,
 * with nothing failing loudly.
 *
 * MEASURED, not hypothesised (2026-08-10): `goal.implies` gained `auto`+`ideate`
 * at 10:57:46Z. All three agents bound to GOAL before that instant lack
 * `ideate`; one lacks `auto` too, i.e. it held a GOAL binding in ask-first
 * posture — the precise failure the "GOAL implies AUTO" clause exists to
 * prevent. Two of the three had hand-written `auto` themselves after reading the
 * contract text, which is the tell: the CONTRACT reached the agent while the
 * MECHANISM did not exist.
 *
 * WHY THIS IS NOT A ONE-OFF BACKFILL SCRIPT. `implies` is a registry field
 * designed to be edited. Every future edit re-opens the identical gap for every
 * agent already holding that mode, so the durable fix is a reconcile that any
 * door can call cheaply and repeatedly — not a migration that fixes today's
 * three rows and leaves the trap armed.
 *
 * IT REUSES THE CASCADE, deliberately. Re-implementing the fill here would mean
 * two places that must agree about "adopt this axis only if it is free", and the
 * one that runs rarely is the one that would silently drift into displacing a
 * posture the owner chose. Reusing `applyImpliedModes` means the never-displace
 * property, the subject-requiring refusal, and the audit row are the SAME code
 * that the write path proves on every call. Consequences worth stating:
 *   - IDEMPOTENT. Every fill is INSERT … ON CONFLICT DO NOTHING, so a second run
 *     writes nothing and reports `already-on`. Safe on a hot path.
 *   - NEVER DISPLACES. A deliberately-chosen `cold-auto` still satisfies
 *     "implies auto" and is left exactly as it is.
 *   - DERIVED rows never inherit `ownerDirected` from the row that implies
 *     them: an owner-directed GOAL does not mean the owner explicitly named
 *     AUTO or IDEATE. If an implied posture needs sticky protection, that is a
 *     separate policy from the provenance bit and must be represented as such.
 *
 * NOT MIRRORED ON EXIT, for the same reason the cascade is not (see above).
 */
export async function reconcileImpliedModes(o: {
  workspaceId: string;
  ownerId: string;
  /** Override the provenance marker; defaults to {@link RECONCILE_SET_BY}. */
  setBy?: string;
  sql?: Sql;
}): Promise<ImpliedModeOutcome[]> {
  const sql = pg(o.sql);
  /* Snapshot first: the loop below inserts, and iterating a live read while
     writing to it is how a reconcile becomes order-dependent. */
  const held = await getModes(o.workspaceId, o.ownerId, sql);
  const out: ImpliedModeOutcome[] = [];
  for (const row of held) {
    if (!resolveImpliedModes(row.mode).length) continue;
    out.push(
      ...(await applyImpliedModes(sql, {
        workspaceId: o.workspaceId,
        ownerId: o.ownerId,
        modeId: row.mode,
        reason: `reconciled: '${row.mode}' was already held when its implications were declared`,
        setBy: o.setBy ?? RECONCILE_SET_BY,
        subject: row.subject,
      })),
    );
  }
  return out;
}

/**
 * Write one mode row. A NEW GOAL subject assignment is also the election:
 * one statement takes a workspace+goal advisory lock, reads the prior elected
 * epoch, upserts the successor, and returns the bounded handoff receipt. The
 * row can therefore never become visible as the new holder without its epoch.
 *
 * Same-owner/same-goal reason refreshes use the ordinary upsert so they retain
 * their epoch and cannot steal sovereignty merely by reasserting the mode.
 */
async function writeModeRow(
  sql: Sql,
  o: {
    workspaceId: string;
    ownerId: string;
    axisKey: string;
    mode: string;
    reason: string;
    setBy: string;
    ownerDirected: boolean;
    subject: string | null;
    impliedBy: ModeImplicationProvenance | null;
    electGoal: boolean;
    callerIsOwnerAuthority: boolean;
    goalElectionExpectation?: GoalModeElectionExpectation;
  },
): Promise<{
  election: GoalModeElectionReceipt | null;
  conflict: GoalModeElectionConflict | null;
}> {
  if (!o.electGoal || !o.subject) {
    await sql`
      INSERT INTO harness_shared.agent_modes
        (workspace_id, owner_id, axis_key, mode, reason, set_by, owner_directed, set_at, subject, implied_by)
      VALUES (${o.workspaceId}, ${o.ownerId}, ${o.axisKey}, ${o.mode}, ${o.reason},
              ${o.setBy}, ${o.ownerDirected}, now(), ${o.subject},
              ${o.impliedBy ? JSON.stringify(o.impliedBy) : null}::jsonb)
      ON CONFLICT (workspace_id, owner_id, axis_key) DO UPDATE SET
        mode = EXCLUDED.mode, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by,
        owner_directed = EXCLUDED.owner_directed, set_at = EXCLUDED.set_at,
        subject = EXCLUDED.subject, implied_by = EXCLUDED.implied_by`;
    return { election: null, conflict: null };
  }

  type ElectionRow = {
      applied: boolean;
      owner_id: string;
      subject: string;
      goal_lease_epoch: string | number | null;
      goal_handoff_from_owner_id: string | null;
      goal_handoff_expires_at: Date | string | null;
      elected_owner_id: string | null;
      elected_epoch: string | number | null;
    };
  const elect = async (tx: Sql): Promise<ElectionRow | undefined> => {
    // Separate command inside one transaction is load-bearing. An advisory
    // lock embedded in the election statement would wait with the statement's
    // OLD READ-COMMITTED snapshot, so two simultaneous first entrants could
    // both miss the winner that committed while the second waited.
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${o.workspaceId}\u001f${o.subject}`}, 0)
      )`;
    const [electionRow] = await tx<Array<ElectionRow>>`
    WITH input AS MATERIALIZED (
      SELECT ${o.workspaceId}::text AS workspace_id,
             ${o.ownerId}::text AS owner_id,
             ${o.axisKey}::text AS axis_key,
             ${o.mode}::text AS mode,
             ${o.reason}::text AS reason,
             ${o.setBy}::text AS set_by,
             ${o.ownerDirected}::boolean AS owner_directed,
             ${o.subject}::text AS subject,
             ${o.impliedBy ? JSON.stringify(o.impliedBy) : null}::jsonb AS implied_by,
             ${o.callerIsOwnerAuthority}::boolean AS caller_is_owner_authority,
             ${o.goalElectionExpectation?.ownerId ?? null}::text AS expected_owner_id,
             ${o.goalElectionExpectation?.epoch ?? null}::bigint AS expected_epoch,
             ${GOAL_HOLDER_HANDOFF_SECONDS}::integer AS handoff_seconds
    ),
    predecessor AS MATERIALIZED (
      SELECT am.owner_id, am.goal_lease_epoch
        FROM harness_shared.agent_modes am
        CROSS JOIN input
       WHERE am.workspace_id = input.workspace_id
         AND am.mode = ${GOAL_MODE}
         AND am.subject = input.subject
       ORDER BY am.goal_lease_epoch DESC NULLS LAST, am.set_at DESC, am.owner_id ASC
       LIMIT 1
    ),
    election_auth AS MATERIALIZED (
      SELECT predecessor.owner_id AS elected_owner_id,
             predecessor.goal_lease_epoch AS elected_epoch,
             predecessor.owner_id IS NULL
             OR input.caller_is_owner_authority
             OR predecessor.owner_id = input.set_by
             OR (
               input.expected_owner_id IS NOT NULL
               AND predecessor.owner_id = input.expected_owner_id
               AND predecessor.goal_lease_epoch IS NOT DISTINCT FROM input.expected_epoch
             ) AS authorized
        FROM input
        LEFT JOIN predecessor ON true
    ),
    -- WI-10005240: the high-water is the MAX over LIVE rows AND the election
    -- history. Live rows alone re-issue an exited holder's epoch to the next
    -- elected owner, so the fencing token repeats. The history row for every
    -- election is written in this same transaction (setModeCore's audit), under
    -- the advisory lock taken above.
    next_epoch AS MATERIALIZED (
      SELECT GREATEST(
               COALESCE((SELECT MAX(am.goal_lease_epoch)
                           FROM harness_shared.agent_modes am
                          WHERE am.workspace_id = input.workspace_id
                            AND am.mode = ${GOAL_MODE}
                            AND am.subject = input.subject), 0),
               COALESCE((SELECT MAX(c.goal_lease_epoch)
                           FROM harness_shared.agent_mode_changes c
                          WHERE c.workspace_id = input.workspace_id
                            AND c.subject = input.subject
                            AND c.goal_lease_epoch IS NOT NULL), 0)
             ) + 1 AS epoch
        FROM input
    ),
    inserted AS (
    INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, axis_key, mode, reason, set_by, owner_directed, set_at, subject,
       implied_by, goal_lease_epoch, goal_handoff_from_owner_id, goal_handoff_expires_at)
    SELECT input.workspace_id, input.owner_id, input.axis_key, input.mode, input.reason,
           input.set_by, input.owner_directed, now(), input.subject,
           input.implied_by,
           next_epoch.epoch, election_auth.elected_owner_id,
           CASE WHEN election_auth.elected_owner_id IS NULL THEN NULL
                ELSE now() + make_interval(secs => input.handoff_seconds) END
      FROM input
      CROSS JOIN next_epoch
      CROSS JOIN election_auth
     WHERE election_auth.authorized
    ON CONFLICT (workspace_id, owner_id, axis_key) DO UPDATE SET
      mode = EXCLUDED.mode, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by,
      owner_directed = EXCLUDED.owner_directed, set_at = EXCLUDED.set_at,
      subject = EXCLUDED.subject, implied_by = EXCLUDED.implied_by,
      goal_lease_epoch = EXCLUDED.goal_lease_epoch,
      goal_handoff_from_owner_id = EXCLUDED.goal_handoff_from_owner_id,
      goal_handoff_expires_at = EXCLUDED.goal_handoff_expires_at
    RETURNING owner_id, subject, goal_lease_epoch,
              goal_handoff_from_owner_id, goal_handoff_expires_at
    )
    SELECT true AS applied, inserted.owner_id, inserted.subject,
           inserted.goal_lease_epoch, inserted.goal_handoff_from_owner_id,
           inserted.goal_handoff_expires_at,
           NULL::text AS elected_owner_id, NULL::bigint AS elected_epoch
      FROM inserted
    UNION ALL
    SELECT false AS applied, input.owner_id, input.subject,
           NULL::bigint AS goal_lease_epoch, NULL::text AS goal_handoff_from_owner_id,
           NULL::timestamptz AS goal_handoff_expires_at,
           election_auth.elected_owner_id, election_auth.elected_epoch
      FROM input
      CROSS JOIN election_auth
     WHERE NOT election_auth.authorized
    LIMIT 1`;
    return electionRow;
  };

  type BeginCapableSql = {
    begin: <T>(callback: (tx: Sql) => Promise<T>) => Promise<T>;
  };
  const beginSql = sql as unknown as Partial<BeginCapableSql>;
  const row =
    typeof beginSql.begin === 'function'
      ? await beginSql.begin(async (tx) => await elect(tx))
      : await elect(sql);

  if (!row) throw new Error(`GOAL holder election wrote no row for ${o.workspaceId}:${o.subject}`);
  if (!row.applied) {
    if (!row.elected_owner_id) {
      throw new Error(`GOAL holder election refusal omitted elected owner for ${o.workspaceId}:${o.subject}`);
    }
    return {
      election: null,
      conflict: {
        goalId: row.subject,
        electedOwnerId: row.elected_owner_id,
        electedEpoch: row.elected_epoch == null ? null : Number(row.elected_epoch),
      },
    };
  }
  return {
    election: {
      ownerId: row.owner_id,
      goalId: row.subject,
      epoch: Number(row.goal_lease_epoch),
      predecessorOwnerId: row.goal_handoff_from_owner_id,
      handoffExpiresAt:
        row.goal_handoff_expires_at == null
          ? null
          : row.goal_handoff_expires_at instanceof Date
            ? row.goal_handoff_expires_at.toISOString()
            : String(row.goal_handoff_expires_at),
    },
    conflict: null,
  };
}

/**
 * Apply one mode transition with the axis + sticky semantics. See module doc.
 * All-or-nothing per call; never throws for semantic refusals (returns
 * stickyConflict / error), only for infrastructure failures.
 */
/** GOAL's primary row and implication cascade are one database transition. */
export async function setMode(opts: SetModeOpts): Promise<SetModeResult> {
  const def = modeById(opts.modeId);
  if (def?.id !== GOAL_MODE || !opts.enabled) return setModeCore(opts);
  const sql = pg(opts.sql);
  type BeginCapableSql = { begin: <T>(callback: (tx: Sql) => Promise<T>) => Promise<T> };
  const beginSql = sql as unknown as Partial<BeginCapableSql>;
  const expected = resolveImpliedModes(def.id);
  const complete = (result: SetModeResult): boolean =>
    !result.ok || expected.every((id) =>
      result.implied?.some((entry) => entry.mode === id && entry.status !== 'failed' && entry.status !== 'skipped'),
    );
  const failure = (result: SetModeResult): string =>
    expected.map((id) => {
      const entry = result.implied?.find((candidate) => candidate.mode === id);
      return !entry || entry.status === 'failed' || entry.status === 'skipped'
        ? `${id}: ${entry?.error ?? entry?.status ?? 'missing from cascade'}`
        : null;
    }).filter((entry): entry is string => entry !== null).join('; ');

  if (typeof beginSql.begin === 'function') {
    let result: SetModeResult;
    try {
      result = await beginSql.begin(async (tx) => {
        const applied = await setModeCore({ ...opts, sql: tx }, { deferNotify: true });
        if (!complete(applied)) throw new Error(failure(applied));
        return applied;
      });
    } catch (error) {
      return { ok: false, mode: def, error: `goal_mode_implication_failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (result.ok && (!result.noop || result.implied?.some((entry) => entry.status === 'set'))) {
      await notifyAgentOrdersChanged(opts.ownerId);
    }
    return result;
  }
  // A caller-supplied Sql without begin is already a transaction tag. Let its
  // owner roll back a failed cascade; a root connection without begin cannot
  // establish the required atomicity and must refuse before writing anything.
  if (!opts.sql) return { ok: false, mode: def, error: 'goal_mode_atomicity_unavailable' };
  const result = await setModeCore(opts, { deferNotify: true });
  if (!complete(result)) throw new Error(`goal_mode_implication_failed: ${failure(result)}`);
  if (result.ok && (!result.noop || result.implied?.some((entry) => entry.status === 'set'))) {
    await notifyAgentOrdersChanged(opts.ownerId);
  }
  return result;
}

async function setModeCore(opts: SetModeOpts, control: { deferNotify?: boolean } = {}): Promise<SetModeResult> {
  const def = modeById(opts.modeId);
  if (!def) return { ok: false, error: `unknown mode '${opts.modeId}'` };
  const sql = pg(opts.sql);
  // The same identity cannot own a GOAL and judge it. Put the refusal at the
  // store boundary so mode:set, bootstrap and admin writes agree.
  if (opts.enabled && (def.id === 'goal' || def.id === 'grade' || def.id === 'test')) {
    const active = await getModes(opts.workspaceId, opts.ownerId, sql);
    const conflicts = def.id === 'goal'
      ? active.some((row) => row.mode === 'grade' || row.mode === 'test')
      : active.some((row) => row.mode === 'goal');
    if (conflicts) return { ok: false, mode: def, error: 'goal_holder_self_verification_refused' };
  }
  const axisKey = axisKeyFor(def);
  const isSelf = opts.setBy === opts.ownerId;
  // Only a genuine self-set, or a tool-layer-VERIFIED owner-authority caller,
  // may arm/hold the sticky flag — an ordinary agent peer cannot, no matter
  // what it claims via opts.ownerDirected.
  const ownerAuthorized = isSelf || Boolean(opts.callerIsOwnerAuthority);
  const ownerDirected = Boolean(opts.ownerDirected) && ownerAuthorized;

  const existing = await sql`
    SELECT * FROM harness_shared.agent_modes
    WHERE workspace_id = ${opts.workspaceId} AND owner_id = ${opts.ownerId} AND axis_key = ${axisKey}`;
  const incumbent = existing.length ? toRow(existing[0] as Record<string, unknown>) : null;

  // OWNER-STICKY (D-003): a caller without owner authority cannot change an
  // owner-directed incumbent (neither replace it nor clear it) — regardless
  // of what `ownerDirected` it CLAIMS (an unauthorized peer's claim is never
  // honored — see `ownerAuthorized` above). Self, and a verified
  // owner-authority write (e.g. the admin UI, P-003), pass.
  if (incumbent?.ownerDirected && !ownerAuthorized) {
    return { ok: false, stickyConflict: true, mode: def, switchedFrom: incumbent.mode };
  }

  if (!opts.enabled) {
    if (!incumbent || incumbent.mode !== def.id) return { ok: true, noop: true, mode: def };
    await sql`
      DELETE FROM harness_shared.agent_modes
      WHERE workspace_id = ${opts.workspaceId} AND owner_id = ${opts.ownerId} AND axis_key = ${axisKey}`;
    await audit(sql, {
      workspaceId: opts.workspaceId, ownerId: opts.ownerId, axisKey,
      oldMode: incumbent.mode, newMode: null, reason: opts.reason, setBy: opts.setBy, ownerDirected,
      // WI-10005573: the cleared row's subject. Without it a GOAL retire row cannot
      // say WHICH goal its owner stopped holding, and former-holder selection by
      // subject (holder-handoff.ts) silently misses every pre-subject holder.
      subject: incumbent.subject,
    });
    // WI-6974: a mode CLEAR changes what this agent was told, so push the Orders
    // panel for this owner. Reached only past the `noop` guard above, so the push
    // tracks real transitions — the thing a row trigger on agent_modes could not do.
    if (!control.deferNotify) await notifyAgentOrdersChanged(opts.ownerId);
    return { ok: true, mode: def, switchedFrom: null };
  }

  // `subject` is tri-state (see SetModeOpts): undefined preserves whatever the
  // incumbent had, so a reason-only refresh cannot silently erase which goal a
  // session is running. On an auto-switch to a DIFFERENT mode there is no
  // subject to preserve — the incumbent's belonged to the mode being displaced.
  const nextSubject =
    opts.subject !== undefined
      ? opts.subject
      : incumbent?.mode === def.id
        ? incumbent.subject
        : null;

  if (incumbent?.mode === def.id) {
    // Already in this mode — refresh reason/sticky/subject only if they changed.
    // subject MUST be part of this comparison: without it, re-asserting GOAL
    // mode with a new goal id would short-circuit as a noop and leave every
    // subsequent work-item stamped with the PREVIOUS goal — a silently wrong
    // stamp, which is worse than no stamp at all.
    if (
      incumbent.ownerDirected === ownerDirected &&
      incumbent.reason === opts.reason &&
      incumbent.subject === nextSubject &&
      incumbent.impliedBy === null
    ) {
      /* D-003: a NOOP re-entry still cascades, and that is the point — this is
         how a missing implied row gets REPAIRED. An agent whose auto row was
         cleared by a peer (or a wipe) re-asserts GOAL and gets the posture back;
         if the cascade were gated on "something changed", the one call an agent
         would naturally make to fix it would be the one call that does nothing. */
      const implied = await applyImpliedModes(sql, {
        workspaceId: opts.workspaceId, ownerId: opts.ownerId, modeId: def.id,
        reason: opts.reason, setBy: opts.setBy, subject: nextSubject,
      });
      if (implied.some((i) => i.status === 'set') && !control.deferNotify) await notifyAgentOrdersChanged(opts.ownerId);
      return { ok: true, noop: true, mode: def, ...(implied.length ? { implied } : {}) };
    }
  }

  const goalWrite = await writeModeRow(sql, {
    workspaceId: opts.workspaceId,
    ownerId: opts.ownerId,
    axisKey,
    mode: def.id,
    reason: opts.reason,
    setBy: opts.setBy,
    ownerDirected,
    subject: nextSubject,
    impliedBy: null,
    // A first assignment or a move to ANOTHER goal elects. A reason/sticky
    // refresh on the same subject preserves the existing epoch and cannot
    // silently take sovereignty back from a later successor.
    electGoal:
      def.id === GOAL_MODE &&
      Boolean(nextSubject) &&
      !(incumbent?.mode === GOAL_MODE && incumbent.subject === nextSubject),
    callerIsOwnerAuthority: Boolean(opts.callerIsOwnerAuthority),
    ...(opts.goalElectionExpectation
      ? { goalElectionExpectation: opts.goalElectionExpectation }
      : {}),
  });
  if (goalWrite.conflict) {
    return {
      ok: false,
      mode: def,
      goalElectionConflict: goalWrite.conflict,
      error:
        `goal '${goalWrite.conflict.goalId}' is already elected to ` +
        `${goalWrite.conflict.electedOwnerId} at epoch ${goalWrite.conflict.electedEpoch ?? 'legacy'}; ` +
        'this transition carried neither current-holder/owner authority nor a matching recovery lease',
    };
  }
  await audit(sql, {
    workspaceId: opts.workspaceId, ownerId: opts.ownerId, axisKey,
    oldMode: incumbent?.mode ?? null, newMode: def.id, reason: opts.reason, setBy: opts.setBy, ownerDirected,
    subject: nextSubject ?? null,
    // WI-10005240: the minted epoch becomes the durable lease high-water.
    goalLeaseEpoch: goalWrite.election?.epoch ?? null,
  });
  // D-003: applied BEFORE the orders notify below, so the single push carries the
  // whole posture — the primary mode and everything it implied — rather than the
  // UI briefly rendering an agent in GOAL with an empty autonomy axis.
  const implied = await applyImpliedModes(sql, {
    workspaceId: opts.workspaceId, ownerId: opts.ownerId, modeId: def.id,
    reason: opts.reason, setBy: opts.setBy, subject: nextSubject,
  });
  // WI-6974: same as the clear branch — a set / auto-switch / reason-refresh is a
  // real orders change for THIS owner. Both `noop` early-returns above are already
  // past, so this never fires on a re-assert that wrote nothing.
  if (!control.deferNotify) await notifyAgentOrdersChanged(opts.ownerId);
  const switchedFrom = incumbent && incumbent.mode !== def.id ? incumbent.mode : null;
  return {
    ok: true,
    mode: def,
    switchedFrom,
    ...(implied.length ? { implied } : {}),
    ...(goalWrite.election ? { goalElection: goalWrite.election } : {}),
  };
}
