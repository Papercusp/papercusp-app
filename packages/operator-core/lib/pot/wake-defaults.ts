/**
 * wake-defaults.ts — the Mug's DEFAULT event-wake subscriptions
 * (start-hive-wake-orchestration-2026-06-09 P-002 / D-001).
 *
 * The event-wake substrate (./wake) is policy-free: it projects whatever
 * subscriptions are declared. THIS is the declared default policy — the three
 * demand producers (start-pot P-001 added their `emits:`/result gates):
 *
 *   - `plans:start`        — a plan actually transitioned to started
 *   - `work_items:create`  — new demand entered a queue
 *   - `coord:escalate`     — an escalation was raised
 *
 * Armed at pot:create (REPLACE — nothing to preserve) and re-affirmed on
 * pot:start (ENSURE — union; the Mug's own runtime tuning via
 * pot:declare-wake is hers to keep, per D-001's "re-tunable at runtime").
 * Start-minimal per OQ-5: exactly these three; the Mug adds more herself.
 */
import {
  readPotWakeState,
  setPotEventSubscriptions,
  type PotEventSubscription,
} from './wake';
import { mugKettleSystemEnabled } from './started';

/**
 * Map a blueprint's declared `wake.subscriptions` ({ on, note }) into runtime
 * PotEventSubscriptions (pot-blueprint-generalization P-013). Returns `undefined`
 * when the blueprint declares none, so the caller falls back to the built-in
 * `defaultPotEventSubscriptions()` — a pot that declares no `wake` (today's coding
 * pot AND generic-pot) is therefore byte-identical to before. A future pot can
 * declare its own demand wakes in its blueprint instead of the universal three.
 * (The blueprint schema's subscription is coarser than the built-in — no `when`
 * filter — so a declared sub wakes on every emit of `on`; the built-ins keep their
 * result-gates.)
 */
export function blueprintWakeSubscriptions(
  wake: { subscriptions?: Array<{ on: string; note?: string }> } | undefined,
): PotEventSubscription[] | undefined {
  const subs = wake?.subscriptions ?? [];
  if (subs.length === 0) return undefined;
  return subs.map((s) => ({ on: s.on, ...(s.note ? { note: s.note } : {}) }));
}

/** Options for {@link defaultPotEventSubscriptions} — currently just the EI-13608
 *  plan-scoped create-wake suppression list. */
export interface DefaultPotEventSubscriptionsOpts {
  /** Plan slugs (owner-steering `createWakeSuppressPlans`) whose UNASSIGNED
   *  work_items:create should NOT fire the demand wake (EI-13608). Empty/omitted
   *  ⇒ no suppression (byte-identical to before this option existed). */
  suppressCreateWakePlans?: string[];
}

/** The three default demand subscriptions (fresh array each call — callers may mutate). */
export function defaultPotEventSubscriptions(
  opts: DefaultPotEventSubscriptionsOpts = {},
): PotEventSubscription[] {
  const suppressPlans = opts.suppressCreateWakePlans?.filter((s) => s.trim().length > 0) ?? [];
  return [
    {
      on: 'plans:start',
      // Only a REAL op_status flip (not the idempotent re-start) is demand.
      when: { 'result.data.transitioned': true },
      note: 'default demand wake: a plan was started (start-pot-wake P-002)',
    },
    {
      on: 'work_items:create',
      // Only UNPLACED demand needs the Mug. Gate on a successful create whose item
      // is UNASSIGNED — a pre-placed / self-assigned create (work_items:create {assign_to};
      // e.g. a warm /loop self-assigning its own work each wake) is already owned, so it
      // must NOT wake her every cycle (EI-1850). `exists:false` is the engine's not-null
      // operator → `$eq null`, matching assignee null/unset = unassigned. The handler still
      // reports in-band failures as { ok:false } inside a successful tool result, so the ok
      // gate stays (onlyOnSuccess alone is not enough).
      //
      // EI-13608: when the owner has named cup-forbidden plans via owner-steering
      // `createWakeSuppressPlans`, also require the create's `plan_item.slug` (present
      // on the synthetic per-item event's `args` — perItemArgs in events/engine.ts
      // carries the caller's own create args, including a top-level or per-item
      // `plan_item`) to be OUTSIDE that list. `notIn` on a MISSING field (no
      // plan_item passed) evaluates true (mingo/$nin semantics — "does not contain
      // a value in the array"), so an ordinary create with no plan linkage is
      // UNAFFECTED; only a create explicitly linked to a named forbidden plan is
      // suppressed. Empty suppression list ⇒ this clause is omitted entirely
      // (byte-identical to pre-EI-13608 behaviour).
      when: {
        'result.data.ok': true,
        'result.data.workItem.assignee': { exists: false },
        ...(suppressPlans.length > 0 ? { 'args.plan_item.slug': { notIn: suppressPlans } } : {}),
      },
      note: 'default demand wake: an UNPLACED (unassigned) work item was created (start-pot-wake P-002; a pre-assigned create skips — EI-1850; a named cup-forbidden plan skips — EI-13608)',
    },
    {
      on: 'coord:escalate',
      when: { 'result.data.ok': true },
      note: 'default demand wake: an escalation was raised (start-pot-wake P-002)',
    },
  ];
}

/**
 * Fail-soft read of the owner-steering `createWakeSuppressPlans` list (EI-13608).
 * Dynamic import (owner-steering.ts is a leaf module with no edge back to this
 * file) — never throws; an unreadable/missing steering store resolves to `[]`
 * (no suppression), the same fail-soft posture every other owner-steering reader
 * in this codebase uses.
 */
export async function readCreateWakeSuppressPlans(workspaceId: string, installSlug: string): Promise<string[]> {
  try {
    const { getOwnerSteering } = await import('../owner-steering');
    const s = await getOwnerSteering(workspaceId, installSlug);
    return s.createWakeSuppressPlans;
  } catch {
    return [];
  }
}

const onKeys = (on: string | string[]): string[] => (Array.isArray(on) ? on : [on]);

/**
 * Union the default demand subscriptions onto a `base` set (e.g. the Mug's
 * just-declared events), keeping every base subscription verbatim and adding
 * only the defaults whose trigger tool is NOT already covered by the base. Pure.
 *
 * The always-armed demand-wake invariant (EI-10525): a Mug re-declaration —
 * including a TIME-ONLY (or `mode:'none'`) one that carries no events — must
 * never drop the default demand subscriptions. `pot:declare-wake` has REPLACE
 * semantics, so a bare `{ inSeconds }` / `{ mode:'none' }` used to persist `[]`
 * and silently wipe the three defaults, leaving demand wakes (a new unplaced
 * work item / escalation) DEAD while a time wake still "looked armed" to the
 * watchdog. Routing the declared set through this before persisting preserves
 * the invariant: her declared events REPLACE her OWN custom set (re-tunable),
 * but the defaults always survive.
 *
 * `defaults` is the set to ensure (the blueprint-declared wakes when non-empty,
 * else the built-in three) — same resolution as {@link armDefaultPotWakeSubscriptions}.
 */
export function withDefaultPotWakeSubscriptions(
  base: PotEventSubscription[],
  defaults?: PotEventSubscription[],
): PotEventSubscription[] {
  const ensure = defaults && defaults.length > 0 ? defaults : defaultPotEventSubscriptions();
  const covered = new Set(base.flatMap((s) => onKeys(s.on)));
  const missing = ensure.filter((d) => onKeys(d.on).some((k) => !covered.has(k)));
  return [...base, ...missing];
}

/**
 * Arm the default subscriptions for a workspace.
 *
 * - `'replace'` — the set becomes exactly the defaults (pot:create: the state
 *   is empty; nothing to preserve).
 * - `'ensure'` — union: every existing subscription is kept verbatim (the
 *   Mug's declared policy), and only defaults whose trigger tool is not
 *   already covered are added. pot:start uses this so Pause→Start never
 *   clobbers her tuning. Always re-persists + re-projects the live rules, so
 *   Start also repairs a registry that lost its in-memory rules.
 */
export async function armDefaultPotWakeSubscriptions(
  workspaceId: string,
  opts: {
    mode: 'replace' | 'ensure';
    subscriptions?: PotEventSubscription[];
    /** Home pot/harness slug — resolves owner-steering `createWakeSuppressPlans`
     *  (EI-13608) into the built-in work_items:create default. Omitted ⇒ no
     *  suppression lookup (byte-identical to before this option existed). Ignored
     *  when `subscriptions` (a blueprint's own declared wake) is supplied — a
     *  blueprint-declared wake is the caller's own policy, not the built-in three. */
    installSlug?: string;
  },
): Promise<{ rules: number; added: number }> {
  // The Mug/Kettle/Cup actuator tier is permanently retired (P-068/D-098).
  // Pot creation still owns this legacy best-effort seam, so make the retirement
  // explicit here: a Pot remains a valid container, but creating one must not
  // persist event rules whose only target (`pot:wake`) now refuses forever.
  // Keep the pure/default helpers above available for historical enabled-tier
  // fixtures and for callers that need to inspect the legacy policy.
  if (!(await mugKettleSystemEnabled())) return { rules: 0, added: 0 };

  // P-013: the blueprint's declared wake.subscriptions WIN over the built-in
  // universal three; a pot that declares none (the coding pot + generic-pot
  // today) falls back to the defaults, so behavior is unchanged.
  const usingBuiltins = !opts.subscriptions || opts.subscriptions.length === 0;
  const suppressCreateWakePlans =
    usingBuiltins && opts.installSlug ? await readCreateWakeSuppressPlans(workspaceId, opts.installSlug) : [];
  const defaults =
    opts.subscriptions && opts.subscriptions.length > 0
      ? opts.subscriptions
      : defaultPotEventSubscriptions({ suppressCreateWakePlans });
  if (opts.mode === 'replace') {
    const rules = await setPotEventSubscriptions(workspaceId, defaults);
    return { rules, added: defaults.length };
  }
  const current = (await readPotWakeState(workspaceId)).subscriptions;
  const merged = withDefaultPotWakeSubscriptions(current, defaults);
  const rules = await setPotEventSubscriptions(workspaceId, merged);
  return { rules, added: merged.length - current.length };
}
