/**
 * Materialize a blueprint's `triggers.schedule` defaults into `harness_shared.routines`
 * (harness-blueprint-orchestration-2026-06-03 P-021 / D-018).
 *
 * A blueprint declares scheduler defaults:
 *
 *   triggers:
 *     schedule:
 *       - { cron: "0 0 9 * * *", action: "system:blueprint-run" }
 *
 * `harness:create` calls `materializeBlueprintTriggers` after provisioning the harness so
 * each entry becomes a cron `routines` row whose `target_role` is the entry's `action`
 * (default `system:blueprint-run`). The shipped DBOS `routinesTick` then dispatches a due
 * row to the registered system action INLINE as one durable step (`system-actions.ts`) —
 * there is deliberately NO `pending_events` consumer (that hop is retired,
 * `git-sync-auto-commit` D-006; `pending_events` the table stays live for the operator
 * scanner's LISTEN/NOTIFY, we just don't add a consumer). Blueprint ⟂ scheduler: one
 * declarative seam onto the EXISTING engine, not a second scheduler (D-018).
 *
 * Routines are runtime-editable after creation — pause / retime via the routines:* surface.
 * Re-running materialize is idempotent on (install_slug, name). The live-edit "re-author the
 * schedule" path is P-016, not here.
 *
 * Workspace-SINGLETON triggers (`singleton: true`, deterministic-blueprints-migration D-018):
 * a schedule entry can declare itself workspace-global — EXACTLY ONE routine per workspace,
 * shared across every install of the blueprint, seeded INACTIVE/dark, under the reserved
 * synthetic host-slug `SINGLETON_TRIGGER_HOST_SLUG` (not a real harness install). This solves
 * the D-010/D-012(b) objection: a learning loop (regret-mine, gym-cycle, …) can carry its own
 * cadence into another hive WITHOUT a naive per-install materialization minting N redundant
 * ACTIVE pulses for N installs. Because all singletons share one reserved host-slug, the
 * routine name embeds the blueprint id (`bp-singleton-<blueprintId>-<i>`) so it is
 * blueprint-unique under the `(install_slug, name)` uniqueness key; re-installing the blueprint
 * upserts the same one row. (Per-install triggers keep keying on the real install slug, seeded
 * ACTIVE — unchanged.) Uniqueness is per-workspace by the existing routines invariant: one
 * workspace per routines namespace (the same single-namespace assumption per-install relies on;
 * the row also carries `workspace_id`). Folding the bespoke `seed-*-routine` scripts' governor
 * registration onto this capability is the per-loop follow-on (D-018 step 2), NOT this step.
 *
 * Each entry delegates to db-org's `upsertRoutine` (the single routine-upsert primitive),
 * passing the owning `workspaceId` explicitly — `harness_shared.routines.workspace_id` is
 * NOT NULL with no default and no fill trigger, and upsertRoutine binds its jsonb via the
 * canonical `${JSON.stringify}::text::jsonb` form (EI-2).
 */
import type { Sql } from 'postgres';
import { getOrgPg, upsertRoutine } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { activeWorkspaceId } from '../workspace-registry';
import { computeNextFireAt } from '../harness/routines/cron';

/** The action a schedule entry dispatches when it declares none (the schema default). */
export const DEFAULT_SCHEDULE_ACTION = 'system:blueprint-run';

// ── P-070 deployment-mode gate (per-hive-learning-loops / D-001) ───────────────
// The LAYER-3 platform-improvement loops are the workspace-SINGLETON Class-C
// frontier/measurement loops. When the `PLATFORM_IMPROVEMENT_LOOPS` knob is OFF
// (a public release before the user opts into platform mode) a Class-C singleton
// is NOT materialized. gym/scout (per-hive Class-B, layers 1-2) are NEVER gated:
// `gym` declares no singleton schedule (its cadence is the workspace gym pulse),
// and `scout` declares `singleton: true` BUT is the per-hive exception below.

/** Singleton blueprint ids that are per-hive (Class-B) and so EXEMPT from the
 *  platform-mode gate even though they materialize as singleton rows. `scout`
 *  carries `singleton: true` in its blueprint but is a per-hive ideation loop. */
const NON_PLATFORM_SINGLETON_IDS: ReadonlySet<string> = new Set(['scout']);

/**
 * Is this blueprint a LAYER-3 platform-improvement (Class-C) loop the
 * `PLATFORM_IMPROVEMENT_LOOPS` knob gates? Only ever consulted for SINGLETON
 * triggers (per-install gym lives on its own per-hive slug, never here). True for
 * every singleton blueprint except the per-hive Class-B exceptions (`scout`).
 * Pure — exported for the registration gate + its tests.
 */
export function isPlatformImprovementLoop(blueprintId: string | undefined): boolean {
  return blueprintId !== undefined && !NON_PLATFORM_SINGLETON_IDS.has(blueprintId);
}

/**
 * Resolve the P-070 deployment-mode gate: are the layer-3 platform-improvement
 * loops enabled? Reads the `PLATFORM_IMPROVEMENT_LOOPS` flag (default ON in
 * dev/self-host; a public release exports PAPERCUSP_PLATFORM_MODE=off). Injectable
 * via `opts.flag` for tests.
 */
export async function platformImprovementLoopsEnabled(
  opts: { flag?: (key: typeof FLAGS.PLATFORM_IMPROVEMENT_LOOPS) => Promise<boolean> } = {},
): Promise<boolean> {
  const flag = opts.flag ?? ((key) => getFlag(key, 'platform-improvement-loops'));
  return flag(FLAGS.PLATFORM_IMPROVEMENT_LOOPS);
}

/**
 * Resolve the EPHEMERAL-cadence gate (schedule-inventory-and-ephemeral-tier-2026-06-26
 * P-013 / D-006): is the blueprint-declared ephemeral tier enabled? Reads
 * `papercusp-ephemeral-cadence` (default ON). Consulted only when a blueprint actually
 * declares a `tier:'ephemeral'` schedule entry (a wasted read otherwise, off the hot
 * per-install durable path). Read here — a MATERIALIZE (request) context — deliberately
 * NOT at host-boot, where getFlag is fragile (PostHog distinct-id / unreachable → false).
 * Injectable via `opts.flag` for tests.
 */
export async function ephemeralCadenceEnabled(
  opts: { flag?: (key: typeof FLAGS.EPHEMERAL_CADENCE) => Promise<boolean> } = {},
): Promise<boolean> {
  const flag = opts.flag ?? ((key) => getFlag(key, 'ephemeral-cadence'));
  return flag(FLAGS.EPHEMERAL_CADENCE);
}

/**
 * The blueprint-ish input the spec-deriver accepts. A parsed `Blueprint` is assignable (its
 * schedule entries carry the `action`/`singleton` defaults already), as is a blueprint-shaped
 * literal — `action` and `singleton` are optional here because this module applies the same
 * defaults the schema does, so callers (and tests) need not pre-fill them. `id` is required
 * only when a schedule entry sets `singleton: true` (the routine name must embed it).
 */
export interface BlueprintTriggerInput {
  id?: string;
  triggers?: {
    schedule?: Array<{
      cron?: string;
      tier?: 'durable' | 'ephemeral';
      intervalSec?: number;
      action?: string;
      singleton?: boolean;
      singletonActive?: boolean;
    }>;
  };
}

/**
 * The reserved synthetic host-slug a workspace-singleton trigger materializes under
 * (deterministic-blueprints-migration D-018). A workspace-global routine isn't owned by any
 * real harness install, so it gets this slug instead of an install slug — cleaner than pinning
 * it to (and orphaning it on the teardown of) a real harness. The leading `@` cannot appear in
 * a real harness slug, so the singleton routine namespace is disjoint from per-install routines
 * on the shared `(install_slug, name)` key.
 */
export const SINGLETON_TRIGGER_HOST_SLUG = '@singleton';

// per-hive-learning-loops P-014 / D-008: `@singleton` is ONLY for workspace-global
// loops (the Class-C frontier/measurement loops). A PER-HIVE learning loop (gym/scout —
// Class B) is owned by its Hive and materializes under that Hive's REAL install_slug,
// never `@singleton`. No routines-schema change is needed: the existing
// (install_slug, name) key already namespaces a per-hive loop by the hive's own slug.

export interface TriggerRoutineSpec {
  /** Stable routine name = the upsert key (with the resolved host slug). Per-install:
   *  `bp-schedule-<i>`. Singleton: `bp-singleton-<blueprintId>-<i>` (blueprint-unique under
   *  the shared reserved host-slug). */
  name: string;
  /** Execution tier (P-010/D-006): 'durable' = a cron routine fired by routinesTick;
   *  'ephemeral' = a frequent in-process cadence (intervalSec), excluded from the tick. */
  tier: 'durable' | 'ephemeral';
  /** 6- or 5-field crontab — present for tier:'durable'; undefined for tier:'ephemeral'. */
  cron?: string;
  /** Cadence in SECONDS — present for tier:'ephemeral'; undefined for tier:'durable'. */
  intervalSec?: number;
  /** target_role — `system:<action>` routes to a registered system action; a bare role spawns it. */
  targetRole: string;
  /** Workspace-singleton (D-018): one dark routine per workspace under the reserved host-slug,
   *  vs. a per-install ACTIVE routine keyed on the install slug. */
  singleton: boolean;
  /** Seed the singleton ACTIVE on first creation (an always-on workspace loop) vs dark
   *  (a frontier loop armed later). Re-materialize always preserves the live active state. */
  singletonActive: boolean;
}

export const SCOUT_SINGLETON_CYCLE_TIMEOUT_MS = 600_000;

export function singletonRoutinePayloadDefaults(blueprintId: string): Record<string, unknown> {
  if (blueprintId === 'scout') {
    return { cycleTimeoutMs: SCOUT_SINGLETON_CYCLE_TIMEOUT_MS };
  }
  return {};
}

export interface MaterializedRoutine extends TriggerRoutineSpec {
  /** The routines.id primary key (`rt_<slug>_<name>`, sanitized). */
  id: string;
  /** The install_slug the row was written under — the real install slug, or
   *  `SINGLETON_TRIGGER_HOST_SLUG` for a singleton. */
  hostSlug: string;
}

/**
 * PURE: derive the routine specs a blueprint's `triggers.schedule` implies (exported for
 * unit testing — no PG). One spec per schedule entry. A per-install entry is named
 * `bp-schedule-<i>` (stable for create-time materialization); a `singleton: true` entry is
 * named `bp-singleton-<blueprintId>-<i>` so it is blueprint-unique under the reserved
 * host-slug the singletons share (a singleton entry therefore REQUIRES `blueprint.id`).
 * (`entry.action` is already defaulted to `system:blueprint-run` by `TriggersSchema`; the
 * `||` guards a loose/unparsed input.)
 */
export function triggerRoutineSpecs(blueprint: BlueprintTriggerInput): TriggerRoutineSpec[] {
  const schedule = blueprint.triggers?.schedule ?? [];
  return schedule.map((entry, i) => {
    const singleton = entry.singleton ?? false;
    if (singleton && !blueprint.id) {
      throw new Error(
        'materializeBlueprintTriggers: a `singleton: true` schedule trigger requires the ' +
          'blueprint id (the routine name must be blueprint-unique under the shared reserved ' +
          'host-slug). Pass the full blueprint, not just its triggers.',
      );
    }
    const tier = entry.tier ?? 'durable';
    // Post-validate invariants (blueprint:validate enforces these author-time; guard here so a
    // raw/hand-built input can never mint a malformed routine row).
    if (tier === 'ephemeral') {
      if (entry.intervalSec == null) {
        throw new Error(`materializeBlueprintTriggers: tier:'ephemeral' schedule entry ${i} requires intervalSec`);
      }
      if (singleton) {
        throw new Error(`materializeBlueprintTriggers: tier:'ephemeral' is not supported for a singleton trigger (entry ${i})`);
      }
    } else if (entry.cron == null) {
      throw new Error(`materializeBlueprintTriggers: tier:'durable' schedule entry ${i} requires cron`);
    }
    return {
      name: singleton ? `bp-singleton-${blueprint.id}-${i}` : `bp-schedule-${i}`,
      tier,
      cron: entry.cron,
      intervalSec: entry.intervalSec,
      targetRole: entry.action || DEFAULT_SCHEDULE_ACTION,
      singleton,
      singletonActive: singleton ? (entry.singletonActive ?? false) : false,
    };
  });
}

/**
 * Upsert a workspace-singleton routine — RE-RUN-SAFE (deterministic-blueprints-migration D-023).
 *
 * On FIRST creation it seeds the row DARK (`active = false`) with concurrency `skip` (matching
 * the bespoke `seed-*-routine` scripts it replaces — a slow learning tick must not pile up).
 * On CONFLICT (a re-materialize / re-install) it PRESERVES the existing `active` (NEVER darkens
 * an armed loop), `next_fire_at` (never resets the cadence), and `concurrency`, and MERGES the
 * payload (ensures `blueprintId`, keeps any owner tuning the row accumulated). This is exactly
 * the ON CONFLICT discipline the bespoke seeds use; the generic `upsertRoutine` overwrites those
 * fields (which is why a naive re-run would darken an armed loop), so singletons get this upsert.
 * A singleton row has NO harness to resolve the blueprint from, so it carries the blueprint in
 * `payload_template.blueprintId` — `system:blueprint-run` reads that and runs the program inline.
 */
async function upsertSingletonRoutine(
  sql: Sql,
  input: { workspaceId: string; name: string; cron: string; targetRole: string; blueprintId: string; seedActive: boolean },
): Promise<{ id: string }> {
  const installSlug = SINGLETON_TRIGGER_HOST_SLUG;
  const id = `rt_${installSlug}_${input.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const nextFireAt = computeNextFireAt(input.cron, new Date());
  const triggerConfig = JSON.stringify({ cron: input.cron });
  const payload = JSON.stringify({ blueprintId: input.blueprintId, ...singletonRoutinePayloadDefaults(input.blueprintId) });
  const rows = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at, workspace_id)
    VALUES (
      ${id}, ${installSlug}, ${input.name}, 'cron',
      ${triggerConfig}::text::jsonb, ${input.targetRole},
      ${payload}::text::jsonb, 'skip', 'skip-old', ${input.seedActive},
      ${nextFireAt ? nextFireAt.toISOString() : null}::timestamptz, ${input.workspaceId}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind     = EXCLUDED.trigger_kind,
      trigger_config   = EXCLUDED.trigger_config,
      target_role      = EXCLUDED.target_role,
      payload_template = ${payload}::text::jsonb
        || COALESCE(harness_shared.routines.payload_template - 'blueprintId', '{}'::jsonb),
      catchup          = EXCLUDED.catchup,
      updated_at       = now()
    RETURNING id
  `;
  return { id: rows[0].id };
}

/**
 * Upsert a per-install EPHEMERAL routine (schedule-inventory-and-ephemeral-tier-2026-06-26
 * P-011 / D-006). An ephemeral row carries `tier='ephemeral'`, the cadence in
 * `trigger_config.interval_sec` (seconds), NO cron, and `next_fire_at = NULL` — the DBOS
 * `routinesTick` EXCLUDES it (`listDueCronRoutines` is durable-only), and the per-host
 * ephemeral executor (P-012) arms a `managedSetInterval` per ACTIVE ephemeral row on boot.
 * Idempotent on (install_slug, name). Seeded ACTIVE (the blueprint author declared it).
 */
async function upsertEphemeralRoutine(
  sql: Sql,
  input: { workspaceId: string; installSlug: string; name: string; intervalSec: number; targetRole: string },
): Promise<{ id: string }> {
  const id = `rt_${input.installSlug}_${input.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = JSON.stringify({ interval_sec: input.intervalSec });
  const rows = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at, workspace_id)
    VALUES (
      ${id}, ${input.installSlug}, ${input.name}, 'cron',
      ${triggerConfig}::text::jsonb, ${input.targetRole},
      'skip', 'skip-old', TRUE, 'ephemeral', NULL, ${input.workspaceId}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind   = EXCLUDED.trigger_kind,
      trigger_config = EXCLUDED.trigger_config,
      target_role    = EXCLUDED.target_role,
      tier           = EXCLUDED.tier,
      updated_at     = now()
    RETURNING id
  `;
  return { id: rows[0].id };
}

/**
 * Upsert a blueprint's schedule triggers as `harness_shared.routines` rows.
 * Returns the materialized routines ([] when the blueprint declares no schedule).
 *
 * Per-install triggers are written under `installSlug` and seeded ACTIVE — the blueprint
 * author explicitly declared the schedule. Workspace-singleton triggers (`singleton: true`,
 * D-018) are written under `SINGLETON_TRIGGER_HOST_SLUG` via the re-run-safe `upsertSingletonRoutine`
 * (seeded INACTIVE/dark on first creation; a re-run preserves an armed loop's active state +
 * tuning — D-023). Either way the routines engine itself is opt-in (`PAPERCUSP_DBOS_ROUTINES`),
 * so nothing fires until the operator enables it. `opts.sql` / `opts.workspaceId` are test seams;
 * production resolves the admin pool + active workspace.
 */
export async function materializeBlueprintTriggers(
  installSlug: string,
  blueprint: BlueprintTriggerInput,
  opts: {
    sql?: Sql;
    workspaceId?: string;
    /** Inject the P-070 platform-mode flag resolver; defaults to the real getFlag. */
    flag?: (key: typeof FLAGS.PLATFORM_IMPROVEMENT_LOOPS) => Promise<boolean>;
    /** Inject the P-013 ephemeral-cadence flag resolver; defaults to the real getFlag. */
    ephemeralFlag?: (key: typeof FLAGS.EPHEMERAL_CADENCE) => Promise<boolean>;
  } = {},
): Promise<MaterializedRoutine[]> {
  const specs = triggerRoutineSpecs(blueprint);
  if (specs.length === 0) return [];
  const sql = opts.sql ?? getOrgPg().sql;
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();

  // P-070 deployment-mode gate: only resolve the flag if this blueprint HAS a
  // gateable Class-C singleton trigger (a flag read otherwise wasted on the
  // hot per-install gym/coding/hive create path). gym/scout are exempt.
  const hasGateableSingleton = specs.some(
    (s) => s.singleton && isPlatformImprovementLoop(blueprint.id),
  );
  const platformLoopsOn = hasGateableSingleton
    ? await platformImprovementLoopsEnabled({ flag: opts.flag })
    : true;

  // P-013/D-006 ephemeral-cadence gate: only resolve the flag if this blueprint HAS a
  // tier:'ephemeral' entry (off the hot durable-only path). OFF ⇒ ephemeral rows are
  // not written, so the per-host executor arms none — the feature's kill-switch.
  const hasEphemeral = specs.some((s) => s.tier === 'ephemeral');
  const ephemeralOn = hasEphemeral ? await ephemeralCadenceEnabled({ flag: opts.ephemeralFlag }) : true;

  const out: MaterializedRoutine[] = [];
  for (const spec of specs) {
    if (spec.tier === 'ephemeral') {
      // EPHEMERAL-CADENCE GATE (P-013/D-006): skip the ephemeral row when the flag is OFF
      // (the feature's kill-switch — nothing materializes, the executor arms none).
      if (!ephemeralOn) continue;
      // Per-install ephemeral cadence (triggerRoutineSpecs guarantees intervalSec + non-singleton).
      const row = await upsertEphemeralRoutine(sql, {
        workspaceId,
        installSlug,
        name: spec.name,
        intervalSec: spec.intervalSec!,
        targetRole: spec.targetRole,
      });
      out.push({ ...spec, id: row.id, hostSlug: installSlug });
      // Live-arm on the host running materialize (P-012/P-013 — close the dangling
      // syncEphemeralRoutine seam so a freshly materialized cadence fires WITHOUT waiting
      // for the next host boot). No-op when this process has not armed the executor (a
      // request-only host); the background host re-enumerates the row on its next boot.
      // Dynamic import keeps the executor's deps off this hot per-install path + avoids a cycle.
      try {
        const { syncEphemeralRoutine } = await import('../dbos/ephemeral-executor');
        syncEphemeralRoutine({
          id: row.id,
          workspaceId,
          installSlug,
          name: spec.name,
          targetRole: spec.targetRole,
          intervalSec: spec.intervalSec!,
          payloadTemplate: null,
          triggerConfig: { interval_sec: spec.intervalSec! },
        });
      } catch {
        /* best-effort live-arm: the boot enumerate is the durable path */
      }
      continue;
    }
    // Durable from here — cron is guaranteed present by triggerRoutineSpecs.
    const cron = spec.cron!;
    if (spec.singleton) {
      // DEPLOYMENT-MODE GATE (P-070): skip a Class-C platform-improvement singleton when
      // platform mode is OFF — no @singleton row is written, so it ships dark on a public
      // release until the user opts in. scout (per-hive Class-B) is exempt (isPlatformImprovementLoop).
      if (!platformLoopsOn && isPlatformImprovementLoop(blueprint.id)) {
        continue;
      }
      // blueprint.id is guaranteed here (triggerRoutineSpecs throws for a singleton without it).
      const row = await upsertSingletonRoutine(sql, {
        workspaceId,
        name: spec.name,
        cron,
        targetRole: spec.targetRole,
        blueprintId: blueprint.id as string,
        seedActive: spec.singletonActive,
      });
      out.push({ ...spec, id: row.id, hostSlug: SINGLETON_TRIGGER_HOST_SLUG });
      continue;
    }
    // Per-install: real install slug, seeded ACTIVE, resolves the blueprint from its harness.
    const row = await upsertRoutine(
      sql,
      {
        workspaceId,
        installSlug,
        name: spec.name,
        triggerKind: 'cron',
        triggerConfig: { cron },
        targetRole: spec.targetRole,
        active: true,
      },
      computeNextFireAt,
    );
    out.push({ ...spec, id: row.id, hostSlug: installSlug });
  }
  return out;
}
