/**
 * provisionPotLearningLoop — lay down the pot's learning-loop records at
 * pot:create (per-hive-learning-loops-2026-06-14 P-020; D-003 + D-008).
 *
 * The Pot (kind:'hive') is the tenant of ONE learning loop (D-008). This
 * provisions its two execution surfaces, both SHIPPED INERT so a fresh pot is
 * never spending until the owner arms it:
 *
 *   (a) a DARK gym_autoloop_config row (enabled:false, budget:null) — the
 *       gym-cycle tick doubly refuses a disabled AND unbudgeted row (the D-004
 *       governor rule), so the row exists for the gym UI to surface + arm but
 *       never fires. ARMING = the owner enabling the row + setting a budget via
 *       the gym control plane.
 *   (b) an INACTIVE scout routine (`scout-cycle`, target system:scout-cycle).
 *       With WORKSPACE_COORDINATION off, it is the legacy per-pot routine.
 *       With WORKSPACE_COORDINATION on, it is keyed to the workspace papercup so
 *       there is ONE Scout brain per workspace (matching blender:cycle's runtime
 *       papercup) while hives keep their own cup execution / repo / membership.
 *       active:false ⇒ the routines engine never ticks it until armed. Its
 *       cycle budget lives in payload_template.budget.maxCostUsd
 *       (parseScoutCycleConfig reads it).
 *
 * Mirrors knowledge-packs/seed.ts (seedPackIntoPot): pure-ish, injectable Sql,
 * returns an `undo` that joins the create's rollback stack so a LATER create
 * step failure removes the rows we laid down — and a summary the result reports.
 *
 * The gym row remains keyed on the pot's OWN slug; the Scout routine uses the
 * workspace-brain scope helper so it follows the shared Mug/Scout/Overwatch
 * re-key. There is NO `?? operatorHomeHarnessSlug()` env default here (P-022
 * retires those env-slug seed scripts for gym/scout). The matching teardown at
 * pot:dissolve (delete the per-pot rows + the governor registrants) is P-021.
 */
import type { Sql } from 'postgres';
import { setAutoloop } from '../gym/control-plane';
import { dreamLoopId, dreamRegistrationInput } from '../dream/dream-governor';
import { gymLoopId, scoutLoopId } from '../learning-governor/core';
import { deleteLearningLoop, getLearningLoop, registerLearningLoop } from '../learning-governor/store';
import { isWorkspaceCoordinationOn, workspaceBrainScopeKey } from '../workspace-brain-scope';

/** The scout routine name a per-pot loop fires from (under the pot install_slug). */
export const POT_SCOUT_ROUTINE_NAME = 'scout-cycle';
/** The routines target_role the scout routine ticks. */
export const SCOUT_CYCLE_TARGET_ROLE = 'system:scout-cycle';
export const POT_DREAM_MANUAL_ROUTINE_NAME = 'dream-cycle-manual';
export const POT_DREAM_AUTO_ROUTINE_NAME = 'dream-cycle-auto';
export const DREAM_CYCLE_TARGET_ROLE = 'system:dream-cycle';
export const DEFAULT_POT_DREAM_MANUAL_CRON = '0 */5 * * * *';

/**
 * Per-pot scout cadence window: a cycle heartbeat fires twice an hour (every
 * 30 min). staggeredPotScoutCron spreads each pot's two fires DETERMINISTICALLY
 * across this window so N hives never collide on one boundary (P-050).
 */
export const POT_SCOUT_CADENCE_MIN = 30;

/**
 * Legacy fixed per-pot scout cron — every 30 min at :05/:35 (OFFSET from the
 * deploy/green-checkpoint :00/:15/:30/:45 rhythm). Superseded by the deterministic
 * per-pot stagger (P-050: {@link staggeredPotScoutCron}); kept only as the
 * documented "what the un-staggered default was" anchor. The provision default is
 * now per-pot-staggered.
 */
export const DEFAULT_POT_SCOUT_CRON = '0 5,35 * * * *';

/**
 * A stable 32-bit FNV-1a hash of a string. Deterministic + dependency-free — the
 * same slug always hashes to the same value (so a re-provision is idempotent),
 * and two different slugs almost never collide on BOTH the derived minute AND
 * second (P-050 only needs "distinct boundaries", not a perfect partition).
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned via the >>> 0 below.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * P-050 — DETERMINISTIC per-pot scout cron. Scout is the one engine that
 * multiplies (N hives × ~13 in-process LLM calls/cycle on ONE shared Anthropic
 * rate limit, D-005). If every pot's routine fired on the same cron boundary,
 * N hives = 13N concurrent API calls at that instant. Spreading each pot's
 * heartbeat to a STABLE per-pot minute+second within the 30-min cadence window
 * — a pure function of the pot slug — declusters those bursts without any
 * coordination: pot A fires at e.g. `:07:42 / :37:42`, pot B at `:23:11 /
 * :53:11`, deterministically and idempotently (the same slug always lands on
 * the same offset, so re-provisioning never churns the schedule).
 *
 * The minute offset ranges over [0, 30) and the second over [0, 60), giving
 * 1800 distinct slots within a half-hour — ample to scatter realistic pot
 * counts. Returns a 6-field (seconds-resolution) cron `S M,M+30 * * * *`.
 */
export function staggeredPotScoutCron(potSlug: string): string {
  const h = fnv1a32(potSlug);
  // Two independent fields from the one hash: low bits → minute, high bits → second.
  const minute = h % POT_SCOUT_CADENCE_MIN; // [0, 30)
  const second = Math.floor(h / POT_SCOUT_CADENCE_MIN) % 60; // [0, 60)
  const minutes = `${minute},${minute + POT_SCOUT_CADENCE_MIN}`; // e.g. "7,37"
  return `${second} ${minutes} * * * *`;
}

/**
 * Default per-cycle scout budget for a fresh per-pot loop (USD). Conservative —
 * scout is the one engine that multiplies across N hives (D-005), so a new pot
 * starts cheap; the owner raises it when arming. parseScoutCycleConfig reads
 * this from payload_template.budget.maxCostUsd.
 */
export const DEFAULT_POT_SCOUT_MAX_COST_USD = 0.5;

export interface ProvisionPotLearningLoopInput {
  sql: Sql;
  workspaceId: string;
  /** The new pot's OWN home install_slug (NOT a `?? operatorHomeHarnessSlug()` default). */
  potSlug: string;
  /** Override the per-cycle scout budget cap (USD). Default 0.5. */
  scoutMaxCostUsd?: number;
  /**
   * Override the scout routine cron. Default = the DETERMINISTIC per-pot stagger
   * (P-050: {@link staggeredPotScoutCron}) — a stable per-slug minute+second
   * within the 30-min window so N hives don't burst together.
   */
  scoutCron?: string;
  /** Manual Start/Pause cadence; row still ships inactive. Default every 5m. */
  dreamManualCron?: string;
  /** Auto-dream heartbeat; row still ships inactive. Default = per-pot 30m stagger. */
  dreamAutoCron?: string;
  now?: number;
}

export interface ProvisionPotLearningLoopResult {
  ok: boolean;
  potSlug: string;
  /** The dark gym autoloop row was written. */
  gymAutoloop: boolean;
  /** The inactive scout routine row was written. */
  scoutRoutine: boolean;
  /** The scout routine id (install_slug + name, sanitized). */
  scoutRoutineId?: string;
  /** Per-cycle scout budget the routine carries. */
  scoutMaxCostUsd?: number;
  /** The inactive manual Start/Pause routine was written. */
  dreamManualRoutine: boolean;
  /** The separate inactive/default-OFF auto-dream routine was written. */
  dreamAutoRoutine: boolean;
  /** The bounded `dream:<pot>` learning-governor registrant was written. */
  dreamGovernorRegistrant: boolean;
  /** Removes both rows — joins the create's undo stack (best-effort). */
  undo: () => Promise<void>;
  /** Present on a partial/failed provision; the create reports + warns, never fails. */
  error?: string;
}

/** Sanitize an install_slug + routine name into a routines.id (mirrors the seed scripts). */
export function potScoutRoutineId(potSlug: string): string {
  return `rt_${potSlug}_${POT_SCOUT_ROUTINE_NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

export function potDreamRoutineId(potSlug: string, mode: 'manual' | 'auto'): string {
  const name = mode === 'manual' ? POT_DREAM_MANUAL_ROUTINE_NAME : POT_DREAM_AUTO_ROUTINE_NAME;
  return `rt_${potSlug}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

async function scoutRoutineScope(workspaceId: string, potSlug: string): Promise<string> {
  return workspaceBrainScopeKey(workspaceId, potSlug, await isWorkspaceCoordinationOn());
}

/** Add dormant Dream controls to new or existing pots without retuning any learning lane. */
export async function ensurePotDreamLearningLoop(input: {
  sql: Sql;
  workspaceId: string;
  potSlug: string;
  dreamManualCron?: string;
  dreamAutoCron?: string;
}): Promise<void> {
  const { sql, workspaceId, potSlug } = input;
  if (!workspaceId.trim() || !potSlug.trim()) throw new Error('Dream setup requires a workspace and pot.');
  const rows = [
    { mode: 'manual', name: POT_DREAM_MANUAL_ROUTINE_NAME, cron: input.dreamManualCron ?? DEFAULT_POT_DREAM_MANUAL_CRON },
    { mode: 'auto', name: POT_DREAM_AUTO_ROUTINE_NAME, cron: input.dreamAutoCron ?? staggeredPotScoutCron(`${potSlug}:dream`) },
  ] as const;
  for (const row of rows) {
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         payload_template, concurrency, catchup, active, next_fire_at)
      VALUES (${potDreamRoutineId(potSlug, row.mode)}, ${potSlug}, ${workspaceId}, ${row.name}, 'cron',
              ${JSON.stringify({ cron: row.cron })}::text::jsonb, ${DREAM_CYCLE_TARGET_ROLE},
              ${JSON.stringify({ mode: row.mode })}::text::jsonb, 'skip', 'skip-old', false, now())
      ON CONFLICT (install_slug, name) DO NOTHING`;
  }
  await registerLearningLoop(sql, { ...dreamRegistrationInput({ workspaceId, potSlug }), ifMissing: true });
}

/**
 * Provision the learning-loop records. Both writes are dark/inactive; the
 * returned undo removes the rows we created. When the Scout routine already
 * existed under the workspace papercup, rollback preserves it for the rest of
 * the workspace.
 */
export async function provisionPotLearningLoop(
  input: ProvisionPotLearningLoopInput,
): Promise<ProvisionPotLearningLoopResult> {
  const { sql, workspaceId, potSlug } = input;
  const now = input.now ?? Date.now();
  const maxCostUsd = input.scoutMaxCostUsd ?? DEFAULT_POT_SCOUT_MAX_COST_USD;
  const scoutScope = await scoutRoutineScope(workspaceId, potSlug);
  // P-050 legacy: OFF uses a deterministic per-pot cron offset. ON uses the
  // same deterministic function against the workspace papercup, yielding one
  // stable workspace Scout routine instead of N per-pot routines.
  const cron = input.scoutCron ?? staggeredPotScoutCron(scoutScope);
  const routineId = potScoutRoutineId(scoutScope);
  const existingScoutRows = await sql<Array<{ id: string }>>`
    SELECT id FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId} AND install_slug = ${scoutScope} AND name = ${POT_SCOUT_ROUTINE_NAME}
     LIMIT 1`;
  const scoutRoutineExisted = existingScoutRows.length > 0;
  const existingDreamRows = await sql<Array<{ name: string }>>`
    SELECT name FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId} AND install_slug = ${potSlug}
       AND name IN (${POT_DREAM_MANUAL_ROUTINE_NAME}, ${POT_DREAM_AUTO_ROUTINE_NAME})`;
  const existingDreamNames = new Set(existingDreamRows.map((row) => row.name));
  const dreamGovernorExisted = Boolean(
    await getLearningLoop(sql, { workspaceId, loopId: dreamLoopId(potSlug) }),
  );

  // (a) DARK gym autoloop row — enabled:false + budget:null. setAutoloop upserts;
  //     for a fresh pot this is a pure INSERT, so the undo can delete the row.
  await setAutoloop(sql, {
    workspaceId,
    harnessSlug: potSlug,
    enabled: false,
    budgetUsd: null,
    now,
  });
  const gymAutoloop = true;

  // (b) INACTIVE scout routine under the effective Scout scope (legacy pot slug,
  //     or workspace papercup when WORKSPACE_COORDINATION is ON).
  //     payload_template.budget.maxCostUsd is the per-pot per-cycle cap
  //     (parseScoutCycleConfig reads it). active:false ⇒ never ticks until armed.
  const payloadTemplate = JSON.stringify({ budget: { maxCostUsd } });
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${routineId}, ${scoutScope}, ${workspaceId}, ${POT_SCOUT_ROUTINE_NAME}, 'cron',
            ${JSON.stringify({ cron })}::text::jsonb, ${SCOUT_CYCLE_TARGET_ROLE},
            ${payloadTemplate}::text::jsonb, 'skip', 'skip-old', false, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = EXCLUDED.payload_template,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()`;
  const scoutRoutine = true;

  // (c) TWO independent, INACTIVE controls over one action. The manual row is
  // what Learning-tab Start/Pause toggles. The auto row is the expensive,
  // separate default-OFF setting; its action additionally self-gates on owner
  // steering + measured idle capacity. DREAM_CYCLE gates the surface, not the
  // rows' activation state.
  await ensurePotDreamLearningLoop(input);
  const dreamManualRoutine = true;
  const dreamAutoRoutine = true;

  const dreamGovernorRegistrant = true;

  const undo = async (): Promise<void> => {
    // Best-effort: a create-rollback must never throw. Remove exactly what we laid down.
    try {
      await sql`
        DELETE FROM harness_shared.gym_autoloop_config
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${potSlug}`;
    } catch {
      /* ignore */
    }
    for (const name of [POT_DREAM_MANUAL_ROUTINE_NAME, POT_DREAM_AUTO_ROUTINE_NAME]) {
      if (existingDreamNames.has(name)) continue;
      try {
        await sql`
          DELETE FROM harness_shared.routines
           WHERE workspace_id = ${workspaceId} AND install_slug = ${potSlug} AND name = ${name}`;
      } catch {
        /* ignore */
      }
    }
    if (!dreamGovernorExisted) {
      try {
        await deleteLearningLoop(sql, { workspaceId, loopId: dreamLoopId(potSlug) });
      } catch {
        /* ignore */
      }
    }
    try {
      await sql`
        DELETE FROM harness_shared.routines
         WHERE workspace_id = ${workspaceId} AND install_slug = ${scoutScope} AND name = ${POT_SCOUT_ROUTINE_NAME}
           AND ${!scoutRoutineExisted}`;
    } catch {
      /* ignore */
    }
  };

  return {
    ok: true,
    potSlug,
    gymAutoloop,
    scoutRoutine,
    scoutRoutineId: routineId,
    scoutMaxCostUsd: maxCostUsd,
    dreamManualRoutine,
    dreamAutoRoutine,
    dreamGovernorRegistrant,
    undo,
  };
}

export interface TeardownPotLearningLoopInput {
  sql: Sql;
  workspaceId: string;
  /** The dissolving pot's OWN home install_slug — same key provisionPotLearningLoop used. */
  potSlug: string;
}

export interface TeardownPotLearningLoopResult {
  potSlug: string;
  /** The dark gym autoloop row was removed (or was already absent). */
  gymAutoloop: boolean;
  /** The inactive scout routine row was removed (or was already absent). */
  scoutRoutine: boolean;
  /** Both inactive dream routine rows were removed (or already absent). */
  dreamRoutines: boolean;
  /** The `gym:<pot>` / `scout:<pot>` / `dream:<pot>` governor registrants were removed (or absent). */
  governorRegistrants: boolean;
  /** The install-scoped infrastructure routines (git/release and outbox drains) for this
   *  install were removed (or were already absent) — git-sync-dx-hardening P-007. */
  gitSyncRoutines: boolean;
}

/**
 * teardownPotLearningLoop — the lifecycle inverse of provisionPotLearningLoop,
 * called from pot:dissolve (per-hive-learning-loops-2026-06-14 P-021; D-003).
 * Removes EVERYTHING the provision laid down for this pot:
 *   (a) the dark gym_autoloop_config row keyed (workspace_id, harness_slug=potSlug),
 *   (b) the inactive scout routine (install_slug=potSlug, name='scout-cycle'),
   *   (c) the manual + auto dream routines and governor registrants
   *       `gym:<pot>` + `scout:<pot>` + `dream:<pot>`.
   *   (d) the install-scoped infrastructure routines (git/release + outbox drains) seeded for
 *       this install — they otherwise leak per benchmark run; both dissolve paths
 *       (pot:dissolve + dissolveBenchPot) flow through here.
 *
 * Mirrors the provision's `undo` (which removes a+b), extended with the governor
 * registrants the provision NEVER writes (the gym/scout tick mirrors write those
 * lazily on first armed contact). Idempotent + best-effort throughout: each
 * removal is independently try/caught so a missing row — or one removal failing —
 * never blocks the others, and the caller WARNS rather than failing the dissolve.
 */
export async function teardownPotLearningLoop(
  input: TeardownPotLearningLoopInput,
): Promise<TeardownPotLearningLoopResult> {
  const { sql, workspaceId, potSlug } = input;
  const result: TeardownPotLearningLoopResult = {
    potSlug,
    gymAutoloop: false,
    scoutRoutine: false,
    dreamRoutines: false,
    governorRegistrants: false,
    gitSyncRoutines: false,
  };

  // (a) dark gym autoloop row.
  try {
    await sql`
      DELETE FROM harness_shared.gym_autoloop_config
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${potSlug}`;
    result.gymAutoloop = true;
  } catch {
    /* best-effort — a failure WARNS in the caller, never fails the dissolve */
  }

  // (b) inactive scout routine (reuse the provision's keying).
  try {
    await sql`
      DELETE FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND install_slug = ${potSlug} AND name = ${POT_SCOUT_ROUTINE_NAME}`;
    result.scoutRoutine = true;
  } catch {
    /* best-effort */
  }

  // (c) learning-governor registrants gym:<pot> + blender:<pot>.
  try {
    await sql`
      DELETE FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND install_slug = ${potSlug}
         AND name IN (${POT_DREAM_MANUAL_ROUTINE_NAME}, ${POT_DREAM_AUTO_ROUTINE_NAME})`;
    result.dreamRoutines = true;
  } catch {
    /* best-effort */
  }

  // (c) learning-governor registrants gym:<pot> + blender:<pot> + dream:<pot>.
  try {
    await deleteLearningLoop(sql, { workspaceId, loopId: gymLoopId(potSlug) });
    await deleteLearningLoop(sql, { workspaceId, loopId: scoutLoopId(potSlug) });
    // Pre-rename registrant rows (WI-2932): scoutLoopId minted `scout:<pot>`
    // before the blender rename — delete the legacy row too so a dissolve never
    // strands an orphaned governor registrant. DELETE this line when the S2
    // contract migration rewrites/reaps the legacy loop ids.
    await deleteLearningLoop(sql, { workspaceId, loopId: `scout:${potSlug}` });
    await deleteLearningLoop(sql, { workspaceId, loopId: dreamLoopId(potSlug) });
    result.governorRegistrants = true;
  } catch {
    /* best-effort */
  }

  // (d) install-scoped infrastructure routines (git-sync-dx-hardening-2026-06-17 P-007 / F6):
  //     git/release and outbox-drain rows seeded per install must leave with that install.
  //     Missing one target here leaked the WI-3329 disposable pot's cross-hive drain after
  //     dissolve, leaving an active routine under an unregistered slug. Scoped tightly to
  //     THIS pot's install_slug, so a live install's routines are never touched.
  try {
    await sql`
      DELETE FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND install_slug = ${potSlug}
         AND target_role IN (
           'system:git-sync',
           'system:green-checkpoint',
           'system:release-trigger',
           'system:cross-pot-outbox-drain',
           'system:cross-hive-outbox-drain'
         )`;
    result.gitSyncRoutines = true;
  } catch {
    /* best-effort */
  }

  return result;
}
