/**
 * Pure, payment-independent hosted entitlement resolution.
 *
 * The caller supplies current persisted bundle/assignment/override rows. This
 * module validates every row at the trust boundary, selects exactly one active
 * organization assignment, pins an exact bundle version, and applies active
 * overrides deterministically. Any malformed, missing, expired, or ambiguous
 * authority fails closed with a stable audit reason.
 */

import {
  parseHostedEntitlementAssignment,
  parseHostedEntitlementBundle,
  parseHostedEntitlementOverride,
  type HostedCloudProvider,
  type HostedEntitlementAssignment,
  type HostedEntitlementBundle,
  type HostedEntitlementInterval,
  type HostedEntitlementOverride,
  type HostedEntitlementPatch,
  type HostedEntitlementSchemaIssue,
  type HostedEntitlementSet,
} from './hosted-entitlement-schema';

export const HOSTED_ENTITLEMENT_DENIAL_REASONS = [
  'invalid_organization',
  'invalid_time',
  'invalid_bundle_record',
  'invalid_assignment_record',
  'invalid_override_record',
  'no_active_assignment',
  'ambiguous_active_assignments',
  'bundle_not_found',
  'ambiguous_bundle',
  'bundle_inactive',
  'ambiguous_override_revision',
  'ambiguous_override_precedence',
] as const;

export type HostedEntitlementDenialReason = (typeof HOSTED_ENTITLEMENT_DENIAL_REASONS)[number];

export interface HostedEntitlementResolutionInput {
  readonly organizationId: string;
  readonly at?: Date;
  readonly bundles: readonly unknown[];
  readonly assignments: readonly unknown[];
  readonly overrides?: readonly unknown[];
}

export interface ResolvedHostedEntitlements extends HostedEntitlementSet {
  readonly organizationId: string;
  readonly assignmentId: string;
  readonly bundleId: string;
  readonly bundleVersion: number;
  readonly appliedOverrides: readonly {
    readonly overrideId: string;
    readonly overrideVersion: number;
  }[];
  /** Receipts required to reconstruct why this exact effective value won. */
  readonly auditReceiptIds: readonly string[];
  /** Earliest known time this result must be resolved again. */
  readonly recheckAt: Date | null;
}

export type HostedEntitlementResolution =
  | {
      readonly ok: true;
      readonly value: ResolvedHostedEntitlements;
    }
  | {
      readonly ok: false;
      readonly reason: HostedEntitlementDenialReason;
      readonly organizationId: string | null;
      readonly issue?: HostedEntitlementSchemaIssue;
      readonly recordIndex?: number;
    };

export type HostedEntitlementGate =
  | { readonly kind: 'provider'; readonly provider: HostedCloudProvider }
  | { readonly kind: 'workspace-limit'; readonly current: number; readonly requested?: number }
  | { readonly kind: 'member-limit'; readonly current: number; readonly requested?: number }
  | { readonly kind: 'browser-pty' }
  | { readonly kind: 'browser-files' }
  | { readonly kind: 'quota'; readonly key: string; readonly used: number; readonly requested?: number }
  | { readonly kind: 'budget'; readonly key: string; readonly used: number; readonly requested?: number }
  | { readonly kind: 'rollout-flag'; readonly key: string };

export type HostedEntitlementGateReason =
  | 'entitled'
  | 'provider_not_allowed'
  | 'workspace_limit_exceeded'
  | 'member_limit_exceeded'
  | 'browser_pty_disabled'
  | 'browser_files_disabled'
  | 'quota_missing'
  | 'quota_exceeded'
  | 'budget_missing'
  | 'budget_exceeded'
  | 'rollout_flag_disabled'
  | 'invalid_gate_input';

export interface HostedEntitlementGateDecision {
  readonly allowed: boolean;
  readonly reason: HostedEntitlementGateReason;
  readonly audit: {
    readonly organizationId: string;
    readonly assignmentId: string;
    readonly bundleId: string;
    readonly bundleVersion: number;
    readonly appliedOverrideIds: readonly string[];
    readonly gate: HostedEntitlementGate['kind'];
    readonly key: string | null;
  };
}

function identifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : null;
}

function active(interval: HostedEntitlementInterval, atMs: number): boolean {
  return (
    interval.effectiveFrom.getTime() <= atMs &&
    (interval.effectiveUntil === null || atMs < interval.effectiveUntil.getTime())
  );
}

function parseRows<T>(
  rows: readonly unknown[],
  parse: (
    row: unknown,
  ) => { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issue: HostedEntitlementSchemaIssue },
  reason: HostedEntitlementDenialReason,
  organizationId: string,
): { ok: true; rows: T[] } | Extract<HostedEntitlementResolution, { ok: false }> {
  const parsed: T[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = parse(rows[index]);
    if (!result.ok) {
      return {
        ok: false,
        reason,
        organizationId,
        issue: result.issue,
        recordIndex: index,
      };
    }
    parsed.push(result.value);
  }
  return { ok: true, rows: parsed };
}

function applyNullableMap<T>(
  base: Readonly<Record<string, T>>,
  patch: Readonly<Record<string, T | null>> | undefined,
): Record<string, T> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function applyPatch(base: HostedEntitlementSet, patch: HostedEntitlementPatch): HostedEntitlementSet {
  return {
    allowedProviders: patch.allowedProviders ?? base.allowedProviders,
    limits: {
      workspaces: patch.limits?.workspaces ?? base.limits.workspaces,
      members: patch.limits?.members ?? base.limits.members,
    },
    browserAccess: {
      pty: patch.browserAccess?.pty ?? base.browserAccess.pty,
      files: patch.browserAccess?.files ?? base.browserAccess.files,
    },
    supportTier: patch.supportTier ?? base.supportTier,
    quotas: applyNullableMap(base.quotas, patch.quotas),
    budgets: applyNullableMap(base.budgets, patch.budgets),
    rolloutFlags: applyNullableMap(base.rolloutFlags, patch.rolloutFlags),
  };
}

function earliestBoundary(atMs: number, rows: readonly HostedEntitlementInterval[]): Date | null {
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const start = row.effectiveFrom.getTime();
    const end = row.effectiveUntil?.getTime() ?? Number.POSITIVE_INFINITY;
    if (start > atMs && start < earliest) earliest = start;
    if (end > atMs && end < earliest) earliest = end;
  }
  return Number.isFinite(earliest) ? new Date(earliest) : null;
}

/**
 * Resolve one organization's effective entitlement set at one instant.
 *
 * Records for other organizations and other bundle pins are inert history.
 * Malformed supplied records are never inert: they make the entire read fail
 * closed because a caller cannot prove the malformed row is non-authoritative.
 */
export function resolveHostedEntitlements(input: HostedEntitlementResolutionInput): HostedEntitlementResolution {
  const organizationId = identifier(input.organizationId);
  if (!organizationId) {
    return { ok: false, reason: 'invalid_organization', organizationId: null };
  }
  const at = input.at ?? new Date();
  const atMs = at instanceof Date ? at.getTime() : Number.NaN;
  if (!Number.isFinite(atMs)) {
    return { ok: false, reason: 'invalid_time', organizationId };
  }

  const bundles = parseRows(input.bundles, parseHostedEntitlementBundle, 'invalid_bundle_record', organizationId);
  if (!bundles.ok) return bundles;
  const assignments = parseRows(
    input.assignments,
    parseHostedEntitlementAssignment,
    'invalid_assignment_record',
    organizationId,
  );
  if (!assignments.ok) return assignments;
  const overrides = parseRows(
    input.overrides ?? [],
    parseHostedEntitlementOverride,
    'invalid_override_record',
    organizationId,
  );
  if (!overrides.ok) return overrides;

  const activeAssignments = assignments.rows.filter(
    (assignment) => assignment.organizationId === organizationId && active(assignment.record, atMs),
  );
  if (activeAssignments.length === 0) {
    return { ok: false, reason: 'no_active_assignment', organizationId };
  }
  if (activeAssignments.length !== 1) {
    return { ok: false, reason: 'ambiguous_active_assignments', organizationId };
  }
  const assignment = activeAssignments[0];

  const matchingBundles = bundles.rows.filter(
    (bundle) => bundle.bundleId === assignment.bundleId && bundle.bundleVersion === assignment.bundleVersion,
  );
  if (matchingBundles.length === 0) {
    return { ok: false, reason: 'bundle_not_found', organizationId };
  }
  if (matchingBundles.length !== 1) {
    return { ok: false, reason: 'ambiguous_bundle', organizationId };
  }
  const bundle = matchingBundles[0];
  if (!active(bundle.record, atMs)) {
    return { ok: false, reason: 'bundle_inactive', organizationId };
  }

  const matchingOverrides = overrides.rows.filter(
    (override) =>
      override.organizationId === organizationId &&
      override.bundleId === bundle.bundleId &&
      override.bundleVersion === bundle.bundleVersion,
  );
  const activeOverrideRows = matchingOverrides.filter((override) => active(override.record, atMs));

  const latestById = new Map<string, HostedEntitlementOverride>();
  for (const override of activeOverrideRows) {
    const current = latestById.get(override.overrideId);
    if (!current || override.overrideVersion > current.overrideVersion) {
      latestById.set(override.overrideId, override);
      continue;
    }
    if (override.overrideVersion === current.overrideVersion) {
      return { ok: false, reason: 'ambiguous_override_revision', organizationId };
    }
  }

  const selectedOverrides = [...latestById.values()].sort((left, right) => left.precedence - right.precedence);
  for (let index = 1; index < selectedOverrides.length; index += 1) {
    if (selectedOverrides[index - 1].precedence === selectedOverrides[index].precedence) {
      return { ok: false, reason: 'ambiguous_override_precedence', organizationId };
    }
  }

  let entitlements: HostedEntitlementSet = bundle.entitlements;
  for (const override of selectedOverrides) {
    entitlements = applyPatch(entitlements, override.patch);
  }

  return {
    ok: true,
    value: {
      organizationId,
      assignmentId: assignment.assignmentId,
      bundleId: bundle.bundleId,
      bundleVersion: bundle.bundleVersion,
      ...entitlements,
      appliedOverrides: selectedOverrides.map((override) => ({
        overrideId: override.overrideId,
        overrideVersion: override.overrideVersion,
      })),
      auditReceiptIds: [
        bundle.record.auditReceiptId,
        assignment.record.auditReceiptId,
        ...selectedOverrides.map((override) => override.record.auditReceiptId),
      ],
      recheckAt: earliestBoundary(atMs, [
        bundle.record,
        assignment.record,
        ...matchingOverrides.map((override) => override.record),
      ]),
    },
  };
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function countRequest(gate: { readonly current: number; readonly requested?: number }): number | null {
  const requested = gate.requested ?? 1;
  if (!Number.isSafeInteger(gate.current) || gate.current < 0) return null;
  if (!Number.isSafeInteger(requested) || requested < 0) return null;
  return gate.current + requested;
}

function gateKey(gate: HostedEntitlementGate): string | null {
  switch (gate.kind) {
    case 'provider':
      return gate.provider;
    case 'quota':
    case 'budget':
    case 'rollout-flag':
      return gate.key;
    default:
      return null;
  }
}

/** Check one gated action against an already-resolved, current entitlement set. */
export function checkHostedEntitlement(
  entitlements: ResolvedHostedEntitlements,
  gate: HostedEntitlementGate,
): HostedEntitlementGateDecision {
  let allowed = false;
  let reason: HostedEntitlementGateReason = 'invalid_gate_input';

  switch (gate.kind) {
    case 'provider':
      allowed = entitlements.allowedProviders.includes(gate.provider);
      reason = allowed ? 'entitled' : 'provider_not_allowed';
      break;
    case 'workspace-limit': {
      const next = countRequest(gate);
      allowed = next !== null && next <= entitlements.limits.workspaces;
      reason = next === null ? 'invalid_gate_input' : allowed ? 'entitled' : 'workspace_limit_exceeded';
      break;
    }
    case 'member-limit': {
      const next = countRequest(gate);
      allowed = next !== null && next <= entitlements.limits.members;
      reason = next === null ? 'invalid_gate_input' : allowed ? 'entitled' : 'member_limit_exceeded';
      break;
    }
    case 'browser-pty':
      allowed = entitlements.browserAccess.pty;
      reason = allowed ? 'entitled' : 'browser_pty_disabled';
      break;
    case 'browser-files':
      allowed = entitlements.browserAccess.files;
      reason = allowed ? 'entitled' : 'browser_files_disabled';
      break;
    case 'quota': {
      const ceiling = entitlements.quotas[gate.key];
      if (ceiling === undefined) reason = 'quota_missing';
      else if (!nonNegative(gate.used) || !nonNegative(gate.requested ?? 0)) reason = 'invalid_gate_input';
      else {
        allowed = gate.used + (gate.requested ?? 0) <= ceiling;
        reason = allowed ? 'entitled' : 'quota_exceeded';
      }
      break;
    }
    case 'budget': {
      const ceiling = entitlements.budgets[gate.key];
      if (ceiling === undefined) reason = 'budget_missing';
      else if (!nonNegative(gate.used) || !nonNegative(gate.requested ?? 0)) reason = 'invalid_gate_input';
      else {
        allowed = gate.used + (gate.requested ?? 0) <= ceiling;
        reason = allowed ? 'entitled' : 'budget_exceeded';
      }
      break;
    }
    case 'rollout-flag':
      allowed = entitlements.rolloutFlags[gate.key] === true;
      reason = allowed ? 'entitled' : 'rollout_flag_disabled';
      break;
  }

  return {
    allowed,
    reason,
    audit: {
      organizationId: entitlements.organizationId,
      assignmentId: entitlements.assignmentId,
      bundleId: entitlements.bundleId,
      bundleVersion: entitlements.bundleVersion,
      appliedOverrideIds: entitlements.appliedOverrides.map((override) => override.overrideId),
      gate: gate.kind,
      key: gateKey(gate),
    },
  };
}
