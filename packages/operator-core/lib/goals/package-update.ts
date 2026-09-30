/**
 * package-update.ts — the goal-package UPDATE story
 * (work-on-everything-goal-2026-08-23 P-018; D-002 rule 3: "a release shipping
 * v2 offers the update to a LIVE instance, never silently rewrites it").
 *
 * THE SPLIT, and why each half is where it is:
 *
 *   "new installs get v2"  — already true BY CONSTRUCTION: the layered disk
 *     store (goal-package-store.ts) re-resolves per call, so once a release
 *     bundles v2 every subsequent install/mint reads v2. Nothing here builds
 *     that; the bundle-integrity test asserts it.
 *
 *   THE OFFER — computed at READ time, never pushed by a sweep: an instance is
 *     "update-available" exactly when the store's current version is semver-
 *     newer than the `metadata.packageVersion` stamped at install/mint. The
 *     fold rides the surfaces that already exist (the HUD goals board rows and
 *     `goals:get`), mirroring how knowledge packs surface `updateAvailable` on
 *     their list — no new channel, no standing machinery (plan D-001).
 *
 *   THE ACCEPT — `applyGoalPackageUpdate`, reached through the explicit
 *     `goals:apply-package-update` door. NOTHING calls it automatically; the
 *     door IS the accepted offer. Two modes, split on the same predicate the
 *     start door uses (`isAdoptableStub`):
 *
 *       stub-refresh  — a never-started install stub gets a FULL refresh: the
 *         result is exactly what a fresh v2 install would have seeded (D-002's
 *         no-clobber blocks the re-install route to the same outcome, so the
 *         update door provides it). The pause record and identity stamps are
 *         kept; only content moves.
 *
 *       live-contract — a started instance gets CONTRACT fields only: title,
 *         body, killCriterion, tripwires (thresholds; `current` readings are
 *         preserved by metric), inputSchema, outputSchema. Operational tuning
 *         (standing, budgets, launchSettings) and live state (status, inputs,
 *         properties, pause/identity metadata) are NEVER touched — those were
 *         start-time folds or owner decisions, and retuning a live instance is
 *         a different deliberate act (`goals:update` / the set-* doors).
 *
 * The kickoff brief is pointer-to-contract (the agent re-reads its goal row),
 * so updating the row's body IS how a live duty updates — which is why the
 * apply door pairs with a `package_updated` plan event (emitted by the tool,
 * on the P-023 rail) so the owning agent's next orient folds the change.
 */

import type { Sql } from 'postgres';
import {
  listLocalGoalPackages,
  resolveLocalGoalPackage,
  type LocalGoalPackage,
  type GoalPackageTripwire,
} from '../cupboard/goal-package-store';
import { semverGt } from '../knowledge-packs/pack-format';

/** The offer, as folded onto read surfaces (HUD rows, goals:get). */
export interface GoalPackageUpdateInfo {
  /** The package's identity in the layered store (= metadata.goalPackageRef). */
  ref: string;
  /** The version stamped on THIS instance at install/mint. Null on a legacy
   *  instance that predates version stamping — comparison is then impossible
   *  and `updateAvailable` is false (honest, not optimistic). */
  installedVersion: string | null;
  /** The version the store currently resolves for `ref`. */
  availableVersion: string;
  /** semverGt(available, installed) — the one-boolean offer signal. */
  updateAvailable: boolean;
  layer: 'bundled' | 'user';
}

/**
 * Compute the offer for one goal's metadata. Null when the goal is not
 * packaged (no `goalPackageRef`) or the package no longer resolves on disk —
 * there is nothing to offer an update TO in either case.
 */
export function goalPackageUpdateInfo(
  metadata: Record<string, unknown> | null | undefined,
  lookup: (ref: string) => LocalGoalPackage | null = (ref) => resolveLocalGoalPackage(ref),
): GoalPackageUpdateInfo | null {
  const ref = typeof metadata?.goalPackageRef === 'string' ? metadata.goalPackageRef.trim() : '';
  if (!ref) return null;
  const pkg = lookup(ref);
  if (!pkg) return null;
  const installedVersion =
    typeof metadata?.packageVersion === 'string' && metadata.packageVersion !== ''
      ? metadata.packageVersion
      : null;
  return {
    ref,
    installedVersion,
    availableVersion: pkg.version,
    updateAvailable: semverGt(pkg.version, installedVersion ?? undefined),
    layer: pkg.layer,
  };
}

/**
 * A memoized store lookup for batch folds (one directory enumeration per
 * batch, not one per row). Lazy: a batch with no packaged goals never touches
 * the disk at all.
 */
export function makeGoalPackageLookup(): (ref: string) => LocalGoalPackage | null {
  let all: LocalGoalPackage[] | null = null;
  return (ref) => {
    const key = (ref ?? '').trim();
    if (!key) return null;
    if (all === null) all = listLocalGoalPackages();
    return all.find((p) => p.ref === key) ?? null;
  };
}

/** A live row's tripwire (package shape + the refreshed reading). */
export type GoalRowTripwire = GoalPackageTripwire & { current?: number | null };

/**
 * The new package's tripwires, with the instance's `current` readings carried
 * over BY METRIC — an accepted update changes thresholds, not measurements. A
 * metric the new package drops loses its reading with the row; a new metric
 * starts unmeasured (`current: null`, the tripwire-refresh convention).
 */
export function mergeTripwiresPreservingCurrent(
  next: GoalPackageTripwire[] | null,
  prior: unknown,
): GoalRowTripwire[] | null {
  if (!next) return null;
  const currentByMetric = new Map<string, number | null>();
  if (Array.isArray(prior)) {
    for (const t of prior) {
      if (t && typeof t === 'object' && typeof (t as { metric?: unknown }).metric === 'string') {
        const cur = (t as { current?: unknown }).current;
        currentByMetric.set(
          (t as { metric: string }).metric,
          typeof cur === 'number' && Number.isFinite(cur) ? cur : null,
        );
      }
    }
  }
  return next.map((t) => ({ ...t, current: currentByMetric.get(t.metric) ?? null }));
}

/** The goal-row slice the plan/apply path reads. */
export interface GoalRowForPackageUpdate {
  id: string;
  title: string;
  status: string;
  body: string | null;
  standing: boolean;
  kill_criterion: string | null;
  tripwires: unknown;
  budget_cents: number | null;
  budget_window_sec: number | null;
  launch_settings: Record<string, unknown> | null;
  input_schema: Record<string, unknown> | null;
  output_schema: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export type GoalPackageUpdateMode = 'stub-refresh' | 'live-contract';

export interface GoalPackageFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export type GoalPackageUpdatePlan =
  | {
      ok: true;
      goalId: string;
      ref: string;
      mode: GoalPackageUpdateMode;
      fromVersion: string | null;
      toVersion: string;
      /** Per-field diff of what apply would write (may be empty on a pure
       *  version bump — the stamp still moves). */
      changes: GoalPackageFieldChange[];
      /** Fields an apply in this mode deliberately does NOT touch. */
      withheld: string[];
    }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'not-packaged'
        | 'package-not-found'
        | 'up-to-date'
        | 'version-unstamped'
        | 'terminal-instance'
        | 'contract-problem';
      detail: string;
      fromVersion?: string | null;
      toVersion?: string;
    };

export interface GoalPackageUpdateDeps {
  resolvePackage: (ref: string) => LocalGoalPackage | null;
  readRow: (
    sql: Sql,
    o: { workspaceId: string; goalId: string },
  ) => Promise<GoalRowForPackageUpdate | null>;
  /** Full content refresh of a never-started stub (= fresh-install seed). */
  writeStubRefresh: (
    sql: Sql,
    o: {
      workspaceId: string;
      goalId: string;
      pkg: LocalGoalPackage;
      metadata: Record<string, unknown>;
    },
  ) => Promise<void>;
  /** Contract-fields-only write for a started instance. */
  writeLiveContract: (
    sql: Sql,
    o: {
      workspaceId: string;
      goalId: string;
      pkg: LocalGoalPackage;
      tripwires: GoalRowTripwire[] | null;
      metadata: Record<string, unknown>;
    },
  ) => Promise<void>;
}

const DEFAULT_DEPS: GoalPackageUpdateDeps = {
  resolvePackage: (ref) => resolveLocalGoalPackage(ref),
  readRow: async (sql, { workspaceId, goalId }) => {
    const rows = (await sql`
      SELECT id, title, status, body, standing, kill_criterion, tripwires,
             budget_cents, budget_window_sec, launch_settings, input_schema,
             output_schema, metadata
        FROM harness_shared.goals
       WHERE workspace_id = ${workspaceId} AND id = ${goalId}
       LIMIT 1`) as unknown as GoalRowForPackageUpdate[];
    return rows[0] ?? null;
  },
  writeStubRefresh: async (sql, { workspaceId, goalId, pkg, metadata }) => {
    await sql`
      UPDATE harness_shared.goals
         SET title = ${pkg.title},
             body = ${pkg.body},
             standing = ${pkg.standing},
             kill_criterion = ${pkg.killCriterion},
             tripwires = ${pkg.tripwires ? JSON.stringify(pkg.tripwires) : null}::jsonb,
             budget_cents = ${pkg.budgetCents},
             budget_window_sec = ${pkg.budgetWindowSec},
             launch_settings = ${pkg.launchSettings ? JSON.stringify(pkg.launchSettings) : null}::jsonb,
             input_schema = ${pkg.inputSchema ? JSON.stringify(pkg.inputSchema) : null}::jsonb,
             output_schema = ${pkg.outputSchema ? JSON.stringify(pkg.outputSchema) : null}::jsonb,
             metadata = ${JSON.stringify(metadata)}::jsonb,
             updated_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${goalId}`;
  },
  writeLiveContract: async (sql, { workspaceId, goalId, pkg, tripwires, metadata }) => {
    await sql`
      UPDATE harness_shared.goals
         SET title = ${pkg.title},
             body = ${pkg.body},
             kill_criterion = ${pkg.killCriterion},
             tripwires = ${tripwires ? JSON.stringify(tripwires) : null}::jsonb,
             input_schema = ${pkg.inputSchema ? JSON.stringify(pkg.inputSchema) : null}::jsonb,
             output_schema = ${pkg.outputSchema ? JSON.stringify(pkg.outputSchema) : null}::jsonb,
             metadata = ${JSON.stringify(metadata)}::jsonb,
             updated_at = now()
       WHERE workspace_id = ${workspaceId} AND id = ${goalId}`;
  },
};

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const change = (field: string, from: unknown, to: unknown): GoalPackageFieldChange | null =>
  same(from, to) ? null : { field, from: from ?? null, to: to ?? null };

/** Fields a live-contract apply deliberately never touches. */
export const LIVE_CONTRACT_WITHHELD = [
  'standing',
  'budgetCents',
  'budgetWindowSec',
  'launchSettings',
  'status',
  'inputs',
  'properties',
] as const;

/**
 * Plan (dry-run) one instance's package update: which mode applies, the
 * per-field diff, and what is withheld — or the refusal, stated precisely.
 */
export async function planGoalPackageUpdate(
  sql: Sql,
  input: { workspaceId: string; goalId: string },
  deps: GoalPackageUpdateDeps = DEFAULT_DEPS,
): Promise<GoalPackageUpdatePlan> {
  const row = await deps.readRow(sql, input);
  if (!row) {
    return { ok: false, reason: 'not-found', detail: `no goal '${input.goalId}' in this workspace` };
  }
  const metadata = row.metadata ?? {};
  const ref = typeof metadata.goalPackageRef === 'string' ? metadata.goalPackageRef.trim() : '';
  if (!ref) {
    return {
      ok: false,
      reason: 'not-packaged',
      detail: `goal '${row.id}' carries no metadata.goalPackageRef — it was not minted from a goal package, so there is no package to update it from`,
    };
  }
  const pkg = deps.resolvePackage(ref);
  if (!pkg) {
    return {
      ok: false,
      reason: 'package-not-found',
      detail: `package '${ref}' no longer resolves in the local store (bundled or user layer)`,
    };
  }
  const installed =
    typeof metadata.packageVersion === 'string' && metadata.packageVersion !== ''
      ? metadata.packageVersion
      : null;
  if (installed === null) {
    return {
      ok: false,
      reason: 'version-unstamped',
      detail:
        `goal '${row.id}' has no metadata.packageVersion stamp (predates version stamping), so ` +
        `there is no honest way to tell whether ${pkg.version} is newer — update it via goals:update if the content should change`,
      fromVersion: null,
      toVersion: pkg.version,
    };
  }
  if (!semverGt(pkg.version, installed)) {
    return {
      ok: false,
      reason: 'up-to-date',
      detail: `installed ${installed}, store has ${pkg.version} — nothing newer to apply`,
      fromVersion: installed,
      toVersion: pkg.version,
    };
  }
  if (row.status === 'achieved' || row.status === 'killed') {
    return {
      ok: false,
      reason: 'terminal-instance',
      detail: `goal '${row.id}' is ${row.status} — a terminal instance is a record, not a pursuit; install/start the package fresh instead`,
      fromVersion: installed,
      toVersion: pkg.version,
    };
  }
  // Pulled lazily: install-goal-io drags git/install machinery and
  // start-from-package drags the start door's graph — the SYNC offer folds
  // above must stay importable from hot paths (sync-resolver) without paying
  // for either at module load.
  const [{ goalPackageContractProblem }, { isAdoptableStub }] = await Promise.all([
    import('../cupboard/install-goal-io'),
    import('./start-from-package'),
  ]);
  // The same refuse-don't-degrade gate the installer runs: never write a
  // contract that reads as configured while binding nothing.
  const problem = goalPackageContractProblem(pkg);
  if (problem) {
    return {
      ok: false,
      reason: 'contract-problem',
      detail: problem,
      fromVersion: installed,
      toVersion: pkg.version,
    };
  }

  if (isAdoptableStub(row)) {
    const changes = [
      change('title', row.title, pkg.title),
      change('body', row.body, pkg.body),
      change('standing', row.standing, pkg.standing),
      change('killCriterion', row.kill_criterion, pkg.killCriterion),
      change('tripwires', row.tripwires, pkg.tripwires),
      change('budgetCents', row.budget_cents, pkg.budgetCents),
      change('budgetWindowSec', row.budget_window_sec, pkg.budgetWindowSec),
      change('launchSettings', row.launch_settings, pkg.launchSettings),
      change('inputSchema', row.input_schema, pkg.inputSchema),
      change('outputSchema', row.output_schema, pkg.outputSchema),
    ].filter((c): c is GoalPackageFieldChange => c !== null);
    return {
      ok: true,
      goalId: row.id,
      ref,
      mode: 'stub-refresh',
      fromVersion: installed,
      toVersion: pkg.version,
      changes,
      withheld: ['status', 'pause record', 'goalPackageRef'],
    };
  }

  const mergedTripwires = mergeTripwiresPreservingCurrent(pkg.tripwires, row.tripwires);
  const changes = [
    change('title', row.title, pkg.title),
    change('body', row.body, pkg.body),
    change('killCriterion', row.kill_criterion, pkg.killCriterion),
    change('tripwires', row.tripwires, mergedTripwires),
    change('inputSchema', row.input_schema, pkg.inputSchema),
    change('outputSchema', row.output_schema, pkg.outputSchema),
  ].filter((c): c is GoalPackageFieldChange => c !== null);
  return {
    ok: true,
    goalId: row.id,
    ref,
    mode: 'live-contract',
    fromVersion: installed,
    toVersion: pkg.version,
    changes,
    withheld: [...LIVE_CONTRACT_WITHHELD],
  };
}

export type GoalPackageUpdateApplied =
  | {
      ok: true;
      goalId: string;
      ref: string;
      mode: GoalPackageUpdateMode;
      fromVersion: string | null;
      toVersion: string;
      /** The field names actually written (plus the version stamp, always). */
      applied: string[];
      withheld: string[];
    }
  | Extract<GoalPackageUpdatePlan, { ok: false }>;

/**
 * Apply one instance's package update — the accepted offer. Plans first (same
 * refusals), then writes per mode. `metadata.packageVersion` moves to the
 * store's version; every other metadata key (pause record, identity stamps,
 * goalPackageRef) is preserved verbatim.
 */
export async function applyGoalPackageUpdate(
  sql: Sql,
  input: { workspaceId: string; goalId: string },
  deps: GoalPackageUpdateDeps = DEFAULT_DEPS,
): Promise<GoalPackageUpdateApplied> {
  const plan = await planGoalPackageUpdate(sql, input, deps);
  if (!plan.ok) return plan;
  // Re-read is not needed: plan just read the row through the same deps in
  // this call. A racing write between plan and apply loses only cosmetically
  // (the diff reported vs written), never structurally — both writes are
  // whole-field REPLACEs derived from the package, not read-modify-writes of
  // row values (the one merged value, tripwire `current`, is re-derived below).
  const row = await deps.readRow(sql, input);
  if (!row) {
    return { ok: false, reason: 'not-found', detail: `goal '${input.goalId}' vanished mid-apply` };
  }
  const pkg = deps.resolvePackage(plan.ref);
  if (!pkg) {
    return {
      ok: false,
      reason: 'package-not-found',
      detail: `package '${plan.ref}' no longer resolves in the local store`,
    };
  }
  const metadata = { ...(row.metadata ?? {}), packageVersion: pkg.version };
  if (plan.mode === 'stub-refresh') {
    await deps.writeStubRefresh(sql, {
      workspaceId: input.workspaceId,
      goalId: plan.goalId,
      pkg,
      metadata,
    });
  } else {
    await deps.writeLiveContract(sql, {
      workspaceId: input.workspaceId,
      goalId: plan.goalId,
      pkg,
      tripwires: mergeTripwiresPreservingCurrent(pkg.tripwires, row.tripwires),
      metadata,
    });
  }
  return {
    ok: true,
    goalId: plan.goalId,
    ref: plan.ref,
    mode: plan.mode,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    applied: [...plan.changes.map((c) => c.field), 'metadata.packageVersion'],
    withheld: plan.withheld,
  };
}
