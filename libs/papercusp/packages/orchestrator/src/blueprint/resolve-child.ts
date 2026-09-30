/**
 * resolveChildBlueprint — the spawn-time binding of `recursion.childBlueprint`
 * (autoloop-pot-operator-rebuild-2026-06-05 D-008 / P-008).
 *
 * A recursion-enabled blueprint declares WHICH blueprint its spawned child runs
 * in one of three forms:
 *
 *   - omitted            → SELF (the documented default — monorepo sub-projects,
 *                          research overflow recurse into their own shape);
 *   - a literal id       → that blueprint (a fixed child shape);
 *   - a `$param` token   → a PARAMETERIZED child, bound by the spawner at spawn
 *                          time. The gym declares `childBlueprint: $target` and
 *                          the gym runtime binds `{ target: <blueprint-under-
 *                          optimization> }` — the former undeclared runtime
 *                          override of "self", now declared in the blueprint and
 *                          resolved through ONE canonical helper.
 *
 * Pure; fail-closed: an unbound or malformed `$param` throws a descriptive
 * error rather than silently falling back to self (a gym run against the wrong
 * target is exactly the bug this lift exists to prevent).
 */

/** The well-formed `$param` placeholder shape: `$` + identifier. */
export const CHILD_BLUEPRINT_PARAM_RE = /^\$[A-Za-z][A-Za-z0-9_-]*$/;

/** True when a declared childBlueprint is a `$param` placeholder (vs a literal id). */
export function isChildBlueprintParam(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('$');
}

/**
 * Resolve the blueprint id a spawned child runs. See the module doc for the
 * three declaration forms. `params` carries the spawner's bindings (the gym
 * passes `{ target: <id> }`); it is only consulted for the `$param` form.
 */
export function resolveChildBlueprint(
  bp: { id: string; recursion?: { childBlueprint?: string } },
  params: Record<string, string> = {},
): string {
  const declared = bp.recursion?.childBlueprint;
  // Omitted ⇒ self (the schema's documented default).
  if (declared === undefined || declared === '') return bp.id;
  // Literal ⇒ that blueprint.
  if (!declared.startsWith('$')) return declared;
  // `$param` ⇒ the spawner's binding. Fail closed on malformed/unbound.
  if (!CHILD_BLUEPRINT_PARAM_RE.test(declared)) {
    throw new Error(
      `blueprint "${bp.id}": recursion.childBlueprint ${JSON.stringify(declared)} is not a valid ` +
        `placeholder — expected \`$\` + identifier (e.g. \`$target\`)`,
    );
  }
  const name = declared.slice(1);
  const bound = params[name];
  if (!bound) {
    throw new Error(
      `blueprint "${bp.id}": recursion.childBlueprint declares the parameterized child ` +
        `\`${declared}\` but the spawn bound no "${name}" param — pass it in ` +
        `resolveChildBlueprint(bp, { ${name}: '<blueprint-id>' })`,
    );
  }
  return bound;
}

/**
 * The NO-NEST GUARD (local-hive D-009 / swarm-coordination D-018 enforcement A).
 *
 * A `kind:'hive'` blueprint (the Queen — `pot`) is launchable ONLY as a ROOT, by
 * the deployment/machine bootstrap (for the pot: the parentless
 * `system:blueprint-run` routine). It must NEVER be instantiated with a parent —
 * a sub-hive is a sub-Queen, another expensive slow brain competing for the same
 * rate-limit pool, and a nested hive breaks the flat-peer budget-federation
 * invariant the model depends on (D-017). General harnesses (`kind:'harness'`)
 * recurse freely; only `'hive'` is gated.
 *
 * Enforced in CODE, not convention (D-018: convention can't protect an
 * architectural invariant) at every admission point that has a parent context —
 * `fireLaunchBlueprint` (launch admission) and the `resolveChildBlueprint`
 * recursion path. Fails LOUD: a stray child-hive launch must stop here, not
 * silently corrupt the budget math.
 *
 * `hasParent` is true when a parent/initiator context exists (a spawning agent,
 * a parent spawn id, a recursion parent). A root launch passes `false`.
 */
export function assertNotNestedHive(
  bp: { id: string; kind?: 'pot' | 'hive' | 'harness' },
  hasParent: boolean,
): void {
  if (hasParent && (bp.kind === 'hive' || bp.kind === 'pot')) {
    throw new Error(
      `blueprint "${bp.id}" is kind:'hive' and cannot be nested — hives are peers, ` +
        `launchable only as a root (the deployment/bootstrap path). Launch pipelines ` +
        `or harnesses as children instead (kind:'harness'), or — if a subproject ` +
        `genuinely needs independent orchestration — a PEER hive via the federation.`,
    );
  }
}
