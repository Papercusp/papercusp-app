/**
 * actionable-conditions.ts — the condition-key opt-in CATALOG, as a ZERO-IMPORT leaf.
 *
 * Extracted from condition-bridge.ts (P-013 of gate-verdict-liveness-and-repair-
 * reliability-2026-08-31, D-012) so the work-items-admission layer can read the
 * alarm-prefix set without a cycle: condition-bridge imports work-items.ts
 * (createWorkItem/setWorkItemState), and work-items.ts imports work-items-admission —
 * so the admission module importing condition-bridge would close that loop. Same
 * leaf-extraction precedent as scheduler/claim-states.ts (EI-11300), and the same
 * compatibility posture: condition-bridge.ts RE-EXPORTS everything here, so every
 * existing `from './condition-bridge'` importer keeps working unchanged.
 *
 * Semantics are unchanged from the original block — see condition-bridge.ts's module
 * doc for the bridge's own contract. The catalog is OPT-IN, deliberately: a transient
 * condition that opens and clears within a tick would otherwise mint and immediately
 * close a work-item on every flap. A prefix earns a place here when the condition is
 * (a) durable enough that a human or agent would want to claim it, and (b) actionable.
 */

export interface ActionableCondition {
  /** Key prefix, always ending in ':'. */
  prefix: string;
  /**
   * How to get the HARNESS this condition belongs to.
   *
   * ⚠ This field exists because the obvious shortcut is wrong and fails SILENTLY.
   * Four of the five original producers suffix the key with the harness slug
   * (`green-stall:${row.install_slug}`, `main-behind-staging:${harnessSlug}`,
   * `release-trigger-freeze:${installSlug}`, `release-trigger-fire-stale:${installSlug}`)
   * — but `single-primary:` does NOT: it is `single-primary:${verdict.key}`, and
   * the live key is `single-primary:no-primary`. `no-primary` is a VERDICT.
   *
   * A `key.split(':')[1]` harness derivation therefore files that condition's
   * work-item under harness `no-primary`, and `createWorkItem` does NOT validate
   * the harness — it just builds `scope: harnessScope(input.harness)`. The row is
   * created successfully, scoped to a harness nobody queries, and is invisible to
   * `work_items:list { harness }` forever. Same class as D-010: a plausible
   * derivation that produces an unreachable row and never errors.
   *
   * 'suffix'  = the text after the prefix IS the harness slug.
   * 'ambient' = the key carries no harness; the caller must supply one.
   */
  harnessFrom: 'suffix' | 'ambient';
  severity: 'critical' | 'major' | 'minor' | 'nit';
}

/** Stable condition namespace for bridge residues with a known agent remedy. */
export const GITHUB_BRIDGE_AGENT_ACTIONABLE_CONDITION_PREFIX = 'github-bridge-agent-actionable:';

/**
 * Stable condition namespace for a frozen candidate HELD for agent convergence
 * (WI-2141736 P-003). Declared here, in the zero-import leaf, and imported by the
 * emitter (release/frozen-repair-agent-routing.ts) rather than the other way round: the
 * catalog must not grow imports, and a prefix spelled twice is a key that can drift out
 * of its own opt-in entry — at which point the alarm broadcasts and silently mints
 * nothing, which is indistinguishable from no red at all.
 */
export const FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX = 'frozen-repair-convergence:';

/**
 * The opt-in catalog. See {@link ActionableCondition.harnessFrom} for why the
 * harness derivation is explicit per-entry rather than parsed.
 */
export const ACTIONABLE_CONDITIONS: readonly ActionableCondition[] = [
  { prefix: 'green-stall:', harnessFrom: 'suffix', severity: 'critical' },
  // P-005 (gate-ownership-followup-2026-08-08). A gate that FIRES hourly and reds
  // every time is not a stall — `green-stall:` above cannot see it (its legs are
  // fire-staleness and a 12h no-green backstop), so until this entry existed a plain
  // red gate had NO condition and therefore no ownable work-item. Emitted by
  // `trackGateStall` (harness/routines/release-actions.ts) at the SAME edge that
  // already fires the urgent stall alert, so the condition's open/close cannot drift
  // from the state machine that decides the gate is stuck. Critical: `main` is frozen.
  { prefix: 'gate-red-streak:', harnessFrom: 'suffix', severity: 'critical' },
  // WI-2141736 P-003 (frozen-candidate-freeze-actually-holds-2026-09-02). Distinct from
  // `gate-red-streak:` above, which says "the gate is red, own it". THIS one says the
  // frozen candidate is being HELD with no dispatchable fixer — so agent/human convergence
  // onto a NAMED sha, by a named call, within a stated deadline, is the only remaining
  // repair path before the candidate is retired. Measured 2026-09-02: a six-day provider
  // wall produced 20 retirements and 0 resumes in one day, and nothing ever asked an agent
  // to converge. Opted in because it is durable (bounded by the 4h convergence hold, not a
  // per-tick flap) and actionable (the body carries the exact `release:repair-queue`
  // converge call). Emitted by green-checkpoint's `routeFrozenRepairToAgents` dep on every
  // tick the hold holds; suffix is `pipelineName(integrationRoot)`, the same slug the other
  // gate entries use. Critical: it is the last path off a frozen `main`.
  { prefix: FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX, harnessFrom: 'suffix', severity: 'critical' },
  { prefix: 'main-behind-staging:', harnessFrom: 'suffix', severity: 'major' },
  { prefix: 'release-trigger-freeze:', harnessFrom: 'suffix', severity: 'major' },
  { prefix: 'release-trigger-fire-stale:', harnessFrom: 'suffix', severity: 'major' },
  { prefix: 'single-primary:', harnessFrom: 'ambient', severity: 'critical' },
  // github-bridge divergence has a separate agent-actionable lane for known
  // local remedies (for example restoring a workflow file when the remote
  // OAuth token lacks the `workflow` scope). Keep it distinct from the
  // owner-gated bridge alarm so the same condition gets one ownable item and
  // does not page a human for a fix an agent can apply.
  { prefix: GITHUB_BRIDGE_AGENT_ACTIONABLE_CONDITION_PREFIX, harnessFrom: 'suffix', severity: 'major' },
];

/** The bare prefixes — derived, so the catalog stays the single source of truth. */
export const ACTIONABLE_CONDITION_PREFIXES: readonly string[] = ACTIONABLE_CONDITIONS.map((c) => c.prefix);

/** The catalog entry governing this key, or null when it is not opted in. */
export function actionableConditionFor(conditionKey: string): ActionableCondition | null {
  const key = conditionKey.trim();
  if (!key) return null;
  return ACTIONABLE_CONDITIONS.find((c) => key.startsWith(c.prefix)) ?? null;
}

/** Should this condition key mint an owning work-item? */
export function isActionableConditionKey(conditionKey: string): boolean {
  return actionableConditionFor(conditionKey) !== null;
}
