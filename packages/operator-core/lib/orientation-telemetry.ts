/**
 * ORIENTATION REACH + ACTION TELEMETRY — the "measure first" instrument (P-020).
 *
 * Plan: turn-start-memory-two-class-2026-09-21.
 *
 * WHY. D-003 admits a class to turn-start by the ACTOR TEST: a field belongs
 * there only if an agent would do something different on reading it. When
 * P-017 withdrew the improvement-triage line that test was applied by
 * JUDGEMENT — the line was compared against a HUD diff and argued about. This
 * module makes the next such call, in either direction, an evidence call:
 *
 *   REACH  — how often did a class actually reach an agent?
 *   ACTION — for a class-B (obligation) row, how many turns did it stay
 *            outstanding before it was dispositioned?
 *
 * ⚠ THE TWO HALVES ARE MEASURED FROM DIFFERENT SOURCES, AND SWAPPING THEM IS
 * THE MISTAKE THIS COMMENT EXISTS TO PREVENT.
 *
 *   • REACH is read from the COMPOSED BLOCK — the lines that survived the outer
 *     character budget. A class projected every turn and truncated away every
 *     turn reached nobody, and reporting it as reach would make a starved class
 *     look healthy, which is the opposite of what the actor test needs.
 *
 *   • ACTION is read from the RESOLVED STATE — every obligation row the
 *     resolver produced, truncated or not. An obligation is discharged by
 *     DISPOSITION, not by delivery (D-001, P-002's re-inject policy), so a row
 *     the budget dropped is still outstanding and its clock must keep running.
 *
 * DISPOSITION IS OBSERVED AS DISAPPEARANCE. Class B is re-injected EVERY turn
 * until dispositioned, so the turn a row stops appearing IS its disposition.
 * That is why nothing here hooks orders:resolve-pending, work_items:*, or any
 * future disposition verb: a new obligation source is measured the day it
 * lands rather than the day someone remembers to instrument it. The cost of
 * that choice is stated honestly in {@link ORIENTATION_ACTION_MEASURABLE} —
 * a class with no per-row identity cannot be measured this way, and the read
 * says so instead of reporting a zero.
 *
 * POSTURE: best-effort, never-throws, mirroring memory/session-epoch-ledger.
 * A missing relation (migration 1192 not applied yet) caches as a process-wide
 * no-op, so an un-migrated host degrades to NO telemetry rather than to a
 * failed turn. Telemetry must never be able to cost an agent its orientation.
 */

import type { SqlTag } from './memory/bump-last-surfaced';
import type { OrientationState } from './turn-start-orientation';

/**
 * The reach threshold at which a class that has never caused an action is
 * FLAGGED (P-020's guard: "renders for 500 turns with zero dispositions is
 * flagged, not silently kept").
 *
 * A flag is a prompt to re-argue the class, never an auto-removal: the actor
 * test is a judgement about what an agent WOULD do, and this instrument can
 * only show what it DID. 500 is the item's number.
 */
export const ORIENTATION_ZERO_ACTION_FLAG_TURNS = 500;

/**
 * The CLASS-B classes, and how each one's rows are identified.
 *
 * ⚠ THIS IS NOT "every class that looks important". It is exactly the set
 * whose rows carry a STABLE PER-ROW IDENTITY, because disappearance-as-
 * disposition needs to tell "this row is gone" from "this row was re-worded".
 * A carry row key exists for precisely that reason (P-013), and a class
 * without such a key would report a re-wording as a disposition — a fabricated
 * action signal, which is strictly worse than no signal at all.
 *
 * unansweredDirected is included at a SYNTHETIC single-row grain because the
 * state carries a COUNT, not rows. Its one key measures turns-until-the-inbox-
 * was-cleared, which is the honest action signal available at that grain; the
 * read labels it so nobody mistakes it for per-message timing.
 */
export const ORIENTATION_ACTION_MEASURABLE = {
  ownerDirectives: 'the directive record id',
  openChecks: 'the carry-row key (OrientationOpenCheck.id)',
  obligations: 'the obligation-agenda entry id (AgentObligation.id)',
  unansweredDirected: 'SYNTHETIC single row — the state carries a count, not rows',
} as const satisfies Partial<Record<keyof OrientationState, string>>;

export type OrientationActionClassId = keyof typeof ORIENTATION_ACTION_MEASURABLE;

/** One class-B row present in the resolved state this turn. */
export interface ObligationTelemetryRow {
  readonly classId: OrientationActionClassId;
  /** Stable identity WITHIN the class. Never the rendered text. */
  readonly rowKey: string;
}

/**
 * PURE: the class-B rows outstanding in this state, and which class-B classes
 * were actually EVALUATED.
 *
 * ⚠ evaluatedClasses is the half that keeps the disposition signal honest, and
 * it is easy to omit. A class whose source FAILED resolves to `undefined` —
 * distinct from a class that resolved EMPTY (an empty array / null), a
 * distinction the state type already draws and fingerprintOrientation already
 * relies on. Without it, one failed provider read would look exactly like
 * "every obligation of that class was dispositioned this turn" and would
 * silently write a fleet-wide burst of fake actions into the ledger. So a
 * class is closed against only when we can say we looked.
 */
export function selectObligationTelemetry(state: OrientationState): {
  rows: ObligationTelemetryRow[];
  evaluatedClasses: OrientationActionClassId[];
} {
  const rows: ObligationTelemetryRow[] = [];
  const evaluated: OrientationActionClassId[] = [];

  if (state.ownerDirectives !== undefined) {
    evaluated.push('ownerDirectives');
    for (const d of state.ownerDirectives ?? []) {
      rows.push({ classId: 'ownerDirectives', rowKey: String(d.id) });
    }
  }

  if (state.openChecks !== undefined) {
    evaluated.push('openChecks');
    for (const c of state.openChecks ?? []) {
      if (c.id) rows.push({ classId: 'openChecks', rowKey: c.id });
    }
  }

  if (state.obligations !== undefined) {
    evaluated.push('obligations');
    // `primary` is the RANKED ACTIONABLE set, not `evaluations`: a satisfied or
    // not-applicable control is not an obligation the agent is carrying, so
    // counting it would dilute exactly the number this instrument is for.
    for (const o of state.obligations?.primary ?? []) {
      if (o.id) rows.push({ classId: 'obligations', rowKey: o.id });
    }
  }

  // Always evaluated: a required number, never optional.
  evaluated.push('unansweredDirected');
  if (state.unansweredDirected > 0) {
    rows.push({ classId: 'unansweredDirected', rowKey: 'directed-awaiting-reply' });
  }

  return { rows, evaluatedClasses: evaluated };
}

/** What one turn contributed, as handed to {@link recordOrientationTurn}. */
export interface OrientationTurnObservation {
  readonly workspaceId: string;
  readonly ownerId: string;
  /** The OrientationSink these rows were rendered for. */
  readonly sink: string;
  /**
   * Lines that SURVIVED the budget, per class. Read from the composed block —
   * see the source-asymmetry warning in this module's header.
   */
  readonly renderedRowsByClass: ReadonlyMap<string, number>;
  readonly obligationRows: readonly ObligationTelemetryRow[];
  readonly evaluatedClasses: readonly string[];
}

let relationMissing = false;

function noteMissingRelation(err: unknown): void {
  const msg = (err as Error)?.message ?? '';
  if (/relation .* does not exist/.test(msg) || msg.includes('orientation_class_')) {
    relationMissing = true;
  }
}

/** Test seam: re-arm the process-wide no-op latch. */
export function resetOrientationTelemetryLatchForTest(): void {
  relationMissing = false;
}

/**
 * Record ONE turn. Best-effort: every failure is swallowed, because a telemetry
 * write must never be able to cost an agent its orientation block.
 *
 * Three statements, each set-based over UNNEST rather than per-row, because
 * this runs inside the 2.5s orientation wall on EVERY turn and an owner can
 * legitimately carry ~20 open checks — a per-row loop would spend the wall on
 * bookkeeping.
 */
export async function recordOrientationTurn(
  sql: SqlTag,
  obs: OrientationTurnObservation,
): Promise<void> {
  if (relationMissing) return;
  if (!obs.workspaceId || !obs.ownerId) return;
  try {
    const classIds = [...obs.renderedRowsByClass.keys()];
    const rowCounts = classIds.map((c) => obs.renderedRowsByClass.get(c) ?? 0);

    if (classIds.length > 0) {
      await sql`
        INSERT INTO harness_shared.orientation_class_reach AS r
          (workspace_id, owner_id, sink, class_id, turns_rendered, rows_rendered)
        SELECT ${obs.workspaceId}, ${obs.ownerId}, ${obs.sink}, c.class_id, 1, c.rows
          FROM UNNEST(${classIds}::text[], ${rowCounts}::bigint[]) AS c(class_id, rows)
        ON CONFLICT (workspace_id, owner_id, sink, class_id) DO UPDATE
          SET turns_rendered   = r.turns_rendered + 1,
              rows_rendered    = r.rows_rendered + EXCLUDED.rows_rendered,
              last_rendered_at = now()`;
    }

    const obligationClassIds = obs.obligationRows.map((r) => r.classId as string);
    const obligationKeys = obs.obligationRows.map((r) => r.rowKey);

    if (obligationClassIds.length > 0) {
      await sql`
        INSERT INTO harness_shared.orientation_obligation_action AS a
          (workspace_id, owner_id, class_id, row_key, turns_outstanding)
        SELECT ${obs.workspaceId}, ${obs.ownerId}, x.class_id, x.row_key, 1
          FROM UNNEST(${obligationClassIds}::text[], ${obligationKeys}::text[]) AS x(class_id, row_key)
        ON CONFLICT (workspace_id, owner_id, class_id, row_key) DO UPDATE
          -- A key that REAPPEARS after disposition opens a NEW episode: its
          -- clock restarts at 1 and the disposition stamp clears. A directive
          -- re-raised after being dismissed is a second obligation, not one
          -- long unresolved one, and folding them would inflate every median.
          SET turns_outstanding = CASE WHEN a.dispositioned_at IS NULL
                                       THEN a.turns_outstanding + 1 ELSE 1 END,
              first_seen_at     = CASE WHEN a.dispositioned_at IS NULL
                                       THEN a.first_seen_at ELSE now() END,
              dispositioned_at  = NULL,
              last_seen_at      = now()`;
    }

    const evaluated = [...obs.evaluatedClasses];
    if (evaluated.length > 0) {
      await sql`
        UPDATE harness_shared.orientation_obligation_action AS a
           SET dispositioned_at     = now(),
               turns_to_disposition = a.turns_outstanding,
               dispositions         = a.dispositions + 1
         WHERE a.workspace_id = ${obs.workspaceId}
           AND a.owner_id = ${obs.ownerId}
           AND a.dispositioned_at IS NULL
           -- Only classes we actually LOOKED at this turn — see
           -- selectObligationTelemetry's evaluatedClasses warning.
           AND a.class_id = ANY(${evaluated}::text[])
           AND NOT EXISTS (
                 SELECT 1
                   FROM UNNEST(${obligationClassIds}::text[], ${obligationKeys}::text[])
                     AS p(class_id, row_key)
                  WHERE p.class_id = a.class_id AND p.row_key = a.row_key)`;
    }
  } catch (err) {
    noteMissingRelation(err);
  }
}

/** One class's measured reach and (where measurable) action. */
export interface OrientationClassTelemetry {
  readonly classId: string;
  readonly turnsRendered: number;
  readonly rowsRendered: number;
  readonly meanRowsPerTurn: number | null;
  readonly firstRenderedAt: string | null;
  readonly lastRenderedAt: string | null;
  /**
   * FALSE is a statement about the INSTRUMENT, not about the class. A delta
   * (class-A) class has no disposition event to observe, so `dispositions`
   * is null rather than 0 — reporting 0 would make every healthy delta class
   * trip the 500-turn guard, and a guard that fires on a dozen classes
   * forever is a guard everyone learns to ignore.
   */
  readonly actionMeasurable: boolean;
  readonly unmeasuredReason: string | null;
  readonly dispositions: number | null;
  readonly openRows: number | null;
  readonly medianTurnsToDisposition: number | null;
  readonly flagged: boolean;
  readonly flagReason: string | null;
}

export interface OrientationTelemetryRead {
  readonly observedAt: string;
  readonly sink: string;
  readonly flagThresholdTurns: number;
  readonly classes: readonly OrientationClassTelemetry[];
  readonly flagged: readonly string[];
  /** Null ⇒ measured. Non-null ⇒ the read could not run; NOT "no telemetry". */
  readonly unavailableReason: string | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * The READ (P-020: "expose as a read … no dashboard").
 *
 * Returns unavailableReason rather than an empty class list when it cannot
 * measure: "no rows" and "could not read" prescribe opposite actions, and a
 * zero-reach class list is exactly the evidence someone would remove a class
 * on.
 */
export async function readOrientationTelemetry(
  sql: SqlTag,
  input: { workspaceId: string; sink?: string },
): Promise<OrientationTelemetryRead> {
  const sink = input.sink ?? 'turn-start';
  const observedAt = new Date().toISOString();
  const base = {
    observedAt,
    sink,
    flagThresholdTurns: ORIENTATION_ZERO_ACTION_FLAG_TURNS,
  };
  try {
    const reach = (await sql`
      SELECT class_id,
             SUM(turns_rendered)::bigint  AS turns_rendered,
             SUM(rows_rendered)::bigint   AS rows_rendered,
             MIN(first_rendered_at)       AS first_rendered_at,
             MAX(last_rendered_at)        AS last_rendered_at
        FROM harness_shared.orientation_class_reach
       WHERE workspace_id = ${input.workspaceId} AND sink = ${sink}
       GROUP BY class_id`) as unknown as Array<Record<string, unknown>>;

    const action = (await sql`
      SELECT class_id,
             SUM(dispositions)::bigint AS dispositions,
             COUNT(*) FILTER (WHERE dispositioned_at IS NULL)::bigint AS open_rows,
             ARRAY_REMOVE(ARRAY_AGG(turns_to_disposition), NULL) AS settled
        FROM harness_shared.orientation_obligation_action
       WHERE workspace_id = ${input.workspaceId}
       GROUP BY class_id`) as unknown as Array<Record<string, unknown>>;

    const actionByClass = new Map(action.map((r) => [String(r.class_id), r]));
    const classes: OrientationClassTelemetry[] = [];

    for (const r of reach) {
      const classId = String(r.class_id);
      const turnsRendered = Number(r.turns_rendered ?? 0);
      const rowsRendered = Number(r.rows_rendered ?? 0);
      const measurable = classId in ORIENTATION_ACTION_MEASURABLE;
      const a = actionByClass.get(classId);
      const dispositions = measurable ? Number(a?.dispositions ?? 0) : null;
      const settled = ((a?.settled as unknown[] | undefined) ?? []).map((v) => Number(v));
      const flagged =
        measurable && turnsRendered >= ORIENTATION_ZERO_ACTION_FLAG_TURNS && dispositions === 0;
      classes.push({
        classId,
        turnsRendered,
        rowsRendered,
        meanRowsPerTurn:
          turnsRendered > 0 ? Math.round((rowsRendered / turnsRendered) * 100) / 100 : null,
        firstRenderedAt: r.first_rendered_at
          ? new Date(r.first_rendered_at as string).toISOString()
          : null,
        lastRenderedAt: r.last_rendered_at
          ? new Date(r.last_rendered_at as string).toISOString()
          : null,
        actionMeasurable: measurable,
        unmeasuredReason: measurable
          ? null
          : 'class-A (delta): no disposition event exists to observe, so action is NOT measured — this is not a zero',
        dispositions,
        openRows: measurable ? Number(a?.open_rows ?? 0) : null,
        medianTurnsToDisposition: measurable ? median(settled) : null,
        flagged,
        flagReason: flagged
          ? `reached ${turnsRendered} turns with 0 dispositions (threshold ${ORIENTATION_ZERO_ACTION_FLAG_TURNS}) — re-argue the actor test for this class`
          : null,
      });
    }

    classes.sort((x, y) => y.turnsRendered - x.turnsRendered || x.classId.localeCompare(y.classId));
    return {
      ...base,
      classes,
      flagged: classes.filter((c) => c.flagged).map((c) => c.classId),
      unavailableReason: null,
    };
  } catch (err) {
    noteMissingRelation(err);
    return {
      ...base,
      classes: [],
      flagged: [],
      unavailableReason: `orientation telemetry could not be read: ${(err as Error)?.message ?? 'unknown error'}`,
    };
  }
}
