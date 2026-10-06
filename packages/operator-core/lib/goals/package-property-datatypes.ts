/**
 * package-property-datatypes.ts — the first-party datatype(s) bundled goal
 * packages' property declarations reference (work-on-everything-goal-2026-08-23
 * P-025; D-005 §2 typed properties; D-004 plan-ref grammar).
 *
 * `validatePropertySchemaDeclaration` refuses a declaration whose datatype ref
 * does not resolve in the workspace's `datatype_registry` — right for user
 * declarations ("declare it via meta:define-datatype first"), but a BUNDLED
 * first-party package must land on a fresh workspace where nothing was ever
 * declared. So the seams that write a package's `propertySchema` onto a goal
 * row (the install seed, the start-from-package mint) ENSURE the first-party
 * datatypes exist first — insert-if-ABSENT, never overwrite: P-024 attaches
 * display specs to these same registry rows, and an ensure that clobbered them
 * would silently erase that lane's work on every install.
 *
 * The one datatype v1 needs: `plan-ref-list` — an ordered list of plan refs in
 * D-004's explicit `plan:` form, the type of the work-on-everything package's
 * `worklist` property (LIST ORDER IS PRIORITY; the owner curates it in the
 * HUD properties panel, the goal agent drives from it — P-025).
 */
import type postgres from 'postgres';
import { getDatatype, upsertDatatype, type DatatypeRow } from '../datatype-registry-store';
import type { TypedPropertyDefinition } from '../typed-properties';

/** The datatype ref the work-on-everything `worklist` property declares (P-025). */
export const PLAN_REF_LIST_DATATYPE = 'plan-ref-list';

/**
 * D-004 ruling 1: a plan ref is `plan:<slug>` or `plan:<harness>/<slug>` — the
 * prefix is mandatory (a bare slug is indistinguishable from a goal id by
 * shape). Slug charset mirrors the store's kebab reality: lowercase
 * alphanumerics with `._-` separators, never leading with a separator.
 */
export const PLAN_REF_STRING_PATTERN = '^plan:[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)?$';

/** JSON-Schema payload for `plan-ref-list`: an ordered array of D-004 refs. */
export function planRefListPayloadSchema(): Record<string, unknown> {
  return {
    type: 'array',
    items: { type: 'string', pattern: PLAN_REF_STRING_PATTERN },
  };
}

export interface EnsurePlanRefListDeps {
  get: (sql: postgres.Sql, workspaceId: string, id: string) => Promise<DatatypeRow | null>;
  upsert: typeof upsertDatatype;
}

const DEFAULT_DEPS: EnsurePlanRefListDeps = { get: getDatatype, upsert: upsertDatatype };

/**
 * Ensure `plan-ref-list` exists in this workspace's registry. Insert-if-absent
 * ONLY — an existing row (whatever its content: a P-024 display spec, an owner
 * re-description) is left untouched, so this is safe to call on every seed.
 */
export async function ensurePlanRefListDatatype(
  sql: postgres.Sql,
  workspaceId: string,
  deps: EnsurePlanRefListDeps = DEFAULT_DEPS,
): Promise<{ created: boolean }> {
  const existing = await deps.get(sql, workspaceId, PLAN_REF_LIST_DATATYPE);
  if (existing) return { created: false };
  await deps.upsert(sql, {
    id: PLAN_REF_LIST_DATATYPE,
    workspaceId,
    title: 'Plan-ref list',
    description:
      "An ordered list of plan references in D-004's explicit `plan:` form " +
      '(`plan:<slug>` or `plan:<harness>/<slug>`). List order is priority. ' +
      "The type of a goal's `worklist` property (work-on-everything-goal-2026-08-23 P-025).",
    tier: 'first-class',
    // P-008 / D-013 §3: a plan-ref list is entity state, never work.
    nature: 'record',
    payloadSchema: planRefListPayloadSchema(),
    createdBy: 'goal-package-seed',
  });
  return { created: true };
}

/** The property name the placement gate reads as canonical on EVERY goal. */
export const CANONICAL_WORKLIST_PROPERTY = 'worklist';

/**
 * The canonical `worklist` declaration. Matches, byte for byte, what the
 * bundled work-on-everything package already writes (verified against the
 * live rows: `{ datatype: 'plan-ref-list', default: [], editable_by: 'both' }`)
 * so an ad-hoc goal and a packaged goal are indistinguishable to every reader.
 */
export function canonicalWorklistDeclaration(): TypedPropertyDefinition {
  return { datatype: PLAN_REF_LIST_DATATYPE, default: [], editable_by: 'both' };
}

/**
 * Seed the canonical `worklist` declaration onto a goal's property_schema at
 * CREATION. PURE — no database, no I/O, so every goal-creation door can call
 * it unconditionally without taking a dependency on the registry.
 *
 * Why every goal and not just packaged ones: `worklist` is not an optional
 * package flourish — `goal-launch-settings.ts` reads
 * `g.properties->'worklist'->'value'` as THE canonical placement worklist for
 * any goal, unconditionally. A system gate that treats a property as universal
 * must not be able to disagree with the schema that declares it. Before this,
 * a goal created ad hoc got `property_schema = '{}'` (insertGoalRow COALESCEs
 * a missing schema to an empty object), so `goals:set-property` refused
 * `unknown_property: worklist` and the goal could never populate the worklist
 * the gate then reported as "empty" — a closed loop with no tool-reachable exit.
 *
 * The OTHER half — the `plan-ref-list` row in the workspace's datatype registry
 * — is ensured lazily at the write door (`ensurePlanRefListDatatype`), where
 * the datatype is actually resolved to validate a value. Deliberately NOT done
 * here: binding four creation doors to a registry round-trip buys nothing at a
 * moment when no value is being validated, and a declaration that fails to
 * land because an unrelated registry read failed is strictly worse than one
 * that lands and is validated on first use.
 *
 * Non-destructive: a caller that declared `worklist` itself keeps its own
 * declaration untouched, mirroring `ensurePlanRefListDatatype`'s
 * insert-if-absent contract.
 */
export function withCanonicalWorklistDeclaration(
  propertySchema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const declared = { ...(propertySchema ?? {}) };
  if (Object.prototype.hasOwnProperty.call(declared, CANONICAL_WORKLIST_PROPERTY)) return declared;
  declared[CANONICAL_WORKLIST_PROPERTY] = canonicalWorklistDeclaration();
  return declared;
}
