/**
 * Typed goal/plan property contract (work-on-everything-goal-2026-08-23 P-023).
 *
 * Declarations live in an owning row's `property_schema`; values, CAS versions,
 * and provenance live together in its ONE `properties` jsonb document. The
 * datatype registry remains the shape authority — callers inject the resolved
 * datatype validator rather than duplicating JSON-Schema compilation here.
 */

import { z } from 'zod';
import type { RefusalContract } from './capability-envelope/refusal-contract-types';

export const PROPERTY_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export const PropertyEditableBySchema = z.enum(['owner', 'agent', 'both']);
export type PropertyEditableBy = z.infer<typeof PropertyEditableBySchema>;

export const TypedPropertyDefinitionSchema = z
  .object({
    datatype: z.string().min(1).max(120),
    default: z.unknown().optional(),
    editable_by: PropertyEditableBySchema,
  })
  .strict();
export type TypedPropertyDefinition = z.infer<typeof TypedPropertyDefinitionSchema>;

export const TypedPropertySchemaDocumentSchema = z
  .record(z.string().regex(PROPERTY_NAME), TypedPropertyDefinitionSchema)
  .refine((document) => Object.keys(document).length <= 100, 'at most 100 properties may be declared');
export type TypedPropertySchemaDocument = z.infer<typeof TypedPropertySchemaDocumentSchema>;

export const PropertyEditProvenanceSchema = z.enum(['owner-edit', 'agent-edit']);
export type PropertyEditProvenance = z.infer<typeof PropertyEditProvenanceSchema>;

export const StoredTypedPropertySchema = z
  .object({
    value: z.unknown(),
    version: z.number().int().positive(),
    edited_at: z.string().datetime(),
    edited_by: z.string().min(1).max(200),
    provenance: PropertyEditProvenanceSchema,
  })
  .strict();
export type StoredTypedProperty = z.infer<typeof StoredTypedPropertySchema>;

export const StoredTypedPropertiesSchema = z.record(z.string(), StoredTypedPropertySchema);
export type StoredTypedProperties = z.infer<typeof StoredTypedPropertiesSchema>;

export type TypedPropertyMutationFailure =
  | { ok: false; code: 'bad_property_schema'; issues: string[] }
  | { ok: false; code: 'bad_properties'; issues: string[] }
  | { ok: false; code: 'unknown_property'; property: string }
  | {
      ok: false;
      code: 'forbidden';
      property: string;
      editableBy: PropertyEditableBy;
      refusal: RefusalContract;
    }
  | { ok: false; code: 'stale'; property: string; expectedVersion: number; actualVersion: number }
  | { ok: false; code: 'invalid_value'; property: string; datatype: string; issues: string[] }
  | {
      ok: false;
      code: 'shrink_blocked';
      property: string;
      priorLength: number;
      proposedLength: number;
      actualVersion: number;
      recovery: { confirmShrink: true };
      refusal: RefusalContract;
    };

export type TypedPropertyMutationResult =
  | TypedPropertyMutationFailure
  | {
      ok: true;
      definition: TypedPropertyDefinition;
      priorValue: unknown;
      priorVersion: number;
      entry: StoredTypedProperty;
      properties: StoredTypedProperties;
    };

export interface PrepareTypedPropertyMutationArgs {
  propertySchema: unknown;
  properties: unknown;
  property: string;
  value: unknown;
  expectedVersion: number;
  /**
   * Explicitly confirms that an array-length reduction is intentional.
   *
   * Typed-property values are whole replacements. A caller that received a
   * result-door-trimmed array otherwise cannot distinguish its excerpt from
   * the authoritative list, so every reduction fails closed unless the caller
   * opts into the destructive path after a complete read.
   */
  confirmShrink?: boolean;
  provenance: PropertyEditProvenance;
  actorId: string;
  editedAt?: string;
  /** Validate against the definition's datatype_registry payload_schema. */
  validate: (datatype: string, value: unknown) => { ok: true } | { ok: false; issues: string[] };
}

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);

/**
 * Pure CAS + authorization + datatype-validation decision shared by both write
 * doors. `expectedVersion: 0` means "the property has no explicit value yet"
 * (its declaration's default, if any, is the effective prior value).
 */
/** Clip one value for a delta line — short JSON, never a paragraph. */
const shortValue = (v: unknown): string => {
  if (v === undefined) return '∅';
  let s: string;
  try {
    s = JSON.stringify(v) ?? 'undefined';
  } catch {
    s = String(v);
  }
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
};

/**
 * Render ONE property write as the human-readable delta line the owning
 * agent's orient/wake fold shows (`worklist: +"docs sweeps" −"perf"`).
 *
 * Pure — rides the plan-events envelope's `detail` field, which the orient
 * fold already passes through verbatim, so no render code exists downstream.
 * Arrays of scalars diff element-wise (+added −removed, insertion order);
 * everything else renders `prior → next` with values clipped to one line.
 */
export function renderPropertyDelta(property: string, prior: unknown, next: unknown): string {
  const scalarArray = (v: unknown): v is Array<string | number | boolean | null> =>
    Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x));
  if (scalarArray(next) && (prior === undefined || prior === null || scalarArray(prior))) {
    const before = new Set((scalarArray(prior) ? prior : []).map(shortValue));
    const after = new Set(next.map(shortValue));
    const added = [...after].filter((x) => !before.has(x));
    const removed = [...before].filter((x) => !after.has(x));
    if (added.length > 0 || removed.length > 0) {
      const parts = [...added.map((a) => `+${a}`), ...removed.map((r) => `−${r}`)];
      return `${property}: ${parts.join(' ')}`;
    }
    return `${property}: unchanged`;
  }
  return `${property}: ${shortValue(prior)} → ${shortValue(next)}`;
}

export function prepareTypedPropertyMutation(
  args: PrepareTypedPropertyMutationArgs,
): TypedPropertyMutationResult {
  const declaration = TypedPropertySchemaDocumentSchema.safeParse(args.propertySchema ?? {});
  if (!declaration.success) {
    return { ok: false, code: 'bad_property_schema', issues: issuesOf(declaration.error) };
  }
  const stored = StoredTypedPropertiesSchema.safeParse(args.properties ?? {});
  if (!stored.success) {
    return { ok: false, code: 'bad_properties', issues: issuesOf(stored.error) };
  }

  const definition = declaration.data[args.property];
  if (!definition) return { ok: false, code: 'unknown_property', property: args.property };

  const actor = args.provenance === 'owner-edit' ? 'owner' : 'agent';
  if (definition.editable_by !== 'both' && definition.editable_by !== actor) {
    return {
      ok: false,
      code: 'forbidden',
      property: args.property,
      editableBy: definition.editable_by,
      refusal: {
        observed: { property: args.property, editableBy: definition.editable_by, actor, provenance: args.provenance },
        liftsWhen:
          `the edit is made as ${definition.editable_by === 'owner' ? 'an owner-edit' : 'an agent-edit'} ` +
          `(the property declares editable_by=${definition.editable_by}), or the declaration is changed to ` +
          'editable_by=both. Retrying with the same provenance changes nothing',
        whoCanMakeItTrue: definition.editable_by === 'owner' ? ['owner'] : ['another-agent'],
      } satisfies RefusalContract,
    };
  }

  const current = stored.data[args.property];
  const actualVersion = current?.version ?? 0;
  if (args.expectedVersion !== actualVersion) {
    return {
      ok: false,
      code: 'stale',
      property: args.property,
      expectedVersion: args.expectedVersion,
      actualVersion,
    };
  }

  const validation = args.validate(definition.datatype, args.value);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'invalid_value',
      property: args.property,
      datatype: definition.datatype,
      issues: validation.issues,
    };
  }

  const priorValue = current ? current.value : definition.default;
  if (
    args.confirmShrink !== true &&
    Array.isArray(priorValue) &&
    Array.isArray(args.value) &&
    args.value.length < priorValue.length
  ) {
    return {
      ok: false,
      code: 'shrink_blocked',
      property: args.property,
      priorLength: priorValue.length,
      proposedLength: args.value.length,
      actualVersion,
      recovery: { confirmShrink: true },
      refusal: {
        observed: {
          property: args.property,
          priorLength: String(priorValue.length),
          proposedLength: String(args.value.length),
        },
        liftsWhen:
          'the caller resubmits the same value with confirmShrink:true (it asserts the shorter list is ' +
          'intentional), or submits a value at least as long as the stored one',
        whoCanMakeItTrue: ['self'],
      } satisfies RefusalContract,
    };
  }

  const entry: StoredTypedProperty = {
    value: args.value,
    version: actualVersion + 1,
    edited_at: args.editedAt ?? new Date().toISOString(),
    edited_by: args.actorId,
    provenance: args.provenance,
  };
  return {
    ok: true,
    definition,
    priorValue,
    priorVersion: actualVersion,
    entry,
    properties: { ...stored.data, [args.property]: entry },
  };
}
