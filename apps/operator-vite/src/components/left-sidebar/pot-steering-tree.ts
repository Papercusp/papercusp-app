/**
 * pot-steering-tree — the pure model behind the Queen steering NESTED PICKER
 * (steering-nested-hive-plan-tree-2026-06-17, P-001 / D-001).
 *
 * The owner's steering is persisted as two FLAT lists — `eligibleHives` (the
 * placement SCOPE → the survey's `allowedHarnesses`) and `eligiblePlans` (the
 * plan allow-list) — but the data is a TREE: a plan belongs to a hive (its
 * `harness`). Two independent allow-lists let you express a contradiction — an
 * *eligible plan under an excluded hive* — which the survey silently drops
 * (`inAllowedHarness(plan.harness) AND inEligiblePlans(plan.slug)`), a config
 * that lies. This module renders the two lists AS the tree and exposes pure
 * toggle fns that can only ever produce a LEGAL pair, so the illegal state is
 * unrepresentable.
 *
 * KEY IDEA (D-001): there is NO separate tree state. The tree is a pure
 * function of the existing `(eligibleHives, eligiblePlans)` pair plus the
 * hive→plan structure; every click computes the next pair. So the round-trip
 * (tree → lists → tree) is stable by construction, and back-compat with every
 * current reader (the Queen survey, pot:get-steering) is total — the persisted
 * shape is unchanged.
 *
 * Semantics preserved exactly:
 *  - `eligibleHives` empty ⇒ any hive; a plan is only selectable under a CHECKED
 *    hive (so the contradiction can't be typed).
 *  - `eligiblePlans` empty ⇒ NO plan narrowing (all plans in the scoped hives
 *    pass, AND unplanned frontier work in them is kept — so checking a hive does
 *    NOT expand to explicit plan slugs).
 *  - NARROWING (unchecking one plan under a checked hive) flips `eligiblePlans`
 *    to the EXPLICIT union of every checked hive's plans minus the unchecked one,
 *    so a global-AND list stays honest across hives (narrowing hive B never
 *    silently unchecks hive A's plans).
 *  - Unchecking a hive removes it + its plans; unchecking a hive's LAST checked
 *    plan also unchecks the hive (so "checked hive, zero plans" — a dead state —
 *    is never produced, avoiding the empty-eligiblePlans-means-all collision).
 *
 * Pure (no React / fetch / PG) so each edge is unit-tested directly — the
 * sibling of MugTab.derivation.ts.
 */

/** Minimal plan shape the tree needs (mapped from PlanListRow / stale slugs). */
export interface TreePlanInput {
  slug: string;
  title: string;
  status: string | null;
  startStatus: string | null;
  /** The plan's owning harness slug (PlanListRow.harness). '' / unmatched ⇒ unassigned. */
  harness: string;
  /** True when the plan is in the current steerable list (vs a stale eligible slug). */
  inActive: boolean;
}

/** A hive option row (from steerHiveOptions): a hive home OR a member harness. */
export interface HiveOptionInput {
  value: string;
  label: string;
}

/** The persisted steering pair — the single source of truth. */
export interface SteeringSelection {
  eligibleHives: string[];
  eligiblePlans: string[];
}

/** One plan as rendered under a hive node. */
export interface TreePlan {
  slug: string;
  title: string;
  status: string | null;
  startStatus: string | null;
  inActive: boolean;
  /** Is this plan currently eligible (checked) in the (normalized) selection. */
  checked: boolean;
}

/** One hive node — a hive home or member, with its plans nested beneath. */
export interface TreeHive {
  slug: string;
  label: string;
  /** Is this hive in eligibleHives (the placement scope). */
  checked: boolean;
  /** 'none' = hive unchecked; 'all' = checked + every plan eligible; 'some' = checked + a subset. */
  planMode: 'none' | 'all' | 'some';
  plans: TreePlan[];
}

export interface SteeringTree {
  hives: TreeHive[];
  /** Plans whose harness matches no hive option (e.g. created at harness:'all') — surfaced, not checkable. */
  unassigned: TreePlan[];
}

/** Map of hive-slug → the plan slugs whose harness === that hive slug. */
export type HivePlanIndex = ReadonlyMap<string, string[]>;

// ── Structure helpers (pure) ────────────────────────────────────────────────

/**
 * Index the plan slugs under each hive option, by exact `harness === option.value`
 * (a member harness is its own option row, so a member's plans nest under the
 * member node, not the hive root — mirroring how eligibleHives gates `plan.harness`).
 */
export function indexPlansByHive(hiveOptions: readonly HiveOptionInput[], plans: readonly TreePlanInput[]): {
  hivePlans: Map<string, string[]>;
  planToHive: Map<string, string>;
  unassigned: string[];
} {
  const potSlugs = new Set(hiveOptions.map((h) => h.value));
  const hivePlans = new Map<string, string[]>();
  for (const h of hiveOptions) hivePlans.set(h.value, []);
  const planToHive = new Map<string, string>();
  const unassigned: string[] = [];
  for (const p of plans) {
    if (p.harness && potSlugs.has(p.harness)) {
      hivePlans.get(p.harness)!.push(p.slug);
      planToHive.set(p.slug, p.harness);
    } else {
      unassigned.push(p.slug);
    }
  }
  return { hivePlans, planToHive, unassigned };
}

function isNarrowed(eligiblePlans: readonly string[]): boolean {
  return eligiblePlans.length > 0;
}

/** Union of every checked hive's plan slugs. */
function checkedHivePlanUnion(eligibleHives: readonly string[], hivePlans: HivePlanIndex): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of eligibleHives) {
    for (const p of hivePlans.get(h) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

// ── Validation / normalization (P-004, D-2: the hive gate wins) ─────────────

/**
 * The DEAD `eligiblePlans` entries — eligible plans whose owning hive is KNOWN
 * but excluded from a non-empty `eligibleHives`. These are the silent no-ops the
 * survey drops (a config that lies). Empty `eligibleHives` ⇒ no hive restriction
 * ⇒ nothing is illegal. (pure; the Phase-2 validation surface.)
 */
export function detectIllegalEligiblePlans(
  selection: SteeringSelection,
  planToHive: ReadonlyMap<string, string>,
): string[] {
  if (selection.eligibleHives.length === 0) return [];
  const allowed = new Set(selection.eligibleHives);
  return selection.eligiblePlans.filter((slug) => {
    const hive = planToHive.get(slug);
    return hive != null && !allowed.has(hive); // known hive, excluded ⇒ dead
  });
}

/**
 * Make a selection LEGAL + tree-representable (idempotent):
 *   1. Drop the dead `eligiblePlans` (hive gate wins, D-2) — only when
 *      `eligibleHives` is non-empty.
 *   2. Ensure every surviving plan with a KNOWN hive has that hive in
 *      `eligibleHives` (so the tree renders it under a checked hive). This is
 *      behaviour-preserving: a plan is eligible only where its own harness is,
 *      so adding its hive to the scope can't change which work passes.
 * Returns the cleaned selection plus what changed (for the surfaced banner).
 */
export function normalizeSteering(
  selection: SteeringSelection,
  planToHive: ReadonlyMap<string, string>,
): { selection: SteeringSelection; droppedIllegal: string[]; addedHives: string[] } {
  const droppedIllegal = detectIllegalEligiblePlans(selection, planToHive);
  const dropped = new Set(droppedIllegal);
  const eligiblePlans = selection.eligiblePlans.filter((s) => !dropped.has(s));

  const hives = new Set(selection.eligibleHives);
  const addedHives: string[] = [];
  for (const slug of eligiblePlans) {
    const hive = planToHive.get(slug);
    if (hive != null && !hives.has(hive)) {
      hives.add(hive);
      addedHives.push(hive);
    }
  }
  // Preserve the original hive order, append any added.
  const eligibleHives = [...selection.eligibleHives, ...addedHives];
  return { selection: { eligibleHives, eligiblePlans }, droppedIllegal, addedHives };
}

// ── Tree render (pure) ──────────────────────────────────────────────────────

/**
 * Render the steering pair as the nested hive→plan tree. Normalizes first so the
 * displayed tree is always legal (legacy illegal entries self-heal on the next
 * write). Plans not under any hive option land in `unassigned` (surfaced,
 * non-checkable).
 */
export function buildSteeringTree(
  hiveOptions: readonly HiveOptionInput[],
  plans: readonly TreePlanInput[],
  selection: SteeringSelection,
): SteeringTree {
  const { hivePlans, planToHive, unassigned } = indexPlansByHive(hiveOptions, plans);
  const { selection: norm } = normalizeSteering(selection, planToHive);
  const checkedHives = new Set(norm.eligibleHives);
  const eligiblePlanSet = new Set(norm.eligiblePlans);
  const narrowed = isNarrowed(norm.eligiblePlans);
  const bySlug = new Map(plans.map((p) => [p.slug, p]));

  const toTreePlan = (slug: string, checked: boolean): TreePlan => {
    const p = bySlug.get(slug);
    return {
      slug,
      title: p?.title ?? slug,
      status: p?.status ?? null,
      startStatus: p?.startStatus ?? null,
      inActive: p?.inActive ?? false,
      checked,
    };
  };

  const hives: TreeHive[] = hiveOptions.map((opt) => {
    const hiveChecked = checkedHives.has(opt.value);
    const planSlugs = hivePlans.get(opt.value) ?? [];
    const plansOut = planSlugs.map((slug) => {
      // A plan is eligible iff its hive is checked AND (no narrowing ⇒ all, else in the set).
      const checked = hiveChecked && (!narrowed || eligiblePlanSet.has(slug));
      return toTreePlan(slug, checked);
    });
    const checkedCount = plansOut.filter((p) => p.checked).length;
    const planMode: TreeHive['planMode'] = !hiveChecked
      ? 'none'
      : !narrowed || checkedCount === planSlugs.length
        ? 'all'
        : 'some';
    return { slug: opt.value, label: opt.label, checked: hiveChecked, planMode, plans: plansOut };
  });

  return {
    hives,
    unassigned: unassigned.map((slug) => toTreePlan(slug, false)),
  };
}

// ── Toggles (pure; every output is normalized → always legal) ───────────────

function finalize(
  eligibleHives: Set<string>,
  eligiblePlans: Set<string>,
  planToHive: ReadonlyMap<string, string>,
): SteeringSelection {
  return normalizeSteering(
    { eligibleHives: [...eligibleHives], eligiblePlans: [...eligiblePlans] },
    planToHive,
  ).selection;
}

/**
 * Toggle a whole hive. ON ⇒ add to scope (and, if already narrowing, cascade all
 * its plans in explicitly so it reads as "all"); OFF ⇒ remove it + its plans.
 */
export function toggleHive(
  selection: SteeringSelection,
  potSlug: string,
  hivePlans: HivePlanIndex,
  planToHive: ReadonlyMap<string, string>,
): SteeringSelection {
  const eh = new Set(selection.eligibleHives);
  const ep = new Set(selection.eligiblePlans);
  const planSlugs = hivePlans.get(potSlug) ?? [];
  if (eh.has(potSlug)) {
    eh.delete(potSlug);
    for (const p of planSlugs) ep.delete(p);
  } else {
    eh.add(potSlug);
    if (isNarrowed([...ep])) for (const p of planSlugs) ep.add(p);
  }
  return finalize(eh, ep, planToHive);
}

/**
 * Toggle a single plan under a checked hive. Narrowing from the "all" state
 * EXPANDS to the explicit union first (minus this plan). Unchecking a hive's last
 * plan also unchecks the hive. A no-op when the plan's hive isn't checked (the UI
 * disables those checkboxes anyway — the invariant guard).
 */
export function togglePlan(
  selection: SteeringSelection,
  potSlug: string,
  planSlug: string,
  hivePlans: HivePlanIndex,
  planToHive: ReadonlyMap<string, string>,
): SteeringSelection {
  const eh = new Set(selection.eligibleHives);
  if (!eh.has(potSlug)) return selection; // guard: plan only togglable under a checked hive
  let ep = new Set(selection.eligiblePlans);
  if (!isNarrowed([...ep])) {
    // currently "all" — the only meaningful click is an UNCHECK → narrow.
    ep = new Set(checkedHivePlanUnion([...eh], hivePlans));
    ep.delete(planSlug);
  } else if (ep.has(planSlug)) {
    ep.delete(planSlug);
  } else {
    ep.add(planSlug);
  }
  // If the hive now has no eligible plans, it falls out of scope.
  const planSlugs = hivePlans.get(potSlug) ?? [];
  if (!planSlugs.some((p) => ep.has(p))) eh.delete(potSlug);
  return finalize(eh, ep, planToHive);
}

/** Set every plan of one checked hive on/off (the per-hive all/none). */
export function setHivePlans(
  selection: SteeringSelection,
  potSlug: string,
  on: boolean,
  hivePlans: HivePlanIndex,
  planToHive: ReadonlyMap<string, string>,
): SteeringSelection {
  const eh = new Set(selection.eligibleHives);
  const planSlugs = hivePlans.get(potSlug) ?? [];
  if (on) {
    // "all of this hive" — add the hive; leave narrowing as-is (if narrowed, add its plans).
    eh.add(potSlug);
    let ep = new Set(selection.eligiblePlans);
    if (isNarrowed([...ep])) for (const p of planSlugs) ep.add(p);
    return finalize(eh, ep, planToHive);
  }
  // "none of this hive" — drop the hive + its plans.
  const ep = new Set(selection.eligiblePlans);
  for (const p of planSlugs) ep.delete(p);
  eh.delete(potSlug);
  return finalize(eh, ep, planToHive);
}

/**
 * Read the steering pair back OUT of a rendered tree — the documented inverse of
 * buildSteeringTree, so the round-trip (selection → tree → selection) is stable
 * (Verification: "a round-trip is stable"). Narrowing exists iff any checked hive
 * is `some`; otherwise `eligiblePlans` collapses to empty ("all plans").
 */
export function selectionFromTree(tree: SteeringTree): SteeringSelection {
  const eligibleHives = tree.hives.filter((h) => h.checked).map((h) => h.slug);
  const narrowed = tree.hives.some((h) => h.checked && h.planMode === 'some');
  if (!narrowed) return { eligibleHives, eligiblePlans: [] };
  const eligiblePlans: string[] = [];
  for (const h of tree.hives) {
    if (!h.checked) continue;
    for (const p of h.plans) if (p.checked) eligiblePlans.push(p.slug);
  }
  return { eligibleHives, eligiblePlans };
}

/** Select-all / clear-all across every hive (no plan narrowing). */
export function setAllHives(
  selection: SteeringSelection,
  on: boolean,
  hiveOptions: readonly HiveOptionInput[],
  planToHive: ReadonlyMap<string, string>,
): SteeringSelection {
  if (!on) return { eligibleHives: [], eligiblePlans: [] };
  // Every hive in scope, no plan narrowing (drop any narrowing → "all plans").
  return finalize(new Set(hiveOptions.map((h) => h.value)), new Set<string>(), planToHive);
}
