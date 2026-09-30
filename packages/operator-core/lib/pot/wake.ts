/**
 * The Pot's self-declared wake — autoloop-hive-operator-rebuild-2026-06-05 P0
 * (D-002/D-003).
 *
 * The pot's "loop" is the operator deciding its OWN next wake before ending a
 * turn — a time, an event-subscription, or nothing. No timer drives it:
 *
 *   - **Time wake** — a ONE-SHOT `pot-wake` routine row (`harness_shared.routines`,
 *     cron-kind with NO cron expr + an explicit `next_fire_at`). The shipped
 *     durable `routinesTick` claims it once (deactivating it — see
 *     `claimDueRoutine`) and fires `system:blueprint-run { blueprintId: 'coding' }`,
 *     which launches the pot blueprint's decider (the operator role) via the
 *     launch-blueprint primitive. Durable: a host restart never loses the wake.
 *
 *   - **Event wake** — persisted subscriptions (`operator-state key pot_wake`, one
 *     row per workspace) projected into LIVE event-reaction rules
 *     (`registerReactionRule`) that fire the `pot:wake` tool when the subscribed
 *     tool-event matches. Re-registered at boot (`registerPotWakeRules`) since
 *     the rule registry is in-memory.
 *
 *   - **Nothing** — both cleared; the pot sleeps until the user (or a manual
 *     `pot:wake`) wakes it.
 *
 * A **wake floor** (D-002's clamp) stops a confused operator from spinning: a
 * declared time is clamped to ≥ now+floor, and `pot:wake` skips a fire that
 * lands within the floor of the previous one (the event-burst debounce).
 */
import type { Sql } from 'postgres';
import type { DataCondition } from '@papercusp/rules';
import { clampToFloor, withinFloor } from '@papercusp/debounce-coalesce';
import { pinModuleState } from '@papercusp/module-singleton';
import { getOrgPg, upsertRoutine, setRoutineActive, deleteRoutine } from '@papercusp/db-org';
import { computeNextFireAt } from '../harness/routines/cron';
import { readOperatorState, updateOperatorState } from '../operator-state-pg';
import { activeWorkspaceId, backgroundWorkspaceIds } from '../workspace-registry';
import { canonicalHarnessSlug } from '../harness/operator-home-harness';
import { registerReactionRule, unregisterReactionRule, listReactionRules } from '../events/registry';
import {
  isWorkspaceCoordinationOn,
  workspaceBrainScopeKey,
  workspaceBrainReadKeys,
} from '../workspace-brain-scope';
import { setCarryNote, getCarryNote, getCarryJournal, hiveScope } from '../carry-note';
import { UNVERIFIED_NOTE_STAMP } from './owner-claim-guard';
import { trackDetached } from '../detached-imports';
import { mugKettleSystemEnabled } from './started';
// The Mug carry-journal converged onto the ONE shared carry-note substrate
// (su-cold-auto-mode-2026-07-03 P-001 / D-004). The journal ring primitives moved
// there; re-exported here for back-compat importers (pot/carry-journal.test.ts).
export {
  appendCarryJournal,
  CARRY_JOURNAL_MAX_ENTRIES,
  CARRY_JOURNAL_NOTE_MAX_CHARS,
  CARRY_JOURNAL_TOTAL_MAX_CHARS,
  type CarryJournalEntry,
} from '../carry-note';

/** The pot launch blueprint id (blueprints/coding/blueprint.yaml — renamed from `hive`). */
export const POT_BLUEPRINT_ID = 'coding';
/** The one-shot wake routine's name (per-harness unique with install_slug). */
export const POT_WAKE_ROUTINE_NAME = 'pot-wake';

/** One persisted event-wake subscription. Serializable (PG JSONB) — so `when`
 *  is the declarative DataCondition form only, never a JS predicate. */
export interface PotEventSubscription {
  /** Trigger tool name(s) — the event-reaction `on` key (e.g. 'coord:escalate'). */
  on: string | string[];
  /** Optional declarative condition over the tool event ({args,result,ctx}). */
  when?: DataCondition;
  /** Why the pot subscribed — surfaced in pot:status + the wake kickoff. */
  note?: string;
}

/** The per-workspace pot_wake state row payload. */
export interface PotWakeState {
  subscriptions: PotEventSubscription[];
  /** ms epoch of the last pot launch fire — the pot:wake floor-debounce input. */
  lastWakeAt?: number;
  /** ms epoch of the last declare-wake call (observability). */
  declaredAt?: number;
  /**
   * LEGACY single carry-note slot (P-015 / B-04) — superseded by
   * `carryJournal` (queen-memory-hybrid-2026-07-02 L1a) but kept as a
   * back-compat MIRROR of the newest journal entry so older readers keep
   * working. Do not write it directly; `setPotCarryNote` maintains it.
   */
  carryNote?: string;
  /**
   * The Mug's carry-JOURNAL (queen-memory-hybrid-2026-07-02 L1a): an
   * APPEND-mode, size-bounded ring of her recent wake notes (newest last in
   * storage; rendered newest-first). Replaces the single REPLACE slot so she
   * sees her own recent reasoning TRAJECTORY each wake, not just the last
   * thought — the REPLACE semantics were why she re-derived the same
   * conclusions wake after wake. Subjective in-flight intention, NOT
   * world-state (durable conclusions belong in facts:assert).
   */
  carryJournal?: Array<{ at: number; note: string }>;
}

const EMPTY_STATE: PotWakeState = { subscriptions: [] };

// The carry-journal ring bounds (CARRY_JOURNAL_*) + appendCarryJournal moved to
// the shared carry-note substrate (su-cold-auto-mode P-001) and are re-exported
// from the import block above.

/** The self-wake floor in seconds (D-002's clamp). Env-tunable, hard min 5s. */
export function potWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_POT_WAKE_FLOOR_SEC ?? process.env.PAPERCUSP_POT_WAKE_FLOOR_SEC ?? 60);
  return Number.isFinite(n) && n >= 5 ? n : 60;
}

/**
 * The effective wake floor in seconds: MAX(system floor, owner override). The owner
 * cadence-floor knob (mug-steering-panel P-006) can only RAISE the interval (slow
 * the loop) — never drop below the system minimum. `ownerFloorSec` undefined/≤0 ⇒
 * the system floor unchanged (today's behaviour). Pure; the async resolver below
 * reads the owner value and calls this.
 */
function effectiveWakeFloorSec(ownerFloorSec?: number): number {
  return Math.max(potWakeFloorSec(), ownerFloorSec && ownerFloorSec > 0 ? ownerFloorSec : 0);
}

/** Clamp a requested wake time to ≥ now + the floor. Delegates the floor math to the
 *  shared `@papercusp/debounce-coalesce` core (the pot is no longer a special case —
 *  unify-watch-primitive-2026-06-06 P-006/D-009). `ownerFloorSec` (mug-steering-panel
 *  P-006) RAISES the floor when the owner set a wake-cadence floor — MAX(system, owner). */
export function clampWakeAt(
  requested: Date,
  now: Date = new Date(),
  ownerFloorSec?: number,
): { at: Date; clamped: boolean } {
  const { at, clamped } = clampToFloor({
    requestedAt: requested.getTime(),
    minSleepMs: effectiveWakeFloorSec(ownerFloorSec) * 1_000,
    now: now.getTime(),
  });
  return { at: new Date(at), clamped };
}

/**
 * Resolve the EFFECTIVE wake floor for a Pot — MAX(system floor, the owner's
 * `cadence-floor-sec` steering knob), fail-soft to the system floor (P-006, D-005).
 * The single async read the cadence-aware seams (declarePotTimeWake, urgent-wake,
 * the pot:wake debounce) call once, then thread the number into the pure
 * clampWakeAt / withinWakeFloor below.
 */
export async function effectivePotWakeFloorSec(workspaceId: string, installSlug: string): Promise<number> {
  try {
    const { getOwnerSteering, effectiveCadenceFloorSec } = await import('../owner-steering');
    const s = await getOwnerSteering(workspaceId, installSlug);
    return effectiveCadenceFloorSec(s, potWakeFloorSec());
  } catch {
    return potWakeFloorSec();
  }
}

/**
 * Declare (or replace) the pot's one-shot TIME wake: upsert the `pot-wake`
 * routine with an explicit clamped `next_fire_at` and no cron (one-shot —
 * `claimDueRoutine` deactivates it on fire). Returns the effective time.
 */
export async function declarePotTimeWake(
  sql: Sql,
  opts: {
    workspaceId: string;
    installSlug: string;
    at: Date;
    kickoff?: string;
    now?: Date;
    blueprintId?: string;
    /** Pre-resolved effective wake floor (seconds) — pass it when the caller
     *  already read owner-steering (urgent-wake) to avoid a second read; omitted ⇒
     *  resolved here via effectivePotWakeFloorSec (mug-steering-panel P-006). */
    floorSec?: number;
  },
): Promise<{ at: Date; clamped: boolean }> {
  // Owner cadence-floor (P-006): the Mug's self-declared wake is clamped up to the
  // owner's floor. Resolve it here (so every declare-wake path — incl. the pot:declare-wake
  // tool — is owner-aware with no call-site change) unless the caller pre-resolved it.
  const floorSec = opts.floorSec ?? (await effectivePotWakeFloorSec(opts.workspaceId, opts.installSlug));
  const { at, clamped } = clampWakeAt(opts.at, opts.now, floorSec);
  // K1 workspace-brain re-key (workspace-scoped-coordination P-003 / D-006): when
  // WORKSPACE_COORDINATION is ON, the one workspace Mug owns ONE pot-wake
  // routine, keyed under the workspace PAPERCUP (install_slug = workspaceId)
  // instead of per-pot — collapsing N per-pot wake routines (the carry-note /
  // subscription clobber the plan names) to one. OFF (the dark default) ⇒ the
  // legacy per-pot install slug, byte-identical to today. (Event-state — the
  // pot_wake operator-state row — is already workspace-keyed; untouched.)
  const scopeSlug = workspaceBrainScopeKey(
    opts.workspaceId,
    opts.installSlug,
    await isWorkspaceCoordinationOn(),
  );
  // EI-1477 (sibling of EI-1472): the pot wake is a SINGLETON keyed by (install_slug,
  // name) — the global routines_install_slug_name_key enforces ONE row per install
  // regardless of workspace. With per-workspace ON CONFLICT (F-E1) on, upsertRoutine
  // conflicts on (workspace_id, install_slug, name); if the existing singleton lives
  // under a DIFFERENT workspace_id than the caller's ctx, that target misses and the
  // INSERT collides with the global constraint → duplicate-key throw, so the Mug
  // can't re-arm her wake. Pin the upsert to the EXISTING row's workspace (UPDATE in
  // place; harmless under the legacy (install_slug, name) conflict).
  const existing = await sql<Array<{ workspace_id: string }>>`
    SELECT workspace_id FROM harness_shared.routines
     WHERE install_slug = ${scopeSlug} AND name = ${POT_WAKE_ROUTINE_NAME}
     LIMIT 1
  `;
  await upsertRoutine(
    sql,
    {
      workspaceId: existing[0]?.workspace_id ?? opts.workspaceId,
      installSlug: scopeSlug,
      name: POT_WAKE_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {}, // no cron expr ⇒ one-shot
      targetRole: 'system:blueprint-run',
      payloadTemplate: {
        blueprintId: opts.blueprintId ?? POT_BLUEPRINT_ID,
        // Workspace-coordination mode keys the routine under the workspace
        // papercup (`install_slug = workspaceId`) so there is only one Mug
        // wake row. The launch itself still targets the concrete pot/harness.
        // Carry it explicitly; system:blueprint-run uses this for /invoke.
        launchInstallSlug: opts.installSlug,
        kickoff:
          opts.kickoff ??
          `Self-declared wake (declared ${new Date().toISOString()}). You are the operator in charge; survey the fleet and figure out what to do.`,
      },
      concurrency: 'skip',
      catchup: 'skip-old',
      active: true,
      nextFireAt: at,
    },
    computeNextFireAt,
  );
  return { at, clamped };
}

/** Clear the pot's time wake (mode 'none', or a declare with no time).
 *  EI-1477: DELETE the row (not just deactivate) to avoid duplicate-key conflicts
 *  under concurrency when a stale/orphaned row would collide with a new UPSERT.
 *
 *  K1 (workspace-scoped-coordination P-003): when WORKSPACE_COORDINATION is ON and
 *  a `workspaceId` is supplied, the wake routine lives under the workspace papercup
 *  — clear BOTH the papercup row and the legacy per-pot row (hygiene; a stop must
 *  leave nothing armed). OFF, or no workspaceId, ⇒ clear the per-pot row only,
 *  byte-identical to today. */
export async function clearPotTimeWake(
  sql: Sql,
  installSlug: string,
  opts: { workspaceId?: string } = {},
): Promise<void> {
  const on = opts.workspaceId ? await isWorkspaceCoordinationOn() : false;
  const slugs = on
    ? workspaceBrainReadKeys(opts.workspaceId!, installSlug, true)
    : [installSlug];
  for (const slug of slugs) await deleteRoutine(sql, slug, POT_WAKE_ROUTINE_NAME);
}

/** timestamptz arrives as Date or ISO string depending on the pool's type
 *  parsers (EI-257: the boot-path pool returns strings — `.getTime()` on one
 *  threw in every watchdog liveness check and flooded the console). */
function toDateOrNull(v: Date | string | null): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Read the pot's time-wake routine state (null = never declared).
 *
 *  K1 (workspace-scoped-coordination P-003): when WORKSPACE_COORDINATION is ON and
 *  a `workspaceId` is supplied, prefer the workspace-papercup routine row, falling
 *  back to the legacy per-pot row until the papercup is first written (zero
 *  regression). OFF, or no workspaceId, ⇒ the per-pot row only, byte-identical
 *  to today. */
export async function getPotTimeWake(
  sql: Sql,
  installSlug: string,
  opts: { workspaceId?: string } = {},
): Promise<{ active: boolean; nextFireAt: Date | null; lastFiredAt: Date | null } | null> {
  const on = opts.workspaceId ? await isWorkspaceCoordinationOn() : false;
  const slugs = on
    ? workspaceBrainReadKeys(opts.workspaceId!, installSlug, true)
    : [installSlug];
  for (const slug of slugs) {
    const rows = await sql<
      Array<{ active: boolean; next_fire_at: Date | string | null; last_fired_at: Date | string | null }>
    >`
      SELECT active, next_fire_at, last_fired_at
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND name = ${POT_WAKE_ROUTINE_NAME}
    `;
    if (rows.length > 0) {
      return {
        active: rows[0].active,
        nextFireAt: toDateOrNull(rows[0].next_fire_at),
        lastFiredAt: toDateOrNull(rows[0].last_fired_at),
      };
    }
  }
  return null;
}

// ── event-wake subscriptions ─────────────────────────────────────────────────

const RULE_PREFIX = 'pot-wake';
const ruleId = (workspaceId: string, i: number): string => `${RULE_PREFIX}:${workspaceId}#${i}`;
/** Cross-process invalidation carried over the existing sync_invalidate PG bus. */
export const POT_WAKE_RULES_INVALIDATION = 'potWakeRules.byWorkspace';

type PotWakeRuleSyncRuntime = {
  start?: Promise<boolean>;
  handle?: { close: () => void };
  removeListenHook?: () => void;
};
// Pinned through the primitive rather than by hand: a hand-rolled `globalThis`
// slot fixes correctness but is invisible to `listModuleDuplications()`, so the
// central report answers a confident `[]` while this module is split. Pinned at
// MODULE SCOPE exactly once — pinning inside the accessor would count every call
// as an evaluation and manufacture a false duplication in that same report.
const potWakeRuleSyncRuntimeState = pinModuleState<PotWakeRuleSyncRuntime>(
  '__papercuspPotWakeRuleSyncRuntime__',
  () => ({}),
);

function potWakeRuleSyncRuntime(): PotWakeRuleSyncRuntime {
  return potWakeRuleSyncRuntimeState;
}

/** Read the persisted pot wake state for a workspace. */
export async function readPotWakeState(workspaceId?: string): Promise<PotWakeState> {
  return (await readOperatorState<PotWakeState>('pot_wake', workspaceId)) ?? EMPTY_STATE;
}

/**
 * Project a workspace's persisted subscriptions into LIVE reaction rules.
 * Idempotent: removes every `pot-wake:<ws>#*` rule first, then registers the
 * current set. Each rule fires the `pot:wake` tool (the floor-debounce lives
 * there) with args carrying the subscription's provenance plus the actual
 * matched trigger tool (`trigger: e.tool` — EI-18654946296495054).
 */
export function syncPotWakeRules(workspaceId: string, subs: PotEventSubscription[]): number {
  for (const r of listReactionRules()) {
    if (r.id.startsWith(`${RULE_PREFIX}:${workspaceId}#`)) unregisterReactionRule(r.id);
  }
  let n = 0;
  for (const [i, sub] of subs.entries()) {
    registerReactionRule({
      id: ruleId(workspaceId, i),
      on: sub.on,
      when: sub.when,
      fire: 'pot:wake',
      // EI-18654946296495054: `args` as a function sees the MATCHED event, so
      // `e.tool` is the actual trigger that fired (not just "one of the
      // subscription's `on` list") — pot:wake's steering-pause gate needs the
      // real trigger to tell a placement-demand wake from a must-fire one.
      args: (e) => ({
        // EI-18742016294354354: `sub.note` is free text a prior wake wrote for
        // itself — it has no provenance mechanism, so it must never reach the
        // NEXT wake's kickoff as bare fact indistinguishable from the platform-
        // computed `reason`/`trigger` fields around it (a fabricated "the owner
        // already answered X" is exactly what slipped through here). Stamp it
        // explicitly wherever it lands in the kickoff text.
        reason: `subscribed event (${e.tool})${sub.note ? ` — [${UNVERIFIED_NOTE_STAMP}] ${sub.note}` : ''}`,
        source: 'event',
        trigger: e.tool,
      }),
      // Durable would survive a restart, but a wake is cheap to lose and MUST
      // not retry-storm the pot — in-process fire-and-forget is right here.
      mode: 'sync',
      onlyOnSuccess: true,
      source: 'pot-wake',
    });
    n++;
  }
  return n;
}

/**
 * Replace the persisted event subscriptions (+ live rules) for a workspace.
 * REPLACE semantics, like coord:declare-intent: each declare describes the
 * whole wake; omitted ⇒ cleared.
 */
export async function setPotEventSubscriptions(
  workspaceId: string,
  subs: PotEventSubscription[],
): Promise<number> {
  await updateOperatorState<PotWakeState>('pot_wake', EMPTY_STATE, (cur) => ({
    ...cur,
    subscriptions: subs,
    declaredAt: Date.now(),
  }), workspaceId);
  const rules = syncPotWakeRules(workspaceId, subs);
  // The reaction registry is process-local while :3070 serves requests from a
  // reuse-port cluster. Project immediately in the writer, then publish the
  // durable state's workspace key so every sibling process re-reads + projects
  // the same subscriptions. This must not use the bus's default 90s dedupe:
  // two legitimate declarations inside that window can carry different rules.
  const { notifySyncInvalidate } = await import('../sync-sse');
  await notifySyncInvalidate(
    POT_WAKE_RULES_INVALIDATION,
    { workspaceId },
    undefined,
    { dedupeWindowMs: 0 },
  );
  return rules;
}

/** Re-project every workspace this operator process can serve. */
export async function refreshAllPotWakeRules(): Promise<number> {
  let total = 0;
  for (const workspaceId of backgroundWorkspaceIds()) {
    total += await registerPotWakeRules(workspaceId);
  }
  return total;
}

/**
 * Keep the process-local Pot wake registry coherent across clustered request
 * workers and the background primary. Runtime declarations push an invalidation
 * over the existing PG bus; initial LISTEN and reconnect both re-read every
 * persisted workspace so a notification missed during a connection gap heals.
 */
export async function ensurePotWakeRuleSync(): Promise<boolean> {
  const runtime = potWakeRuleSyncRuntime();
  if (runtime.handle) return true;
  if (runtime.start) return runtime.start;

  runtime.start = (async () => {
    const { registerInvalidationListenHook, subscribe } = await import('../sync-sse');
    runtime.removeListenHook = registerInvalidationListenHook(async () => {
      await refreshAllPotWakeRules();
    });
    runtime.handle = await subscribe((event) => {
      if (event.name !== POT_WAKE_RULES_INVALIDATION) return;
      const workspaceId = event.args?.workspaceId;
      if (typeof workspaceId !== 'string' || !workspaceId.trim()) return;
      void registerPotWakeRules(workspaceId);
    });
    // If the shared listener was already up before this subscriber registered,
    // its initial onListen hook has already fired. Explicit catch-up closes that
    // race; the rebuild is idempotent when onListen also ran it.
    await refreshAllPotWakeRules();
    return true;
  })().catch((e) => {
    runtime.removeListenHook?.();
    runtime.removeListenHook = undefined;
    runtime.start = undefined;
    console.warn(`[pot] cross-process wake-rule sync skipped: ${e instanceof Error ? e.message : e}`);
    return false;
  });

  return runtime.start;
}

/**
 * Test-only: tear down the process-global sync subscription + guard.
 *
 * The state is pinned at module scope, so its OBJECT IDENTITY is fixed for the
 * realm — dropping the slot (the old `delete globalThis[key]`) would strand the
 * live reference this module already closed over. Clear every field instead,
 * which is what "a fresh runtime" actually has to mean once the state is pinned.
 */
export function _resetPotWakeRuleSyncForTests(): void {
  const runtime = potWakeRuleSyncRuntimeState;
  runtime.handle?.close();
  runtime.removeListenHook?.();
  runtime.handle = undefined;
  runtime.removeListenHook = undefined;
  runtime.start = undefined;
}

/**
 * Set (or clear) the Mug's self-authored carry-note for her next wake
 * (P-015 / B-04). REPLACE-semantics: a non-empty string replaces the stored note
 * and appends to her carry-JOURNAL ring; `null`/`undefined`/blank clears the note
 * (the journal — her recent-reasoning trajectory — persists; the next wake
 * re-derives the floor). As of su-cold-auto-mode-2026-07-03 P-001 this delegates
 * to the ONE shared carry-note substrate under {@link hiveScope} (the Mug
 * carry-journal, the cup checkpoint and the su loop carry-note are now the same
 * store + shape). Returns the stored note (trimmed) or null.
 */
export async function setPotCarryNote(
  workspaceId: string,
  note: string | null | undefined,
): Promise<string | null> {
  return setCarryNote({ scope: hiveScope(), workspaceId }, note);
}

/**
 * Read the Mug's carry-journal, NEWEST FIRST (L1a) — the brief renderer's
 * input. Reads the shared carry-note substrate under {@link hiveScope}.
 */
export async function getPotCarryJournal(
  workspaceId?: string,
): Promise<Array<{ at: number; note: string }>> {
  return getCarryJournal({ scope: hiveScope(), workspaceId });
}

/**
 * Read the Mug's carry-note stored for the current wake (P-015 / B-04) — the
 * additive second half of her brief. Null when she carried nothing. The brief
 * builder (B-05 / the wake-invocation seam) passes this to
 * `renderMugBrief({ carryNote })`.
 */
export async function getPotCarryNote(workspaceId?: string): Promise<string | null> {
  return getCarryNote({ scope: hiveScope(), workspaceId });
}

/**
 * Boot-time re-registration: the rule registry is in-memory, so persisted
 * subscriptions must be projected again on every host start. Fail-soft (a
 * missing table pre-migration must never block boot).
 */
export async function registerPotWakeRules(workspaceId?: string): Promise<number> {
  const ws = workspaceId ?? activeWorkspaceId();
  try {
    // P-068/D-098 retired every Pot actuator, including `pot:wake`. Persisted
    // subscriptions can outlive that retirement, so never re-project them into
    // live reaction rules. Clearing the process-local projection here also heals
    // a worker that loaded the old rules before a restart or invalidation.
    if (!(await mugKettleSystemEnabled())) {
      syncPotWakeRules(ws, []);
      return 0;
    }
    const state = await readPotWakeState(ws);
    return syncPotWakeRules(ws, state.subscriptions);
  } catch (e) {
    console.warn(`[pot] wake-rule registration skipped: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

// ── the fire-side floor debounce ─────────────────────────────────────────────

/** Whether a pot fire at `now` falls inside the floor window of the last one. Delegates
 *  to the shared `@papercusp/debounce-coalesce` floor (P-006/D-009): the pot consumes the
 *  SAME core every other wake-subscription now uses, rather than a bespoke comparison. */
export function withinWakeFloor(state: PotWakeState, now: number = Date.now(), ownerFloorSec?: number): boolean {
  return withinFloor({
    lastWokenAt: state.lastWakeAt ?? null,
    minSleepMs: effectiveWakeFloorSec(ownerFloorSec) * 1_000,
    now,
  });
}

export interface PotWakeAdmission {
  fired: boolean;
  skipped?: 'wake-floor';
  floorSec: number;
  nextAllowedAt?: string;
}

export function decidePotWakeAdmission(
  state: PotWakeState,
  opts: { now: number; floorSec: number; force?: boolean },
): PotWakeAdmission {
  if (!opts.force && withinWakeFloor(state, opts.now, opts.floorSec)) {
    return {
      fired: false,
      skipped: 'wake-floor',
      floorSec: opts.floorSec,
      nextAllowedAt: new Date((state.lastWakeAt ?? 0) + opts.floorSec * 1_000).toISOString(),
    };
  }
  return { fired: true, floorSec: opts.floorSec };
}

/** Atomically claim the right to launch a Mug wake by recording `lastWakeAt`
 * before the expensive launch. The old fire path recorded after launch, leaving
 * a check-then-act window where event/manual/watchdog wakes could all see the
 * same stale state and launch overlapping Mugs. */
export async function claimPotWakeFire(
  workspaceId: string,
  opts: { floorSec: number; force?: boolean; now?: number },
): Promise<PotWakeAdmission> {
  const now = opts.now ?? Date.now();
  let admission: PotWakeAdmission = { fired: false, floorSec: opts.floorSec };
  await updateOperatorState<PotWakeState>(
    'pot_wake',
    EMPTY_STATE,
    (cur) => {
      admission = decidePotWakeAdmission(cur, { now, floorSec: opts.floorSec, force: opts.force });
      return admission.fired ? { ...cur, lastWakeAt: now } : cur;
    },
    workspaceId,
  );
  return admission;
}

/** Record a pot launch fire (the debounce input for the next one). */
export async function recordPotWake(workspaceId?: string): Promise<void> {
  await updateOperatorState<PotWakeState>(
    'pot_wake',
    EMPTY_STATE,
    (cur) => ({ ...cur, lastWakeAt: Date.now() }),
    workspaceId,
  );
  // Per-wake push for the MugHeartbeat sidebar (data-sync-push-completion P-007):
  // pot.controlState surfaces lastWakeAt + the next-fire countdown + the placements
  // the Mug is driving. This is THE single ledger chokepoint every explicit wake
  // path funnels through (pot:wake, urgent-wake, the events/await wake-executor, pot
  // create), so invalidating here replaces the heartbeat's old 12s self-poll. Fire-and-
  // forget + non-throwing (mirrors pot:start/pause); name-only/{} matches the
  // no-arg consumer. (A wake path that bypasses recordPotWake is still caught by the
  // @papercusp/sync 180s drift-repair tick.)
  void trackDetached(import('../sync-sse'))
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate('pot.controlState', {}))
    .catch(() => {});
}

/** Resolve the harness slug the pot runs against: explicit arg → ctx harness →
 *  env default. The pot is workspace-level but the invoke route is
 *  harness-scoped, so a home slug must be named somewhere. */
export function resolvePotHomeSlug(explicit?: string | null, ctxSlug?: string | null): string | null {
  // '*' / 'all' (wildcard / all-harnesses scope) are NOT concrete pot homes — SKIP them at each level so the chain falls
  // through to a real slug (env home) or null, instead of firing the pot launch with installSlug '*', which the
  // invoke route's resolveProject can't find → HTTP 404 "unknown project" (2026-07-01: an operator-scoped
  // `pot:wake` with no explicit harness inherited ctx.harnessSlug='*' and 404'd instead of resolving/erroring).
  const concrete = (s?: string | null): string | undefined => {
    const t = s?.trim();
    return t && t !== '*' && t.toLowerCase() !== 'all' ? t : undefined;
  };
  const slug = concrete(explicit) ?? concrete(ctxSlug) ?? concrete(process.env.PAPERCUSP_POT_HOME_SLUG) ?? null;
  return slug ? canonicalHarnessSlug(slug) : null;
}
