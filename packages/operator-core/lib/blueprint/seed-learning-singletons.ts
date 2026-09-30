/**
 * Seed the workspace-SINGLETON learning-loop cadence routines from the blueprints that
 * declare them — deterministic-blueprints-migration-2026-06-13 P-144 / D-018 step 2.
 *
 * This REPLACES the per-loop bespoke `seed-*-routine.ts` scripts. For each migrated learning
 * blueprint that declares `singleton: true` on its schedule trigger, it calls the production
 * `materializeBlueprintTriggers` — which upserts ONE dark routine per workspace under the
 * reserved `@singleton` host-slug, stamped `payload_template.blueprintId` so the harness-less
 * row fires the right program. Governor registration is NOT done here: every frontier loop
 * self-registers its learning-governor loop at first armed contact (`<loop>GovernorGate`), so
 * retiring the bespoke seed leaves the loop registered-on-first-contact (the D-018 "capability
 * does routine-materialization only" finding).
 *
 * It also (opt-in) RETIRES the legacy `papercup`-slug bespoke row each migrated loop used to
 * seed — but ONLY if that row is DARK (`active = false`). It never deletes an ACTIVE routine
 * (the 3 active loops change-ledger/scout/iq-battery are not migrated here and must not be
 * darkened); an active legacy row is reported and left for an explicit, owner-watched cutover.
 *
 * DRY-RUN by default — prints the plan, writes nothing. `--execute` performs the upserts;
 * `--retire-legacy` additionally deletes the (dark) legacy rows. `--only <blueprintId>`
 * restricts to one loop (the recommended per-loop cadence — verify each before the next).
 *
 *   PAPERCUSP_WORKSPACE_ID=<ws> DATABASE_URL=... tsx packages/operator-core/lib/blueprint/seed-learning-singletons.ts            # dry-run, all
 *   ... --only graduation                          # dry-run, one loop
 *   ... --only graduation --execute                # create the @singleton row
 *   ... --only graduation --execute --retire-legacy  # + delete the dark legacy papercup row
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import { FLAGS } from '@papercusp/flags';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { activeWorkspaceId } from '../workspace-registry';
import { isCliEntry } from '../util/cli-entry';
import {
  materializeBlueprintTriggers,
  triggerRoutineSpecs,
  isPlatformImprovementLoop,
  platformImprovementLoopsEnabled,
  SINGLETON_TRIGGER_HOST_SLUG,
  singletonRoutinePayloadDefaults,
  type MaterializedRoutine,
} from './materialize-triggers';

/** A migrated learning loop: its blueprint id + the legacy `papercup`-slug routine name its
 *  bespoke seed used to create (the row this cutover retires once the loop declares
 *  `singleton: true`). The legacy name is the routine's `name` column, not the blueprint id. */
export interface LearningSingleton {
  blueprintId: string;
  legacyRoutine: string;
}

/** Exit status for `--reconcile` check mode. A missing declaration must make the
 * CLI fail so CI/boot callers cannot mistake a printed FATAL for a green check. */
export function reconcileLearningSingletonsExitCode(execute: boolean, missingCount: number): number {
  return !execute && missingCount > 0 ? 1 : 0;
}

/**
 * All 13 migrated workspace-singleton loops (D-018/D-024). A loop is only acted on once its
 * blueprint actually declares `singleton: true`. The 10 FRONTIER learning loops are dark-by-design
 * (armed at the P-001 gate); the 3 ALWAYS-ON loops (change-ledger/scout/iq-battery) declare
 * `singletonActive: true` so a fresh workspace seeds them live. `gym` is NOT here — it fires
 * `system:gym-cycle`, a workspace pulse, not a blueprint program (D-010). On THIS box, DARK loops
 * are cut over by `materializeLearningSingletons` and ACTIVE loops (armed frontier + always-on)
 * by `cutoverActiveLearningSingleton` (behavior-neutral copy).
 */
export const LEARNING_SINGLETONS: LearningSingleton[] = [
  // Frontier learning loops (dark-by-design):
  { blueprintId: 'graduation', legacyRoutine: 'graduation-scan' },
  { blueprintId: 'negative-space', legacyRoutine: 'negative-space-mine' },
  { blueprintId: 'neologism', legacyRoutine: 'neologism-mine' },
  { blueprintId: 'fleet-ekg', legacyRoutine: 'fleet-ekg-scan' },
  { blueprintId: 'calibration', legacyRoutine: 'calibration-resolve' },
  { blueprintId: 'deferral-interest', legacyRoutine: 'deferral-interest-refit' },
  { blueprintId: 'prompt-ablation', legacyRoutine: 'prompt-ablation' },
  { blueprintId: 'regret', legacyRoutine: 'regret-mine' },
  { blueprintId: 'transfer', legacyRoutine: 'transfer-distill' },
  { blueprintId: 'red-queen', legacyRoutine: 'red-queen-drill' },
  // Always-on workspace loops (singletonActive: true):
  { blueprintId: 'change-ledger', legacyRoutine: 'change-ledger-scan' },
  { blueprintId: 'scout', legacyRoutine: 'scout-cycle' },
  { blueprintId: 'iq-battery', legacyRoutine: 'iq-battery-gen' },
  // relight-self-learning-edges P-033: memory-precision monitoring (always-on, flag-gated).
  // No legacy bespoke routine ever existed — the legacyRoutine name matches nothing, so the
  // retire-legacy pass is a clean no-op; this loop is born as a @singleton row.
  { blueprintId: 'memory-precision', legacyRoutine: 'memory-precision-bench' },
  // EI-10047: memory recall canary (always-on, flag-gated). Like memory-precision, no
  // legacy bespoke routine ever existed — the retire-legacy pass is a clean no-op.
  { blueprintId: 'memory-live-recall-canary', legacyRoutine: 'memory-live-recall-canary' },
];

export interface LegacyRowState {
  found: boolean;
  active: boolean | null;
  deleted: boolean;
  /** When a legacy row was found ACTIVE and therefore NOT deleted (the active-loop guard). */
  keptActive?: boolean;
}

export interface CutoverResult {
  blueprintId: string;
  /** false → the blueprint doesn't declare `singleton: true` yet; the loop is skipped. */
  declaresSingleton: boolean;
  /** The singleton routine specs the blueprint implies (always computed, for the report). */
  plannedNames: string[];
  /** Set when `execute` and the blueprint declares a singleton — the upserted rows. */
  materialized?: MaterializedRoutine[];
  legacy: LegacyRowState;
  /** Why this loop was skipped (no @singleton row materialized), if it was:
   *  - `not-declared`: the blueprint hasn't added `singleton: true` yet.
   *  - `legacy-active`: the legacy `papercup` row is ACTIVE — this dark CLI must NOT create a
   *    duplicate beside a firing loop (D-023 collision guard); it needs the owner-watched
   *    atomic active cutover instead.
   *  - `platform-mode-off`: a Class-C platform-improvement loop while the
   *    `PLATFORM_IMPROVEMENT_LOOPS` deployment-mode knob is OFF (P-070 — a public
   *    release before the user opts into platform mode). gym/scout are exempt. */
  skipped?: 'not-declared' | 'legacy-active' | 'platform-mode-off';
}

/** The legacy `papercup`-slug row a migrated loop seeded — read its current active state. */
async function readLegacyRow(
  sql: Sql,
  workspaceId: string,
  legacyRoutine: string,
): Promise<{ active: boolean } | null> {
  const homeSlug = operatorHomeHarnessSlug();
  const rows = await sql<{ active: boolean }[]>`
    SELECT active FROM harness_shared.routines
     WHERE install_slug = ${homeSlug} AND name = ${legacyRoutine} AND workspace_id = ${workspaceId}
  `;
  return rows.length ? { active: rows[0].active } : null;
}

/**
 * Materialize the singleton routines for the migrated learning blueprints and (opt-in) retire
 * their dark legacy rows. Pure-ish: all DB access goes through `sql`; injectable for tests.
 *
 * DEPLOYMENT-MODE GATE (P-070 / D-001): the LAYER-3 platform-improvement loops (every Class-C
 * singleton — `isPlatformImprovementLoop`) are SKIPPED when the `PLATFORM_IMPROVEMENT_LOOPS`
 * knob is OFF (a public release before the user opts into platform mode). gym/scout (Class-B)
 * are never gated. The flag is resolved ONCE up front (default ON in dev/self-host) and is
 * injectable via `opts.flag` for tests. Registration-only — no loop's logic changes.
 */
export async function materializeLearningSingletons(
  sql: Sql,
  workspaceId: string,
  opts: {
    only?: string;
    execute: boolean;
    retireLegacy: boolean;
    log?: (m: string) => void;
    /** Inject the platform-mode flag resolver (P-070); defaults to the real getFlag. */
    flag?: (key: typeof FLAGS.PLATFORM_IMPROVEMENT_LOOPS) => Promise<boolean>;
  },
): Promise<CutoverResult[]> {
  const log = opts.log ?? (() => {});
  const homeSlug = operatorHomeHarnessSlug();
  const targets = opts.only
    ? LEARNING_SINGLETONS.filter((s) => s.blueprintId === opts.only)
    : LEARNING_SINGLETONS;
  if (opts.only && targets.length === 0) {
    throw new Error(`seed-learning-singletons: unknown blueprint '${opts.only}' (not in LEARNING_SINGLETONS)`);
  }

  // P-070 deployment-mode gate — resolved once (a flag read), reused for every Class-C loop.
  const platformLoopsOn = await platformImprovementLoopsEnabled({ flag: opts.flag });

  const out: CutoverResult[] = [];
  for (const t of targets) {
    const { blueprint } = loadBuiltinBlueprint(t.blueprintId);
    const declaresSingleton = (blueprint.triggers?.schedule ?? []).some(
      (s) => (s as { singleton?: boolean }).singleton === true,
    );
    const plannedNames = triggerRoutineSpecs(blueprint)
      .filter((s) => s.singleton)
      .map((s) => s.name);

    const legacyBefore = await readLegacyRow(sql, workspaceId, t.legacyRoutine);
    const legacy: LegacyRowState = {
      found: legacyBefore !== null,
      active: legacyBefore?.active ?? null,
      deleted: false,
    };

    if (!declaresSingleton) {
      log(`SKIP ${t.blueprintId}: blueprint does not declare singleton:true yet (not migrated)`);
      out.push({ blueprintId: t.blueprintId, declaresSingleton: false, plannedNames, legacy, skipped: 'not-declared' });
      continue;
    }

    // DEPLOYMENT-MODE GATE (P-070): skip a Class-C platform-improvement loop when platform mode
    // is OFF — it is not materialized at all (no @singleton row), so it ships dark on a public
    // release until the user opts in. gym/scout (Class-B) are exempt via isPlatformImprovementLoop.
    if (!platformLoopsOn && isPlatformImprovementLoop(t.blueprintId)) {
      log(`SKIP ${t.blueprintId}: platform-improvement loops are OFF (PLATFORM_IMPROVEMENT_LOOPS) — release/non-platform mode (P-070)`);
      out.push({ blueprintId: t.blueprintId, declaresSingleton, plannedNames, legacy, skipped: 'platform-mode-off' });
      continue;
    }

    // COLLISION GUARD (D-023): if the legacy papercup row is ACTIVE, this loop is being actively
    // used — the frontier-arming campaign re-creates + arms papercup rows via `seed --active`.
    // Materializing a dark @singleton row beside it is exactly the double-state the revert cleaned
    // up. An active loop must go through the owner-watched ATOMIC active cutover (copy active +
    // payload → @singleton, delete papercup, in one step), NOT this dark CLI. Skip it untouched.
    if (legacy.found && legacy.active === true) {
      log(`SKIP ${t.blueprintId}: legacy papercup/${t.legacyRoutine} is ACTIVE — needs the owner-watched active cutover, not the dark CLI (collision guard, D-023)`);
      out.push({ blueprintId: t.blueprintId, declaresSingleton, plannedNames, legacy: { ...legacy, keptActive: true }, skipped: 'legacy-active' });
      continue;
    }

    let materialized: MaterializedRoutine[] | undefined;
    if (opts.execute) {
      materialized = await materializeBlueprintTriggers(t.blueprintId, blueprint, { sql, workspaceId, flag: opts.flag });
      log(`MATERIALIZED ${t.blueprintId}: ${materialized.map((r) => `${r.hostSlug}/${r.name} (active=${!r.singleton ? 'true' : 'false'})`).join(', ')}`);
    } else {
      log(`DRY-RUN ${t.blueprintId}: would upsert @singleton/${plannedNames.join(', ')} (dark) + payload.blueprintId=${t.blueprintId}`);
    }

    // Retire the legacy papercup row. It is DARK here — ACTIVE loops were skipped by the
    // collision guard above — so the `AND active = false` is a belt-and-braces final guard.
    if (legacy.found && opts.retireLegacy) {
      if (opts.execute) {
        await sql`
          DELETE FROM harness_shared.routines
           WHERE install_slug = ${homeSlug} AND name = ${t.legacyRoutine} AND workspace_id = ${workspaceId} AND active = false
        `;
        legacy.deleted = true;
        log(`RETIRED ${t.blueprintId}: deleted dark legacy papercup/${t.legacyRoutine}`);
      } else {
        log(`DRY-RUN ${t.blueprintId}: would delete dark legacy papercup/${t.legacyRoutine}`);
      }
    } else if (legacy.found) {
      log(`LEAVE ${t.blueprintId}: dark legacy papercup/${t.legacyRoutine} present (pass --retire-legacy to delete)`);
    }

    out.push({ blueprintId: t.blueprintId, declaresSingleton: true, plannedNames, materialized, legacy });
  }
  return out;
}

/** One loop's reconcile verdict — see {@link reconcileLearningSingletons}. */
export interface SingletonReconcileEntry {
  blueprintId: string;
  /** The `@singleton` routine row this loop must have. */
  routineName: string;
  /** Is a routine row EXPECTED? (false = Class-C loop, platform mode OFF — absent by design.) */
  expected: boolean;
  /** Does the routine row EXIST? */
  present: boolean;
  /** EXPECTED but NOT PRESENT — the registration silently never happened. THE defect. */
  missing: boolean;
  /** Set when `execute` and the row was missing — the rows we upserted to heal it. */
  materialized?: MaterializedRoutine[];
}

export interface SingletonReconcileResult {
  entries: SingletonReconcileEntry[];
  /** Loops that were declared but never materialized. MUST be empty on a healthy install. */
  missing: string[];
  /** Loops healed this run (only when `execute`). */
  healed: string[];
}

/**
 * RECONCILE the declared learning singletons against the routine rows that actually exist
 * — EI-10625, the recurrence-preventing fix.
 *
 * THE BUG THIS EXISTS TO KILL: `materializeLearningSingletons` had exactly one caller, the
 * one-shot `enable-platform-mode`. So adding a loop to {@link LEARNING_SINGLETONS} DID NOT
 * SCHEDULE IT. Registering a loop *looked* complete — the list entry, the blueprint, the
 * flag, the tables, the health line all existed — but the routine row only appeared if a
 * human happened to re-run a CLI afterwards. `memory-precision` got its row that way on
 * 2026-06-30. The memory recall canary (EI-10047) was added later, nobody re-ran anything,
 * and it was DEAD ON ARRIVAL: 0 routine rows, 0 runs, for its entire life — silently, with
 * no error, on a 10,491-memory store it was built to watch.
 *
 * A DECLARATION NOBODY EXECUTES IS NOT A REGISTRATION. This diffs declared-vs-materialized
 * and (with `execute`) heals the gap, so a loop added to the list is a loop that RUNS.
 * Idempotent: `materializeBlueprintTriggers` upserts, so re-running touches nothing that is
 * already correct — safe to call on every boot.
 *
 * Read-only by default (`execute: false`) — it reports the diff and writes nothing.
 */
export async function reconcileLearningSingletons(
  sql: Sql,
  workspaceId: string,
  opts: {
    execute: boolean;
    log?: (m: string) => void;
    flag?: (key: typeof FLAGS.PLATFORM_IMPROVEMENT_LOOPS) => Promise<boolean>;
    /** The declared loop set to reconcile. Defaults to {@link LEARNING_SINGLETONS}; injectable for tests. */
    loops?: readonly LearningSingleton[];
  },
): Promise<SingletonReconcileResult> {
  const log = opts.log ?? (() => {});
  const platformLoopsOn = await platformImprovementLoopsEnabled({ flag: opts.flag });

  // Every @singleton routine row that exists for this workspace, in one read.
  const rows = (await sql<{ name: string }[]>`
    SELECT name FROM harness_shared.routines
     WHERE install_slug = ${SINGLETON_TRIGGER_HOST_SLUG} AND workspace_id = ${workspaceId}
  `) as { name: string }[];
  const present = new Set(rows.map((r) => r.name));

  const entries: SingletonReconcileEntry[] = [];
  for (const t of opts.loops ?? LEARNING_SINGLETONS) {
    const { blueprint } = loadBuiltinBlueprint(t.blueprintId);
    const specs = triggerRoutineSpecs(blueprint).filter((s) => s.singleton);
    if (specs.length === 0) continue; // the blueprint declares no singleton — nothing to reconcile
    const routineName = specs[0].name;

    // The ONLY legitimate absence (P-070): a Class-C platform-improvement loop while the
    // deployment-mode knob is OFF is deliberately never materialized. Everything else that
    // is declared is expected to exist.
    const expected = platformLoopsOn || !isPlatformImprovementLoop(t.blueprintId);
    const exists = present.has(routineName);
    const missing = expected && !exists;

    const entry: SingletonReconcileEntry = { blueprintId: t.blueprintId, routineName, expected, present: exists, missing };
    if (missing) {
      // LOUD, always — even in read-only mode. A declared-but-unmaterialized singleton is a
      // loop that will never run, and silence here is precisely how this bug survived.
      console.warn(
        `[learning-singletons] NEVER MATERIALIZED: '${t.blueprintId}' is declared in LEARNING_SINGLETONS ` +
          `but has no @singleton/${routineName} routine row — it has never run and never will. ` +
          (opts.execute ? 'Materializing now.' : 'Run with execute to heal it.'),
      );
      log(`MISSING ${t.blueprintId}: no @singleton/${routineName} row`);
      if (opts.execute) {
        entry.materialized = await materializeBlueprintTriggers(t.blueprintId, blueprint, {
          sql,
          workspaceId,
          flag: opts.flag,
        });
        log(`HEALED ${t.blueprintId}: materialized @singleton/${routineName}`);
      }
    }
    entries.push(entry);
  }

  return {
    entries,
    missing: entries.filter((e) => e.missing).map((e) => e.blueprintId),
    healed: entries.filter((e) => e.materialized !== undefined).map((e) => e.blueprintId),
  };
}

export interface ActiveCutoverResult {
  blueprintId: string;
  /** The legacy `papercup` row existed. */
  found: boolean;
  /** It was ACTIVE (this mode only acts on active loops). */
  legacyActive: boolean;
  /** We copied it → `@singleton` and deleted the legacy row (one transaction). */
  cutOver: boolean;
  /** The `@singleton` routine name the loop now fires from. */
  singletonName: string;
  /** Why skipped, if it was: `not-found` (no legacy row) or `legacy-dark` (use the dark CLI). */
  skipped?: 'not-found' | 'legacy-dark';
}

/**
 * Cut over an ACTIVE migrated loop from its `papercup` row to a `@singleton` row,
 * BEHAVIOR-NEUTRAL by copy (deterministic-blueprints-migration D-023 step 4): in ONE
 * transaction, INSERT a `@singleton` row copying EVERY column of the legacy row (active,
 * payload, next_fire_at, last_fired_at, concurrency, catchup, metadata — byte-identical except
 * install_slug/name/id), then DELETE the legacy `papercup` row. The loop keeps firing, unchanged,
 * from the new row — there is no behavior change and no firing gap. Loops whose `papercup` row is
 * DARK are skipped (use `materializeLearningSingletons` for those). DRY-RUN unless `execute`.
 *
 * PREREQUISITE (D-023): the loop's bespoke `seed-*-routine.ts` must be RETIRED first, otherwise a
 * concurrent arming re-creates the `papercup` row and the cutover re-collides. Run only when the
 * frontier-arming campaign has settled + the seeds are gone.
 */
export async function cutoverActiveLearningSingleton(
  sql: Sql,
  workspaceId: string,
  entry: LearningSingleton,
  opts: { execute: boolean; log?: (m: string) => void },
): Promise<ActiveCutoverResult> {
  const log = opts.log ?? (() => {});
  const homeSlug = operatorHomeHarnessSlug();
  const { blueprint } = loadBuiltinBlueprint(entry.blueprintId);
  const singletonName =
    triggerRoutineSpecs(blueprint).find((s) => s.singleton)?.name ?? `bp-singleton-${entry.blueprintId}-0`;
  const singletonId = `rt_${SINGLETON_TRIGGER_HOST_SLUG}_${singletonName}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();

  const legacy = await sql<{ active: boolean }[]>`
    SELECT active FROM harness_shared.routines
     WHERE install_slug=${homeSlug} AND name=${entry.legacyRoutine} AND workspace_id=${workspaceId}`;
  if (legacy.length === 0) {
    log(`SKIP ${entry.blueprintId}: no legacy papercup/${entry.legacyRoutine} row`);
    return { blueprintId: entry.blueprintId, found: false, legacyActive: false, cutOver: false, singletonName, skipped: 'not-found' };
  }
  if (legacy[0].active !== true) {
    log(`SKIP ${entry.blueprintId}: papercup/${entry.legacyRoutine} is DARK — use the dark CLI (this mode is for ACTIVE loops)`);
    return { blueprintId: entry.blueprintId, found: true, legacyActive: false, cutOver: false, singletonName, skipped: 'legacy-dark' };
  }
  if (!opts.execute) {
    log(`DRY-RUN ${entry.blueprintId}: would copy ACTIVE papercup/${entry.legacyRoutine} → @singleton/${singletonName} (preserve active+payload+timing) + delete legacy, atomically`);
    return { blueprintId: entry.blueprintId, found: true, legacyActive: true, cutOver: false, singletonName };
  }

  const payloadDefaults = JSON.stringify(singletonRoutinePayloadDefaults(entry.blueprintId));

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.routines
        (id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template,
         concurrency, catchup, active, last_fired_at, next_fire_at, workspace_id, metadata, created_at, updated_at)
      SELECT ${singletonId}, ${SINGLETON_TRIGGER_HOST_SLUG}, ${singletonName}, trigger_kind, trigger_config,
             target_role, ${payloadDefaults}::text::jsonb || COALESCE(payload_template, '{}'::jsonb),
             concurrency, catchup, active, last_fired_at, next_fire_at,
             workspace_id, metadata, now(), now()
        FROM harness_shared.routines
       WHERE install_slug=${homeSlug} AND name=${entry.legacyRoutine} AND workspace_id=${workspaceId}
      ON CONFLICT (install_slug, name) DO UPDATE SET
        trigger_config = EXCLUDED.trigger_config, target_role = EXCLUDED.target_role,
        payload_template = EXCLUDED.payload_template, concurrency = EXCLUDED.concurrency,
        catchup = EXCLUDED.catchup, active = EXCLUDED.active,
        last_fired_at = EXCLUDED.last_fired_at, next_fire_at = EXCLUDED.next_fire_at, updated_at = now()`;
    await tx`
      DELETE FROM harness_shared.routines
       WHERE install_slug=${homeSlug} AND name=${entry.legacyRoutine} AND workspace_id=${workspaceId}`;
  });
  log(`CUT OVER ${entry.blueprintId}: ACTIVE papercup/${entry.legacyRoutine} → @singleton/${singletonName} (behavior-neutral copy)`);
  return { blueprintId: entry.blueprintId, found: true, legacyActive: true, cutOver: true, singletonName };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const retireLegacy = argv.includes('--retire-legacy');
  const activeCutover = argv.includes('--active-cutover');
  const reconcile = argv.includes('--reconcile');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;

  const workspaceId =
    process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE ?? activeWorkspaceId();
  const { sql } = getOrgPg();

  // --reconcile (EI-10625): diff DECLARED singletons against the routine rows that exist,
  // and heal the gap. This is the mode that must eventually run on boot — a loop added to
  // LEARNING_SINGLETONS without it is dead on arrival, silently.
  if (reconcile) {
    console.log(`[seed-learning-singletons] ws=${workspaceId} RECONCILE ${execute ? 'EXECUTE' : 'DRY-RUN'}`);
    try {
      const r = await reconcileLearningSingletons(sql, workspaceId, {
        execute,
        log: (m) => console.log(`  ${m}`),
      });
      console.log(
        `[seed-learning-singletons] reconcile: ${r.missing.length} never-materialized` +
          `${r.missing.length ? ` (${r.missing.join(', ')})` : ''}` +
          `${execute ? `; healed ${r.healed.length}` : ' — pass --execute to heal'}.`,
      );
      process.exitCode = reconcileLearningSingletonsExitCode(execute, r.missing.length);
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }

  const mode = activeCutover ? 'ACTIVE-CUTOVER (copy)' : 'DARK-MATERIALIZE';
  console.log(
    `[seed-learning-singletons] ws=${workspaceId} ${mode} ${execute ? 'EXECUTE' : 'DRY-RUN'}` +
      `${retireLegacy && !activeCutover ? ' +retire-legacy' : ''}${only ? ` only=${only}` : ' (all migrated loops)'}`,
  );
  try {
    const targets = only ? LEARNING_SINGLETONS.filter((s) => s.blueprintId === only) : LEARNING_SINGLETONS;
    if (only && targets.length === 0) throw new Error(`unknown blueprint '${only}' (not in LEARNING_SINGLETONS)`);

    if (activeCutover) {
      // ACTIVE loops only — behavior-neutral copy (D-023 step 4). Requires the bespoke seeds to be
      // RETIRED first (else arming re-creates the papercup row mid-cutover).
      let cut = 0;
      for (const t of targets) {
        const r = await cutoverActiveLearningSingleton(sql, workspaceId, t, { execute, log: (m) => console.log(`  ${m}`) });
        if (r.cutOver) cut++;
      }
      console.log(`[seed-learning-singletons] active-cutover: ${execute ? 'cut over' : 'would cut over'} ${cut}/${targets.length} active loop(s).`);
      return;
    }

    const results = await materializeLearningSingletons(sql, workspaceId, {
      only,
      execute,
      retireLegacy,
      log: (m) => console.log(`  ${m}`),
    });
    const acted = results.filter((r) => r.declaresSingleton && !r.skipped);
    console.log(
      `[seed-learning-singletons] ${acted.length}/${results.length} loop(s) ${execute ? 'materialized' : 'would materialize'}; ` +
        `legacy: ${results.filter((r) => r.legacy.deleted).length} deleted, ` +
        `${results.filter((r) => r.skipped === 'legacy-active').length} skipped-active(collision guard).`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run as a CLI (not when imported by a test, and NEVER when bundled into
// the desktop sidecar — see isCliEntry / EI-650).
if (isCliEntry(import.meta.url)) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((e) => {
      console.error('[seed-learning-singletons] FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
