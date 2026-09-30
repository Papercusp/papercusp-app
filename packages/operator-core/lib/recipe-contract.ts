/**
 * Versioned recipe-script binding and capability contract (P-015).
 *
 * This module is deliberately pure.  It validates stored/inline metadata and
 * current-run inputs, reconciles statically derived requirements with the
 * declared manifest, and checks a CURRENT caller/catalog snapshot.  It does not
 * dispatch, resolve secrets, read the recipe store, or carry author privilege.
 * Runtime consumers must repeat authorization at every nested dispatch.
 */
import { z } from 'zod';

export const RECIPE_CONTRACT_VERSION = 1 as const;
export const RECIPE_SCRIPT_REPRESENTATION = 'recipe-script' as const;
export const REQUIRED_RECIPE_TOPOLOGY_PREMISE = 'host:same' as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const bindingLifetimeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stable') }).strict(),
  z
    .object({
      kind: z.literal('resolved-ref'),
      refKind: z.enum(['resource', 'secret']),
      resolution: z.enum(['each-run', 'each-use']),
    })
    .strict(),
  z.object({ kind: z.literal('invocation-ephemeral') }).strict(),
]);

export const bindingPropertySchema = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean', 'json', 'secret-ref', 'resource-ref']),
    required: z.boolean().optional(),
    description: z.string().min(1).optional(),
    lifetime: bindingLifetimeSchema,
  })
  .strict()
  .superRefine((property, ctx) => {
    if (property.type === 'secret-ref') {
      if (
        property.lifetime.kind !== 'resolved-ref'
        || property.lifetime.refKind !== 'secret'
        || property.lifetime.resolution !== 'each-use'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifetime'],
          message: 'secret-ref requires a resolved-ref/secret/each-use lifetime',
        });
      }
      return;
    }

    if (property.type === 'resource-ref') {
      if (property.lifetime.kind !== 'resolved-ref' || property.lifetime.refKind !== 'resource') {
        ctx.addIssue({
          code: 'custom',
          path: ['lifetime'],
          message: 'resource-ref requires a resolved-ref/resource lifetime',
        });
      }
      return;
    }

    if (property.lifetime.kind === 'resolved-ref') {
      ctx.addIssue({
        code: 'custom',
        path: ['lifetime'],
        message: 'resolved-ref lifetime is valid only for secret-ref or resource-ref bindings',
      });
    }
  });

export const recipeBindingSchemaV1Schema = z
  .object({
    version: z.literal(RECIPE_CONTRACT_VERSION),
    properties: z.record(z.string().min(1), bindingPropertySchema),
    additionalProperties: z.literal(false),
  })
  .strict();

export type BindingLifetime = z.infer<typeof bindingLifetimeSchema>;
export type RecipeBindingProperty = z.infer<typeof bindingPropertySchema>;
export type RecipeBindingSchemaV1 = z.infer<typeof recipeBindingSchemaV1Schema>;

export const REPLAY_CLASSES = ['read-only', 'idempotent', 'checkpointed', 'non-replayable'] as const;
export type ReplayClass = (typeof REPLAY_CLASSES)[number];
export type RecipeLifecycle = 'foreground' | 'background';
export type RecipeContentKind = 'text' | 'reference' | 'image' | 'audio' | 'pty-frame' | 'replay-state';

export type LogicalCapability =
  | `tools:${string}:${string}`
  | 'execution:shell'
  | 'execution:background-task'
  | 'execution:pty'
  | 'content:image'
  | 'content:audio'
  | 'lifecycle:durable'
  | 'topology:host:same';

const TOOL_REQUIREMENT = /^tools:[^:\s]+:[^:\s]+$/;
const FIXED_LOGICAL_CAPABILITIES = new Set<LogicalCapability>([
  'execution:shell',
  'execution:background-task',
  'execution:pty',
  'content:image',
  'content:audio',
  'lifecycle:durable',
  'topology:host:same',
]);

export function isKnownLogicalCapability(value: string): value is LogicalCapability {
  return TOOL_REQUIREMENT.test(value) || FIXED_LOGICAL_CAPABILITIES.has(value as LogicalCapability);
}

export const capabilityRequirementSchema = z
  .object({
    capability: z
      .string()
      .min(1)
      .refine(isKnownLogicalCapability, 'unknown logical capability'),
    optional: z.literal(false).optional(),
  })
  .strict();

export const capabilityManifestV1Schema = z
  .object({
    version: z.literal(RECIPE_CONTRACT_VERSION),
    representation: z.literal(RECIPE_SCRIPT_REPRESENTATION),
    topology: z
      .object({ premises: z.tuple([z.literal(REQUIRED_RECIPE_TOPOLOGY_PREMISE)]) })
      .strict(),
    requirements: z.array(capabilityRequirementSchema),
    lifecycle: z
      .object({
        allowed: z.array(z.enum(['foreground', 'background'])).min(1),
        default: z.enum(['foreground', 'background']),
      })
      .strict(),
    replay: z
      .object({
        class: z.enum(REPLAY_CLASSES),
        reason: z.string().min(1).optional(),
      })
      .strict(),
    content: z
      .object({ emits: z.array(z.enum(['text', 'reference', 'image', 'audio', 'pty-frame', 'replay-state'])) })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (!manifest.lifecycle.allowed.includes(manifest.lifecycle.default)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lifecycle', 'default'],
        message: 'default lifecycle must be included in lifecycle.allowed',
      });
    }
    const requirements = manifest.requirements.map(({ capability }) => capability);
    if (new Set(requirements).size !== requirements.length) {
      ctx.addIssue({ code: 'custom', path: ['requirements'], message: 'requirements must be unique' });
    }
    if (new Set(manifest.lifecycle.allowed).size !== manifest.lifecycle.allowed.length) {
      ctx.addIssue({ code: 'custom', path: ['lifecycle', 'allowed'], message: 'allowed lifecycles must be unique' });
    }
    if (new Set(manifest.content.emits).size !== manifest.content.emits.length) {
      ctx.addIssue({ code: 'custom', path: ['content', 'emits'], message: 'content kinds must be unique' });
    }
  });

export type CapabilityRequirement = z.infer<typeof capabilityRequirementSchema>;
export type CapabilityManifestV1 = z.infer<typeof capabilityManifestV1Schema>;

export type RecipeContractDiagnosticCode =
  | 'ambiguous_source'
  | 'source_missing'
  | 'script_invalid'
  | 'recipe_not_found'
  | 'recipe_schema_stale'
  | 'recipe_authority_required'
  | 'recipe_authority_stale'
  | 'recipe_authority_mismatch'
  | 'binding_schema_required'
  | 'binding_invalid'
  | 'binding_secret_inline'
  | 'binding_ephemeral_persisted'
  | 'capability_undeclared'
  | 'capability_denied'
  | 'capability_unavailable'
  | 'topology_premise_failed'
  | 'execution_mode_unavailable'
  | 'lifecycle_unavailable'
  | 'timeout_invalid'
  | 'replayability_mismatch'
  | 'durable_replay_unsafe';

export interface RecipeContractDiagnostic {
  code: RecipeContractDiagnosticCode;
  message: string;
  path?: string;
  capability?: string;
}

export interface RecipeContractFailure {
  ok: false;
  phase: 'preflight';
  executed: false;
  error: RecipeContractDiagnostic;
}

export interface RecipeContractSuccess<T> {
  ok: true;
  value: T;
}

export type RecipeContractCheck<T> = RecipeContractSuccess<T> | RecipeContractFailure;

export function recipeContractFailure(
  code: RecipeContractDiagnosticCode,
  message: string,
  extra: Pick<RecipeContractDiagnostic, 'path' | 'capability'> = {},
): RecipeContractFailure {
  return {
    ok: false,
    phase: 'preflight',
    executed: false,
    error: { code, message, ...extra },
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const ok = value.every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return ok;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    seen.delete(value);
    return false;
  }
  const ok = Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return ok;
}

const EPHEMERAL_KEY = new Set([
  'claimid',
  'cursor',
  'jobid',
  'lockid',
  'locklease',
  'ownerid',
  'pid',
  'processid',
  'ptyid',
  'requestid',
  'sessionid',
  'taskid',
  'transportid',
]);
const VOLATILE_OWNER_ID = /\bsu-(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{4,64})\b/i;
const EPHEMERAL_PATH = /^(?:\/tmp\/|\/var\/tmp\/|\/run\/|\/dev\/shm\/)/;

function findInvocationEphemeral(value: JsonValue, path: string): string | null {
  if (typeof value === 'string') {
    return VOLATILE_OWNER_ID.test(value) || EPHEMERAL_PATH.test(value) ? path : null;
  }
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findInvocationEphemeral(value[index], `${path}[${index}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (EPHEMERAL_KEY.has(normalized)) return childPath;
    const hit = findInvocationEphemeral(child, childPath);
    if (hit) return hit;
  }
  return null;
}

function bindingValueMatches(property: RecipeBindingProperty, value: unknown): boolean {
  switch (property.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return isJsonValue(value);
    case 'secret-ref': {
      const record = asRecord(value);
      return record !== null
        && typeof record.secretRef === 'string'
        && record.secretRef.length > 0
        && Object.keys(record).every((key) => key === 'secretRef');
    }
    case 'resource-ref': {
      const record = asRecord(value);
      return record !== null
        && typeof record.resourceRef === 'string'
        && record.resourceRef.length > 0
        && (record.revision === undefined || typeof record.revision === 'string')
        && Object.keys(record).every((key) => key === 'resourceRef' || key === 'revision');
    }
  }
}

function firstZodPath(error: z.ZodError): string | undefined {
  const path = error.issues[0]?.path.map(String).join('.');
  return path || undefined;
}

export interface RecipeBindingSet {
  values: Record<string, unknown>;
}

export interface ValidatedRecipeBindings {
  /** Safe JSON/reference values for later cloning + deep-freezing INSIDE the VM realm. Secrets are excluded. */
  inputs: Record<string, JsonValue | { resourceRef: string; revision?: string }>;
  secretRefs: Record<string, { secretRef: string; resolution: 'each-use' }>;
  resourceRefs: Record<string, { resourceRef: string; revision?: string; resolution: 'each-run' | 'each-use' }>;
  replayClass: 'read-only' | 'non-replayable';
  portability: 'portable' | 'invocation-bound';
}

export interface ValidateRecipeBindingsInput {
  schema?: unknown;
  bindings?: RecipeBindingSet;
  lifecycle?: RecipeLifecycle;
  /** True only when the values themselves would be captured/persisted, not merely used for this run. */
  persistBindings?: boolean;
}

export function validateRecipeBindings(
  input: ValidateRecipeBindingsInput,
): RecipeContractCheck<ValidatedRecipeBindings> {
  const values = input.bindings?.values ?? {};
  if (!asRecord(values)) {
    return recipeContractFailure('binding_invalid', 'bindings.values must be an object', { path: 'bindings.values' });
  }
  if (input.schema === undefined) {
    if (Object.keys(values).length > 0) {
      return recipeContractFailure(
        'binding_schema_required',
        'non-empty bindings require a versioned binding schema',
        { path: 'bindingSchema' },
      );
    }
    return {
      ok: true,
      value: { inputs: {}, secretRefs: {}, resourceRefs: {}, replayClass: 'read-only', portability: 'portable' },
    };
  }

  const parsed = recipeBindingSchemaV1Schema.safeParse(input.schema);
  if (!parsed.success) {
    return recipeContractFailure('recipe_schema_stale', parsed.error.issues[0]?.message ?? 'invalid binding schema', {
      path: firstZodPath(parsed.error),
    });
  }
  const schema = parsed.data;
  const extra = Object.keys(values).find((key) => !(key in schema.properties));
  if (extra) {
    return recipeContractFailure('binding_invalid', `binding ${extra} is not declared`, {
      path: `bindings.values.${extra}`,
    });
  }

  const result: ValidatedRecipeBindings = {
    inputs: {},
    secretRefs: {},
    resourceRefs: {},
    replayClass: 'read-only',
    portability: 'portable',
  };

  for (const [name, property] of Object.entries(schema.properties)) {
    const present = Object.prototype.hasOwnProperty.call(values, name);
    if (!present) {
      if (property.required) {
        return recipeContractFailure('binding_invalid', `required binding ${name} is missing`, {
          path: `bindings.values.${name}`,
        });
      }
      continue;
    }
    const value = values[name];
    if (!bindingValueMatches(property, value)) {
      const code = property.type === 'secret-ref' ? 'binding_secret_inline' : 'binding_invalid';
      return recipeContractFailure(code, `binding ${name} does not match ${property.type}`, {
        path: `bindings.values.${name}`,
      });
    }

    if (property.lifetime.kind === 'invocation-ephemeral') {
      if (input.lifecycle === 'background' || input.persistBindings === true) {
        return recipeContractFailure(
          'binding_ephemeral_persisted',
          `binding ${name} is invocation-ephemeral and cannot be persisted or used for background execution`,
          { path: `bindings.values.${name}` },
        );
      }
      result.replayClass = 'non-replayable';
      result.portability = 'invocation-bound';
    }

    if (property.lifetime.kind === 'stable' && isJsonValue(value)) {
      const ephemeralPath = findInvocationEphemeral(value, `bindings.values.${name}`);
      if (ephemeralPath) {
        return recipeContractFailure(
          'binding_ephemeral_persisted',
          `stable binding ${name} contains a known invocation-ephemeral value`,
          { path: ephemeralPath },
        );
      }
    }

    if (property.type === 'secret-ref') {
      const secretRef = (value as { secretRef: string }).secretRef;
      result.secretRefs[name] = { secretRef, resolution: 'each-use' };
      continue;
    }
    if (property.type === 'resource-ref') {
      const resource = value as { resourceRef: string; revision?: string };
      result.resourceRefs[name] = {
        ...resource,
        resolution: property.lifetime.kind === 'resolved-ref' ? property.lifetime.resolution : 'each-run',
      };
      result.inputs[name] = { ...resource };
      continue;
    }
    result.inputs[name] = value as JsonValue;
  }

  return { ok: true, value: result };
}

const snake = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

/** Convert either a projected `namespace:verb` or code-facade `namespace.verb` name. */
export function projectedToolName(toolName: string): string {
  if (toolName.includes(':')) return toolName;
  const [namespace, ...rest] = toolName.split('.');
  if (!namespace || rest.length === 0) return toolName;
  return `${snake(namespace)}:${snake(rest.join('_'))}`;
}

export function toolRequirementFor(toolName: string): LogicalCapability {
  return `tools:${projectedToolName(toolName)}` as LogicalCapability;
}

function escapeRequirementsFor(toolName: string): LogicalCapability[] {
  const tool = projectedToolName(toolName);
  if (tool === 'capability:bash') return ['execution:shell'];
  if (tool === 'capability:bash_output' || tool === 'capability:bash_kill') {
    return ['execution:shell', 'execution:background-task'];
  }
  if (tool.startsWith('capability:pty_')) return ['execution:pty'];
  return [];
}

export interface LegacyManifestOptions {
  emits?: RecipeContentKind[];
}

/** Foreground-only compatibility metadata for a legacy recipe with no stored contract. */
export function deriveLegacyForegroundManifest(
  staticToolNames: readonly string[],
  options: LegacyManifestOptions = {},
): CapabilityManifestV1 {
  const emits: RecipeContentKind[] = [...new Set<RecipeContentKind>(options.emits ?? ['text'])];
  const requirements = new Set<LogicalCapability>();
  for (const toolName of staticToolNames) {
    requirements.add(toolRequirementFor(toolName));
    for (const capability of escapeRequirementsFor(toolName)) requirements.add(capability);
  }
  if (emits.includes('image')) requirements.add('content:image');
  if (emits.includes('audio')) requirements.add('content:audio');
  if (emits.includes('pty-frame')) requirements.add('execution:pty');
  return {
    version: RECIPE_CONTRACT_VERSION,
    representation: RECIPE_SCRIPT_REPRESENTATION,
    topology: { premises: [REQUIRED_RECIPE_TOPOLOGY_PREMISE] },
    requirements: [...requirements].sort().map((capability) => ({ capability })),
    lifecycle: { allowed: ['foreground'], default: 'foreground' },
    replay: {
      class: 'non-replayable',
      reason: 'legacy recipe: foreground-only until recaptured with an explicit versioned contract',
    },
    content: { emits },
  };
}

export interface CurrentCallerCapabilityCatalog {
  /** Current projected tool names, in canonical `namespace:verb` form. */
  projectedTools: ReadonlySet<string>;
  /** Subset the current caller may invoke now. */
  allowedTools: ReadonlySet<string>;
  /** Logical service/topology-independent capabilities implemented now. */
  availableCapabilities: ReadonlySet<LogicalCapability>;
  /** Logical capabilities admitted by the current caller's live envelope. */
  allowedCapabilities: ReadonlySet<LogicalCapability>;
  topology: { hostSame: boolean };
}

export interface ValidateRecipeCapabilitiesInput {
  manifest: unknown;
  staticToolNames: readonly string[];
  derivedRequirements?: readonly string[];
  lifecycle?: RecipeLifecycle;
  catalog: CurrentCallerCapabilityCatalog;
}

export interface ValidatedRecipeCapabilities {
  manifest: CapabilityManifestV1;
  requirements: LogicalCapability[];
}

function requiredByContent(manifest: CapabilityManifestV1): LogicalCapability[] {
  const requirements: LogicalCapability[] = [];
  if (manifest.content.emits.includes('image')) requirements.push('content:image');
  if (manifest.content.emits.includes('audio')) requirements.push('content:audio');
  if (manifest.content.emits.includes('pty-frame')) requirements.push('execution:pty');
  return requirements;
}

export function validateRecipeCapabilities(
  input: ValidateRecipeCapabilitiesInput,
): RecipeContractCheck<ValidatedRecipeCapabilities> {
  const parsed = capabilityManifestV1Schema.safeParse(input.manifest);
  if (!parsed.success) {
    return recipeContractFailure('recipe_schema_stale', parsed.error.issues[0]?.message ?? 'invalid manifest', {
      path: firstZodPath(parsed.error),
    });
  }
  const manifest = parsed.data;
  const lifecycle = input.lifecycle ?? manifest.lifecycle.default;
  if (!manifest.lifecycle.allowed.includes(lifecycle)) {
    return recipeContractFailure('lifecycle_unavailable', `manifest does not allow ${lifecycle} execution`, {
      path: 'execution.lifecycle',
    });
  }
  if (!input.catalog.topology.hostSame) {
    return recipeContractFailure(
      'topology_premise_failed',
      'recipe contract requires host:same, but the current topology does not satisfy it',
      { path: 'manifest.topology.premises', capability: 'topology:host:same' },
    );
  }

  const declared = new Set(manifest.requirements.map(({ capability }) => capability as LogicalCapability));
  const derived = new Set<LogicalCapability>();
  for (const tool of input.staticToolNames) {
    derived.add(toolRequirementFor(tool));
    for (const capability of escapeRequirementsFor(tool)) derived.add(capability);
  }
  for (const capability of input.derivedRequirements ?? []) {
    if (!isKnownLogicalCapability(capability)) {
      return recipeContractFailure('capability_unavailable', `unknown derived capability ${capability}`, {
        path: 'derivedRequirements',
        capability,
      });
    }
    derived.add(capability);
  }
  for (const capability of requiredByContent(manifest)) derived.add(capability);
  if (lifecycle === 'background') derived.add('lifecycle:durable');

  for (const capability of derived) {
    if (!declared.has(capability)) {
      return recipeContractFailure('capability_undeclared', `required capability ${capability} is not declared`, {
        path: 'manifest.requirements',
        capability,
      });
    }
  }

  for (const capability of declared) {
    if (capability.startsWith('tools:')) {
      const tool = capability.slice('tools:'.length);
      if (!input.catalog.projectedTools.has(tool)) {
        return recipeContractFailure('capability_unavailable', `projected tool ${tool} is unavailable`, {
          path: 'manifest.requirements',
          capability,
        });
      }
      if (!input.catalog.allowedTools.has(tool)) {
        return recipeContractFailure('capability_denied', `current caller may not invoke ${tool}`, {
          path: 'manifest.requirements',
          capability,
        });
      }
      continue;
    }
    if (capability === 'topology:host:same') continue;
    if (!input.catalog.availableCapabilities.has(capability)) {
      return recipeContractFailure('capability_unavailable', `capability ${capability} is unavailable`, {
        path: 'manifest.requirements',
        capability,
      });
    }
    if (!input.catalog.allowedCapabilities.has(capability)) {
      return recipeContractFailure('capability_denied', `current caller may not use ${capability}`, {
        path: 'manifest.requirements',
        capability,
      });
    }
  }

  return { ok: true, value: { manifest, requirements: [...declared].sort() } };
}

const REPLAY_RISK: Record<ReplayClass, number> = {
  'read-only': 0,
  idempotent: 1,
  checkpointed: 2,
  'non-replayable': 3,
};

/** Select the less permissive class; an author assertion can never upgrade runtime evidence. */
export function downgradeReplayClass(asserted: ReplayClass, derived: ReplayClass): ReplayClass {
  return REPLAY_RISK[derived] > REPLAY_RISK[asserted] ? derived : asserted;
}

export interface PreflightRecipeContractInput extends ValidateRecipeCapabilitiesInput {
  bindingSchema?: unknown;
  bindings?: RecipeBindingSet;
  persistBindings?: boolean;
  /** Runtime/static evidence, never copied from the author assertion. */
  derivedReplayClass: ReplayClass;
}

export interface PreflightRecipeContractValue {
  manifest: CapabilityManifestV1;
  bindingSchema?: RecipeBindingSchemaV1;
  bindings: ValidatedRecipeBindings;
  requirements: LogicalCapability[];
  replay: {
    asserted: ReplayClass;
    derived: ReplayClass;
    effective: ReplayClass;
    downgraded: boolean;
  };
  portability: 'topology-bound' | 'invocation-bound';
}

/** One pure preflight over the exact revision and one current-caller catalog snapshot. */
export function preflightRecipeContract(
  input: PreflightRecipeContractInput,
): RecipeContractCheck<PreflightRecipeContractValue> {
  const capabilities = validateRecipeCapabilities(input);
  if (!capabilities.ok) return capabilities;

  const bindings = validateRecipeBindings({
    schema: input.bindingSchema,
    bindings: input.bindings,
    lifecycle: input.lifecycle ?? capabilities.value.manifest.lifecycle.default,
    persistBindings: input.persistBindings,
  });
  if (!bindings.ok) return bindings;

  let parsedBindingSchema: RecipeBindingSchemaV1 | undefined;
  if (input.bindingSchema !== undefined) {
    const parsed = recipeBindingSchemaV1Schema.safeParse(input.bindingSchema);
    if (!parsed.success) {
      return recipeContractFailure('recipe_schema_stale', parsed.error.issues[0]?.message ?? 'invalid binding schema', {
        path: firstZodPath(parsed.error),
      });
    }
    parsedBindingSchema = parsed.data;
  }

  const manifest = capabilities.value.manifest;
  const fromRuntime = downgradeReplayClass(input.derivedReplayClass, bindings.value.replayClass);
  const effective = downgradeReplayClass(manifest.replay.class, fromRuntime);
  const lifecycle = input.lifecycle ?? manifest.lifecycle.default;
  if (lifecycle === 'background' && effective === 'non-replayable') {
    return recipeContractFailure(
      'durable_replay_unsafe',
      'effective replay class is non-replayable; background execution is forbidden',
      { path: 'manifest.replay.class' },
    );
  }

  return {
    ok: true,
    value: {
      manifest,
      ...(parsedBindingSchema ? { bindingSchema: parsedBindingSchema } : {}),
      bindings: bindings.value,
      requirements: capabilities.value.requirements,
      replay: {
        asserted: manifest.replay.class,
        derived: fromRuntime,
        effective,
        downgraded: effective !== manifest.replay.class,
      },
      portability: bindings.value.portability === 'invocation-bound' ? 'invocation-bound' : 'topology-bound',
    },
  };
}
