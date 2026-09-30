/**
 * Canonical saved fleet launch-spec recovery (agent-launch-unification P-043).
 *
 * `fleet:headcount-target` is the existing durable writer for a homogeneous
 * fleet's launch recipe. Recovery callers must read that row before composing a
 * command, preserve every omitted field, and fail closed when an unaudited
 * request disagrees with it. This module is the one read/merge/diagnostic seam;
 * launch-on-plan, launch-agent resume, and respawn-member integrate it in P-044.
 */
import {
  accountFromArgv,
  composeLaunchModelSpec,
  flagValueFromArgv,
  modelSpecFromArgv,
  splitModelSpec,
} from '../../agent-config-constants';
import {
  getFleetHeadcountTarget,
  type FleetHeadcountConfig,
  type FleetHeadcountTarget,
} from '../../agent-fleets-store';
import type { MemberSpec } from '../../agent-launch-core';
import { readAdvSessionLaunchRecordByOwner, type AdvSessionLaunchRecord } from '../../adv-sessions';
import { parseSuLaunchSpecRecord } from '../../su-persona-render';
import { normalizeSuContextSize } from '../../su-context-size.mjs';

export const SAVED_FLEET_LAUNCH_SPEC_SOURCE = 'fleet:headcount-target' as const;
export const LEGACY_FLEET_LAUNCH_SPEC_SOURCE = 'adv_sessions.launch_spec' as const;
export type SavedFleetLaunchSpecSource =
  | typeof SAVED_FLEET_LAUNCH_SPEC_SOURCE
  | typeof LEGACY_FLEET_LAUNCH_SPEC_SOURCE;

/**
 * Canonical headcount rows require a plan, while a legacy member may have
 * been launched through the planless capability:launch-agent door. Keep that
 * distinction local to recovery rather than weakening FleetHeadcountConfig.
 */
export type SavedFleetLaunchConfig = Omit<FleetHeadcountConfig, 'plan'> & { plan?: string };

export type SavedFleetLaunchField =
  | 'plan'
  | 'harness'
  | 'agent'
  | 'model'
  | 'account'
  | 'headless'
  | 'carry'
  | 'role'
  | 'brief'
  | 'launchContext'
  | 'contextSize'
  | 'compactionLimit'
  | 'extraArgs';

export interface SavedFleetLaunchSpecRequest {
  plan?: string;
  harness?: string;
  agent?: string;
  model?: string;
  effort?: string;
  account?: string;
  headless?: boolean;
  carry?: 'warm' | 'cold';
  role?: string;
  brief?: string;
  launchContext?: string;
  contextSize?: 'trimmed' | 'steward';
  compactionLimit?: number;
  extraArgs?: readonly string[];
  /** A homogeneous saved profile cannot be silently reconstructed per member. */
  members?: readonly unknown[];
  perMemberLaunchContext?: readonly string[];
  /** Claim scope is persisted by the fleet claim-spec store, not this recipe. */
  claimKinds?: readonly string[];
  /** These MemberSpec fields are intentionally absent from FleetHeadcountConfig. */
  addDir?: readonly string[];
  allowSubagents?: boolean;
  brain?: boolean;
  feature?: string;
  profile?: string;
  display?: string;
}

export interface SavedFleetLaunchSpec {
  /** Optional only for legacy planless recovery; canonical targets always set it. */
  plan?: string;
  harness: string;
  member: MemberSpec;
}

/**
 * Normalize the one legacy value that can appear in a persisted launch profile
 * but is not a psu persona. Fleet membership stores `member` as its role label;
 * launch profiles store a psu `role`, where omission means the standard su
 * collaborator. Keep this intentionally narrow so real persona names continue
 * to round-trip unchanged.
 */
export function normalizePersistedFleetLaunchRole(role: unknown): string | undefined {
  const trimmed = typeof role === 'string' ? role.trim() : undefined;
  return trimmed && trimmed !== 'member' ? trimmed : undefined;
}

/** Return a copy of a saved config with the legacy membership label removed. */
export function normalizePersistedFleetLaunchConfig<T extends SavedFleetLaunchConfig>(
  config: T,
): T {
  const role = normalizePersistedFleetLaunchRole(config.role);
  if (role === config.role) return config;

  const normalized = { ...config } as T;
  if (role === undefined) delete normalized.role;
  else normalized.role = role;
  return normalized;
}

/** Return a copy of a command-neutral spec with the legacy membership label removed. */
export function normalizePersistedFleetLaunchSpec(
  spec: SavedFleetLaunchSpec,
): SavedFleetLaunchSpec {
  const role = normalizePersistedFleetLaunchRole(spec.member.role);
  if (role === spec.member.role) return spec;

  const member = { ...spec.member };
  if (role === undefined) delete member.role;
  else member.role = role;
  return { ...spec, member };
}

export interface SavedFleetLaunchSpecProvenance {
  source: SavedFleetLaunchSpecSource;
  workspaceId: string;
  fleetSlug: string;
  target: number | null;
}

export interface SavedFleetLaunchSpecDelta {
  field: string;
  saved: unknown;
  requested: unknown;
  provenance: SavedFleetLaunchSpecProvenance;
  reusePath: string;
}

export type SavedFleetLaunchSpecResolution =
  | {
      ok: true;
      found: false;
      provenance: SavedFleetLaunchSpecProvenance;
      reusePath: string;
    }
  | {
      ok: true;
      found: true;
      target: number;
      config: SavedFleetLaunchConfig;
      saved: SavedFleetLaunchSpec;
      effective: SavedFleetLaunchSpec;
      preservedFields: SavedFleetLaunchField[];
      overrides: SavedFleetLaunchSpecDelta[];
      deprecations: string[];
      provenance: SavedFleetLaunchSpecProvenance;
      reusePath: string;
    }
  | {
      ok: false;
      found: boolean;
      error:
        | 'saved_launch_spec_read_failed'
        | 'saved_launch_spec_missing'
        | 'saved_launch_spec_invalid'
        | 'saved_launch_spec_conflict';
      message: string;
      conflicts: SavedFleetLaunchSpecDelta[];
      provenance: SavedFleetLaunchSpecProvenance;
      reusePath: string;
    };

const SAVED_FIELD_ORDER: readonly SavedFleetLaunchField[] = [
  'plan',
  'harness',
  'agent',
  'model',
  'account',
  'headless',
  'carry',
  'role',
  'brief',
  'launchContext',
  'contextSize',
  'compactionLimit',
  'extraArgs',
];

function provenanceFor(
  workspaceId: string,
  fleetSlug: string,
  target: number | null,
  source: SavedFleetLaunchSpecSource = SAVED_FLEET_LAUNCH_SPEC_SOURCE,
): SavedFleetLaunchSpecProvenance {
  return { source, workspaceId, fleetSlug, target };
}

/** Convert the validated headcount recipe to the command-neutral member spec. */
export function savedFleetLaunchSpecFromConfig(config: SavedFleetLaunchConfig): SavedFleetLaunchSpec {
  const normalizedConfig = normalizePersistedFleetLaunchConfig(config);
  const normalizedContextSize = normalizeSuContextSize((normalizedConfig as { contextSize?: unknown }).contextSize);
  if (!normalizedContextSize.ok) throw new Error(normalizedContextSize.error);
  return {
    ...(normalizedConfig.plan !== undefined ? { plan: normalizedConfig.plan } : {}),
    harness: normalizedConfig.harness,
    member: {
      agent: normalizedConfig.agent,
      ...(normalizedConfig.model !== undefined ? { model: normalizedConfig.model } : {}),
      ...(normalizedConfig.effort !== undefined ? { effort: normalizedConfig.effort } : {}),
      ...(normalizedConfig.account !== undefined ? { account: normalizedConfig.account } : {}),
      headless: normalizedConfig.headless ?? true,
      ...(normalizedConfig.carry !== undefined ? { carry: normalizedConfig.carry } : {}),
      ...(normalizedConfig.role !== undefined ? { role: normalizedConfig.role } : {}),
      ...(normalizedConfig.brief !== undefined ? { brief: normalizedConfig.brief } : {}),
      ...(normalizedConfig.launchContext !== undefined ? { launchContext: normalizedConfig.launchContext } : {}),
      ...(normalizedConfig.contextSize !== undefined ? { contextSize: normalizedContextSize.contextSize } : {}),
      ...(normalizedConfig.compactionLimit !== undefined ? { compactionLimit: normalizedConfig.compactionLimit } : {}),
      ...(normalizedConfig.extraArgs !== undefined ? { extraArgs: [...normalizedConfig.extraArgs] } : {}),
    },
  };
}

export type LegacyLaunchParseResult =
  | { ok: true; config: SavedFleetLaunchConfig; saved: SavedFleetLaunchSpec; normalizedLegacyContextSize: boolean }
  | { ok: false; message: string };

/** Trusted values a recovery caller may supply only to fill absent legacy fields. */
export interface LegacyLaunchSpecFallbacks {
  /** Explicit respawn agent override, used when both legacy sources omit the agent. */
  agent?: string;
  /** Target-member pot/harness context or a concrete caller harness. */
  harness?: string;
}

const LEGACY_AGENTS = new Set<FleetHeadcountConfig['agent']>(['claude', 'omp', 'codex']);
const LEGACY_CARRY = new Set<NonNullable<FleetHeadcountConfig['carry']>>(['warm', 'cold']);

function argFlag(argv: readonly string[], flag: string): string | null {
  return flagValueFromArgv(argv, flag);
}

function booleanFlag(argv: readonly string[], flag: string): boolean {
  const bare = `--${flag}`;
  return argv.some((item) => item === bare || new RegExp(`(?:^|\\s)${bare}(?:\\s|$)`).test(item));
}

function matchingValue(
  label: string,
  stored: string | null,
  recorded: string | null,
): { value: string | null; error?: string } {
  if (stored && recorded && stored !== recorded) {
    return { value: null, error: `${label} differs between launch_spec (${stored}) and launch_argv (${recorded})` };
  }
  return { value: stored ?? recorded };
}

/**
 * Convert one legacy adv_sessions record into the same command-neutral recipe
 * used by the canonical fleet target. This is deliberately strict: a legacy
 * row is useful only when its owner, workspace, fleet membership, and recorded
 * argv all attest to the same launch. Missing data stays an error rather than
 * becoming a fresh launch with guessed defaults. The only exceptions are
 * explicit, trusted recovery fallbacks for fields older records never stored.
 */
export function savedFleetLaunchSpecFromLegacyRecord(
  record: AdvSessionLaunchRecord,
  workspaceId: string,
  fleetSlug: string,
  fallbacks: LegacyLaunchSpecFallbacks = {},
): LegacyLaunchParseResult {
  if (!record || record.workspaceId !== workspaceId) {
    return {
      ok: false,
      message: `Legacy adv_sessions launch record workspace does not match requested workspace \`${workspaceId}\`.`,
    };
  }
  const rawLaunchSpec =
    record.launchSpec && typeof record.launchSpec === 'object' && !Array.isArray(record.launchSpec)
      ? record.launchSpec as Record<string, unknown>
      : null;
  if (!rawLaunchSpec) return { ok: false, message: 'Legacy adv_sessions launch_spec is missing or malformed.' };
  if (!Array.isArray(record.launchArgv) || !record.launchArgv.every((item) => typeof item === 'string')) {
    return { ok: false, message: 'Legacy adv_sessions launch_argv is missing or malformed.' };
  }
  const argv = record.launchArgv as string[];
  const recordedFleet = argFlag(argv, 'fleet')?.trim() || null;
  const rawFleet =
    rawLaunchSpec.fleet && typeof rawLaunchSpec.fleet === 'object' && !Array.isArray(rawLaunchSpec.fleet)
      ? rawLaunchSpec.fleet as Record<string, unknown>
      : null;
  const storedFleet = typeof rawFleet?.slug === 'string' && rawFleet.slug.trim()
    ? rawFleet.slug.trim()
    : null;
  if (!recordedFleet || !storedFleet) {
    return { ok: false, message: 'Legacy launch record fleet is missing from launch_spec or launch_argv.' };
  }
  // The member target has already established the live fleet. A legacy member
  // can legitimately have been moved/rejoined since its launch record was
  // written, so compare the two persisted source attestations with each other
  // rather than rejecting a stale source fleet against the live target. The
  // caller supplies `fleetSlug` to the replacement launch separately.
  if (storedFleet !== recordedFleet) {
    return {
      ok: false,
      message: `fleet differs between launch_spec (${storedFleet}) and launch_argv (${recordedFleet})`,
    };
  }

  // Older launch_spec/argv rows can omit agent even though adv_sessions.agent
  // recorded the backend at launch. Reuse that persisted column before an
  // explicit recovery fallback; never guess a system/default agent.
  const recordedAgent = argFlag(argv, 'agent');
  const storedAgent = typeof rawLaunchSpec.agent === 'string' && rawLaunchSpec.agent.trim()
    ? rawLaunchSpec.agent
    : null;
  const persistedAgent = typeof record.agent === 'string' && record.agent.trim()
    ? record.agent
    : null;
  const storedVsArgvAgent = matchingValue('agent', storedAgent, recordedAgent);
  if (storedVsArgvAgent.error) return { ok: false, message: storedVsArgvAgent.error };
  if (storedVsArgvAgent.value && persistedAgent && storedVsArgvAgent.value !== persistedAgent) {
    return {
      ok: false,
      message: `agent differs between legacy launch record (${storedVsArgvAgent.value}) and adv_sessions.agent (${persistedAgent})`,
    };
  }
  const effectiveAgent = storedVsArgvAgent.value ?? persistedAgent ?? fallbacks.agent ?? null;
  const launch = parseSuLaunchSpecRecord({
    ...rawLaunchSpec,
    ...(effectiveAgent ? { agent: effectiveAgent } : {}),
  });
  if (!launch) return { ok: false, message: 'Legacy adv_sessions launch_spec is missing or malformed.' };
  if (launch.workspaceId !== workspaceId) {
    return { ok: false, message: `Legacy launch_spec workspace \`${launch.workspaceId}\` does not match \`${workspaceId}\`.` };
  }
  if (launch.fleet?.slug !== storedFleet) {
    return { ok: false, message: `Legacy launch_spec fleet does not match its recorded fleet \`${storedFleet}\`.` };
  }

  const plan = matchingValue('plan', launch.planSlug, argFlag(argv, 'plan'));
  const harness = matchingValue('harness', launch.harnessSlug, argFlag(argv, 'harness'));
  if (plan.error || harness.error) {
    return { ok: false, message: plan.error ?? harness.error! };
  }
  const fallbackHarness = fallbacks.harness?.trim() || null;
  const effectiveHarness = harness.value ?? fallbackHarness;
  if (!effectiveHarness || !effectiveAgent || !LEGACY_AGENTS.has(effectiveAgent as FleetHeadcountConfig['agent'])) {
    return { ok: false, message: 'Legacy launch record lacks a valid harness or agent.' };
  }

  const recordedModel = modelSpecFromArgv(argv);
  const storedModel = launch.model;
  if (storedModel && recordedModel) {
    const stored = splitModelSpec(storedModel);
    const recorded = splitModelSpec(recordedModel);
    if (stored.model !== recorded.model || (stored.effort && recorded.effort && stored.effort !== recorded.effort)) {
      return { ok: false, message: `model differs between launch_spec (${storedModel}) and launch_argv (${recordedModel})` };
    }
  }
  const modelSpec = recordedModel ?? storedModel;
  const model = splitModelSpec(modelSpec);

  const account = accountFromArgv(argv);
  const carryRaw = argFlag(argv, 'carry');
  if (carryRaw && !LEGACY_CARRY.has(carryRaw as NonNullable<FleetHeadcountConfig['carry']>)) {
    return { ok: false, message: `Legacy launch_argv has invalid carry \`${carryRaw}\`.` };
  }
  const contextSizeRaw = argFlag(argv, 'context-size');
  const normalizedContextSize = normalizeSuContextSize(contextSizeRaw);
  if (!normalizedContextSize.ok) return { ok: false, message: `Legacy launch_argv has invalid context size \`${contextSizeRaw}\`.` };
  const compactionRaw = argFlag(argv, 'compaction-limit');
  let compactionLimit: number | undefined;
  if (compactionRaw != null) {
    const parsedCompactionLimit = Number(compactionRaw);
    if (!Number.isSafeInteger(parsedCompactionLimit) || parsedCompactionLimit <= 0) {
      return { ok: false, message: `Legacy launch_argv has invalid compaction limit \`${compactionRaw}\`.` };
    }
    compactionLimit = parsedCompactionLimit;
  }

  // These flags are not first-class FleetHeadcountConfig fields, but they are
  // safe, supported psu passthroughs and must not silently disappear on a
  // respawn. Preserve token-shaped records; shell-command records are handled
  // by the dedicated first-class parsers above.
  const extraArgs = argv.filter((item) =>
    item === '--brain' || item === '--allow-subagents' || item === '--no-subagents' ||
    item.startsWith('--feature=') || item.startsWith('--profile=') || item.startsWith('--add-dir='),
  );
  const config = normalizePersistedFleetLaunchConfig({
    ...(plan.value ? { plan: plan.value } : {}),
    harness: effectiveHarness,
    agent: effectiveAgent as FleetHeadcountConfig['agent'],
    ...(model.model ? { model: model.model } : {}),
    ...(model.effort ? { effort: model.effort } : {}),
    ...(account ? { account } : {}),
    headless: booleanFlag(argv, 'headless'),
    ...(carryRaw ? { carry: carryRaw as FleetHeadcountConfig['carry'] } : {}),
    ...(argFlag(argv, 'role') ? { role: argFlag(argv, 'role')! } : {}),
    ...(argFlag(argv, 'launch-context') ? { launchContext: argFlag(argv, 'launch-context')! } : {}),
    ...(contextSizeRaw ? { contextSize: normalizedContextSize.contextSize } : {}),
    ...(compactionLimit !== undefined ? { compactionLimit } : {}),
    ...(extraArgs.length ? { extraArgs } : {}),
  });
  return {
    ok: true,
    config,
    saved: savedFleetLaunchSpecFromConfig(config),
    normalizedLegacyContextSize: normalizedContextSize.normalizedLegacyFull,
  };
}

function cloneSpec(spec: SavedFleetLaunchSpec): SavedFleetLaunchSpec {
  return {
    plan: spec.plan,
    harness: spec.harness,
    member: {
      ...spec.member,
      ...(spec.member.extraArgs ? { extraArgs: [...spec.member.extraArgs] } : {}),
    },
  };
}

function requestedFieldPresent(requested: SavedFleetLaunchSpecRequest, field: SavedFleetLaunchField): boolean {
  if (field === 'model') return requested.model !== undefined || requested.effort !== undefined;
  return requested[field] !== undefined;
}

function canonicalModel(spec: SavedFleetLaunchSpec): string | undefined {
  return composeLaunchModelSpec(spec.member.model, spec.member.effort);
}

function fieldValue(spec: SavedFleetLaunchSpec, field: SavedFleetLaunchField): unknown {
  if (field === 'plan' || field === 'harness') return spec[field];
  if (field === 'model') return canonicalModel(spec);
  return spec.member[field as keyof MemberSpec];
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyRequest(saved: SavedFleetLaunchSpec, requested: SavedFleetLaunchSpecRequest): SavedFleetLaunchSpec {
  const effective = cloneSpec(saved);
  if (requested.plan !== undefined) effective.plan = requested.plan;
  if (requested.harness !== undefined) effective.harness = requested.harness;

  if (requested.model !== undefined) {
    const split = splitModelSpec(requested.model);
    if (split.model === null) delete effective.member.model;
    else effective.member.model = split.model;
    // A suffixed model explicitly carries effort. A bare model preserves the
    // saved effort because omission is fallthrough, never an implicit reset.
    if (split.effort !== null) effective.member.effort = split.effort;
  }
  if (requested.effort !== undefined) effective.member.effort = requested.effort;

  const directFields: readonly Exclude<SavedFleetLaunchField, 'plan' | 'harness' | 'model'>[] = [
    'agent',
    'account',
    'headless',
    'carry',
    'role',
    'brief',
    'launchContext',
    'contextSize',
    'compactionLimit',
    'extraArgs',
  ];
  for (const field of directFields) {
    const value = requested[field];
    if (value === undefined) continue;
    (effective.member as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
  }
  return effective;
}

function diagnostic(
  field: string,
  saved: unknown,
  requested: unknown,
  provenance: SavedFleetLaunchSpecProvenance,
  reusePath: string,
): SavedFleetLaunchSpecDelta {
  return { field, saved, requested, provenance, reusePath };
}

function reconstructionConflicts(
  requested: SavedFleetLaunchSpecRequest,
  provenance: SavedFleetLaunchSpecProvenance,
  reusePath: string,
): SavedFleetLaunchSpecDelta[] {
  const conflicts: SavedFleetLaunchSpecDelta[] = [];
  if (requested.members?.length) {
    conflicts.push(
      diagnostic(
        'members',
        'fleet-wide persisted profile',
        `${requested.members.length} member override(s)`,
        provenance,
        reusePath,
      ),
    );
  }
  if (requested.perMemberLaunchContext?.length) {
    conflicts.push(
      diagnostic(
        'perMemberLaunchContext',
        'fleet-wide persisted launchContext',
        `${requested.perMemberLaunchContext.length} per-member launch context override(s)`,
        provenance,
        reusePath,
      ),
    );
  }
  if (requested.claimKinds?.length) {
    conflicts.push(
      diagnostic(
        'claimKinds',
        'fleet claim spec (preserved separately)',
        [...requested.claimKinds],
        provenance,
        reusePath,
      ),
    );
  }
  for (const field of ['addDir', 'allowSubagents', 'brain', 'feature', 'profile', 'display'] as const) {
    const value = requested[field];
    if (value === undefined) continue;
    conflicts.push(diagnostic(field, 'not present in canonical fleet launch spec', value, provenance, reusePath));
  }
  return conflicts;
}

/**
 * Merge an already-read target with a request. Only fields named in
 * `allowDeltas` may differ; every other difference is a fail-closed conflict.
 */
export function resolveLoadedSavedFleetLaunchSpec(opts: {
  target: FleetHeadcountTarget | null;
  saved?: SavedFleetLaunchSpec | null;
  config?: SavedFleetLaunchConfig | null;
  source?: SavedFleetLaunchSpecSource;
  syntheticTarget?: number;
  workspaceId: string;
  fleetSlug: string;
  requested?: SavedFleetLaunchSpecRequest;
  allowDeltas?: readonly SavedFleetLaunchField[];
  reusePath: string;
  requireSaved?: boolean;
  normalizedLegacyContextSize?: boolean;
}): SavedFleetLaunchSpecResolution {
  const { target, workspaceId, fleetSlug, reusePath } = opts;
  const provenance = provenanceFor(workspaceId, fleetSlug, target?.target ?? null, opts.source);
  if (!target && !opts.saved) {
    if (opts.requireSaved) {
      return {
        ok: false,
        found: false,
        error: 'saved_launch_spec_missing',
        message: `No saved launch spec exists for fleet \`${fleetSlug}\`; refusing recovery through ${reusePath}.`,
        conflicts: [],
        provenance,
        reusePath,
      };
    }
    return { ok: true, found: false, provenance, reusePath };
  }

  const requested = opts.requested ?? {};
  const rawConfig = target?.config ?? opts.config;
  if (!rawConfig) {
    return {
      ok: false,
      found: true,
      error: 'saved_launch_spec_invalid',
      message: `Saved launch spec for fleet \`${fleetSlug}\` has no reconstructible config; refusing recovery through ${reusePath}.`,
      conflicts: [],
      provenance,
      reusePath,
    };
  }
  const config = normalizePersistedFleetLaunchConfig(rawConfig);
  const saved = normalizePersistedFleetLaunchSpec(
    opts.saved ?? savedFleetLaunchSpecFromConfig(config),
  );
  let effective: SavedFleetLaunchSpec;
  try {
    // Validate both the stored model/effort pair and the requested merge before
    // comparing. An invalid persisted recipe is not an invitation to default.
    canonicalModel(saved);
    effective = applyRequest(saved, requested);
    canonicalModel(effective);
  } catch (error) {
    return {
      ok: false,
      found: true,
      error: 'saved_launch_spec_invalid',
      message: `Invalid ${provenance.source} launch spec for fleet \`${fleetSlug}\`: ${error instanceof Error ? error.message : String(error)}. Refusing recovery through ${reusePath}.`,
      conflicts: [],
      provenance,
      reusePath,
    };
  }

  const allowed = new Set(opts.allowDeltas ?? []);
  const overrides: SavedFleetLaunchSpecDelta[] = [];
  const conflicts = reconstructionConflicts(requested, provenance, reusePath);
  const preservedFields: SavedFleetLaunchField[] = [];
  for (const field of SAVED_FIELD_ORDER) {
    if (!requestedFieldPresent(requested, field)) {
      if (fieldValue(saved, field) !== undefined) preservedFields.push(field);
      continue;
    }
    const savedValue = fieldValue(saved, field);
    const requestedValue = fieldValue(effective, field);
    if (valuesEqual(savedValue, requestedValue)) continue;
    const row = diagnostic(field, savedValue, requestedValue, provenance, reusePath);
    if (allowed.has(field)) overrides.push(row);
    else conflicts.push(row);
  }

  if (conflicts.length) {
    return {
      ok: false,
      found: true,
      error: 'saved_launch_spec_conflict',
      message: `Saved launch spec conflict for fleet \`${fleetSlug}\` through ${reusePath}: ${JSON.stringify(conflicts)}.`,
      conflicts,
      provenance,
      reusePath,
    };
  }
  return {
    ok: true,
    found: true,
    target: target?.target ?? opts.syntheticTarget ?? 1,
    config,
    saved,
    effective,
    preservedFields,
    overrides,
    deprecations:
      target?.normalizedLegacyContextSize || opts.normalizedLegacyContextSize
        ? ['Saved contextSize=full is deprecated and was normalized to trimmed before launch.']
        : [],
    provenance,
    reusePath,
  };
}

/** Read the canonical row and apply the same pure fail-closed merge. */
export async function resolveSavedFleetLaunchSpec(opts: {
  workspaceId: string;
  fleetSlug: string;
  requested?: SavedFleetLaunchSpecRequest;
  allowDeltas?: readonly SavedFleetLaunchField[];
  reusePath: string;
  requireSaved?: boolean;
  readTarget?: typeof getFleetHeadcountTarget;
  memberOwnerId?: string;
  readLegacy?: typeof readAdvSessionLaunchRecordByOwner;
  legacyFallbacks?: LegacyLaunchSpecFallbacks;
}): Promise<SavedFleetLaunchSpecResolution> {
  const readTarget = opts.readTarget ?? getFleetHeadcountTarget;
  let target: FleetHeadcountTarget | null;
  try {
    target = await readTarget(opts.workspaceId, opts.fleetSlug);
  } catch (error) {
    const provenance = provenanceFor(opts.workspaceId, opts.fleetSlug, null);
    return {
      ok: false,
      found: false,
      error: 'saved_launch_spec_read_failed',
      message: `Could not read the canonical saved launch spec for fleet \`${opts.fleetSlug}\`: ${error instanceof Error ? error.message : String(error)}. Refusing reconstruction through ${opts.reusePath}.`,
      conflicts: [],
      provenance,
      reusePath: opts.reusePath,
    };
  }
  if (!target && opts.memberOwnerId) {
    let legacy: AdvSessionLaunchRecord | null;
    try {
      legacy = await (opts.readLegacy ?? readAdvSessionLaunchRecordByOwner)(opts.memberOwnerId, opts.workspaceId);
    } catch (error) {
      const provenance = provenanceFor(opts.workspaceId, opts.fleetSlug, null, LEGACY_FLEET_LAUNCH_SPEC_SOURCE);
      return {
        ok: false,
        found: false,
        error: 'saved_launch_spec_read_failed',
        message: `Could not read the legacy saved launch spec for fleet \`${opts.fleetSlug}\`: ${error instanceof Error ? error.message : String(error)}. Refusing reconstruction through ${opts.reusePath}.`,
        conflicts: [],
        provenance,
        reusePath: opts.reusePath,
      };
    }
    if (legacy) {
      const parsed = savedFleetLaunchSpecFromLegacyRecord(
        legacy,
        opts.workspaceId,
        opts.fleetSlug,
        opts.legacyFallbacks,
      );
      if (!parsed.ok) {
        const provenance = provenanceFor(opts.workspaceId, opts.fleetSlug, null, LEGACY_FLEET_LAUNCH_SPEC_SOURCE);
        return {
          ok: false,
          found: true,
          error: 'saved_launch_spec_invalid',
          message: `${parsed.message} Refusing recovery through ${opts.reusePath}.`,
          conflicts: [],
          provenance,
          reusePath: opts.reusePath,
        };
      }
      return resolveLoadedSavedFleetLaunchSpec({
        ...opts,
        target: null,
        saved: parsed.saved,
        config: parsed.config,
        source: LEGACY_FLEET_LAUNCH_SPEC_SOURCE,
        syntheticTarget: 1,
        normalizedLegacyContextSize: parsed.normalizedLegacyContextSize,
      });
    }
  }
  return resolveLoadedSavedFleetLaunchSpec({ ...opts, target });
}
