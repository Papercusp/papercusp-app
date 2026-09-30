/**
 * goals:update — move a goal's standing state.
 *
 * The other half of P-009's "wire the dead table". Creating a goal record is
 * only half a ratchet-guard: GOAL mode's contract says an agent that only ever
 * CREATES is a ratchet, so the goal must also be closable — `status: 'killed'`
 * when the kill criterion trips, `'achieved'` when it is met — and a verified
 * measured child-fleet spend snapshot may be recorded against the ceiling
 * declared at creation. This tool cannot infer the interactive session's own
 * spend.
 *
 * Partial by construction: every field is optional and an omitted field is left
 * alone, so recording a measured spend snapshot never silently clears a kill
 * criterion.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { GOAL_SPEND_SNAPSHOT_SOURCE, goalSpend } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { PapercuspUnifiedToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';
import { evaluateGoalWindDownOutputs } from '@papercusp/operator-core/lib/goals/goal-io-validation';
import { killCriterionProblem } from '@papercusp/operator-core/lib/goals/kill-criterion';
import { GENERICALLY_MEASURABLE_METRICS } from '@papercusp/operator-core/lib/goals/tripwire-refresh';
import { HARNESS_SLUG_RE, isWildcardScopeToken } from '@papercusp/operator-core/lib/harness-slug';
import {
  GOAL_LAUNCH_DEFAULTS,
  UNLIMITED_CEILING,
  declareGoalHolderPolicy,
  goalHolderPolicySchema,
  goalLaunchSettingsSchema,
  readGoalLaunchSettings,
  writeGoalLaunchSettings,
} from '@papercusp/operator-core/lib/goal-launch-settings';
import { SU_WRITE_ROLES } from '../../role-config';
import { GOAL_STATUSES, TripwireSchema } from './create';
import { applyGoalBlockedBy, readGoalBlockedByEdges } from './goal-deps';
import { resolveGoalWorkspace } from './_workspace';
import {
  getGoalTransitionExecutor,
  isTransitioningStatus,
  isStopReport,
  type GoalTransitionReport,
} from './stop-seam';
import { clearGoalPause, stampGoalPause } from './pause-record';
import { addGoalFieldChange, appendGoalHistory, type GoalFieldChange } from './history';
import { isGoalHolderAuthorityError } from '@papercusp/operator-core/lib/modes/goal-context';
import { assertGoalWriteAuthorityForCaller } from '@papercusp/operator-core/lib/goals/write-authority';
import { withGoalPackageInstanceOverride } from './_core';

function jsonField(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function centsField(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const cents = Number(value);
  return Number.isFinite(cents) ? cents : null;
}

function integerField(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const integer = Number(value);
  return Number.isInteger(integer) ? integer : null;
}

function sortedRefs(refs: readonly string[]): string[] {
  return [...refs].sort((a, b) => a.localeCompare(b));
}

const goalUpdateArgs = z.object({
  id: z.string().min(1),
  status: z.enum(GOAL_STATUSES).optional(),
  outputs: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      "the goal's reported terminal outputs. With status:'achieved', every declared-required output must be filled; status:'killed' accepts partial or absent outputs. Pass this together with a terminal status so the status and product claim are validated and written atomically.",
    ),
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(20000).optional(),
  killCriterion: z.string().max(2000).optional(),
  tripwires: z
    .array(TripwireSchema)
    .max(12)
    .nullable()
    .optional()
    .describe(
      'refresh the structured kill criterion — this is how a tripwire\'s `current` advances ("$310 of $500"). ⚠ You may NOT hand-write a `current` AT OR ABOVE its threshold for a metric the platform measures itself (spend_usd et al): for a STANDING goal that is a kill trigger, not a bar, and it must come from the measured rollup — omit `current` and the rollup fills it in. Below-threshold values, and any metric the platform cannot resolve, are yours as before. Pass null to drop them back to prose-only. Omit to leave untouched.',
    ),
  budgetCents: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      'revise the declared ceiling; omit to leave it untouched, or pass null to REMOVE it (back to no ceiling). Clearing the ceiling clears its window too unless budgetWindowSec is passed in the same call.',
    ),
  budgetWindowSec: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      'revise the budget ceiling window in seconds; omit to leave it untouched, or pass null to restore a lifetime ceiling',
    ),
  spentCents: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'cents from the all-time measured child-fleet goals:pots rollup; the handler rejects missing, partial, or mismatched measurements and never derives interactive-session cost',
    ),
  parentId: z.string().min(1).nullable().optional().describe('re-parent, or null to detach'),
  installSlug: z
    .string()
    .min(1)
    .max(120)
    .regex(
      HARNESS_SLUG_RE,
      'install_slug must match the launch door\'s slug pattern (HARNESS_SLUG_RE) — a wildcard scope token like "*" is rejected here precisely because it is accepted at write time and then fails at every holder launch',
    )
    // `'all'` PASSES the pattern above, so the regex alone would admit it and
    // file the goal against a Pot named `all` that does not exist. This door
    // refuses both scope tokens rather than resolving them (as goals:create
    // does): a repair caller is naming its target explicitly and can name the
    // Pot, so silently retargeting the row would be the wrong kind of helpful.
    .refine((s) => !isWildcardScopeToken(s), {
      message:
        'install_slug names a Pot, not a scope: "*" and "all" are workspace-global scope tokens. Name the concrete Pot to file this goal against (the platform Pot is "papercusp").',
    })
    .optional()
    .describe(
      // Provenance EI-21563406996333542 lives here, not on the wire (argSchema bytes are paid every turn).
      'REPAIR the Pot this goal is filed against. A goal created from a workspace-global session was written with install_slug="*", which reads healthy everywhere but makes the goal PERMANENTLY UNLAUNCHABLE — launch-su rejects the wildcard, so the holder spawn fails with "invalid harness slug". There was previously no way to fix such a row in place; this is that way. Validated against the same slug pattern the launch door enforces, so an unlaunchable value cannot be written through this door either.',
    ),
  blockedBy: z
    .array(z.string().min(1).max(200))
    .max(20)
    .nullable()
    .optional()
    .describe(
      // Provenance: plan goal-dag-shared-substrate-2026-08-18 (kept off the wire).
      'REPLACE this goal\'s blocked-by set: goal ids and/or bare WI-/EI- issue ids that must resolve before this goal is actionable. Declarative full-set — the previous set is replaced; null or [] clears it. Every ref must RESOLVE (a goal in this workspace / an existing issue) and the goal graph must stay acyclic. Edges are prerequisites between SEPARATE outcomes — phases of one outcome belong inside the goal as plans/tripwires (D-005). An achieved goal blocker satisfies; a KILLED one flags this goal premiseInvalidated instead of unblocking it.',
    ),
  drainFleet: z
    .string()
    .min(1)
    .max(120)
    .nullable()
    .optional()
    .describe(
      'the STANDING drain fleet slug for this goal (GOAL contract clause 3 — one per goal, always maintained). Record it the moment the fleet is established; null clears it (e.g. re-establishing under a new slug). The goal-liveness watchdog treats an active goal without one as a gap.',
    ),
  launchSettings: goalLaunchSettingsSchema
    .nullable()
    .optional()
    .describe(
      // The schema itself enumerates the keys; a hand-listed subset here went stale as keys were added.
      'per-goal launch ceilings + profile — the numbers every launch for this goal is checked against. ' +
        `Each ceiling takes a number, or "${UNLIMITED_CEILING}" for no ceiling at all; OMITTING one applies the system default ` +
        `(${GOAL_LAUNCH_DEFAULTS.maxAgents} agents / ${GOAL_LAUNCH_DEFAULTS.maxPerFleet} per fleet), which is NOT the same as unlimited. ` +
        'Pass null to clear the whole document back to those defaults; omit to leave untouched. ' +
        'A partial patch REPLACES the document and is REFUSED if it would delete existing keys — see confirmDropLaunchSettingsKeys.',
    ),
  confirmDropLaunchSettingsKeys: z
    .array(z.string())
    .optional()
    .describe(
      // Provenance WI-10002016 (kept off the wire).
      'Names the existing top-level launchSettings keys a REPLACING write may delete. ' +
        'launchSettings replaces the whole document, so a partial patch like { maxAgents: 6 } drops every sibling key; ' +
        'such a write is refused and names the exact keys — pass them here to confirm. ' +
        'To change one field WITHOUT touching the rest, re-send the existing keys alongside it; for holder policy use the `holder` arg, which merges.',
    ),
  reason: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Why this amendment is being made. REQUIRED when pausing (status:"paused") — ideally name what would end the hold — and persisted both in metadata.pause and the append-only amendment history. On other amendments it is optional; when omitted the audit entry carries an explicit generated reason rather than losing the provenance field.',
    ),
  holder: goalHolderPolicySchema
    .optional()
    .describe(
      'Declare (or revise) THIS goal\'s holder policy: does it need a LIVE holder to count as active, and what happens when it loses one. ' +
        "{ requireLive: true } for a goal a session owns; { requireLive: false } for one driven by routines rather than a held session; onLoss 'deactivate' (default) or 'respawn'. " +
        'MERGES into the existing launch settings — unlike launchSettings, which replaces the whole document — so declaring a policy cannot disturb a declared ceiling. ' +
        'This is the door that clears a "no declared holder policy" refusal from goals:create / goals:start / mode:set { mode:"goal" }.',
    ),
});

const goalUpdateTool = defineTool({
  name: 'goals:update',
  needsWorkspaceTx: true,
  description:
    'Move a GOAL record\'s standing state (harness_shared.goals). ' +
    'Partial — omitted fields stay untouched; budgetCents, budgetWindowSec, tripwires, parentId, launchSettings and drainFleet take null to CLEAR. ' +
    'status:"killed" when the kill criterion trips, "achieved" when the outcome is met. ' +
    'status FANS OUT: "paused"|"killed"|"achieved" gates placement on the projects this goal OWNS and disarms the engine loops of sessions attributed to it; ' +
    '"active" re-opens placement on those same projects (nothing else can — the pause is marked deliberate so no watchdog undoes it). Read `stop` and `degraded` either way.',
  capability: 'goals:write',
  guidance: {
    when:
      'Recording a verified child-fleet spend snapshot against a goal\'s declared ceiling, revising its statement, kill criterion, or budget window, or CLOSING it (achieved / killed). A spend snapshot is accepted only when it exactly matches the measured goals:pots rollup.',
    notWhen:
      'For per-pot progress or measured spend use goals:pots { goalId } and the pot/plan/work-item beneath the goal — this row carries the goal-level state only. Do not invent interactive-session cost. To read current state first, goals:get { id, detail:"full" }.',
    chaining:
      'goals:get → goals:pots → goals:update only when writing a verified measured snapshot. Pausing/killing winds the projects down FOR you (placement gate + loop disarm); ' +
      'a degraded spend result means no snapshot was written and the tripwire remains unmeasured — chase it with goals:pots, then fleet:assignments / loop:status on the reported projects.',
    returns:
      '`stop` carries the fan-out report and is NOT symmetric — check its `status` before reading it. ' +
      'STOP arm (paused/killed/achieved): `potsStopped`, `potsSkippedContributing`, `loopsStopped`, and ⚠ `unattributedActiveLoops` — active loops in this goal\'s own pots that could NOT be attributed to it and are STILL RUNNING. ' +
      'TERMINAL only (killed/achieved): `modesCleared` — sessions whose GOAL-mode row was retired — and ⚠ `modesLeftArmed`, owner-directed rows the sticky guard REFUSED, so those sessions are still being told this goal is their mission. A pause keeps the rows (resume reads them). ' +
      'TERMINAL only (killed/achieved): `drainFleet`, `drainFleetWoundDown`, and ⚠ `drainFleetWindDownError` report whether the goal\'s standing drain fleet was put into typed winding-down state. ' +
      'RESUME arm (active): `potsResumed`, `potsSkippedContributing`, and ⚠ `loopsLeftDisarmed` — sessions attributed to this goal that are still not looping, deliberately NOT re-armed (they are routinely dead by resume time; new work re-forms from PLACEMENT instead). ' +
      '`timeWakeRestored` is always false: the pause DELETES the pot\'s declared time-wake row and its cadence is not reconstructible. ' +
      '`degraded` is true when either gap is non-zero — a caller that renders only `status` will be wrong, which is what these numbers exist to prevent. ' +
      'REFUSAL: status:"paused" with no `reason` returns degraded and writes NOTHING — an unexplained pause is indistinguishable from a goal that lost its holder, so the reason is recorded with author + timestamp (metadata.pause, read back by goals:get) or the pause does not happen.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  args: goalUpdateArgs,
  result: z
    .object({
      stop: z.unknown().optional(),
      potsStopped: z.unknown().optional(),
      potsSkippedContributing: z.unknown().optional(),
      loopsStopped: z.unknown().optional(),
      unattributedActiveLoops: z.unknown().optional(),
      modesCleared: z.unknown().optional(),
      modesLeftArmed: z.unknown().optional(),
      drainFleet: z.unknown().optional(),
      drainFleetWoundDown: z.unknown().optional(),
      drainFleetWindDownError: z.unknown().optional(),
      potsResumed: z.unknown().optional(),
      loopsLeftDisarmed: z.unknown().optional(),
      timeWakeRestored: z.unknown().optional(),
      degraded: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const tx = ctx.tx!;
    // ── The criterion gate (P-009) ───────────────────────────────────────────
    //
    // BEFORE the read, because it needs no row and a refusal should cost
    // nothing. `goals:propose` refuses a criterion that states no abandonment
    // condition; until P-009 this door did not, so the edit path was a way to
    // install a criterion the create path would have rejected. Both doors now
    // call the SAME `killCriterionProblem` — sharing the rule rather than
    // re-stating it is the item's hard constraint, since a second copy drifts
    // silently and only ever in the permissive direction.
    //
    // A BLANK criterion is an explicit CLEAR, not a refusal, and is allowed
    // through deliberately: a goal may be created with no criterion at all
    // (WI-37604, owner-directed 2026-08-09), so refusing to clear one would
    // make this door STRICTER than creation rather than equal to it. Clearing
    // restores the panel's "nothing can stop this goal" alarm, which is the
    // honest reading of the resulting state. It is normalised to null so the
    // column holds an absence rather than whitespace that every reader has to
    // re-trim before it reads as absent.
    const criterionArg = args.killCriterion?.trim();
    if (criterionArg) {
      const problem = killCriterionProblem(criterionArg);
      if (problem) {
        return { data: null, degraded: true, degradedReasons: [problem] };
      }
    }

    // ── The pause-reason gate (P-005, D-009) ─────────────────────────────────
    //
    // Also BEFORE the read, for the same reason: a refusal should cost nothing.
    //
    // A pause with no recorded WHY is the failure this item exists to close.
    // `status='paused'` already had teeth (it gates placement and disarms
    // attributed loops) but carried no record of the DECISION — no author, no
    // timestamp of its own, no reason — so a later reader could not tell an
    // owner's deliberate hold from a goal that quietly lost its holder, which
    // is precisely the distinction P-004's derived deactivation has to make.
    //
    // REQUIRED rather than optional, following `routines:set` rather than
    // softening it. The evidence for requiring it is three recorded incidents
    // (EI-18654017982759582 twice, EI-19336000265007219 once), and the obvious
    // counter-argument — that an emergency pause should not be blocked by a
    // missing sentence — is answered by those same incidents: the emergency
    // pause is the one most likely to be left unexplained and then forgotten.
    const pauseReason = args.reason?.trim();
    if (args.status === 'paused' && !pauseReason) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [
          `goal ${args.id} not paused: status:'paused' requires \`reason\` — why the goal is being held, and ideally what would end the hold. ` +
            `A pause with no recorded reason is indistinguishable from a goal that lost its holder, which is the exact confusion this record exists to prevent. ` +
            `Retry with { status:'paused', reason:'…' }.`,
        ],
      };
    }

    const existing = await tx<
      Array<{
        workspace_id: string;
        install_slug: string;
        title: string;
        body: string | null;
        status: string;
        parent_id: string | null;
        budget_cents: string | null;
        budget_window_sec: number | null;
        kill_criterion: string | null;
        tripwires: unknown;
        metadata: Record<string, unknown> | null;
        launch_settings: unknown;
        output_schema: Record<string, unknown> | null;
        outputs: Record<string, unknown> | null;
      }>
    >`
      SELECT workspace_id, install_slug, title, body, status, parent_id, budget_cents, budget_window_sec,
             kill_criterion, tripwires, metadata, launch_settings, output_schema, outputs
        FROM harness_shared.goals WHERE id = ${args.id} LIMIT 1
    `;
    if (!existing.length) {
      return { data: null, degraded: true, degradedReasons: [`goal ${args.id} not found`] };
    }
    const prev = existing[0]!;

    // ── The terminal-output gate (P-021) ─────────────────────────────────────
    //
    // loop:end and session:end already consult the shared evaluator before
    // applying a disposition. `goals:update` is another terminal write path,
    // and letting it set achieved directly would otherwise bypass that gate:
    // the status would say "done" while the declared product remained null.
    // Validate the candidate row before authority checks or any subordinate
    // writes. Passing outputs here is deliberately paired with a terminal
    // status so a product cannot be amended on an active goal without an
    // explicit lifecycle transition.
    const terminalStatus = args.status === 'achieved' || args.status === 'killed' ? args.status : null;
    if (args.outputs !== undefined && terminalStatus === null) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [
          `goal ${args.id} outputs refused: pass outputs together with status:'achieved' or status:'killed' so the terminal product claim is validated atomically`,
        ],
      };
    }
    let terminalOutputs: Record<string, unknown> | null = prev.outputs ?? null;
    if (terminalStatus !== null) {
      const outputVerdict = evaluateGoalWindDownOutputs({
        outputSchema: prev.output_schema,
        outputs: args.outputs === undefined ? prev.outputs : args.outputs,
        disposition: terminalStatus,
      });
      if (!outputVerdict.ok) {
        return {
          data: null,
          degraded: true,
          degradedReasons: [`goal ${args.id} not ${terminalStatus}: ${outputVerdict.hint}`],
          goalOutputValidation: {
            code: outputVerdict.code,
            missing: outputVerdict.missing,
            errors: outputVerdict.errors,
          },
        };
      }
      terminalOutputs = outputVerdict.outputs;
    }

    // The row read above gives the canonical workspace; fence the attributable
    // caller before any subordinate edge/settings write or the goal UPDATE.
    // Missing legacy identity stays the pre-existing unattributable system path,
    // but any real agent identity must prove it is not an expired GOAL holder.
    try {
      await assertGoalWriteAuthorityForCaller(ctx, prev.workspace_id, tx as unknown as Sql);
    } catch (error) {
      if (isGoalHolderAuthorityError(error)) {
        return {
          data: null,
          degraded: true,
          degradedReasons: [error.message],
          goalHolderAuthority: {
            code: error.code,
            ...(error.authority ?? {}),
          },
        };
      }
      throw error;
    }
    let previousBlockedBy: string[] | null = null;
    if (args.blockedBy !== undefined) {
      const edges = await readGoalBlockedByEdges(tx, prev.workspace_id);
      previousBlockedBy = sortedRefs((edges.get(args.id) ?? []).map((edge) => edge.ref));
    }

    /* SPEND PROVENANCE (EI-20188678636377696).
       `spentCents` used to be an owner-entered number. That made a guess
       indistinguishable from a measurement and let a decorative ceiling read
       as enforced. The only currently honest source is the existing measured
       child-fleet rollup behind goals:pots. Read it in this transaction, reject
       an incomplete rollup, and compare the caller's number to the source
       before touching the goal row. The interactive GOAL session deliberately
       remains outside this figure: provider billing is not attributable there. */
    let measuredSpendCents: number | undefined;
    if (args.spentCents !== undefined) {
      const workspaceId = await resolveGoalWorkspace({
        tx,
        workspaceId: ctx.principal?.workspaceId,
      });
      if (!workspaceId) {
        return {
          data: null,
          degraded: true,
          degradedReasons: [
            `spentCents refused for goal ${args.id}: no concrete workspace is available to read the measured goals:pots rollup`,
          ],
        };
      }
      const spend = await goalSpend(tx as Sql, { workspaceId, goalId: args.id });
      if (!spend.measured || !Number.isFinite(spend.costUsd)) {
        return {
          data: null,
          degraded: true,
          degradedReasons: [
            `spentCents refused for goal ${args.id}: goals:pots has no complete priced measurement (samples=${spend.samples}, priced=${spend.pricedSamples}, unpriced=${spend.unpricedSamples}); the spend tripwire remains unmeasured`,
          ],
        };
      }
      measuredSpendCents = Math.round(spend.costUsd * 100);
      if (args.spentCents !== measuredSpendCents) {
        return {
          data: null,
          degraded: true,
          degradedReasons: [
            `spentCents refused for goal ${args.id}: supplied ${args.spentCents} does not match the measured goals:pots rollup (${measuredSpendCents} cents); the spend tripwire remains unmeasured`,
          ],
        };
      }
    }

    /* TRIPWIRE PROVENANCE (EI-22512669283419131).
       The spend-provenance guard above stops a guess reaching `spentCents`. It
       left the sibling field wide open: `tripwires[].current` accepted any
       caller-supplied number, and for a `standing` goal the tripwires ARE the
       stopping condition (see the goals.standing column comment), so a
       hand-written `current` at or above its threshold is not a decorative bar
       — it is a kill trigger that the spend rollup executes on its next pass.

       That is precisely the failure the comment above describes, running the
       other way: there a guess read as enforcement; here a number written FOR
       display BECAME enforcement. It has fired once in production, killing a
       live standing goal and winding down its drain fleet on a figure whose own
       label read "estimated, likely a floor".

       Scope is deliberately narrow, on BOTH axes, because advancing a bar by
       hand is a designed and tested behaviour ("$310 of $500") that this guard
       must not revoke:

         - METRIC: only ones the rollup can resolve itself. Most metrics
           (`species_covered`, revenue, users) live outside this database
           entirely, and there the caller is the ONLY source and stays free to
           report even a breach.
         - VALUE: only a `current` AT OR ABOVE its threshold — the kill trigger.
           A below-threshold bar is an honest progress report and still moves
           the way it always did.

       So what is refused is exactly one thing: hand-writing a KILL for a metric
       the platform measures for itself. The rollup writes this column with its
       own UPDATE and never routes through this tool, so a real measured breach
       is unaffected — it simply has to come from the measurement. */
    if (args.tripwires && args.tripwires.length > 0) {
      const handWrittenKill = args.tripwires.filter(
        (t) =>
          t.current !== undefined &&
          t.current >= t.threshold &&
          GENERICALLY_MEASURABLE_METRICS.includes(t.metric),
      );
      if (handWrittenKill.length > 0) {
        return {
          data: null,
          degraded: true,
          degradedReasons: handWrittenKill.map(
            (t) =>
              `tripwires refused for goal ${args.id}: supplied current ${t.current} for metric "${t.metric}" is at or above its threshold ${t.threshold}, which for a STANDING goal is a KILL TRIGGER rather than a display value — and "${t.metric}" is measured by the rollup, so a breach must come from that measurement, not from the caller. Omit \`current\` (the rollup fills it in), or report a below-threshold value. Put an unmeasured estimate in \`label\`.`,
          ),
        };
      }
    }

    // Merge rather than replace: reporting spend must not clear the kill
    // criterion recorded at creation, and vice versa.
    //
    // The kill criterion and its tripwires are COLUMNS now (migration 765), not
    // metadata keys — the GUI's headline reads them directly. A goal written
    // before that migration still carries `metadata.killCriterion`, so fall
    // back to it when the column is empty rather than silently blanking the one
    // field the owner most needs to see.
    const metadata: Record<string, unknown> = { ...(prev.metadata ?? {}) };
    if (measuredSpendCents !== undefined) {
      metadata.spentCents = measuredSpendCents;
      metadata.spentCentsSource = GOAL_SPEND_SNAPSHOT_SOURCE;
    }
    // Standing drain fleet (EI-20581099901890760): omitted leaves it alone;
    // null clears it (re-establishment under a new slug passes the new one).
    if (args.drainFleet !== undefined) {
      if (args.drainFleet === null) delete metadata.drainFleet;
      else metadata.drainFleet = args.drainFleet;
    }
    const legacyCriterion =
      typeof metadata.killCriterion === 'string' ? (metadata.killCriterion as string) : null;
    // Having migrated it into the column, drop the metadata copy: two sources
    // of truth for the one field that decides whether a goal ends is how a
    // reader ends up showing the stale one.
    delete metadata.killCriterion;

    // ── The deliberate-pause record (P-005, D-009) ───────────────────────────
    //
    // Gated on an EXPLICIT `status` argument, never on the resolved value: a
    // title edit on an already-paused goal passes no status, and clearing its
    // pause record because `next.status` happens to be 'paused' would delete
    // the record on every unrelated write. Same discipline as the fan-out
    // below, which fires on the argument rather than on a transition edge.
    //
    // Every OTHER metadata key survives — the helpers spread rather than
    // replace. Goal metadata carries spentCents / drainFleet / startedBy from
    // other write paths, and a pause that dropped them would be a data-loss bug
    // wearing an audit-trail costume.
    let pauseMetadata: Record<string, unknown> = metadata;
    if (args.status === 'paused') {
      // `pauseReason` is non-empty here: the gate above refuses otherwise.
      pauseMetadata = stampGoalPause(metadata, {
        reason: pauseReason as string,
        // Best-effort attribution, and it must never BLOCK a pause: an
        // unattributable caller degrades to a marker, exactly as
        // `routines:set`'s `pausedByFrom` degrades to its role string.
        pausedBy: ctx.principal?.slug ?? 'unknown',
      });
    } else if (args.status !== undefined) {
      // Any other explicit status ends the hold — including the terminal ones.
      // A `killed`/`achieved` goal still carrying a live `pause` record would
      // report a hold that is over, which is the same false-premise state the
      // record exists to prevent, inverted.
      pauseMetadata = clearGoalPause(metadata);
    }

    // Resolve every column in JS so "omitted" and "explicitly null" stay
    // distinguishable — a COALESCE in SQL cannot express detaching a parent,
    // and a conditional SQL fragment to work around that is worse.
    const next = {
      title: args.title ?? prev.title,
      body: args.body ?? prev.body,
      status: args.status ?? prev.status,
      // `=== undefined`, never `??` — the money ceiling is clearable now
      // (EI-20072247655456262) and `args.budgetCents ?? prev` reads an explicit
      // null as "omitted", which would make the clear a silent no-op. The same
      // form also keeps an explicit `0` ceiling from falling through to prev,
      // which the `??` version already got right and this must not regress.
      budgetCents:
        args.budgetCents === undefined
          ? prev.budget_cents === null || prev.budget_cents === undefined
            ? null
            : Number(prev.budget_cents)
          : args.budgetCents,
      // A window scopes a ceiling, so removing the ceiling removes its window
      // too — otherwise the row keeps a dangling `budget_window_sec` that is
      // inert while there is no ceiling (every enforcement and display path
      // gates on `budgetCents != null`) and then silently RE-ATTACHES itself to
      // the next ceiling somebody sets, which is a window they never asked for.
      // An explicit `budgetWindowSec` in the same call still wins: a caller
      // naming both fields has said what it wants.
      budgetWindowSec:
        args.budgetWindowSec !== undefined
          ? args.budgetWindowSec
          : args.budgetCents === null
            ? null
            : prev.budget_window_sec === null || prev.budget_window_sec === undefined
              ? null
              : Number(prev.budget_window_sec),
      parentId: args.parentId === undefined ? prev.parent_id : args.parentId,
      installSlug: args.installSlug ?? prev.install_slug,
      // Omitted leaves it alone; a blank CLEARS it to null (see the gate above)
      // rather than storing whitespace that every reader has to re-trim before
      // it reads as absent — `killCriterionLine` and the board card both decide
      // "missing" by trimming, so an untrimmed blank is already an absence
      // wearing a value.
      killCriterion:
        criterionArg === undefined ? (prev.kill_criterion ?? legacyCriterion) : criterionArg || null,
      tripwires:
        args.tripwires === undefined
          ? prev.tripwires === null || prev.tripwires === undefined
            ? null
            : JSON.stringify(prev.tripwires)
          : args.tripwires === null || args.tripwires.length === 0
            ? null
            : JSON.stringify(args.tripwires),
    };

    // A packaged goal has a reusable disk contract plus per-instance live
    // state. Directly editing its contract must not disappear when the next
    // instance is minted from the package. Preserve only explicit contract
    // edits as a narrow metadata overlay; operational tuning remains local.
    const packageRef =
      typeof pauseMetadata.goalPackageRef === 'string' ? pauseMetadata.goalPackageRef.trim() : '';
    const packageOverride =
      packageRef.length > 0
        ? {
            ...(args.title !== undefined ? { title: next.title } : {}),
            ...(args.body !== undefined ? { body: next.body } : {}),
            ...(args.killCriterion !== undefined ? { killCriterion: next.killCriterion } : {}),
            ...(args.tripwires !== undefined ? { tripwires: jsonField(next.tripwires) } : {}),
          }
        : {};
    const nextMetadata =
      Object.keys(packageOverride).length > 0
        ? withGoalPackageInstanceOverride(pauseMetadata, packageOverride)
        : pauseMetadata;
    const nextOutputs = terminalStatus === null ? prev.outputs : terminalOutputs;
    const serializedOutputs =
      nextOutputs === null || nextOutputs === undefined ? null : JSON.stringify(nextOutputs);

    await tx`
      UPDATE harness_shared.goals
         SET title          = ${next.title},
             body           = ${next.body},
             status         = ${next.status},
             budget_cents   = ${next.budgetCents},
             budget_window_sec = ${next.budgetWindowSec},
             parent_id      = ${next.parentId},
             install_slug   = ${next.installSlug},
             kill_criterion = ${next.killCriterion},
             tripwires      = ${next.tripwires}::jsonb,
             outputs        = ${serializedOutputs}::jsonb,
             metadata       = ${Object.keys(nextMetadata).length ? JSON.stringify(nextMetadata) : null}::jsonb,
             updated_at     = now()
       WHERE id = ${args.id}
    `;

    /* PER-GOAL LAUNCH SETTINGS (P-005 wires P-004's store to a door).
       Delegated to `writeGoalLaunchSettings` rather than folded into the UPDATE
       above: that function is the store's writer, it re-validates before the
       column is touched, and having a second place that knows how to serialise
       this document is how the two would drift.

       Passed `ctx.tx`, so it runs INSIDE this handler's transaction — the
       settings and the rest of the row commit together or not at all. Its own
       default (`getOrgPg()`) would open a second connection and could leave a
       ceiling raised on a goal whose update rolled back.

       Undefined leaves the column alone; null clears it — the same
       omitted-vs-explicitly-null distinction `parentId` and `tripwires` make. */
    let launchSettingsError: string | null = null;
    if (args.launchSettings !== undefined) {
      /* DROP GUARD (WI-10002016). This write REPLACES the document — correct when
         the owner is editing it AS a document, destructive when it is a partial
         patch. A steward raising `{ maxAgents }` deleted `holder.onLoss:'respawn'`
         and `defaults.account:'auto'` on a live goal with no way to notice; it was
         recoverable only because audit_log keeps the full `before`.

         Guarding the DOOR rather than changing the writer is deliberate. Replace is
         the documented semantic and the only way to CLEAR a key, so merging by
         default would remove a capability and silently change every existing caller.
         Reading the goal first cannot save the caller either: `goals:get` may return
         this document projection-truncated, so a careful read-modify-write still
         loses the keys it never saw. Only the write side knows the whole document.

         Only an OBJECT is guarded. An explicit `null` remains an unambiguous "clear
         the whole document" — nobody types null meaning "patch one field", which is
         precisely the accident this catches.

         Same shape as `loop:checkpoint`'s row-eviction refusal: name the exact keys
         that would go, and make the caller confirm them. */
      const dropped: string[] = [];
      if (args.launchSettings !== null) {
        const current = await readGoalLaunchSettings(args.id, tx);
        // An unparseable stored document is NOT treated as empty: reporting
        // "nothing to drop" about keys we merely failed to read is the same
        // false-clean verdict the guard exists to prevent.
        if (current.error) {
          launchSettingsError = `launch settings NOT saved: the existing document could not be read, so the keys this write would delete are unknown (${current.error})`;
        } else {
          const nextKeys = new Set(Object.keys(args.launchSettings));
          const confirmed = new Set(args.confirmDropLaunchSettingsKeys ?? []);
          for (const key of Object.keys(current.settings ?? {})) {
            if (!nextKeys.has(key) && !confirmed.has(key)) dropped.push(key);
          }
        }
      }
      if (!launchSettingsError && dropped.length > 0) {
        launchSettingsError =
          `launch settings NOT saved: this write REPLACES the document and would DELETE ${dropped.length} ` +
          `existing top-level key(s): ${dropped.map((k) => `\`${k}\``).join(', ')}. ` +
          'Re-send those keys to keep them, or pass ' +
          `confirmDropLaunchSettingsKeys: [${dropped.map((k) => `'${k}'`).join(', ')}] to delete them on purpose. ` +
          'To set holder policy without touching the rest, use the `holder` arg, which merges.';
      }
      if (!launchSettingsError) {
        const w = await writeGoalLaunchSettings(args.id, args.launchSettings, tx);
        if (!w.ok) launchSettingsError = `launch settings NOT saved: ${w.error ?? 'unknown error'}`;
      }
    }

    /* HOLDER POLICY (goal-live-holder-guarantee-2026-08-18 P-003). Its own arg
       rather than "just pass launchSettings" because the two write the document
       differently ON PURPOSE: `launchSettings` REPLACES it, which is right when
       the owner is editing the document as a document, and wrong for a caller
       answering only the holder question — sending `{ holder }` through that
       path silently drops the goal's ceilings. Since this is the door the
       P-003 refusals name as the fix, a fix that destroys a ceiling would be
       worse than the refusal it clears.

       AFTER the launchSettings write and in the same transaction, so passing
       both in one call means the holder policy merges into the document just
       written rather than into the one it replaced. */
    let holderError: string | null = null;
    if (args.holder !== undefined) {
      const w = await declareGoalHolderPolicy(args.id, args.holder, tx);
      if (!w.ok) holderError = `holder policy NOT saved: ${w.error ?? 'unknown error'}`;
    }

    /* BLOCKED-BY (goal-dag-shared-substrate-2026-08-18 P-002). Same
       partial-by-construction contract as every other field: omitted leaves the
       edge set alone; null/[] clears it; a refused set (unresolvable ref,
       cycle) degrades WITHOUT reverting the rest of the update — the failure
       rides degradedReasons like launchSettingsError above. Runs in ctx.tx, so
       the edges and the row commit together. */
    let blockedByError: string | null = null;
    let blockedByApplied: string[] | null = null;
    if (args.blockedBy !== undefined) {
      const workspaceId = await resolveGoalWorkspace({
        tx,
        workspaceId: ctx.principal?.workspaceId,
      });
      if (!workspaceId) {
        blockedByError = 'blockedBy NOT saved: no concrete workspace in scope to resolve the refs against';
      } else {
        const applied = await applyGoalBlockedBy(tx, {
          workspaceId,
          goalId: args.id,
          refs: args.blockedBy ?? [],
          createdBy: ctx.uiClientId ?? null,
        });
        if (applied.ok) blockedByApplied = applied.blockers.map((b) => b.ref);
        else blockedByError = `blockedBy NOT saved: ${applied.problem}`;
      }
    }

    const [row] = await tx<
      Array<{
        id: string;
        workspace_id: string;
        title: string;
        body: string | null;
        status: string;
        parent_id: string | null;
        budget_cents: string | null;
        budget_window_sec: number | null;
        kill_criterion: string | null;
        tripwires: unknown;
        metadata: Record<string, unknown> | null;
        launch_settings: unknown;
        output_schema: Record<string, unknown> | null;
        outputs: Record<string, unknown> | null;
      }>
    >`
      SELECT id, workspace_id, title, body, status, parent_id, budget_cents, budget_window_sec,
             kill_criterion, tripwires, metadata, launch_settings, output_schema, outputs
        FROM harness_shared.goals WHERE id = ${args.id} LIMIT 1
    `;

    // D-008/D-013: unrestricted self-amendment is bounded by an audit trail,
    // not by an approval or not-self gate. Compare the persisted row before and
    // after every write so failed subordinate writes are never logged as if
    // they landed, and no-op calls do not manufacture fake history.
    if (row) {
      const changes: GoalFieldChange[] = [];
      addGoalFieldChange(changes, 'title', prev.title, row.title);
      addGoalFieldChange(changes, 'body', prev.body, row.body);
      addGoalFieldChange(changes, 'status', prev.status, row.status);
      addGoalFieldChange(changes, 'parentId', prev.parent_id, row.parent_id);
      addGoalFieldChange(
        changes,
        'budgetCents',
        centsField(prev.budget_cents),
        centsField(row.budget_cents),
      );
      addGoalFieldChange(
        changes,
        'budgetWindowSec',
        integerField(prev.budget_window_sec),
        integerField(row.budget_window_sec),
      );
      addGoalFieldChange(changes, 'killCriterion', prev.kill_criterion, row.kill_criterion);
      addGoalFieldChange(changes, 'tripwires', jsonField(prev.tripwires), jsonField(row.tripwires));
      addGoalFieldChange(changes, 'outputs', jsonField(prev.outputs), jsonField(row.outputs));
      addGoalFieldChange(changes, 'metadata', jsonField(prev.metadata), jsonField(row.metadata));
      addGoalFieldChange(
        changes,
        'launchSettings',
        jsonField(prev.launch_settings),
        jsonField(row.launch_settings),
      );
      if (previousBlockedBy !== null && blockedByApplied !== null) {
        addGoalFieldChange(changes, 'blockedBy', previousBlockedBy, sortedRefs(blockedByApplied));
      }
      if (changes.length > 0) {
        const callerReason = args.reason?.trim();
        await appendGoalHistory(tx, {
          workspaceId: row.workspace_id,
          goalId: args.id,
          author: ctx.uiClientId ?? ctx.principal?.slug ?? ctx.role ?? 'unknown',
          detail: {
            kind: 'amendment',
            reason: callerReason || `goals:update changed ${changes.map((change) => change.field).join(', ')}`,
            reasonSource: callerReason ? 'caller' : 'generated',
            changes,
          },
        });
      }
    }

    // ── The stop fan-out (EI-20013729460455061) ──────────────────────────────
    //
    // Until this existed, moving a goal to paused/killed relabelled the row and
    // nothing else: no consumer of harness_shared.goals gates execution on
    // status, so every fleet, loop and pot pursuing the goal kept running.
    //
    // FIRED ON AN EXPLICIT `status` ARGUMENT, not on a transition edge. A stop
    // that only fired on active->paused could never be RE-issued, and re-issuing
    // is exactly what an owner does when the first stop came back degraded (loops
    // still burning). Reporting spend on an already-paused goal passes no
    // `status`, so it does not re-fire.
    let stop: GoalTransitionReport | null = null;
    let stopError: string | null = null;
    if (args.status !== undefined && isTransitioningStatus(args.status)) {
      const executor = getGoalTransitionExecutor();
      if (executor) {
        // UnifiedToolContext carries NO top-level workspaceId — only
        // principal.workspaceId (EI-18884122799901600) — so pass the two fields
        // explicitly rather than the whole ctx. The GUC still wins inside the
        // resolver; this is only the fallback leg.
        const workspaceId = await resolveGoalWorkspace({
          tx,
          workspaceId: ctx.principal?.workspaceId,
        });
        if (!workspaceId) {
          // Refuse rather than fan out against the wrong tenant: gating placement
          // in a workspace the goal does not live in would stop unrelated work.
          stopError = 'no concrete workspace in scope — stop fan-out skipped';
        } else {
          try {
            stop = await executor({
              goalId: args.id,
              workspaceId,
              status: args.status,
              actor: ctx.principal?.slug ?? null,
              // Keep terminal relationship cleanup in the same transaction as
              // the goals row. Background callers omit this and use the host
              // connection selected by the installed executor.
              sql: tx as Sql,
            });
          } catch (e) {
            // The status write STANDS even when the stop fails: the owner's intent
            // is recorded either way, and silently reverting to 'active' would be
            // a second lie on top of the first. Surface it loudly instead.
            stopError = e instanceof Error ? e.message : String(e);
          }
        }
      } else {
        // No host executor wired (a bare agent-mcp embedding). Say so — this is
        // precisely the state the item describes, and it must not read as success.
        stopError = 'no goal-stop executor installed by the host — status changed, nothing stopped';
      }
    }

    const degradedReasons: string[] = [];
    // Loud, not swallowed: an owner who just raised a ceiling and got `ok` back
    // would otherwise believe a limit is in force that was never written.
    if (launchSettingsError) degradedReasons.push(launchSettingsError);
    if (holderError) degradedReasons.push(holderError);
    if (blockedByError) degradedReasons.push(blockedByError);
    if (stopError) degradedReasons.push(stopError);
    if (stop?.degraded) {
      if (isStopReport(stop)) {
        // ONE CLAUSE PER ACTUAL CAUSE. `degraded` is now reachable two ways, so a
        // single hardcoded sentence would report whichever cause it happens to name —
        // and a sticky-refusal degrade would read "…but 0 active loop(s) are STILL
        // RUNNING", a confident statement about the wrong quantity. That is the exact
        // steering-surface lie the seam exists to prevent (EI-19995648221353323), so
        // each cause states itself and a cause that did not fire says nothing.
        if (stop.unattributedActiveLoops > 0) {
          degradedReasons.push(
            `goal ${args.status}, but ${stop.unattributedActiveLoops} active loop(s) in its pots could not be attributed to this goal and are STILL RUNNING`,
          );
        }
        if (stop.modesLeftArmed.length > 0) {
          degradedReasons.push(
            `goal ${args.status}, but ${stop.modesLeftArmed.length} session(s) could NOT have their GOAL mode retired — the row is owner-directed and this fan-out is not an owner-authority channel, so they are still being told this finished goal is their standing mission (${stop.modesLeftArmed.join(', ')})`,
          );
        }
        if (stop.drainFleetWoundDown === false) {
          degradedReasons.push(
            `goal ${args.status}, but its standing drain fleet ${stop.drainFleet ?? '(unrecorded)'} could NOT be put into typed winding-down state${stop.drainFleetWindDownError ? `: ${stop.drainFleetWindDownError}` : ''}`,
          );
        }
      } else {
        // The resume mirror: placement is open again, but the sessions that were
        // pursuing this goal are not looping and this resume deliberately did not
        // re-arm them (plan D-013). Work will re-form from placement, not from them.
        degradedReasons.push(
          `goal resumed and placement re-opened on ${stop.potsResumed.length} pot(s), but ${stop.loopsLeftDisarmed} attributed session loop(s) remain DISARMED and were not re-armed — new work re-forms from placement, the paused sessions do not come back`,
        );
      }
    }

    return {
      data: row
        ? { ...row, stop, ...(blockedByApplied !== null ? { blocked_by: blockedByApplied } : {}) }
        : null,
      ...(degradedReasons.length ? { degraded: true, degradedReasons } : {}),
    };
  },
});

export default goalUpdateTool;
