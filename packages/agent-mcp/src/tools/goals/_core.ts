/**
 * Shared goal-row primitives — the ONE definition of how a goal id is minted
 * and how a goal row is written, so a second writer cannot drift from
 * `goals:create`'s column list.
 *
 * WHY THIS IS A SEPARATE MODULE (and a package export subpath). The second
 * writer is `goals:start` (operator-core), which creates the goal AND spawns
 * the GOAL-mode agent that owns it, atomically. That tool cannot live in this
 * package: the spawn needs operator-core's console-launcher, and agent-mcp
 * deliberately does not depend on operator-core. The dependency runs the other
 * way (operator-core imports `@papercusp/agent-mcp`), so the half they share
 * lives HERE and is imported from there — exactly the arrangement `./_bulk`
 * already has.
 *
 * The alternative was re-typing the INSERT in operator-core. That column list
 * has already moved once (migration 765 promoted `kill_criterion` out of
 * `metadata`), and a duplicate would have kept writing the old shape while
 * still compiling.
 */

import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';

/** A readable, collision-resistant id: `ship-paid-app-3f9a1c`. */
export function goalId(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${stem || 'goal'}-${randomBytes(3).toString('hex')}`;
}

export const GOAL_STATUSES = ['active', 'achieved', 'killed', 'paused'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * The goal TERMINAL partition — the dependency substrate's per-kind policy for
 * `blocked_kind='goal'` edges (goal-dag-shared-substrate-2026-08-18 D-002).
 *
 * Goals join the shared work-queue DAG (`work_item_deps` + the blockersOf()/
 * frontier-readiness seam) as a SECOND consumer family, and the work-item rule
 * — any terminal blocker is satisfied — is WRONG here, because a goal dies two
 * ways that mean opposite things downstream:
 *
 *   - `achieved` SATISFIES a dependent ("get 1k users" achieved ⇒ "monetize
 *     the users" is now doable);
 *   - `killed` INVALIDATES the dependent's PREMISE ("get 1k users" killed ⇒
 *     "monetize the users" is moot, not ready). A killed blocker must NEVER
 *     silently unblock — readers flag the dependent `premiseInvalidated` for
 *     owner/parent review (retarget, unblock deliberately, or kill downstream).
 *
 * TERMINAL answers "is this goal finished?" (what a generic finished-check
 * needs); the SATISFYING/INVALIDATING split answers "what does that mean for
 * a dependent?". Same shape as work-item-blocking.ts's ISSUE_SHIPPED /
 * ISSUE_ABANDONED partition of ISSUE_TERMINAL_STATUSES — promoted here from
 * reporting to blocking semantics. The partition invariant (disjoint, together
 * exhaustive over TERMINAL) is pinned by `_core.test.ts`, so a future status
 * joining GOAL_STATUSES without being classified fails a test rather than
 * silently defaulting to either side.
 */
export const GOAL_TERMINAL_STATUSES: ReadonlySet<string> = new Set<GoalStatus>(['achieved', 'killed']);
export const GOAL_SATISFYING_STATUSES: ReadonlySet<string> = new Set<GoalStatus>(['achieved']);
export const GOAL_INVALIDATING_STATUSES: ReadonlySet<string> = new Set<GoalStatus>(['killed']);

/**
 * The PLAN terminal partition — the same D-002 split applied to
 * `harness_shared.harness_plans.status`, for `blocker_kind='plan'` edges
 * (work-on-everything-goal-2026-08-23 D-004, P-019).
 *
 * A plan dies the same two ways a goal does, meaning opposite things downstream:
 *
 *   - `shipped` SATISFIES a dependent — the plan delivered, so the goal it was
 *     gating is now doable;
 *   - `superseded` INVALIDATES the dependent's PREMISE — the plan will never
 *     ship because its substance moved to the superseding plan. Exactly the
 *     `killed`-goal case: it must NEVER silently unblock, so readers flag the
 *     dependent `premiseInvalidated` for review (retarget onto the successor,
 *     or unblock deliberately).
 *
 * `draft` / `ready` / `active` are non-terminal ⇒ pending (in neither set).
 *
 * Kept here beside the goal partition rather than imported from
 * `unshipped-plans-audit.ts` on purpose: that module's local
 * `PLAN_TERMINAL_STATUSES` is a REPORTING set (both statuses lumped together,
 * "is this plan finished?"), which is precisely the distinction this split
 * exists to refuse. Reusing it would erase the satisfying/invalidating
 * difference. The partition invariant is pinned by `goal-deps.test.ts`.
 */
export const PLAN_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['shipped', 'superseded']);
export const PLAN_SATISFYING_STATUSES: ReadonlySet<string> = new Set(['shipped']);
export const PLAN_INVALIDATING_STATUSES: ReadonlySet<string> = new Set(['superseded']);

/**
 * A TRIPWIRE turns the kill criterion from prose into a readout.
 *
 * A criterion written as a sentence ("kill this if we pass $500 or 30 days
 * without a shipped build") is a promise nobody re-checks; the same thing as
 * `{ metric, threshold, current }` renders as a bar the owner can act on at a
 * glance (goal-mode-2026-08-07 P-021). Deliberately OPTIONAL and unconstrained
 * as to metric name: a goal whose criterion is genuinely unquantifiable must
 * still be creatable, and the detail view renders the prose with no bars when
 * this is null. `current` is a snapshot the agent refreshes via goals:update —
 * it is NOT computed here, because most metrics (revenue, users, shipped
 * builds) live outside this database entirely.
 */
export const TripwireSchema = z.object({
  metric: z.string().min(1).max(60).describe('machine key, e.g. "days_elapsed" / "spend_usd"'),
  label: z.string().min(1).max(120).describe('how it reads to the owner, e.g. "Day 12 of 30"'),
  threshold: z.number().describe('the value at which the criterion trips'),
  current: z.number().optional().describe('latest observed value; omit until first measured'),
  unit: z.string().max(20).optional().describe('"usd" / "days" / "users" — display only'),
});
export type Tripwire = z.infer<typeof TripwireSchema>;

/**
 * The real postgres.js SQL handle both callers use. `goals:create` passes the
 * MCP request's typed `ctx.tx`; `goals:start` passes the org pool's `sql`.
 * Keeping the actual `Sql` type here prevents the old structural Promise-only
 * approximation from rejecting postgres.js's valid `PendingQuery` result.
 */
export type GoalSqlTag = Sql;

export interface GoalRowInput {
  id: string;
  installSlug: string;
  workspaceId: string;
  title: string;
  body?: string | null;
  parentId?: string | null;
  budgetCents?: number | null;
  status?: GoalStatus;
  killCriterion?: string | null;
  tripwires?: Tripwire[] | null;
  metadata?: Record<string, unknown> | null;
  /**
   * The goal's declared launch settings, holder policy included
   * (goal-live-holder-guarantee-2026-08-18 P-003).
   *
   * Written HERE rather than by a follow-up `writeGoalLaunchSettings` so the
   * policy lands in the SAME statement as the row it governs. The follow-up
   * shape has a window — a goal that exists for a moment with no declared
   * policy is exactly the state P-003's refusal exists to prevent, and on a
   * failure between the two writes that window never closes.
   *
   * Typed structurally rather than importing `GoalLaunchSettings`: this module
   * is deliberately free of imports beyond node/zod (see the header), and the
   * document is validated by the caller's schema before it reaches this row.
   */
  launchSettings?: Record<string, unknown> | null;
  /**
   * TRUE for a STANDING (stewardship) goal — one pursuing an ongoing duty
   * rather than a checkable outcome (work-on-everything-goal-2026-08-23 P-001,
   * migration 913).
   *
   * Omitted ⇒ the column default (`false`), which is an ORDINARY
   * outcome-shaped goal. Never write `false` here to mean "unknown": there is
   * no third state, and the default already covers every caller that has no
   * opinion — which is all of them except the goal-package start door.
   */
  standing?: boolean;
  /**
   * Denominator for `budgetCents` in SECONDS
   * (work-on-everything-goal-2026-08-23 P-004, migration 914).
   *
   * Omitted/null ⇒ the ceiling is per goal LIFETIME, which is what every
   * pre-P-004 caller means and what the column defaults to. A positive value
   * makes it spend-per-trailing-window — which a STANDING goal REQUIRES, since
   * an ongoing duty's lifetime spend crosses any finite ceiling by
   * construction, turning a lifetime ceiling into a scheduled auto-kill.
   *
   * Deliberately independent of `standing`: a window is a property of the
   * CEILING, not of the goal's polarity (D-001 — no bespoke rails).
   */
  budgetWindowSec?: number | null;
  /**
   * The goal's declared IO schemas + resolved start-time inputs
   * (work-on-everything-goal-2026-08-23 P-021, migration 927).
   *
   * Pass-through like `launchSettings`: validated by the CALLER (the start
   * door / set doors run operator-core's goal-io-validation ajv seam) before
   * they reach this row — this module stays free of imports beyond node/zod.
   * `outputs` is deliberately NOT here: outputs are reported at wind-down
   * (`applyGoalDisposition`), never at creation.
   */
  inputSchema?: Record<string, unknown> | null;
  inputs?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  /**
   * Typed property DECLARATIONS: name → { datatype, default?, editable_by }
   * (work-on-everything-goal-2026-08-23 P-023, migration 923).
   *
   * Pass-through like the IO schemas above: validated by the CALLER against
   * operator-core's typed-properties seam (zod shape + datatype_registry
   * refs) before it reaches this row. Omitted/null ⇒ the column default
   * (`{}`): no properties declared. VALUES are never written here — they land
   * only through goals:set-property (CAS + provenance, migration 923's
   * column comment is the contract).
   */
  propertySchema?: Record<string, unknown> | null;
}

/** Contract edits made to one packaged instance and inherited by later starts.
 * Live operational fields never belong here: the package remains the source
 * for standing, budgets, launch settings, inputs, and properties. */
export interface GoalPackageInstanceOverride {
  title?: string;
  body?: string | null;
  killCriterion?: string | null;
  tripwires?: unknown;
}

export const GOAL_PACKAGE_INSTANCE_OVERRIDE_KEY = 'packageInstanceOverride';

/** Read the narrow, user-authored contract overlay carried in goal metadata. */
export function readGoalPackageInstanceOverride(
  metadata: Record<string, unknown> | null | undefined,
): GoalPackageInstanceOverride | null {
  const raw = metadata?.[GOAL_PACKAGE_INSTANCE_OVERRIDE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const next: GoalPackageInstanceOverride = {};
  if (typeof source.title === 'string') next.title = source.title;
  if (typeof source.body === 'string' || source.body === null) next.body = source.body;
  if (typeof source.killCriterion === 'string' || source.killCriterion === null) {
    next.killCriterion = source.killCriterion;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'tripwires')) {
    next.tripwires = source.tripwires;
  }
  return Object.keys(next).length > 0 ? next : null;
}

/** Merge a packaged-instance contract edit without replacing unrelated metadata. */
export function withGoalPackageInstanceOverride(
  metadata: Record<string, unknown>,
  patch: GoalPackageInstanceOverride,
): Record<string, unknown> {
  return {
    ...metadata,
    [GOAL_PACKAGE_INSTANCE_OVERRIDE_KEY]: {
      ...(readGoalPackageInstanceOverride(metadata) ?? {}),
      ...patch,
    },
  };
}

/**
 * Write the goal row. Both writers go through here, so the column list has
 * exactly one home.
 *
 * The kill criterion is a first-class COLUMN (migration 765), not a metadata
 * key. It used to be folded into `metadata` because the column did not exist —
 * but the whole GUI reads it (the detail view's "THIS GOAL ENDS WHEN"
 * headline, the rail's glance), and a jsonb key cannot be indexed,
 * constrained, or joined the way the read path needs.
 */
export async function insertGoalRow(tx: GoalSqlTag, row: GoalRowInput): Promise<void> {
  const metadata = { ...(row.metadata ?? {}) };
  await tx`
    INSERT INTO harness_shared.goals
      (id, install_slug, workspace_id, title, body, parent_id, budget_cents, budget_window_sec,
       status, standing, kill_criterion, tripwires, metadata, launch_settings,
       input_schema, inputs, output_schema, property_schema)
    VALUES
      (${row.id}, ${row.installSlug}, ${row.workspaceId}, ${row.title}, ${row.body ?? null},
       ${row.parentId ?? null}, ${row.budgetCents ?? null}, ${row.budgetWindowSec ?? null},
       ${row.status ?? 'active'},
       ${row.standing ?? false},
       ${row.killCriterion ?? null},
       ${row.tripwires?.length ? JSON.stringify(row.tripwires) : null}::jsonb,
       ${Object.keys(metadata).length ? JSON.stringify(metadata) : null}::jsonb,
       ${row.launchSettings && Object.keys(row.launchSettings).length ? JSON.stringify(row.launchSettings) : null}::jsonb,
       ${row.inputSchema && Object.keys(row.inputSchema).length ? JSON.stringify(row.inputSchema) : null}::jsonb,
       ${row.inputs && Object.keys(row.inputs).length ? JSON.stringify(row.inputs) : null}::jsonb,
       ${row.outputSchema && Object.keys(row.outputSchema).length ? JSON.stringify(row.outputSchema) : null}::jsonb,
       COALESCE(${row.propertySchema && Object.keys(row.propertySchema).length ? JSON.stringify(row.propertySchema) : null}::jsonb, '{}'::jsonb))
  `;
}

/**
 * Undo `insertGoalRow` — used ONLY to roll back a goal whose agent failed to
 * spawn (`goals:start`). A goal with no agent is worse than no goal: it sits
 * on the board as an outcome somebody believes is being pursued, and nothing
 * is pursuing it.
 *
 * Deliberately id-scoped AND workspace-scoped: the id is minted per call and
 * cannot collide across workspaces, but `harness_shared.goals` is multi-tenant
 * and a rollback must never be able to reach another tenant's row.
 */
export async function deleteGoalRow(
  tx: GoalSqlTag,
  opts: { id: string; workspaceId: string },
): Promise<void> {
  await tx`
    DELETE FROM harness_shared.goals
     WHERE id = ${opts.id} AND workspace_id = ${opts.workspaceId}
  `;
}
