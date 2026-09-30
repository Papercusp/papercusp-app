/**
 * typed-properties-db.ts — the DB half of the typed goal/plan property contract
 * (work-on-everything-goal-2026-08-23 P-023 / WI-41047).
 *
 * The PURE decision (CAS + authorization + datatype validation) lives in
 * `typed-properties.ts`; THIS module owns the row I/O both write doors share:
 *
 *   - declaration validation against `datatype_registry` (creation seams +
 *     anywhere a `property_schema` document is accepted), and
 *   - the locked read → prepare → persist cycle on the owning goal / plan row
 *     (`goals:set-property` / `plans:set-property`).
 *
 * ONE writer per table, two thin doors — the same arrangement the goals
 * `_core.ts` insert has. The datatype registry remains the shape authority:
 * values are validated against the datatype's `payload_schema` via the shared
 * ajv seam, and an unknown datatype ref is an error, never a silent pass.
 *
 * Transport-agnostic: every function takes the `sql` handle (the caller's tx),
 * so the same code serves a tool ctx.tx, a withWorkspace tx, and an
 * integration test's admin client. Callers MUST run the write cycle inside a
 * transaction — the SELECT ... FOR UPDATE is what serializes concurrent CAS
 * writers on the same row.
 */
import type postgres from 'postgres';
import {
  prepareTypedPropertyMutation,
  TypedPropertySchemaDocumentSchema,
  type PropertyEditProvenance,
  type TypedPropertyMutationResult,
} from './typed-properties';
import { getDatatype } from './datatype-registry-store';
import { checkAgainstJsonSchema } from './json-schema-validation';
import {
  CANONICAL_WORKLIST_PROPERTY,
  PLAN_REF_LIST_DATATYPE,
  ensurePlanRefListDatatype,
  withCanonicalWorklistDeclaration,
} from './goals/package-property-datatypes';

/** The narrowest handle both callers' SQL tags satisfy (pool sql or tx). */
type SqlLike = postgres.Sql;

/** JSONB columns come back parsed on some driver configs and as raw text on
 *  others — normalize to an object (the columns are NOT NULL DEFAULT '{}'). */
function asDoc(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export type PropertySchemaDeclarationCheck =
  | { ok: true; declared: string[] }
  | { ok: false; issues: string[] };

/**
 * Validate a `property_schema` DECLARATION document: shape (zod), every
 * datatype ref resolves in this workspace's `datatype_registry`, and every
 * declared `default` satisfies its datatype's `payload_schema`.
 *
 * The declare-time gate for every creation seam (goals:create / goals:start /
 * plans:new) — the same validated-on-declare rule the IO schemas ship (714):
 * a declaration stored unresolvable could not be checked at write time, and
 * the write door must never render "could not check" as "anything goes".
 */
export async function validatePropertySchemaDeclaration(
  sql: SqlLike,
  workspaceId: string,
  doc: unknown,
): Promise<PropertySchemaDeclarationCheck> {
  const parsed = TypedPropertySchemaDocumentSchema.safeParse(doc ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }
  const issues: string[] = [];
  for (const [name, def] of Object.entries(parsed.data)) {
    const dt = await getDatatype(sql, workspaceId, def.datatype);
    if (!dt) {
      issues.push(
        `${name}: unknown datatype '${def.datatype}' — not in datatype_registry for this workspace (declare it via meta:define-datatype first)`,
      );
      continue;
    }
    if (def.default !== undefined) {
      const check = checkAgainstJsonSchema(dt.payloadSchema, def.default);
      if (!check.ok) {
        issues.push(`${name}: default does not satisfy datatype '${def.datatype}': ${check.errors.join('; ')}`);
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, declared: Object.keys(parsed.data) };
}

/** Validate one VALUE against a datatype's registered payload_schema. */
async function validateValueForDatatype(
  sql: SqlLike,
  workspaceId: string,
  datatype: string,
  value: unknown,
): Promise<{ ok: true } | { ok: false; issues: string[] }> {
  const dt = await getDatatype(sql, workspaceId, datatype);
  if (!dt) {
    return {
      ok: false,
      issues: [`unknown datatype '${datatype}' — not in datatype_registry for this workspace`],
    };
  }
  // A datatype with no payload_schema constrains nothing (checkAgainstJsonSchema
  // treats null/empty as "no constraint declared").
  const check = checkAgainstJsonSchema(dt.payloadSchema, value);
  if (check.ok) return { ok: true };
  return { ok: false, issues: check.errors };
}

export type TypedPropertyWriteResult = { ok: false; code: 'not_found' } | TypedPropertyMutationResult;

export interface TypedPropertyWriteArgs {
  workspaceId: string;
  property: string;
  value: unknown;
  /** CAS guard — the version the caller last read; 0 = "no explicit value yet". */
  expectedVersion: number;
  /** Explicit destructive opt-in for an authoritative array-length reduction. */
  confirmShrink?: boolean;
  provenance: PropertyEditProvenance;
  actorId: string;
}

/**
 * Run the shared prepare over one row's (property_schema, properties) pair.
 * The ONE datatype this write can touch is pre-resolved here so the pure
 * core's injected validator stays synchronous.
 */
async function runPreparedMutation(
  sql: SqlLike,
  args: TypedPropertyWriteArgs,
  row: { property_schema: unknown; properties: unknown },
): Promise<TypedPropertyMutationResult> {
  const schemaDoc = asDoc(row.property_schema);
  const propsDoc = asDoc(row.properties);
  const parsed = TypedPropertySchemaDocumentSchema.safeParse(schemaDoc);
  const datatypeRef = parsed.success ? parsed.data[args.property]?.datatype : undefined;
  const resolved = datatypeRef
    ? await validateValueForDatatype(sql, args.workspaceId, datatypeRef, args.value)
    : null; // unknown property / bad schema — prepare refuses before validate runs
  return prepareTypedPropertyMutation({
    propertySchema: schemaDoc,
    properties: propsDoc,
    property: args.property,
    value: args.value,
    expectedVersion: args.expectedVersion,
    confirmShrink: args.confirmShrink,
    provenance: args.provenance,
    actorId: args.actorId,
    validate: () => (resolved === null || resolved.ok ? { ok: true } : { ok: false, issues: resolved.issues }),
  });
}

/**
 * The `goals:set-property` write cycle: lock the goal row, decide via the pure
 * core, persist the merged `properties` document. Caller supplies a tx.
 */
export async function applyGoalPropertyWrite(
  sql: SqlLike,
  args: TypedPropertyWriteArgs & { goalId: string },
): Promise<TypedPropertyWriteResult> {
  const rows = await sql<Array<{ property_schema: unknown; properties: unknown }>>`
    SELECT property_schema, properties
      FROM harness_shared.goals
     WHERE id = ${args.goalId} AND workspace_id = ${args.workspaceId}
     FOR UPDATE`;
  if (!rows[0]) return { ok: false, code: 'not_found' };
  // Goals created before the canonical worklist seed still have no declaration.
  // Repair at the existing write boundary, under the same row lock as CAS, so
  // they can enter the placement worklist without a privileged data patch.
  // A custom declaration remains authoritative, including owner-only editing.
  const schema = asDoc(rows[0].property_schema);
  const worklistWrite = args.property === CANONICAL_WORKLIST_PROPERTY;
  const seedWorklist =
    worklistWrite && !Object.prototype.hasOwnProperty.call(schema, CANONICAL_WORKLIST_PROPERTY);
  const propertySchema = seedWorklist ? withCanonicalWorklistDeclaration(schema) : schema;
  if (worklistWrite) {
    const parsed = TypedPropertySchemaDocumentSchema.safeParse(propertySchema);
    if (
      parsed.success &&
      parsed.data[CANONICAL_WORKLIST_PROPERTY]?.datatype === PLAN_REF_LIST_DATATYPE
    ) {
      await ensurePlanRefListDatatype(sql, args.workspaceId);
    }
  }
  const result = await runPreparedMutation(sql, args, { ...rows[0], property_schema: propertySchema });
  if (!result.ok) return result;
  await sql`
    UPDATE harness_shared.goals
       SET properties = ${JSON.stringify(result.properties)}::text::jsonb,
           property_schema = CASE WHEN ${seedWorklist}
             THEN ${JSON.stringify(propertySchema)}::text::jsonb ELSE property_schema END,
           updated_at = now()
     WHERE id = ${args.goalId} AND workspace_id = ${args.workspaceId}`;
  return result;
}

/**
 * The `plans:set-property` write cycle — identical contract on the
 * `harness_plans` row (PK workspace_id, harness_slug, plan_slug).
 */
export async function applyPlanPropertyWrite(
  sql: SqlLike,
  args: TypedPropertyWriteArgs & { harnessSlug: string; planSlug: string },
): Promise<TypedPropertyWriteResult> {
  const rows = await sql<Array<{ property_schema: unknown; properties: unknown }>>`
    SELECT property_schema, properties
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${args.planSlug}
     FOR UPDATE`;
  if (!rows[0]) return { ok: false, code: 'not_found' };
  const result = await runPreparedMutation(sql, args, rows[0]);
  if (!result.ok) return result;
  await sql`
    UPDATE harness_shared.harness_plans
       SET properties = ${JSON.stringify(result.properties)}::text::jsonb,
           updated_at = now()
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${args.planSlug}`;
  return result;
}

/**
 * Read one row's property surface as the shape every reader wants: the raw
 * declaration + envelopes, plus the EFFECTIVE value per declared property
 * (stored value, else the declaration's default) so no caller re-derives the
 * fallback rule. Returns null when the row is absent.
 */
export function derivePropertySurface(row: { property_schema: unknown; properties: unknown }): {
  propertySchema: Record<string, unknown>;
  properties: Record<string, unknown>;
  effective: Record<string, unknown>;
} {
  const schemaDoc = asDoc(row.property_schema);
  const propsDoc = asDoc(row.properties);
  const effective: Record<string, unknown> = {};
  const parsed = TypedPropertySchemaDocumentSchema.safeParse(schemaDoc);
  if (parsed.success) {
    for (const [name, def] of Object.entries(parsed.data)) {
      const stored = propsDoc[name] as { value?: unknown } | undefined;
      effective[name] = stored && typeof stored === 'object' && 'value' in stored ? stored.value : def.default;
    }
  }
  return { propertySchema: schemaDoc, properties: propsDoc, effective };
}
