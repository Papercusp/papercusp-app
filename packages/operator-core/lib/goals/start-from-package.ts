/**
 * start-from-package.ts — deliberate instantiation of an INSTALLED goal package
 * (work-on-everything-goal-2026-08-23 P-017; D-002: install ≠ start).
 *
 * The Cupboard install path (install-goal-io.ts) lands an INACTIVE paused stub
 * stamped `metadata.goalPackageRef` — no agent, no spend. THIS is the other
 * half of D-002's split: the deliberate act that turns an installed package
 * into a pursued goal. It:
 *
 *   1. resolves the PACKAGE from the layered disk store (bundled or user);
 *   2. collects TYPED INPUTS (P-021) via `evaluateGoalStartInputs` — the same
 *      gate `goals:start` consults, so two doors cannot drift into two notions
 *      of "ready";
 *   3. reports ALREADY-ACTIVE instances of the same package — INFO, never a
 *      gate (the plan item states this outright): a second deliberate start
 *      mints a second instance;
 *   4. ADOPTS the seeded stub when it is still unstarted (paused, no
 *      `agentOwnerId` ever stamped), else MINTS a fresh instance row from the
 *      package content;
 *   5. folds STANDING DEFAULTS at start (see `effectiveGoalContent`):
 *      holder `{ requireLive: true, onLoss: 'respawn' }`, a rolling budget
 *      window for a windowless standing ceiling, drain-fleet auto-mint;
 *   6. converges on `startGoalById` — D-006's ONE activation primitive — so the
 *      idempotence guard, the readiness gate and the launch-policy ceilings
 *      (budget/headcount refusals) all apply for free; the kickoff brief is
 *      `buildGoalKickoffBrief` from the instance's content (pointer-to-contract
 *      style, never a second copy).
 *
 * NOT routed through `autoStartGoal` — its D-005 criterion+budget mandate stays
 * intact per this plan's D-003 (which binds P-017 only if it takes that route;
 * it does not).
 *
 * THE P-022 CONSTRUCTOR (LANDED): a package may carry `construct.js` —
 * `construct(typedInputs) => spec`, pure + sandboxed + double-run-deterministic
 * (package-constructor.ts is the runtime; this file is the ONE call site). Run
 * at START never install. It interposes in exactly ONE place: after the
 * typed-input gate, the validated spec merges OVER the static content and the
 * merged content flows through `effectiveGoalContent` — still the single fold
 * from package content to the effective instance fields. Do not add a second
 * content path.
 *
 * COMPENSATION CONTRACT. `startGoalById` REFUSES (ok:false) strictly before
 * anything spawns, so a refusal is safe to compensate — the minted row is
 * deleted / the adopted stub restored — EXCEPT `already-held` and
 * `holder-unknown`, where a holder may exist and unwinding would pause a goal
 * somebody is (or may be) live on. A THROW from the primitive means the spawn
 * already happened (irreversible); the row stays and the liveness watchdog is
 * the designed backstop, exactly as the primitive's own error text says.
 */

import type { Sql } from 'postgres';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import { goalId as mintGoalId, insertGoalRow, deleteGoalRow } from '@papercusp/agent-mcp/goals';
import { clearGoalPause } from '@papercusp/agent-mcp/goal-pause';
import {
  resolveLocalGoalPackage,
  readGoalPackageConstructScript,
  type LocalGoalPackage,
  type GoalPackageTripwire,
} from '../cupboard/goal-package-store';
import { runPackageConstructor, type PackageConstructorResult } from './package-constructor';
import { buildGoalKickoffBrief } from '../agent-tools/goals/start';
import { GOAL_HOLDER_DEFAULTS } from '../goal-launch-settings-shared';
import { drainFleetTopologyProblem } from '../goal-launch-settings';
import { evaluateGoalStartInputs } from './goal-io-validation';
import { ensurePlanRefListDatatype, withCanonicalWorklistDeclaration } from './package-property-datatypes';
import { validatePropertySchemaDeclaration } from '../typed-properties-db';
import { startGoalById } from './start-goal-by-id';
import { drainFleetAutoMintEnabled, mintDrainFleetForGoal } from './drain-fleet-mint';
import { killCriterionProblem } from './kill-criterion';
import { readGoalPackageInstanceOverride } from '@papercusp/agent-mcp/goals';

/**
 * The rolling-window default for a STANDING ceiling that declares none: one
 * week. A standing goal's lifetime spend crosses any finite ceiling eventually,
 * so a windowless ceiling on one is really a scheduled auto-kill — the exact
 * P-004 hazard. Applied ONLY when the package sets `budgetCents` without
 * `budgetWindowSec`; a package that chose its window keeps it, and a package
 * with no ceiling gets no window invented for it.
 */
export const STANDING_GOAL_DEFAULT_BUDGET_WINDOW_SEC = 604_800;

/**
 * The standing holder default (the plan item names it verbatim). `respawn`
 * rather than the system-wide `deactivate` (GOAL_HOLDER_DEFAULTS) because a
 * standing DUTY going quiet is a failure, not a completion — the respawn rail
 * this plan's P-010 consumed exists precisely for it. A package that pins its
 * own holder policy is left alone.
 */
export const STANDING_GOAL_HOLDER_DEFAULT = { requireLive: true, onLoss: 'respawn' } as const;

/** The content shape the fold reads — satisfied structurally by both a
 *  `LocalGoalPackage` (mint path) and a stub row's mapped fields (adopt path). */
export interface GoalPackageContent {
  title: string;
  body: string | null;
  standing: boolean;
  killCriterion: string | null;
  tripwires: GoalPackageTripwire[] | null;
  budgetCents: number | null;
  budgetWindowSec: number | null;
  launchSettings: Record<string, unknown> | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  /** Typed property DECLARATIONS (P-023 shape), landed on the minted row's
   *  `property_schema`. Declarations are SHAPE — runtime `properties` values
   *  are live state and never ride package content. */
  propertySchema: Record<string, unknown> | null;
}

export interface EffectiveGoalContent extends GoalPackageContent {
  launchSettings: Record<string, unknown>;
  /** Human-readable disclosure of every default this fold applied — surfaced
   *  verbatim on the result so a start never silently installs a policy. */
  appliedDefaults: string[];
}

/**
 * THE single fold from package content to the effective instance fields —
 * standing defaults applied, everything else passed through. P-022's
 * `construct(typedInputs)` interposes HERE when it lands (run before the
 * defaults, so a constructed spec gets the same rails as a static one).
 */
export function effectiveGoalContent(content: GoalPackageContent): EffectiveGoalContent {
  const appliedDefaults: string[] = [];
  const launchSettings: Record<string, unknown> = { ...(content.launchSettings ?? {}) };

  // Holder policy: this door SPAWNS the holding session, so it is the caller
  // "uniquely positioned to answer" (goalHolderPolicyProblem's rule) — an
  // undeclared policy is declared here rather than left to trip the write
  // boundary. A package that pinned one is respected untouched.
  if (launchSettings.holder == null) {
    if (content.standing) {
      launchSettings.holder = { ...STANDING_GOAL_HOLDER_DEFAULT };
      appliedDefaults.push(
        `holder { requireLive: true, onLoss: 'respawn' } (standing default — a standing duty respawns its holder rather than going quiet)`,
      );
    } else {
      launchSettings.holder = { requireLive: true };
      appliedDefaults.push(
        `holder { requireLive: true, onLoss: '${GOAL_HOLDER_DEFAULTS.onLoss}' } (this door spawns the holding session, so the goal requires a live holder)`,
      );
    }
  }

  let budgetWindowSec = content.budgetWindowSec;
  if (content.standing && content.budgetCents != null && budgetWindowSec == null) {
    budgetWindowSec = STANDING_GOAL_DEFAULT_BUDGET_WINDOW_SEC;
    appliedDefaults.push(
      `budgetWindowSec ${STANDING_GOAL_DEFAULT_BUDGET_WINDOW_SEC} (standing default — a windowless ceiling on a standing goal is a scheduled auto-kill, P-004)`,
    );
  }

  return { ...content, launchSettings, budgetWindowSec, appliedDefaults };
}

/** One existing goal carrying this package's stamp, as reported (info, not a gate). */
export interface PackageInstance {
  id: string;
  title: string;
  status: string;
  installSlug: string | null;
  /** True when this row is the seeded, never-started stub (paused, no agent ever attached). */
  adoptableStub: boolean;
}

/** The stub row's fields the adopt path needs — mapped into the fold's shape. */
interface StubRow {
  id: string;
  title: string;
  status: string;
  install_slug: string | null;
  body: string | null;
  standing: boolean;
  kill_criterion: string | null;
  tripwires: unknown;
  budget_cents: number | null;
  budget_window_sec: number | null;
  launch_settings: Record<string, unknown> | null;
  input_schema: Record<string, unknown> | null;
  output_schema: Record<string, unknown> | null;
  property_schema: Record<string, unknown> | null;
  inputs: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface StartGoalFromPackageInput {
  workspaceId: string;
  /** The package's subdir ref — its identity in the layered store and the
   *  `metadata.goalPackageRef` stamp on its instances. */
  ref: string;
  /** Harness for a freshly-minted instance. Falls back to the adopted stub's
   *  own install_slug; REQUIRED when minting with no stub to adopt. */
  harness?: string | null;
  /** Typed start inputs (P-021), validated against the content's inputSchema. */
  inputs?: Record<string, unknown> | null;
  launcherOwnerId?: string | null;
  startBlocked?: boolean;
  startBlockedReason?: string | null;
  /** Test/probe seam, forwarded to the activation primitive. */
  deferSpawn?: boolean;
}

export type StartGoalFromPackageResult =
  | {
      ok: true;
      goalId: string;
      ownerId: string;
      /** True when the seeded install stub was adopted; false when a fresh
       *  instance row was minted. */
      adopted: boolean;
      /** Disclosure: every standing/holder default the fold applied. */
      appliedDefaults: string[];
      /** P-022 disclosure: the content keys construct.js built (empty for a
       *  static package) — a start never silently swaps authored content. */
      constructedKeys: string[];
      /** Already-active instances of the same package at start time — INFO. */
      activeInstances: PackageInstance[];
      drainFleet: string | null;
      warnings: string[];
    }
  | {
      ok: false;
      reason: string;
      detail: string;
      activeInstances?: PackageInstance[];
    };

export interface StartGoalFromPackageDeps {
  resolvePackage: (ref: string) => LocalGoalPackage | null;
  /** P-022: read the package's construct script (`null` = static package). */
  readConstructScript: (pkg: LocalGoalPackage) => string | null;
  /** P-022: run it — sandboxed, strict-validated, double-run-deterministic.
   *  A deps seam so tests exercise the wiring without a real worker. */
  runConstructor: (
    script: string,
    typedInputs: Record<string, unknown> | null,
  ) => Promise<PackageConstructorResult>;
  readInstances: (sql: Sql, opts: { workspaceId: string; ref: string }) => Promise<StubRow[]>;
  adoptStub: (
    sql: Sql,
    opts: {
      workspaceId: string;
      goalId: string;
      inputs: Record<string, unknown> | null;
      launchSettings: Record<string, unknown>;
      budgetWindowSec: number | null;
      /** P-022: non-null when a constructor ran — the adopted row's static
       *  content columns are rewritten to the constructed effective content
       *  (the stub was seeded from static package content and cannot know
       *  what construct built). */
      constructedContent: EffectiveGoalContent | null;
      metadata: Record<string, unknown>;
    },
  ) => Promise<void>;
  restoreStub: (sql: Sql, opts: { workspaceId: string; stub: StubRow }) => Promise<void>;
  mintRow: (
    sql: Sql,
    opts: {
      workspaceId: string;
      id: string;
      installSlug: string;
      content: EffectiveGoalContent;
      inputs: Record<string, unknown> | null;
      metadata: Record<string, unknown>;
    },
  ) => Promise<void>;
  deleteRow: (sql: Sql, opts: { id: string; workspaceId: string }) => Promise<void>;
  stampAgentOwner: (
    sql: Sql,
    opts: { workspaceId: string; goalId: string; ownerId: string },
  ) => Promise<void>;
  startById: typeof startGoalById;
  drainEnabled: () => Promise<boolean>;
  mintDrain: typeof mintDrainFleetForGoal;
  /** Ensure the first-party package datatypes exist (insert-if-absent) before a
   *  minted declaration is validated against the registry (P-025). */
  ensurePropertyDatatypes: (sql: Sql, opts: { workspaceId: string }) => Promise<void>;
  /** Validate a propertySchema declaration document against the registry. */
  validatePropertySchema: (
    sql: Sql,
    opts: { workspaceId: string; doc: Record<string, unknown> },
  ) => Promise<{ ok: true } | { ok: false; issues: string[] }>;
  buildBrief: (opts: {
    goalId: string;
    title: string;
    killCriterion?: string | null;
    budgetCents?: number | null;
    body?: string | null;
    standing?: boolean;
    budgetWindowSec?: number | null;
  }) => string;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Exported as a TEST SEAM (same spirit as `startGoalById`'s `deferSpawn`): the
 * package-goal E2E (P-016, package-goal-e2e.integration.test.ts) spreads these
 * REAL deps and overrides only the process-spawn boundary — copying the SQL
 * closures into the test would be a second content path that drifts.
 */
export const DEFAULT_DEPS: StartGoalFromPackageDeps = {
  resolvePackage: (ref) => resolveLocalGoalPackage(ref),
  readConstructScript: (pkg) => readGoalPackageConstructScript(pkg),
  runConstructor: (script, typedInputs) => runPackageConstructor(script, typedInputs),
  readInstances: async (sql, { workspaceId, ref }) => {
    return (await sql`
      SELECT id, title, status, install_slug, body, standing, kill_criterion, tripwires,
             budget_cents, budget_window_sec, launch_settings, input_schema, output_schema,
             property_schema, inputs, metadata
        FROM harness_shared.goals
       WHERE workspace_id = ${workspaceId}
         AND metadata->>'goalPackageRef' = ${ref}
       ORDER BY updated_at DESC, id DESC`) as unknown as StubRow[];
  },
  adoptStub: async (sql, o) => {
    await sql`
      UPDATE harness_shared.goals
         SET status = 'active',
             inputs = ${o.inputs ? JSON.stringify(o.inputs) : null}::jsonb,
             launch_settings = ${JSON.stringify(o.launchSettings)}::jsonb,
             budget_window_sec = ${o.budgetWindowSec},
             metadata = ${JSON.stringify(o.metadata)}::jsonb
       WHERE id = ${o.goalId} AND workspace_id = ${o.workspaceId}`;
    // P-022: a constructor ran — the stub's static content columns are stale
    // against the constructed effective content; rewrite them so the adopted
    // instance matches what a fresh mint would have inserted.
    if (o.constructedContent) {
      const c = o.constructedContent;
      await sql`
        UPDATE harness_shared.goals
           SET title = ${c.title},
               body = ${c.body},
               standing = ${c.standing},
               kill_criterion = ${c.killCriterion},
               tripwires = ${c.tripwires ? JSON.stringify(c.tripwires) : null}::jsonb,
               budget_cents = ${c.budgetCents},
               output_schema = ${c.outputSchema ? JSON.stringify(c.outputSchema) : null}::jsonb,
               property_schema = ${c.propertySchema ? JSON.stringify(c.propertySchema) : null}::jsonb
         WHERE id = ${o.goalId} AND workspace_id = ${o.workspaceId}`;
    }
  },
  restoreStub: async (sql, { workspaceId, stub }) => {
    // Restores the CONTENT columns too (not only the activation fields): a
    // P-022 constructor may have rewritten them on adopt, and the stub row we
    // hold carries the pre-adopt originals.
    await sql`
      UPDATE harness_shared.goals
         SET status = ${stub.status},
             inputs = ${stub.inputs ? JSON.stringify(stub.inputs) : null}::jsonb,
             launch_settings = ${stub.launch_settings ? JSON.stringify(stub.launch_settings) : null}::jsonb,
             budget_window_sec = ${stub.budget_window_sec},
             metadata = ${stub.metadata ? JSON.stringify(stub.metadata) : null}::jsonb,
             title = ${stub.title},
             body = ${stub.body},
             standing = ${stub.standing},
             kill_criterion = ${stub.kill_criterion},
             tripwires = ${Array.isArray(stub.tripwires) ? JSON.stringify(stub.tripwires) : null}::jsonb,
             budget_cents = ${stub.budget_cents},
             output_schema = ${stub.output_schema ? JSON.stringify(stub.output_schema) : null}::jsonb,
             property_schema = ${stub.property_schema ? JSON.stringify(stub.property_schema) : null}::jsonb
       WHERE id = ${stub.id} AND workspace_id = ${workspaceId}`;
  },
  mintRow: async (sql, { workspaceId, id, installSlug, content, inputs, metadata }) => {
    // Every minted goal declares the canonical `worklist` (EI-23745110935212173):
    // a package that declares no properties would otherwise land with
    // property_schema '{}' and could never have a worklist written to it.
    // Non-destructive — a package declaring `worklist` keeps its own.
    const seededPropertySchema = withCanonicalWorklistDeclaration(content.propertySchema);
    await insertGoalRow(sql as unknown as GoalSqlTag, {
      id,
      installSlug,
      workspaceId,
      title: content.title,
      body: content.body,
      standing: content.standing,
      killCriterion: content.killCriterion,
      tripwires: content.tripwires ?? null,
      budgetCents: content.budgetCents,
      budgetWindowSec: content.budgetWindowSec,
      launchSettings: content.launchSettings,
      inputSchema: content.inputSchema,
      inputs,
      outputSchema: content.outputSchema,
      propertySchema: seededPropertySchema,
      status: 'active',
      metadata,
    });
  },
  deleteRow: (sql, opts) => deleteGoalRow(sql as unknown as GoalSqlTag, opts),
  stampAgentOwner: async (sql, { workspaceId, goalId, ownerId }) => {
    await sql`
      UPDATE harness_shared.goals
         SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('agentOwnerId', ${ownerId}::text)
       WHERE id = ${goalId} AND workspace_id = ${workspaceId}`;
  },
  startById: startGoalById,
  drainEnabled: drainFleetAutoMintEnabled,
  mintDrain: mintDrainFleetForGoal,
  ensurePropertyDatatypes: async (sql, { workspaceId }) => {
    await ensurePlanRefListDatatype(sql, workspaceId);
  },
  validatePropertySchema: async (sql, { workspaceId, doc }) => {
    const check = await validatePropertySchemaDeclaration(sql, workspaceId, doc);
    return check.ok ? { ok: true } : { ok: false, issues: check.issues };
  },
  buildBrief: buildGoalKickoffBrief,
};

/** True for the seeded, never-started install stub: paused, and no agent was
 *  ever attached (the install seeder deliberately mints no identity).
 *  Exported (structurally typed) so the update door (package-update.ts,
 *  P-018) splits stub-refresh vs live-contract on the SAME predicate the
 *  adopt path uses — two definitions of "never started" would drift. */
export function isAdoptableStub(row: {
  status: string;
  metadata: Record<string, unknown> | null;
}): boolean {
  return row.status === 'paused' && !(row.metadata ?? {}).agentOwnerId;
}

function instanceView(row: StubRow): PackageInstance {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    installSlug: row.install_slug,
    adoptableStub: isAdoptableStub(row),
  };
}

/**
 * Start a goal from an installed package — adopt the unstarted stub or mint a
 * fresh instance, then activate through the ONE primitive. See the header for
 * the compensation contract.
 */
export async function startGoalFromPackage(
  sql: Sql,
  input: StartGoalFromPackageInput,
  deps: StartGoalFromPackageDeps = DEFAULT_DEPS,
): Promise<StartGoalFromPackageResult> {
  const workspaceId = input.workspaceId?.trim();
  const ref = input.ref?.trim();
  if (!workspaceId) throw new Error('startGoalFromPackage requires workspaceId');
  if (!ref) throw new Error('startGoalFromPackage requires ref');

  // ── 1. the package (disk, layered store) ────────────────────────────────
  const pkg = deps.resolvePackage(ref);
  if (!pkg) {
    return {
      ok: false,
      reason: 'package-not-found',
      detail:
        `no goal package '${ref}' in the local store (bundled or user layer) — ` +
        `install it first (cupboard:install-goal), or check cupboard:search { kind: 'goal' }`,
    };
  }

  // ── 2. existing instances: the adoptable stub + the info list ───────────
  const rows = await deps.readInstances(sql, { workspaceId, ref });
  const activeInstances = rows.filter((r) => r.status === 'active').map(instanceView);
  const stub = rows.find(isAdoptableStub) ?? null;
  const adopting = stub !== null;

  // ── 3. the STATIC content (stub row when adopting, else the package) ────
  const staticContent: GoalPackageContent = adopting
    ? {
        title: stub.title,
        body: stub.body,
        standing: stub.standing,
        killCriterion: stub.kill_criterion,
        tripwires: Array.isArray(stub.tripwires) ? (stub.tripwires as GoalPackageTripwire[]) : null,
        budgetCents: stub.budget_cents,
        budgetWindowSec: stub.budget_window_sec,
        launchSettings: asObj(stub.launch_settings),
        inputSchema: asObj(stub.input_schema),
        outputSchema: asObj(stub.output_schema),
        propertySchema: asObj(stub.property_schema),
      }
    : pkg;
  const inheritedOverride = adopting
    ? null
    : rows.map((row) => readGoalPackageInstanceOverride(row.metadata)).find((override) => override !== null) ?? null;

  // ── 4. typed inputs (P-021) — the same gate goals:start consults. Runs
  // BEFORE the constructor on purpose: construct CONSUMES the validated typed
  // inputs, and `inputSchema` is not constructible, so the gate's contract is
  // fixed before any third-party package code executes. ───────────────────
  const inputsVerdict = evaluateGoalStartInputs(staticContent.inputSchema, input.inputs ?? null);
  if (!inputsVerdict.ready) {
    return {
      ok: false,
      reason: 'inputs-not-ready',
      detail: `inputs refused (${inputsVerdict.code}): ${inputsVerdict.hint}`,
      activeInstances,
    };
  }

  // ── 4b. P-022: the constructor — sandboxed, strict, double-run-checked
  // (package-constructor.ts). The validated spec merges OVER the static
  // content; the merged content then takes the SAME fold + rails as a static
  // one. A refusal surfaces the runtime's typed reason verbatim.
  let content: GoalPackageContent = staticContent;
  let constructedKeys: string[] = [];
  const constructScript = deps.readConstructScript(pkg);
  if (constructScript !== null) {
    const built = await deps.runConstructor(constructScript, inputsVerdict.inputs);
    if (!built.ok) {
      return { ok: false, reason: built.reason, detail: built.detail, activeInstances };
    }
    content = { ...staticContent, ...built.spec };
    constructedKeys = built.overriddenKeys;
  }
  // A direct edit to a packaged instance is a local contract amendment, not
  // package live state. Apply it after construction so a later instance keeps
  // the authored directive even when the package also has a constructor.
  if (inheritedOverride) {
    const inheritedContentOverride: Partial<GoalPackageContent> = {
      ...(inheritedOverride.title !== undefined ? { title: inheritedOverride.title } : {}),
      ...(inheritedOverride.body !== undefined ? { body: inheritedOverride.body } : {}),
      ...(inheritedOverride.killCriterion !== undefined
        ? { killCriterion: inheritedOverride.killCriterion }
        : {}),
      ...(inheritedOverride.tripwires === null || Array.isArray(inheritedOverride.tripwires)
        ? { tripwires: inheritedOverride.tripwires as GoalPackageTripwire[] | null }
        : {}),
    };
    content = { ...content, ...inheritedContentOverride };
  }
  const effective = effectiveGoalContent(content);

  const criterion = effective.killCriterion?.trim();
  if (criterion) {
    const problem = killCriterionProblem(criterion);
    if (problem) {
      return {
        ok: false,
        reason: 'kill-criterion-invalid',
        detail: problem,
        activeInstances,
      };
    }
  }

  // EI-24556293106348130: the same drain-topology floor goals:start enforces.
  // This door mints the drain fleet rows below, and the watchdog then launches
  // its leader and worker under these ceilings; below the floor the worker is
  // refused every time and the fleet runs leader-only. Decided once and reused
  // at the mint so the floor and the mint cannot disagree.
  const mintsDrainFleet = await deps.drainEnabled();
  if (mintsDrainFleet) {
    const topologyProblem = drainFleetTopologyProblem(effective.launchSettings);
    if (topologyProblem) {
      return { ok: false, reason: 'launch-ceilings-too-low', detail: topologyProblem, activeInstances };
    }
  }

  // ── 4c. typed property declarations (P-025). MINT path — and, since P-022,
  // ALSO an adopt whose constructor produced the declaration: the stub's
  // schema was validated at install-seed time, but a CONSTRUCTED one never saw
  // that gate. Ensure the first-party datatypes exist (insert-if-absent), then
  // validate — refuse rather than landing a row whose declared properties
  // could never be checked at write time.
  const propertySchemaConstructed = constructedKeys.includes('propertySchema');
  if (
    (!adopting || propertySchemaConstructed) &&
    effective.propertySchema &&
    Object.keys(effective.propertySchema).length > 0
  ) {
    await deps.ensurePropertyDatatypes(sql, { workspaceId });
    const schemaCheck = await deps.validatePropertySchema(sql, {
      workspaceId,
      doc: effective.propertySchema,
    });
    if (!schemaCheck.ok) {
      return {
        ok: false,
        reason: 'property-schema-invalid',
        detail: `the package's propertySchema cannot bind: ${schemaCheck.issues.join('; ')}`,
        activeInstances,
      };
    }
  }

  // ── 5. adopt or mint ────────────────────────────────────────────────────
  const startedBy = input.launcherOwnerId ?? 'goals:start-from-package';
  let goalIdStarted: string;
  let installSlug: string;
  if (adopting) {
    goalIdStarted = stub.id;
    const stubHarness = stub.install_slug?.trim();
    if (!stubHarness) {
      return {
        ok: false,
        reason: 'no-harness',
        detail: `stub '${stub.id}' has no install_slug — re-seed it or pass harness and delete the stub`,
        activeInstances,
      };
    }
    installSlug = stubHarness;
    await deps.adoptStub(sql, {
      workspaceId,
      goalId: stub.id,
      inputs: inputsVerdict.inputs,
      launchSettings: effective.launchSettings,
      budgetWindowSec: effective.budgetWindowSec,
      constructedContent: constructedKeys.length > 0 ? effective : null,
      metadata: {
        ...clearGoalPause(stub.metadata),
        startedBy,
        ...(constructedKeys.length > 0 ? { packageConstructedKeys: constructedKeys } : {}),
      },
    });
  } else {
    const harness = input.harness?.trim();
    if (!harness) {
      return {
        ok: false,
        reason: 'no-harness',
        detail:
          `no unstarted stub of package '${ref}' to adopt, so a fresh instance would be minted — ` +
          `pass \`harness\` (the install_slug the new goal is filed against)`,
        activeInstances,
      };
    }
    installSlug = harness;
    goalIdStarted = mintGoalId(effective.title);
    await deps.mintRow(sql, {
      workspaceId,
      id: goalIdStarted,
      installSlug,
      content: effective,
      inputs: inputsVerdict.inputs,
      metadata: {
        goalPackageRef: ref,
        packageVersion: pkg.version,
        startedFrom: 'package',
        startedBy,
        ...(inheritedOverride ? { packageInstanceOverride: inheritedOverride } : {}),
        ...(constructedKeys.length > 0 ? { packageConstructedKeys: constructedKeys } : {}),
      },
    });
  }

  // ── 6. activate through the ONE primitive (D-006) ───────────────────────
  const brief = deps.buildBrief({
    goalId: goalIdStarted,
    title: effective.title,
    killCriterion: effective.killCriterion,
    budgetCents: effective.budgetCents,
    body: effective.body,
    standing: effective.standing,
    budgetWindowSec: effective.budgetWindowSec,
  });
  const started = await deps.startById(sql, {
    workspaceId,
    goalId: goalIdStarted,
    launcherOwnerId: input.launcherOwnerId ?? null,
    startBlocked: input.startBlocked,
    startBlockedReason: input.startBlockedReason,
    deferSpawn: input.deferSpawn,
    kickoffPrompt: brief,
  });

  if (!started.ok) {
    // A refusal precedes any spawn — compensate, EXCEPT where a holder may
    // exist (already-held / holder-unknown): unwinding those could pause a
    // goal somebody is live on. See the header's compensation contract.
    const holderMayExist = started.reason === 'already-held' || started.reason === 'holder-unknown';
    if (!holderMayExist) {
      if (adopting) {
        await deps.restoreStub(sql, { workspaceId, stub: stub! }).catch(() => {});
      } else {
        await deps.deleteRow(sql, { id: goalIdStarted, workspaceId }).catch(() => {});
      }
    }
    return {
      ok: false,
      reason: started.reason,
      detail:
        started.detail +
        (holderMayExist
          ? adopting
            ? ' (the adopted stub was left active — a holder may exist)'
            : ' (the minted instance was left in place — a holder may exist)'
          : adopting
            ? ' (the stub was restored to its installed state)'
            : ' (the minted instance was rolled back)'),
      activeInstances,
    };
  }

  const warnings = [...started.warnings];

  // ── 7. post-start stamps: the owning agent + the drain fleet (P-001) ────
  // Both fail-SOFT: the goal is running; a missing stamp/fleet is exactly what
  // the liveness / goal-drain-fleet watchdogs report until repaired.
  await deps
    .stampAgentOwner(sql, { workspaceId, goalId: goalIdStarted, ownerId: started.ownerId })
    .catch((e) => warnings.push(`agentOwnerId stamp failed: ${(e as Error)?.message ?? e}`));

  let drainFleet: string | null = null;
  if (mintsDrainFleet) {
    try {
      const minted = await deps.mintDrain({
        workspaceId,
        harnessSlug: installSlug,
        goalId: goalIdStarted,
        goalTitle: effective.title,
        agentOwnerId: started.ownerId,
        goalTx: sql as unknown as GoalSqlTag,
      });
      drainFleet = minted.fleetSlug;
      warnings.push(
        `drain fleet '${minted.fleetSlug}' minted (rows + goal-scoped lane); the goal agent leads it — ` +
          'members join via fleet:join / capability:terminal --fleet (the watchdog reports it until one does)',
      );
    } catch (e) {
      warnings.push(
        `drain-fleet auto-mint failed (goal started anyway; the goal-drain-fleet watchdog keeps reporting until a fleet exists): ${(e as Error)?.message ?? e}`,
      );
    }
  }

  return {
    ok: true,
    goalId: goalIdStarted,
    ownerId: started.ownerId,
    adopted: adopting,
    appliedDefaults: effective.appliedDefaults,
    constructedKeys,
    activeInstances,
    drainFleet,
    warnings,
  };
}
