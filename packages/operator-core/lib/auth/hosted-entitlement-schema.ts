/**
 * Persistable schema for organization-scoped hosted entitlements.
 *
 * The schema is deliberately independent of payment processing. A private-beta
 * assignment can be authored by a distinct staff principal today; a future
 * billing projection can author the same records without changing resolution.
 * Every authority-bearing record is versioned or pins a version, has an exact
 * effective interval, and carries an audit receipt.
 */

export const HOSTED_ENTITLEMENT_SCHEMA_VERSION = 1 as const;

export const HOSTED_CLOUD_PROVIDERS = ['gcp', 'aws', 'azure'] as const;
export type HostedCloudProvider = (typeof HOSTED_CLOUD_PROVIDERS)[number];

export const HOSTED_ENTITLEMENT_SOURCES = ['private-beta', 'staff-override', 'billing', 'migration'] as const;
export type HostedEntitlementSource = (typeof HOSTED_ENTITLEMENT_SOURCES)[number];

export type HostedEntitlementActor =
  | { readonly kind: 'staff'; readonly principalId: string }
  | { readonly kind: 'service'; readonly principalId: string };

export interface HostedEntitlementInterval {
  readonly effectiveFrom: Date;
  /** Exclusive. Null means no scheduled end. */
  readonly effectiveUntil: Date | null;
}

export interface HostedEntitlementRecordMetadata extends HostedEntitlementInterval {
  readonly source: HostedEntitlementSource;
  readonly actor: HostedEntitlementActor;
  readonly auditReceiptId: string;
}

export interface HostedEntitlementSet {
  readonly allowedProviders: readonly HostedCloudProvider[];
  readonly limits: {
    readonly workspaces: number;
    readonly members: number;
  };
  readonly browserAccess: {
    readonly pty: boolean;
    readonly files: boolean;
  };
  /** Version-independent identifier; pricing/display labels live elsewhere. */
  readonly supportTier: string;
  /** Named, non-negative counters. Units are part of the stable key contract. */
  readonly quotas: Readonly<Record<string, number>>;
  /** Named, non-negative minor-unit budgets. Currency/unit belongs in the key. */
  readonly budgets: Readonly<Record<string, number>>;
  readonly rolloutFlags: Readonly<Record<string, boolean>>;
}

export interface HostedEntitlementPatch {
  readonly allowedProviders?: readonly HostedCloudProvider[];
  readonly limits?: {
    readonly workspaces?: number;
    readonly members?: number;
  };
  readonly browserAccess?: {
    readonly pty?: boolean;
    readonly files?: boolean;
  };
  readonly supportTier?: string;
  /** Null removes a key inherited from the bundle. */
  readonly quotas?: Readonly<Record<string, number | null>>;
  /** Null removes a key inherited from the bundle. */
  readonly budgets?: Readonly<Record<string, number | null>>;
  /** Null removes a key inherited from the bundle. */
  readonly rolloutFlags?: Readonly<Record<string, boolean | null>>;
}

export interface HostedEntitlementBundle {
  readonly schemaVersion: typeof HOSTED_ENTITLEMENT_SCHEMA_VERSION;
  readonly bundleId: string;
  readonly bundleVersion: number;
  readonly entitlements: HostedEntitlementSet;
  readonly record: HostedEntitlementRecordMetadata;
}

export interface HostedEntitlementAssignment {
  readonly schemaVersion: typeof HOSTED_ENTITLEMENT_SCHEMA_VERSION;
  readonly assignmentId: string;
  readonly organizationId: string;
  readonly bundleId: string;
  /** Exact pin: a newer bundle never silently widens an existing organization. */
  readonly bundleVersion: number;
  readonly record: HostedEntitlementRecordMetadata;
}

export interface HostedEntitlementOverride {
  readonly schemaVersion: typeof HOSTED_ENTITLEMENT_SCHEMA_VERSION;
  readonly overrideId: string;
  readonly overrideVersion: number;
  readonly organizationId: string;
  readonly bundleId: string;
  readonly bundleVersion: number;
  /** Lower values apply first. Two active overrides may not share a precedence. */
  readonly precedence: number;
  readonly patch: HostedEntitlementPatch;
  readonly record: HostedEntitlementRecordMetadata;
}

export interface HostedEntitlementSchemaIssue {
  readonly code: 'invalid_type' | 'invalid_value' | 'unknown_field' | 'missing_field';
  readonly path: string;
  readonly message: string;
}

export type HostedEntitlementSchemaResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: HostedEntitlementSchemaIssue };

class SchemaFailure extends Error {
  constructor(readonly issue: HostedEntitlementSchemaIssue) {
    super(`${issue.path}: ${issue.message}`);
  }
}

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const NAMED_VALUE_KEY_RE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const PROVIDER_SET = new Set<string>(HOSTED_CLOUD_PROVIDERS);
const SOURCE_SET = new Set<string>(HOSTED_ENTITLEMENT_SOURCES);

function failure(code: HostedEntitlementSchemaIssue['code'], path: string, message: string): never {
  throw new SchemaFailure({ code, path, message });
}

function readObject(input: unknown, path: string): UnknownRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    failure('invalid_type', path, 'must be an object');
  }
  return input as UnknownRecord;
}

function exactObject(
  input: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): UnknownRecord {
  const value = readObject(input, path);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) failure('unknown_field', `${path}.${key}`, 'is not allowed');
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      failure('missing_field', `${path}.${key}`, 'is required');
    }
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string') failure('invalid_type', path, 'must be a string');
  const normalized = value.trim();
  if (!IDENTIFIER_RE.test(normalized)) {
    failure('invalid_value', path, 'must be a non-empty stable identifier');
  }
  return normalized;
}

function namedValueKey(value: string, path: string): string {
  if (!NAMED_VALUE_KEY_RE.test(value)) {
    failure('invalid_value', path, 'must be a lowercase stable key');
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') failure('invalid_type', path, 'must be a boolean');
  return value;
}

function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    failure('invalid_value', path, `must be a safe integer >= ${minimum}`);
  }
  return value;
}

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    failure('invalid_value', path, 'must be a finite number >= 0');
  }
  return value;
}

function date(value: unknown, path: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    failure('invalid_value', path, 'must be a valid Date or ISO timestamp');
  }
  return parsed;
}

function interval(input: unknown, path: string): HostedEntitlementInterval {
  const value = exactObject(input, path, ['effectiveFrom', 'effectiveUntil'], ['effectiveFrom', 'effectiveUntil']);
  const effectiveFrom = date(value.effectiveFrom, `${path}.effectiveFrom`);
  const effectiveUntil = value.effectiveUntil === null ? null : date(value.effectiveUntil, `${path}.effectiveUntil`);
  if (effectiveUntil && effectiveUntil.getTime() <= effectiveFrom.getTime()) {
    failure('invalid_value', `${path}.effectiveUntil`, 'must be later than effectiveFrom');
  }
  return { effectiveFrom, effectiveUntil };
}

function actor(input: unknown, path: string): HostedEntitlementActor {
  const value = exactObject(input, path, ['kind', 'principalId'], ['kind', 'principalId']);
  if (value.kind !== 'staff' && value.kind !== 'service') {
    failure('invalid_value', `${path}.kind`, 'must be staff or service');
  }
  return {
    kind: value.kind,
    principalId: identifier(value.principalId, `${path}.principalId`),
  };
}

function recordMetadata(input: unknown, path: string): HostedEntitlementRecordMetadata {
  const value = exactObject(
    input,
    path,
    ['source', 'actor', 'auditReceiptId', 'effectiveFrom', 'effectiveUntil'],
    ['source', 'actor', 'auditReceiptId', 'effectiveFrom', 'effectiveUntil'],
  );
  if (typeof value.source !== 'string' || !SOURCE_SET.has(value.source)) {
    failure('invalid_value', `${path}.source`, 'is not a supported entitlement source');
  }
  const parsedActor = actor(value.actor, `${path}.actor`);
  if ((value.source === 'private-beta' || value.source === 'staff-override') && parsedActor.kind !== 'staff') {
    failure('invalid_value', `${path}.actor.kind`, `${value.source} records require a distinct staff principal`);
  }
  if ((value.source === 'billing' || value.source === 'migration') && parsedActor.kind !== 'service') {
    failure('invalid_value', `${path}.actor.kind`, `${value.source} records require a service principal`);
  }
  const parsedInterval = interval({ effectiveFrom: value.effectiveFrom, effectiveUntil: value.effectiveUntil }, path);
  return {
    source: value.source as HostedEntitlementSource,
    actor: parsedActor,
    auditReceiptId: identifier(value.auditReceiptId, `${path}.auditReceiptId`),
    ...parsedInterval,
  };
}

function providers(input: unknown, path: string): readonly HostedCloudProvider[] {
  if (!Array.isArray(input)) failure('invalid_type', path, 'must be an array');
  const seen = new Set<HostedCloudProvider>();
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (typeof value !== 'string' || !PROVIDER_SET.has(value)) {
      failure('invalid_value', `${path}[${index}]`, 'is not a supported cloud provider');
    }
    if (seen.has(value as HostedCloudProvider)) {
      failure('invalid_value', `${path}[${index}]`, 'duplicates a cloud provider');
    }
    seen.add(value as HostedCloudProvider);
  }
  return [...seen];
}

function numericMap(input: unknown, path: string, nullable: false): Readonly<Record<string, number>>;
function numericMap(input: unknown, path: string, nullable: true): Readonly<Record<string, number | null>>;
function numericMap(input: unknown, path: string, nullable: boolean): Readonly<Record<string, number | null>> {
  const value = readObject(input, path);
  const out: Record<string, number | null> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = namedValueKey(rawKey, `${path}.${rawKey}`);
    if (nullable && rawValue === null) out[key] = null;
    else out[key] = finiteNonNegative(rawValue, `${path}.${rawKey}`);
  }
  return out;
}

function booleanMap(input: unknown, path: string, nullable: false): Readonly<Record<string, boolean>>;
function booleanMap(input: unknown, path: string, nullable: true): Readonly<Record<string, boolean | null>>;
function booleanMap(input: unknown, path: string, nullable: boolean): Readonly<Record<string, boolean | null>> {
  const value = readObject(input, path);
  const out: Record<string, boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = namedValueKey(rawKey, `${path}.${rawKey}`);
    if (nullable && rawValue === null) out[key] = null;
    else out[key] = boolean(rawValue, `${path}.${rawKey}`);
  }
  return out;
}

function entitlementSet(input: unknown, path: string): HostedEntitlementSet {
  const value = exactObject(
    input,
    path,
    ['allowedProviders', 'limits', 'browserAccess', 'supportTier', 'quotas', 'budgets', 'rolloutFlags'],
    ['allowedProviders', 'limits', 'browserAccess', 'supportTier', 'quotas', 'budgets', 'rolloutFlags'],
  );
  const limits = exactObject(value.limits, `${path}.limits`, ['workspaces', 'members'], ['workspaces', 'members']);
  const browserAccess = exactObject(value.browserAccess, `${path}.browserAccess`, ['pty', 'files'], ['pty', 'files']);
  return {
    allowedProviders: providers(value.allowedProviders, `${path}.allowedProviders`),
    limits: {
      workspaces: safeInteger(limits.workspaces, `${path}.limits.workspaces`),
      members: safeInteger(limits.members, `${path}.limits.members`),
    },
    browserAccess: {
      pty: boolean(browserAccess.pty, `${path}.browserAccess.pty`),
      files: boolean(browserAccess.files, `${path}.browserAccess.files`),
    },
    supportTier: identifier(value.supportTier, `${path}.supportTier`),
    quotas: numericMap(value.quotas, `${path}.quotas`, false),
    budgets: numericMap(value.budgets, `${path}.budgets`, false),
    rolloutFlags: booleanMap(value.rolloutFlags, `${path}.rolloutFlags`, false),
  };
}

function entitlementPatch(input: unknown, path: string): HostedEntitlementPatch {
  const allowed = [
    'allowedProviders',
    'limits',
    'browserAccess',
    'supportTier',
    'quotas',
    'budgets',
    'rolloutFlags',
  ] as const;
  const value = exactObject(input, path, allowed, []);
  if (Object.keys(value).length === 0) failure('invalid_value', path, 'must change at least one field');

  const out: {
    allowedProviders?: readonly HostedCloudProvider[];
    limits?: { workspaces?: number; members?: number };
    browserAccess?: { pty?: boolean; files?: boolean };
    supportTier?: string;
    quotas?: Readonly<Record<string, number | null>>;
    budgets?: Readonly<Record<string, number | null>>;
    rolloutFlags?: Readonly<Record<string, boolean | null>>;
  } = {};

  if ('allowedProviders' in value) {
    out.allowedProviders = providers(value.allowedProviders, `${path}.allowedProviders`);
  }
  if ('limits' in value) {
    const limits = exactObject(value.limits, `${path}.limits`, ['workspaces', 'members'], []);
    if (Object.keys(limits).length === 0) failure('invalid_value', `${path}.limits`, 'must not be empty');
    out.limits = {
      ...('workspaces' in limits ? { workspaces: safeInteger(limits.workspaces, `${path}.limits.workspaces`) } : {}),
      ...('members' in limits ? { members: safeInteger(limits.members, `${path}.limits.members`) } : {}),
    };
  }
  if ('browserAccess' in value) {
    const browser = exactObject(value.browserAccess, `${path}.browserAccess`, ['pty', 'files'], []);
    if (Object.keys(browser).length === 0) failure('invalid_value', `${path}.browserAccess`, 'must not be empty');
    out.browserAccess = {
      ...('pty' in browser ? { pty: boolean(browser.pty, `${path}.browserAccess.pty`) } : {}),
      ...('files' in browser ? { files: boolean(browser.files, `${path}.browserAccess.files`) } : {}),
    };
  }
  if ('supportTier' in value) out.supportTier = identifier(value.supportTier, `${path}.supportTier`);
  if ('quotas' in value) out.quotas = numericMap(value.quotas, `${path}.quotas`, true);
  if ('budgets' in value) out.budgets = numericMap(value.budgets, `${path}.budgets`, true);
  if ('rolloutFlags' in value) {
    out.rolloutFlags = booleanMap(value.rolloutFlags, `${path}.rolloutFlags`, true);
  }
  return out;
}

function parse<T>(reader: () => T): HostedEntitlementSchemaResult<T> {
  try {
    return { ok: true, value: reader() };
  } catch (error) {
    if (error instanceof SchemaFailure) return { ok: false, issue: error.issue };
    throw error;
  }
}

export function parseHostedEntitlementBundle(input: unknown): HostedEntitlementSchemaResult<HostedEntitlementBundle> {
  return parse(() => {
    const value = exactObject(
      input,
      '$',
      ['schemaVersion', 'bundleId', 'bundleVersion', 'entitlements', 'record'],
      ['schemaVersion', 'bundleId', 'bundleVersion', 'entitlements', 'record'],
    );
    if (value.schemaVersion !== HOSTED_ENTITLEMENT_SCHEMA_VERSION) {
      failure('invalid_value', '$.schemaVersion', 'is not supported');
    }
    return {
      schemaVersion: HOSTED_ENTITLEMENT_SCHEMA_VERSION,
      bundleId: identifier(value.bundleId, '$.bundleId'),
      bundleVersion: safeInteger(value.bundleVersion, '$.bundleVersion', 1),
      entitlements: entitlementSet(value.entitlements, '$.entitlements'),
      record: recordMetadata(value.record, '$.record'),
    };
  });
}

export function parseHostedEntitlementAssignment(
  input: unknown,
): HostedEntitlementSchemaResult<HostedEntitlementAssignment> {
  return parse(() => {
    const value = exactObject(
      input,
      '$',
      ['schemaVersion', 'assignmentId', 'organizationId', 'bundleId', 'bundleVersion', 'record'],
      ['schemaVersion', 'assignmentId', 'organizationId', 'bundleId', 'bundleVersion', 'record'],
    );
    if (value.schemaVersion !== HOSTED_ENTITLEMENT_SCHEMA_VERSION) {
      failure('invalid_value', '$.schemaVersion', 'is not supported');
    }
    return {
      schemaVersion: HOSTED_ENTITLEMENT_SCHEMA_VERSION,
      assignmentId: identifier(value.assignmentId, '$.assignmentId'),
      organizationId: identifier(value.organizationId, '$.organizationId'),
      bundleId: identifier(value.bundleId, '$.bundleId'),
      bundleVersion: safeInteger(value.bundleVersion, '$.bundleVersion', 1),
      record: recordMetadata(value.record, '$.record'),
    };
  });
}

export function parseHostedEntitlementOverride(
  input: unknown,
): HostedEntitlementSchemaResult<HostedEntitlementOverride> {
  return parse(() => {
    const value = exactObject(
      input,
      '$',
      [
        'schemaVersion',
        'overrideId',
        'overrideVersion',
        'organizationId',
        'bundleId',
        'bundleVersion',
        'precedence',
        'patch',
        'record',
      ],
      [
        'schemaVersion',
        'overrideId',
        'overrideVersion',
        'organizationId',
        'bundleId',
        'bundleVersion',
        'precedence',
        'patch',
        'record',
      ],
    );
    if (value.schemaVersion !== HOSTED_ENTITLEMENT_SCHEMA_VERSION) {
      failure('invalid_value', '$.schemaVersion', 'is not supported');
    }
    return {
      schemaVersion: HOSTED_ENTITLEMENT_SCHEMA_VERSION,
      overrideId: identifier(value.overrideId, '$.overrideId'),
      overrideVersion: safeInteger(value.overrideVersion, '$.overrideVersion', 1),
      organizationId: identifier(value.organizationId, '$.organizationId'),
      bundleId: identifier(value.bundleId, '$.bundleId'),
      bundleVersion: safeInteger(value.bundleVersion, '$.bundleVersion', 1),
      precedence: safeInteger(value.precedence, '$.precedence'),
      patch: entitlementPatch(value.patch, '$.patch'),
      record: recordMetadata(value.record, '$.record'),
    };
  });
}
