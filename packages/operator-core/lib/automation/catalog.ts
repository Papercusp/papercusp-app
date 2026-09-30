/**
 * Automation catalog — the read model behind the owner-facing automation panes:
 * **Agents** (everything that runs a model) and **System** (everything that does
 * not). Both render from this one catalog; the pane a row lands in is decided by
 * its `spend`, so the split cannot leave a row homeless.
 *
 * WHY THIS EXISTS (2026-07-25, owner ask): the owner's weekly Claude limit was
 * being consumed by cron-spawned agents with NO owner-facing surface to see or
 * configure them. Every existing surface produced a false negative — the
 * agents-running roster reads empty because these agents are EPHEMERAL (spawn →
 * a few turns → exit), so nothing is ever listed while spend is continuous.
 * See /internal/docs/agent-insights/attributing-claude-token-spend.
 *
 * WHY IT LOOKS LIKE THIS (2026-07-26, agents-system-pane-split): the first version
 * grouped by CATEGORY — learning / docs / supervision / health / infra — and fed
 * three panes (Blender, Docs, Agents, the latter two now retired). The owner's
 * question "is everything in the agents tab an llm?" exposed the axis as wrong: of
 * 140 non-loop schedules, 55 spawn a model and 85 are git commits, GC and probes.
 * Category is a label; SPEND is the thing worth splitting on, and it derives from
 * `target_role` (see ./routine-classification).
 *
 * This module joins the halves the owner needs in one place:
 *   - WHAT IS SCHEDULED — `harness_shared.routines` (cadence, active, last/next fire)
 *     plus the four non-routines sources via `collectScheduleInventory`
 *   - WHETHER IT SPENDS — derived per row from `target_role`
 *   - WHAT IT COSTS     — `harness_shared.agent_usage_samples` rolled up by role
 *
 * ⚠ DELIBERATELY NOT JOINED: routine → cost. `agent_usage_samples.account_id` is
 * frequently NULL and there is no foreign key from a usage row back to the routine
 * that spawned it, so any per-routine cost number would be a guess presented as a
 * fact. Spend is reported by ROLE alongside the schedule, never fused into it.
 * (An earlier version of this investigation asserted exactly such an unproven link
 * and was wrong twice.) If per-routine attribution is wanted, the fix is to stamp
 * the spawning routine onto the usage row at spawn time — not to infer it here.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  readScoutBudgetOverrides,
  resolveScoutWorkspaceCeilingUsd,
  resolveScoutWorkspaceCeilingUsdLive,
} from '../learning-governor/scout-budget-overrides';
import type { LearningBudgetKind } from '../learning-governor/core';
import { activeWorkspaceId } from '../workspace-registry';
import type { ScheduleSource } from '../schedule-inventory';

// The owner-facing category set + which pane renders each one now live in a
// dependency-free module, because the sidebar tabs import them as VALUES and
// this file top-level-imports a Postgres client. Re-exported so existing
// importers (and the automation.catalog consumers) are unaffected.
export { AUTOMATION_CATEGORIES } from './pane-categories';
export type { AutomationCategory } from './pane-categories';
import type { AutomationCategory } from './pane-categories';
import { AUTOMATION_CATEGORIES } from './pane-categories';
import {
  isClockDriven,
  routineControl,
  routineFamily,
  routineKind,
  routineArmedState,
  routineLiveness,
  routineNeedsAttention,
  spendForTargetRole,
  spendReasonForTargetRole,
  type RoutineArmedState,
  type RoutineControl,
  type RoutineFamily,
  type RoutineKind,
  type RoutineLiveness,
  type RoutineSpend,
} from './routine-classification';

export interface AutomationRoutine {
  name: string;
  installSlug: string;
  group: string | null;
  category: AutomationCategory;
  cron: string | null;
  /** Human cadence, e.g. "every 30m" — derived from cron for display. */
  cadence: string | null;
  active: boolean;
  /**
   * Does firing this bill a model? Derived from `target_role` via
   * TARGET_ROLE_SPEND — NOT from the routine's name (the retired
   * AGENT_SPAWNING_PATTERNS regex flagged `wake-brain`, a no-op tombstone, and
   * four of the five `improvement-*` routines that never dispatch).
   *
   * `'unknown'` means the role has no classification — surfaced as its own state
   * rather than defaulting to `none`, so a new system action cannot present itself
   * as free.
   */
  spend: RoutineSpend | 'unknown';
  /** One-line reason behind `spend`, for the row tooltip. Null when unknown. */
  spendWhy: string | null;
  /** True when this routine's fire spawns a model-backed agent. Alias of `spend === 'llm'`. */
  spawnsAgent: boolean;
  /** What fires it: a clock, an event, or an armed agent loop. */
  kind: RoutineKind;
  /** Subject grouping for the browse-by-family view. */
  family: RoutineFamily;
  /** Is it actually going to run again? `active` alone cannot say (see routine-classification). */
  liveness: RoutineLiveness;
  /**
   * Is this schedule ARMED right now — and do we actually know?
   *
   * WI-6447 (owner-reported 2026-07-27): the pane rendered an unarmed sweep
   * identically to a running one (both just showed their cadence, e.g. "every
   * 1m"), so the owner could see neither the state nor a switch. Worse, the
   * boolean it was derived through — `const active = row.armed !== false` —
   * turned schedule-inventory's THIRD value into the optimistic one:
   * `armed: null` means genuinely UNKNOWN (the external-process rows carry
   * "static manifest — live fire-state requires P-014 federation"), and it was
   * silently reading as active. The pane asserted "running" where nothing had
   * checked.
   *
   * So this mirrors `spend: RoutineSpend | 'unknown'` directly above: the
   * unverified case is its OWN state rather than defaulting to the reassuring
   * one, so an unverifiable schedule cannot present itself as healthy — the
   * same rule that made `spend` refuse to let a new system action present
   * itself as free.
   */
  armedState: RoutineArmedState;
  /** Where this row's on/off switch lives — replaces the ambiguous `controllable: false` padlock. */
  control: RoutineControl;
  /**
   * One line: where the switch is, or WHY this row has none. Mirrors `spendWhy`.
   * Exists because `control:'none'` alone collapsed five different situations into
   * one dead-end tooltip ("paused from its own subsystem"), which sent the owner
   * to ask a human instead of reading the row. See `routineControl`.
   */
  controlWhy: string;
  /**
   * When `control === 'flag'`, the feature-flag key that IS this row's armed state
   * (e.g. `papercusp-doc-steward`). The pane wires its toggle to `flags:set` for
   * these — before this they rendered an inert padlock, so the one row with a real
   * switch was the one the pane refused to offer a control for.
   */
  flagKey: string | null;
  /** Does this row want the owner's attention right now? */
  needsAttention: boolean;
  /**
   * Every install slug this routine is deployed to. `git-sync` is ONE routine
   * installed on 19 pots; the pane renders one row carrying all 19 rather than 19
   * peer rows. Always ≥1 and always contains `installSlug`.
   */
  installs: string[];
  /** For a loop row: the session that armed it (routines.target_owner_id). */
  ownerId: string | null;
  /** For a loop row: when that session was last active — why a stalled loop is stalled. */
  ownerLastActiveAt: string | null;
  /** For a triggered row: what fires it, e.g. "after each git-sync". Null otherwise. */
  triggerLabel: string | null;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  /**
   * Which scheduling mechanism this row came from. `harness_shared.routines` is
   * only ONE of five (see lib/schedule-inventory.ts); the pane used to read that
   * one table alone, which is why scheduled work living in a DBOS workflow, a
   * managedSetInterval timer or an in-process sweep was structurally invisible
   * in the rail no matter how the categories were wired.
   */
  source: ScheduleSource;
  /**
   * Whether this row can be paused from the pane. Only `routines` rows can:
   * `routines:set` writes that table and nothing else. A row with
   * `controllable:false` MUST NOT render a working-looking pause button — the
   * whole reason this pane was broken is that it offered controls that could
   * not act, so an inert control here would repeat the same lie in a new place.
   */
  controllable: boolean;
}

export interface AutomationRoleSpend {
  role: string;
  modelClass: string | null;
  turns: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  lastSeenAt: string | null;
}

export interface AutomationCategorySummary {
  category: AutomationCategory;
  total: number;
  active: number;
  /** Active routines in this category that spawn a model-backed agent. */
  activeSpawning: number;
}

/** Per-pot gym arm state (harness_shared.gym_autoloop_config) — armed via gym:arm. */
export interface AutomationGymArm {
  harnessSlug: string;
  enabled: boolean;
  budgetUsd: number | null;
  spentUsd: number;
  status: string;
}

/** Per-lane learning-governor arm state (harness_shared.learning_governor_loops) — armed via governor:arm. */
export interface AutomationLaneArm {
  loopId: string;
  displayName: string;
  potSlug: string | null;
  enabled: boolean;
  budgetUsd: number | null;
  /**
   * How `budgetUsd` bounds spend — WITHOUT this a per-cycle cap renders as a lifetime overrun.
   * 'lifetime' accumulates (remaining = budget − spent); 'per-cycle' caps ONE run, so
   * `remainingLoopBudgetUsd` returns the cap unchanged and `spentUsd` is a cumulative total the
   * cap never bounds (learning-governor/core.ts:83-87).
   */
  budgetKind: LearningBudgetKind;
  spentUsd: number;
  enforcement: string;
}

/** Workspace-wide Scout/Blender spend ceiling (learning:set-scout-budget) — the cap ABOVE every per-pot/per-lane budget below. */
export interface AutomationScoutCeiling {
  /** Runtime override in USD; null = unset (env/default governs). */
  overrideUsd: number | null;
  /** The ceiling actually in force (override ?? env/default). 0 = no Scout spend allowed. */
  effectiveUsd: number;
  /** The env/default layer the override shadows. */
  envUsd: number;
}

/**
 * The SPEND-GATING layer, distinct from the schedule layer above (P-011): a
 * routine can be active while its pot/lane is disarmed (fires, spends nothing)
 * and vice versa. `gym:*` governor rows are deliberately folded into `gymPots`
 * (via gym_autoloop_config) rather than listed as lanes — gym arming writes both
 * layers through gym:arm, and the dozens of disabled `gym:<dead-test-pot>` rows
 * would otherwise swamp the list.
 */
/**
 * The per-pot learning MASTER switch (learning-pot-scope-gate-2026-08-30 D-001),
 * the layer ABOVE gymPots and lanes: a pot switched off here gates every lane
 * under it while leaving each lane's own arming untouched, so switching it back
 * on restores exactly what was armed.
 */
export interface AutomationPotScope {
  /**
   * The pots switched OFF. This is the load-bearing field: an ABSENT row means
   * ENABLED, so the enabled set is answered by absence and only this one is
   * worth materializing. It is served explicitly rather than left for each UI
   * surface to derive, because a surface that re-derives the fail-open rule and
   * gets it backwards renders every pot as switched off.
   */
  disabledPots: string[];
  /** Every stored row — including explicit re-enables, which keep their audit stamp. */
  rows: Array<{ potSlug: string; enabled: boolean; setBy: string | null; setAt: string }>;
}

export interface AutomationArming {
  gymPots: AutomationGymArm[];
  lanes: AutomationLaneArm[];
  /** P-012: the workspace-wide ceiling row rendered above the per-pot/per-lane arms; null when unreadable. */
  scoutCeiling: AutomationScoutCeiling | null;
  /**
   * learning-pot-scope-gate D-001: the per-pot master switch. `null` when
   * unreadable — NOT an empty scope, because an empty scope means "every pot is
   * learning", which is a claim this pane must not make when it failed to read.
   */
  potScope: AutomationPotScope | null;
}

export interface AutomationCatalog {
  routines: AutomationRoutine[];
  categories: AutomationCategorySummary[];
  /** 7-day spend by agent role. NOT attributable per-routine — see module header. */
  spend7d: AutomationRoleSpend[];
  spend7dTotalUsd: number;
  /** Arming (spend-gate) state for the Blender pane's Arming section. */
  arming: AutomationArming;
  generatedAt: string;
}

/**
 * ⚠ RETIRED: `AGENT_SPAWNING_PATTERNS` (agents-system-pane-split-2026-07-26 D-001).
 *
 * The "can this spend money?" answer used to be a list of regexes matched against
 * the routine's NAME. It was wrong in both directions and its output drove the
 * owner-facing "tokens" flag:
 *
 *   • `/(^|-)wake($|-)/` flagged `wake-brain`, whose handler is
 *     `async (ctx) => { void ctx; }` — a retired tombstone that cannot spend.
 *   • `/^improvement-(implement|triage|watchdog|human-digest|invalid-args-miner)$/`
 *     flagged five routines; only `improvement-implement` returns `durableSpawns`.
 *
 * Spend now derives from `target_role` — the handler the routines engine actually
 * dispatches to — via `spendForTargetRole()` in ./routine-classification, whose
 * table is cross-checked against the live registry by a test. See that module's
 * header for the full rationale.
 */

const DOCS_PATTERNS: RegExp[] = [/doc/i, /^knowledge-pack-/i];

/**
 * Learning-pipeline routines identified by NAME, checked BEFORE the group slug for the same
 * reason Docs is: the owner thinks of the whole `improvement-*` family as one pipeline (the
 * Blender) and expects one place to pause it, but the DB files them across different groups —
 * `improvement-watchdog` is grouped `health` while its siblings `improvement-implement` /
 * `-triage` / `-human-digest` are grouped `self-improvement`. That split rendered the
 * pipeline's single biggest work-item emitter in the Agents pane while the rest of the family
 * sat in Blender, so pausing "the Blender" demonstrably did NOT stop it (2026-07-25: the
 * watchdog kept minting duplicate work items every 15 min).
 */
const LEARNING_NAME_PATTERNS: RegExp[] = [
  /^improvement-/i,
  /^bp-singleton-/i,
  /^gym-cycle$/i,
  /^template-gym$/i,
  /^pot-eval-battery$/i,
  /^scout-/i,
  /prospector-cadence$/i,
];

/**
 * @deprecated Name-based spend detection is retired (D-001) — it cannot see the
 * handler, so it guessed. Use `spendForTargetRole(targetRole)` instead. Kept only
 * so an out-of-tree caller fails loudly at review rather than silently getting a
 * wrong answer.
 */
export function routineSpawnsAgent(): never {
  throw new Error(
    'routineSpawnsAgent() is retired — spend derives from target_role. Use spendForTargetRole() from lib/automation/routine-classification.',
  );
}

/**
 * Classify a routine into an owner-facing category.
 *
 * Docs is checked BEFORE the group, because a documentation routine may be filed
 * under self-improvement/health by its group_slug while the owner thinks of it as
 * "the documentation agent" and looks for it in the Docs pane.
 */
export function classifyRoutine(name: string, groupSlug: string | null): AutomationCategory {
  if (DOCS_PATTERNS.some((re) => re.test(name))) return 'docs';
  // Before the group, like Docs: the learning pipeline must present as ONE pane even though
  // its routines are filed under different group slugs (see LEARNING_NAME_PATTERNS).
  if (LEARNING_NAME_PATTERNS.some((re) => re.test(name))) return 'learning';
  if (groupSlug === 'agent-loops' || /^loop-su-/i.test(name)) return 'agent-loops';
  if (groupSlug === 'self-improvement') return 'learning';
  if (groupSlug === 'supervision') return 'supervision';
  if (groupSlug === 'health') return 'health';
  if (groupSlug === 'git-sync' || groupSlug === 'release') return 'infra';
  // Ungrouped: fall back to name shape so nothing lands in a category the owner
  // would never think to open.
  if (/^bp-singleton-|gym|improvement-|eval-battery|prospector/i.test(name)) return 'learning';
  if (/git-sync|checkpoint|release|deploy|gc|reaper|retention|precompute/i.test(name)) return 'infra';
  if (/wake|overwatch|coord-|claim-|canary|autonomy/i.test(name)) return 'supervision';
  return 'health';
}

/** Render a cron expression as a short human cadence for the pane. */
export function cronCadence(cron: string | null): string | null {
  if (!cron) return null;
  const f = cron.trim().split(/\s+/);
  // 6-field (with seconds) or 5-field.
  const [, min, hour] = f.length >= 6 ? f : ['0', ...f];
  const everyMin = min?.match(/^\*\/(\d+)$/);
  if (everyMin && hour === '*') return `every ${everyMin[1]}m`;
  const everyHour = hour?.match(/^\*\/(\d+)$/);
  if (everyHour) return `every ${everyHour[1]}h`;
  if (min?.includes(',') && hour === '*') return `${min.split(',').length}×/hour`;
  if (hour === '*') return 'hourly';
  if (/^\d+$/.test(hour ?? '')) return 'daily';
  return cron;
}

/** "every 5m" for a loop's reschedule interval — loops carry no cron. */
export function loopCadence(intervalSec: number | null | undefined): string | null {
  if (intervalSec == null || !Number.isFinite(intervalSec) || intervalSec <= 0) return null;
  if (intervalSec % 3600 === 0) return `every ${intervalSec / 3600}h`;
  if (intervalSec % 60 === 0) return `every ${intervalSec / 60}m`;
  return `every ${Math.round(intervalSec)}s`;
}

/**
 * Spend for a NON-routines inventory row, which has no `target_role` to classify by.
 *
 * `sync-triggered` sweeps DECLARE it (SYNC_TRIGGERED_SWEEPS.spends) because they are
 * the one host source that can dispatch an agent — `doc-steward-dispatch` spawns a
 * doc-steward per drift batch. Every other source (DBOS scheduled workflows, managed
 * timers, in-process sweeps, external-process timers) runs host code inline and has
 * no spawn seam at all, so `none` is a structural fact about the mechanism rather
 * than a per-row guess — which is why this is not the silent unknown→none default
 * that D-002 forbids.
 */
function inventorySpend(row: { category: string; source: string; detail?: Record<string, unknown> | null }): {
  spend: RoutineSpend | 'unknown';
  why: string | null;
} {
  if (row.category === 'sync-triggered') {
    const declared = row.detail?.spends;
    if (declared === 'llm') return { spend: 'llm', why: 'Dispatches an agent when its trigger fires' };
    if (declared === 'none') return { spend: 'none', why: 'Runs inline on its trigger — no agent spawn' };
    return { spend: 'unknown', why: null };
  }
  return { spend: 'none', why: `Host ${row.source} machinery — runs inline, no agent spawn seam` };
}

/**
 * Collapse per-pot fan-out: one row per (name, kind), carrying every install.
 *
 * `git-sync` is ONE routine installed on 19 pots; `green-checkpoint` on 14;
 * `cross-hive-outbox-drain` on 13; `hive-wake` on 16. Listed per-install they were
 * 60+ peer rows of four things, which is most of why the pane read as a wall.
 *
 * The collapsed row reports the UNION honestly: active if ANY install is active,
 * the worst liveness across installs (so one stalled pot cannot hide behind
 * fifteen healthy ones), the most recent fire, and the earliest next fire. Loops
 * are deliberately NOT collapsed — each is a distinct session's loop and its name
 * is already unique.
 */
export function collapseFanOut(rows: readonly AutomationRoutine[]): AutomationRoutine[] {
  const byKey = new Map<string, AutomationRoutine[]>();
  for (const r of rows) {
    const key = `${r.kind}\x00${r.name}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }

  const worst = (xs: readonly AutomationRoutine[]): RoutineLiveness =>
    xs.some((x) => x.liveness === 'stalled')
      ? 'stalled'
      : xs.some((x) => x.liveness === 'running')
        ? 'running'
        : 'dormant';

  /**
   * WI-6447: collapse a group's armed states without inventing certainty. A
   * grouped row spreads `...head`, so without this the FIRST install's state
   * would silently speak for all of them. If ANY install is unverifiable the
   * group is `unknown` — the group cannot be more certain than its least
   * certain member. Otherwise it mirrors `active = group.some(...)`: armed
   * somewhere reads as armed.
   */
  const worstArmed = (xs: readonly AutomationRoutine[]): RoutineArmedState =>
    xs.some((x) => x.armedState === 'unknown')
      ? 'unknown'
      : xs.some((x) => x.armedState === 'armed')
        ? 'armed'
        : 'disarmed';

  const maxIso = (xs: Array<string | null>): string | null =>
    xs.filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const minIso = (xs: Array<string | null>): string | null =>
    xs.filter((x): x is string => Boolean(x)).sort().at(0) ?? null;

  const out: AutomationRoutine[] = [];
  for (const group of byKey.values()) {
    const head = group[0]!;
    if (group.length === 1) {
      out.push(head);
      continue;
    }
    const active = group.some((g) => g.active);
    const liveness = worst(group);
    const armedState = worstArmed(group);
    /*
     * A group can hold two DIFFERENT kinds of member, and conflating them is what made the
     * pane refuse a switch that existed (EI-19294826146331487):
     *
     *   - several INSTALLS of one routine (git-sync ×19) — each its own `routines:set` target;
     *   - several VIEWS of ONE subject — an arm-state routines row plus the live inventory
     *     observation of the same sweep. A view is not an install: it is never controllable,
     *     and its `installSlug` is a SOURCE name ('in-process', 'managed', 'external-process')
     *     that `routines:set` cannot address at all.
     *
     * So the routines members alone decide both answers when any exist. Demanding that EVERY
     * member be controllable let a single view veto a real switch; iterating every member's
     * slug would have pointed the click at a source name and failed the write.
     */
    const switches = group.filter((g) => g.source === 'routines');
    const controllers = switches.length > 0 ? switches : group;
    out.push({
      ...head,
      active,
      liveness,
      armedState,
      needsAttention: routineNeedsAttention({
        liveness,
        armedState,
        control: head.control,
        active,
        spend: head.spend,
      }),
      // Sorted so the row is stable across reads regardless of SQL ordering.
      installs: controllers.map((g) => g.installSlug).sort(),
      lastFiredAt: maxIso(group.map((g) => g.lastFiredAt)),
      nextFireAt: minIso(group.map((g) => g.nextFireAt)),
      // Controllable only if every INSTALL is — a partially-controllable row would
      // offer a switch that silently misses some pots. Views are excluded above.
      controllable: controllers.every((g) => g.controllable),
    });
  }
  return out;
}

export async function getAutomationCatalog(): Promise<AutomationCatalog> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const iso = (d: Date | null | undefined): string | null =>
    d && !Number.isNaN(new Date(d).getTime()) ? new Date(d).toISOString() : null;

  // The LEFT JOIN on coord_presence is what lets a stalled loop EXPLAIN itself: a
  // `loop-<ownerId>` row whose owning session last spoke five days ago is stalled
  // *because the owner is gone*, and that sentence is the whole reason the row is
  // actionable rather than mysterious.
  const rows = await sql<
    Array<{
      name: string;
      install_slug: string;
      group_slug: string | null;
      trigger_config: Record<string, unknown> | null;
      target_role: string | null;
      payload_template: Record<string, unknown> | null;
      target_owner_id: string | null;
      reschedule_interval_sec: number | null;
      tier: string | null;
      active: boolean;
      last_fired_at: Date | null;
      next_fire_at: Date | null;
      owner_last_active_at: Date | null;
    }>
  >`
    SELECT r.name, r.install_slug, r.group_slug, r.trigger_config, r.target_role,
           r.payload_template,
           r.target_owner_id, r.reschedule_interval_sec, r.tier, r.active,
           r.last_fired_at, r.next_fire_at,
           p.last_active_at AS owner_last_active_at
      FROM harness_shared.routines r
      LEFT JOIN harness_shared.coord_presence p
             ON p.owner_id = r.target_owner_id
            AND p.workspace_id = r.workspace_id
     WHERE r.workspace_id = ${ws}
     ORDER BY r.active DESC, r.name ASC`;

  const routines: AutomationRoutine[] = rows.map((r) => {
    const cron = typeof r.trigger_config?.cron === 'string' ? (r.trigger_config.cron as string) : null;
    const kind = routineKind({ name: r.name });
    const spend = spendForTargetRole(r.target_role, r.payload_template);
    const active = r.active === true;
    const clockDriven = isClockDriven({
      source: 'routines',
      kind,
      cron,
      rescheduleIntervalSec: r.reschedule_interval_sec,
      tier: r.tier,
    });
    const liveness = routineLiveness({ active, nextFireAt: iso(r.next_fire_at), clockDriven });
    const { control, why: controlWhy } = routineControl({ source: 'routines' });
    return {
      name: r.name,
      installSlug: r.install_slug,
      group: r.group_slug,
      category: classifyRoutine(r.name, r.group_slug),
      cron,
      cadence: cronCadence(cron) ?? loopCadence(r.reschedule_interval_sec),
      active,
      spend,
      spendWhy: spendReasonForTargetRole(r.target_role, r.payload_template),
      spawnsAgent: spend === 'llm',
      kind,
      family: routineFamily(r.name, kind),
      liveness,
      // A routines ROW has a real, stored `active` column — this is the one
      // source where armed state is genuinely known, never `unknown` (WI-6447).
      armedState: routineArmedState(active),
      control,
      controlWhy,
      flagKey: null,
      needsAttention: routineNeedsAttention({
        liveness,
        armedState: routineArmedState(active),
        control,
        active,
        spend,
      }),
      installs: [r.install_slug],
      ownerId: r.target_owner_id,
      ownerLastActiveAt: iso(r.owner_last_active_at),
      triggerLabel: null,
      lastFiredAt: iso(r.last_fired_at),
      nextFireAt: iso(r.next_fire_at),
      source: 'routines' as const,
      controllable: true,
    };
  });

  /*
   * The other four scheduling mechanisms. `harness_shared.routines` above is one
   * of five sources in the host (schedule-inventory.ts); reading only it is why
   * the owner could ask "what about the routine that checks for drifted
   * documentation?" and be right that it was missing — that sweep does not live
   * in the routines table, so no amount of category wiring could surface it.
   *
   * These rows are LISTED but not controllable: `routines:set` writes the
   * routines table and nothing else, so the pane shows them with their cadence
   * and last fire and says plainly that they cannot be paused from here.
   * Degrades to routines-only if the inventory throws — a partial pane beats a
   * pane that fails to load.
   */
  let external: AutomationRoutine[] = [];
  try {
    const { collectScheduleInventory } = await import('../schedule-inventory');
    const inventory = await collectScheduleInventory();
    external = inventory
      .filter((row) => row.source !== 'routines')
      .map((row) => {
        // `sync-triggered` rows (doc-freshness-sweep, doc-steward-dispatch) fire on
        // an EVENT, not a clock — they are function calls at the end of git-sync.
        // Calling them "schedules" is what produced the padlock with the false
        // tooltip "runs as an in-process schedule"; they get their own kind and
        // name their trigger instead of faking a cadence.
        const syncTriggered = row.category === 'sync-triggered';
        const kind = routineKind({ name: row.name, syncTriggered });
        // `armed` is null for sources that cannot report it; treat unknown as
        // running, because claiming a live sweep is "off" is the worse error.
        // WI-6447: keep the TRI-STATE. `active` stays a boolean because the
        // control/pause plumbing is boolean, but `armed !== false` maps UNKNOWN
        // onto true, so the honest value is derived separately and carried to the
        // pane rather than being destroyed here.
        const armedState = routineArmedState(row.armed);
        const active = row.armed !== false;
        const { spend, why: spendWhy } = inventorySpend(row);
        // Only a routines row has a `routines:set` switch. A sync-triggered sweep
        // whose armed state comes from a feature flag has a REAL switch — the flag —
        // so it is `flag`, not an inert padlock. Everything else is genuinely
        // uncontrollable from here and now says WHY (watchdog / per-process /
        // per-connection / other-process / ephemeral-tier) rather than pointing the
        // owner at an unnamed "own subsystem".
        const { control, why: controlWhy } = routineControl({
          source: row.source,
          category: row.category,
          flagKey: typeof row.detail?.flag === 'string' ? row.detail.flag : null,
        });
        const liveness = routineLiveness({
          active,
          nextFireAt: row.nextFire,
          // Keys on nextFire ALONE for a non-routines row — never on the cadence.
          // See isClockDriven's header for why (P-008: 17 healthy System sweeps
          // reported as needing attention the first time the pane ran for real).
          clockDriven: isClockDriven({ source: 'other', kind, nextFireAt: row.nextFire }),
        });
        return {
          name: row.name,
          installSlug: row.installSlug ?? row.source,
          group: row.groupSlug,
          category: classifyRoutine(row.name, row.groupSlug),
          cron: null,
          cadence: syncTriggered ? null : row.cadence || null,
          active,
          spend,
          spendWhy,
          spawnsAgent: spend === 'llm',
          kind,
          family: routineFamily(row.name, kind),
          liveness,
          armedState,
          control,
          controlWhy,
          flagKey: typeof row.detail?.flag === 'string' ? row.detail.flag : null,
          needsAttention: routineNeedsAttention({ liveness, armedState, control, active, spend }),
          installs: [row.installSlug ?? row.source],
          ownerId: null,
          ownerLastActiveAt: null,
          triggerLabel: syncTriggered ? row.cadence || 'on an event' : null,
          lastFiredAt: row.lastFire,
          nextFireAt: row.nextFire,
          source: row.source,
          controllable: false,
        };
      });
  } catch {
    external = [];
  }

  const allRoutines = collapseFanOut([...routines, ...external]);

  const categories: AutomationCategorySummary[] = AUTOMATION_CATEGORIES.map((category) => {
    const inCat = allRoutines.filter((x) => x.category === category);
    return {
      category,
      total: inCat.length,
      active: inCat.filter((x) => x.active).length,
      activeSpawning: inCat.filter((x) => x.active && x.spawnsAgent).length,
    };
  });

  const spendRows = await sql<
    Array<{
      role: string | null;
      model_class: string | null;
      turns: string | null;
      out_tok: string | null;
      cache_r: string | null;
      usd: string | null;
      last_ts: string | null;
    }>
  >`
    SELECT role,
           model_class,
           sum(turn_count)::text          AS turns,
           sum(output_tokens)::text       AS out_tok,
           sum(cache_read_tokens)::text   AS cache_r,
           sum(cost_usd)::text            AS usd,
           max(ts)::text                  AS last_ts
      FROM harness_shared.agent_usage_samples
     WHERE workspace_id = ${ws}
       AND ts > (extract(epoch from now()) * 1000 - 7 * 86400000)
     GROUP BY role, model_class
     ORDER BY sum(cost_usd) DESC NULLS LAST`;

  const spend7d: AutomationRoleSpend[] = spendRows
    .filter((r) => r.role)
    .map((r) => ({
      role: r.role as string,
      modelClass: r.model_class,
      turns: Number(r.turns ?? 0) || 0,
      outputTokens: Number(r.out_tok ?? 0) || 0,
      cacheReadTokens: Number(r.cache_r ?? 0) || 0,
      costUsd: Number(r.usd ?? 0) || 0,
      lastSeenAt: r.last_ts ? new Date(Number(r.last_ts)).toISOString() : null,
    }));

  // Arming (spend-gate) state — same degrade-to-empty posture as the schedule
  // inventory above: a partial pane beats a pane that fails to load.
  let arming: AutomationArming = { gymPots: [], lanes: [], scoutCeiling: null, potScope: null };
  try {
    const gymRows = await sql<
      Array<{ harness_slug: string; enabled: boolean; budget_usd: number | null; spent_usd: number | null; status: string | null }>
    >`
      SELECT harness_slug, enabled, budget_usd, spent_usd, status
        FROM harness_shared.gym_autoloop_config
       WHERE workspace_id = ${ws}
       ORDER BY enabled DESC, harness_slug ASC`;
    const laneRows = await sql<
      Array<{ loop_id: string; display_name: string | null; pot_slug: string | null; enabled: boolean; budget_usd: string | null; budget_kind: string | null; spent_usd: string | null; enforcement: string | null }>
    >`
      SELECT loop_id, display_name, pot_slug, enabled, budget_usd, budget_kind, spent_usd, enforcement
        FROM harness_shared.learning_governor_loops
       WHERE workspace_id = ${ws}
         AND loop_id NOT LIKE 'gym:%'
       ORDER BY enabled DESC, loop_id ASC`;
    arming = {
      gymPots: gymRows.map((r) => ({
        harnessSlug: r.harness_slug,
        enabled: r.enabled === true,
        budgetUsd: r.budget_usd === null ? null : Number(r.budget_usd),
        spentUsd: Number(r.spent_usd ?? 0) || 0,
        status: r.status ?? 'idle',
      })),
      lanes: laneRows.map((r) => ({
        loopId: r.loop_id,
        displayName: r.display_name ?? r.loop_id,
        potSlug: r.pot_slug,
        enabled: r.enabled === true,
        budgetUsd: r.budget_usd === null ? null : Number(r.budget_usd),
        // 'lifetime' on anything unrecognized, matching the storage default that writes these
        // rows (learning-governor/store.ts:114). Defaulting the OTHER way would render a real
        // accumulating overrun as a harmless per-run rate — the failure this field exists to fix.
        budgetKind: r.budget_kind === 'per-cycle' ? 'per-cycle' : 'lifetime',
        spentUsd: Number(r.spent_usd ?? 0) || 0,
        enforcement: r.enforcement ?? 'governor',
      })),
      scoutCeiling: null,
      potScope: null,
    };
  } catch {
    /* degrade: arming section renders empty, schedule section still loads */
  }
  // learning-pot-scope-gate D-001 — read in its OWN try, like the ceiling below:
  // a pot-scope read failure must not blank the gym/lane arms it sits above.
  try {
    const { listPotLearningScope } = await import('../learning/pot-gate/store');
    const rows = await listPotLearningScope(sql, { workspaceId: ws });
    arming.potScope = {
      disabledPots: rows.filter((r) => !r.enabled).map((r) => r.potSlug),
      rows: rows.map((r) => ({
        potSlug: r.potSlug,
        enabled: r.enabled,
        setBy: r.setBy,
        setAt: new Date(r.setAt).toISOString(),
      })),
    };
  } catch {
    /* degrade: potScope stays null — "unknown", never "every pot is learning" */
  }
  try {
    const [override, effectiveUsd] = await Promise.all([
      readScoutBudgetOverrides(),
      resolveScoutWorkspaceCeilingUsdLive(),
    ]);
    arming.scoutCeiling = {
      overrideUsd: override.workspaceCeilingUsd ?? null,
      effectiveUsd,
      envUsd: resolveScoutWorkspaceCeilingUsd(),
    };
  } catch {
    /* degrade: ceiling row absent, pot/lane arms still render */
  }

  return {
    routines: allRoutines,
    categories,
    spend7d,
    spend7dTotalUsd: spend7d.reduce((a, b) => a + b.costUsd, 0),
    arming,
    generatedAt: new Date().toISOString(),
  };
}
