/**
 * P-005: identity grants narrow the existing role envelope at the shared kernel
 * seat. Receipts come from the control anchor/launch record, never tool args.
 * Mutable policy is read again for every preflight AND enforce invocation.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import {
  loadBlueprintFromFile,
  layerSourceDocument,
  BlueprintSourceDocumentSchema,
  replayAgentSpecification,
  type ResolvedAgentSpecification,
} from '@papercusp/orchestrator/blueprint';
import {
  listAllProjectedTools,
  resolveMcpName,
  type KernelContextState,
  type KernelEnforcementRequest,
  type KernelEnforcementResult,
  type KernelExecutionRevision,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  getPotCapabilityProviderBinding,
  parseCapabilityClassRef,
  type PotCapabilityProviderBindingRow,
} from '../capability-class-registry-store';
import type { CapabilityEnvelopeOverrides } from '../capability-envelope-overrides';
import type { HarnessRegistry } from '../harness-registry';
import { readOperatorState } from '../operator-state-pg';
import { systemDistinctId } from '../flag-distinct-id';
import { operatorResolveExtends } from '../blueprint/installed-blueprints';
import { potSlugsForHarnesses } from '../memory/hive-scope';
import { identityGrantToolFailure, resolveIdentityGrantEnvelope, type IdentityGrantFailure } from './blueprint-envelopes';
import { ROLE_ENVELOPES, type RoleEnvelope } from './policy';
// The door's identity lives in a module with no imports, so the kernel resolver's
// catch can reach it when THIS module is what failed to load. Importing the same
// constants here keeps one source of truth rather than a second copy to drift.
import { RECOVERY_DOOR_TOOL, RECOVERY_DOOR_DISPATCH_WRAPPER, isRecoveryDoorCall } from './recovery-door';
import { isLazyIdentityLaunchRecord } from './lazy-launch-record';
import { recipeProviderPins, type CapabilityGrantResolutionVerdict } from '../cupboard/capability-grant-resolver';

export interface IdentityGrantPolicy {
  policyRevision: string;
  potSlug: string;
  bindings: readonly PotCapabilityProviderBindingRow[];
  ceilings: readonly RoleEnvelope[];
  tools: ReadonlyMap<string, readonly string[]>;
  protectedAdditions: readonly string[];
}

interface PolicyInput {
  workspaceId: string;
  harnessSlug: string;
  role?: string;
  classRefs: readonly string[];
}

type PolicyReader = (input: PolicyInput) => Promise<IdentityGrantPolicy>;

interface IdentityGrantKernelState extends KernelContextState {
  /** Set only when the control anchor's adv_sessions join found no row. */
  identityLaunchRecordMissing?: boolean;
  /** Database-owned row identity/version, never supplied by the tool caller. */
  identityLaunchRecordVersion?: { sessionId: string; rowVersion: string };
  /** Server-resolved coordination owner; never taken from a tool argument. */
  operationOwnerId?: string;
}

interface OperationEffectClaim {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  ownerId: string | null;
  advSessionId: string | null;
  acceptedOperation: Record<string, unknown>;
}

type OperationEffectClaimReader = (claim: OperationEffectClaim) => Promise<boolean>;

async function readCurrentOperationEffectClaim(claim: OperationEffectClaim): Promise<boolean> {
  if (!claim.ownerId || !claim.advSessionId) return false;
  const { readActiveOperationWorkerClaimBinding, operationWorkerEffectWhereSql } =
    await import('../blueprint/operation-worker-binding');
  const read = await readActiveOperationWorkerClaimBinding(claim.workspaceId, claim.ownerId);
  if (read.status !== 'bound' || String(read.receipt.sessionId) !== claim.advSessionId ||
      !isDeepStrictEqual(read.receipt.acceptedOperation, claim.acceptedOperation)) return false;
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM harness_shared.work_items AS wi
     WHERE wi.workspace_id = ${claim.workspaceId}
       AND wi.feature_id = ${claim.workItemId}
       AND wi.harness_slug = ${claim.harnessSlug}
       AND ${operationWorkerEffectWhereSql(sql, read, {
         payload: 'wi.payload', id: 'wi.feature_id', harness: 'wi.harness_slug', holder: 'wi.taken_by',
       })}
     LIMIT 1`;
  return rows.length > 0;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Exact receipt selection; do not select a newer desired artifact for execution. */
export function appliedIdentityArtifact(
  raw: unknown,
  revision: KernelExecutionRevision | null | undefined,
): ResolvedAgentSpecification | null {
  const record = object(raw);
  if (!record || !revision) return null;
  const receipts = [record, ...(Array.isArray(record.identityHistory) ? record.identityHistory : [])];
  const receipt = receipts.map(object).find((entry) =>
    entry?.specificationRevision === revision.specificationRevision &&
    entry?.stateRevision === revision.stateRevision);
  if (!receipt?.specificationArtifact) return null;
  const artifact = replayAgentSpecification(receipt.specificationArtifact);
  return artifact.specificationRevision === revision.specificationRevision ? artifact : null;
}

/**
 * The applied artifact, admitting the one case `resolveIdentityArtifact` below
 * also admits: a control-only activation advanced the applied STATE revision
 * without re-rendering, so no receipt carries it, while the record's current
 * specification IS the applied one (EI-23431478594488191). Readers of worn
 * content (rule pins) need the artifact itself, which that verdict omits for an
 * ungoverned identity, so they share this instead of re-deriving the fallback.
 */
export function appliedOrCurrentIdentityArtifact(
  raw: unknown,
  revision: KernelExecutionRevision | null | undefined,
): ResolvedAgentSpecification | null {
  const artifact = appliedIdentityArtifact(raw, revision);
  if (artifact || !revision) return artifact;
  const record = object(raw);
  if (!record?.specificationArtifact || record.specificationRevision !== revision.specificationRevision) return null;
  const current = replayAgentSpecification(record.specificationArtifact);
  return current.specificationRevision === revision.specificationRevision ? current : null;
}

/**
 * The verdict `checkIdentityGrantKernel` reaches about a launch record, as a
 * value instead of a control-flow side effect.
 *
 * WI-10002060 — WHY THIS IS EXTRACTED. A standing sweep has to find sessions
 * this gate would wedge, and the obvious way to write one is a jsonb predicate
 * comparing `control_state->activation->applied` with `launch_spec`. Every
 * attempt at that has been wrong IN BOTH DIRECTIONS, because the gate's
 * question is not a revision comparison:
 *   - `appliedIdentityArtifact` above searches `record` AND `record
 *     .identityHistory` for a receipt matching BOTH revisions, so a record
 *     whose top-level revision differs can still resolve. SQL that compares
 *     only the top level over-reports it as wedged.
 *   - the `current`-fallback below admits a case no jsonb predicate expresses
 *     at all.
 * So the detector imports THIS, and the gate below is its only other caller.
 * Keep it that way: a second paraphrase of this decision is the defect.
 */
export type IdentityArtifactResolution =
  | {
      kind: 'stale-artifact';
      reason: 'replay-failed' | 'record-revision-mismatch' | 'receipt-missing' | 'grants-asymmetric';
    }
  | { kind: 'ungoverned' }
  | { kind: 'governed'; artifact: ResolvedAgentSpecification; current: ResolvedAgentSpecification };

export function resolveIdentityArtifact(
  record: Record<string, unknown>,
  applied: KernelExecutionRevision | null | undefined,
): IdentityArtifactResolution {
  let artifact: ResolvedAgentSpecification | null;
  let current: ResolvedAgentSpecification | null;
  try {
    artifact = appliedIdentityArtifact(record, applied);
    current = record.specificationArtifact ? replayAgentSpecification(record.specificationArtifact) : null;
    if (current && current.specificationRevision !== record.specificationRevision) {
      return { kind: 'stale-artifact', reason: 'record-revision-mismatch' };
    }
  } catch {
    return { kind: 'stale-artifact', reason: 'replay-failed' };
  }
  // A control-only activation (e.g. re-registering an already-active mode)
  // advances the applied STATE revision without re-rendering the launch
  // artifact, so no receipt can ever carry the new stateRevision and the
  // session would be denied every tool for the rest of its life
  // (EI-23431478594488191). The immutable specification — and therefore
  // configuration.grants — is unchanged in that case, so the record's current
  // artifact IS the applied specification.
  //
  // WI-10002005: this deliberately does NOT require the pending activation to
  // have reached status 'applied'. A pending activation is a request about the
  // session's FUTURE authority; it must never RETRACT authority the host has
  // already acknowledged. Requiring 'applied' here did exactly that, and the
  // resulting denial is total and self-sealing: a `relaunch-with-carry` stack
  // mutation makes turn-start skip both markControlTransitionPrepared and
  // acknowledgeControlTransition (stack-binding-channel.ts sets
  // requiresFreshContext), leaving prepared:null/status:'desired' with no
  // throw and no failure record, and acknowledgeControlTransition's own WHERE
  // clause requires prepared = desired — so the row can never converge and
  // EVERY tool is refused for the life of the session, including the
  // coord:orient recovery door.
  //
  // The conjunct that actually enforces fail-closed is the specification
  // equality below, NOT the status: configuration.grants is a property of the
  // immutable specification, so a pending BROADENING necessarily carries a
  // different specificationRevision and still falls through to denial. What is
  // admitted here is only the case where the record's current specification is
  // byte-identical to the one already acknowledged in `applied` — i.e. where
  // granting changes nothing about the authority in force. Narrowing is
  // likewise unaffected: the caller intersects `artifact` with `current`,
  // so any reduction expressed in the current specification still binds.
  if (
    !artifact && current && applied &&
    current.specificationRevision === applied.specificationRevision
  ) {
    artifact = current;
  }
  if (!artifact) {
    return applied || current?.configuration.grants
      ? { kind: 'stale-artifact', reason: 'receipt-missing' }
      : { kind: 'ungoverned' };
  }
  if (!artifact.configuration.grants && !current?.configuration.grants) return { kind: 'ungoverned' };
  // A removal or a new narrowing cannot wait for successful prompt delivery.
  // Never let a prepared broadening supply authority missing from the receipt.
  if (!artifact.configuration.grants || !current?.configuration.grants) {
    return { kind: 'stale-artifact', reason: 'grants-asymmetric' };
  }
  return { kind: 'governed', artifact, current };
}

// Replay verifies every package byte and canonical-hashes the full saved
// specification. The launch record is immutable between PostgreSQL row
// versions, so repeating that synchronous work at every tool preflight and
// dispatch stalls the operator event loop. PostgreSQL changes xmin on an
// UPDATE; the applied pair is a separate control-state input and belongs in
// the key as well. Policy is deliberately NOT cached here.
export const IDENTITY_RESOLUTION_CACHE_TTL_MS = 5 * 60_000;
export const IDENTITY_RESOLUTION_CACHE_MAX = 128;
const identityResolutionCache = pinModuleState('@papercusp/operator-core.identity-resolution-cache', () =>
  new Map<string, { validatedAt: number; resolution: IdentityArtifactResolution }>(),
);

function identityResolutionKey(
  record: Record<string, unknown>,
  applied: KernelExecutionRevision | null | undefined,
  version: IdentityGrantKernelState['identityLaunchRecordVersion'],
): string | null {
  // Callers without a database-owned version retain the original replay path.
  if (!version?.sessionId || !version.rowVersion) return null;
  return JSON.stringify([
    version.sessionId, version.rowVersion, record.workspaceId, record.harnessSlug,
    applied?.specificationRevision ?? null, applied?.stateRevision ?? null,
  ]);
}

/**
 * A fresh cached verdict, or null. Needs only the key fields — NOT the launch
 * record body — which is what lets the kernel resolver skip reading that body on
 * a hit (WI-10002721).
 */
function cachedIdentityResolution(
  record: Record<string, unknown>,
  applied: KernelExecutionRevision | null | undefined,
  version: IdentityGrantKernelState['identityLaunchRecordVersion'],
): IdentityArtifactResolution | null {
  const key = identityResolutionKey(record, applied, version);
  if (key === null) return null;
  const cached = identityResolutionCache.get(key);
  if (!cached || Date.now() - cached.validatedAt >= IDENTITY_RESOLUTION_CACHE_TTL_MS) return null;
  identityResolutionCache.delete(key);
  identityResolutionCache.set(key, cached);
  return cached.resolution;
}

function resolveIdentityArtifactForKernel(
  record: Record<string, unknown>,
  applied: KernelExecutionRevision | null | undefined,
  version: IdentityGrantKernelState['identityLaunchRecordVersion'],
): IdentityArtifactResolution {
  const cached = cachedIdentityResolution(record, applied, version);
  if (cached) return cached;
  const resolution = resolveIdentityArtifact(record, applied);
  const key = identityResolutionKey(record, applied, version);
  if (key === null) return resolution;
  const now = Date.now();
  identityResolutionCache.delete(key);
  identityResolutionCache.set(key, { validatedAt: now, resolution });
  while (identityResolutionCache.size > IDENTITY_RESOLUTION_CACHE_MAX) {
    const oldest = identityResolutionCache.keys().next().value;
    if (oldest === undefined) break;
    identityResolutionCache.delete(oldest);
  }
  return resolution;
}

/**
 * May `revision` be ACKNOWLEDGED as the session's `applied` identity, given the
 * launch record the kernel selects for it? (EI-23703586803892464 /
 * EI-23886889674609842.)
 *
 * `acknowledgeControlTransition` is the only writer of `activation.applied`, and
 * it used to write `desired` whenever `prepared` matched — without asking whether
 * the record this gate judges could resolve it. When a sibling launch record
 * minted `desired` but the gate selected a different, live row, the
 * acknowledgement itself manufactured a `stale-artifact` denial of every tool,
 * the coord:orient recovery door included.
 *
 * The answer is this gate's own, not a revision comparison (see WI-10002060
 * above): an absent or malformed record cannot carry an acknowledged identity,
 * and otherwise anything short of `stale-artifact` is admissible.
 */
export function launchRecordAdmitsApplied(
  rawRecord: unknown,
  revision: KernelExecutionRevision,
): boolean {
  const record = object(rawRecord);
  if (!record) return false;
  return resolveIdentityArtifact(record, revision).kind !== 'stale-artifact';
}

/** The administrator-selected pot of a harness and the worker roles ITS OWN layer declares. */
async function readAdministratorPotRoles(workspaceId: string, harnessSlug: string) {
  const registry = await readOperatorState<HarnessRegistry>('harness_registry', workspaceId, { fresh: true });
  const harness = registry?.projects.find((entry) => entry.slug === harnessSlug);
  if (!harness || !registry) throw new Error('identity harness is not registered');
  const potSlug = potSlugsForHarnesses(registry.projects, [harness.slug])[0] ?? harness.slug;
  const pot = registry.projects.find((entry) => entry.slug === potSlug);
  if (!pot) throw new Error('identity pot is not registered');
  // This is the current administrator-selected POT, not the installed identity.
  // Bypass blueprintRoleEnvelopes' best-effort mtime cache on this authority read.
  const loaded = loadBlueprintFromFile(join(pot.path, '.papercusp', 'blueprint.yaml'),
    operatorResolveExtends({ localDirs: [join(pot.path, '.papercusp', 'blueprints')] }));
  const ownLayer = loaded.layers.at(-1);
  if (!ownLayer) throw new Error('administrator pot source is unavailable');
  // A remote identity can contribute worker-role configuration too. Its
  // inherited value cannot count as independent administrator authorization.
  const ownSource = BlueprintSourceDocumentSchema.parse(layerSourceDocument(ownLayer));
  return { potSlug, roles: ownSource.fleet?.workerRoles ?? [] };
}

/** The runtime role-envelope overrides, only while that flag is on. */
async function readEnvelopeOverrides(workspaceId: string): Promise<CapabilityEnvelopeOverrides> {
  const overridesEnabled = await getFlag(FLAGS.CAPABILITY_ENVELOPE_OVERRIDES, systemDistinctId());
  return overridesEnabled
    ? await readOperatorState<CapabilityEnvelopeOverrides>('operator_capability_envelopes', workspaceId, { fresh: true }) ?? {}
    : {};
}

/** Reads existing stores; missing or failed policy reads must reach the caller. */
export const readIdentityGrantPolicy: PolicyReader = async (input) => {
  const { potSlug, roles } = await readAdministratorPotRoles(input.workspaceId, input.harnessSlug);
  // A library install may omit a role only for an unambiguous single-role pot.
  // The installed package never supplies the administrator role selection.
  const role = input.role ?? (roles.length === 1 ? roles[0].id : null);
  if (!role) throw new Error('identity grant target role is ambiguous');
  const potRole = roles.find((entry) => entry.id === role);
  if (potRole?.capabilities === undefined) throw new Error('administrator pot has no explicit role capability ceiling');
  const overrides = await readEnvelopeOverrides(input.workspaceId);
  const ceilings: RoleEnvelope[] = [overrides.roleEnvelopes?.[role] ?? ROLE_ENVELOPES[role] ?? {}];
  ceilings.push({ allowCapabilities: potRole.capabilities });
  const bindings: PotCapabilityProviderBindingRow[] = [];
  for (const classRef of input.classRefs) {
    const parsed = parseCapabilityClassRef(classRef);
    if (!parsed) throw new Error(`invalid capability class ${classRef}`);
    const binding = await getPotCapabilityProviderBinding(getOrgPg().sql, {
      workspaceId: input.workspaceId, potSlug, classId: parsed.id, classVersion: parsed.version,
      providerKinds: ['tool', 'recipe'],
    });
    if (binding) bindings.push(binding);
  }
  const tools = new Map<string, readonly string[]>();
  for (const tool of listAllProjectedTools()) {
    if (tool.expose.mcp) tools.set(tool.expose.mcp.name, tool.capabilities);
  }
  const protectedAdditions = overrides.protectedAdditions ?? [];
  const policyRevision = createHash('sha256').update(JSON.stringify({
    workspaceId: input.workspaceId, potSlug, ceilings, protectedAdditions,
    bindings, tools: [...tools].sort(([a], [b]) => a.localeCompare(b)),
  })).digest('hex');
  return { policyRevision, potSlug, bindings, ceilings, tools, protectedAdditions };
};

/** The pot/role ceiling an identity reaction's capability is narrowed to (P-018, D-027 §4). */
export interface IdentityReactionCeiling {
  potSlug: string;
  ceilings: readonly RoleEnvelope[];
  protectedAdditions: readonly string[];
}

/**
 * The same sources as {@link readIdentityGrantPolicy}: the role envelope (with its
 * runtime override) and the administrator pot's explicit role ceiling. One
 * difference: a pot that declares no ceiling for the role adds none here instead
 * of throwing. The dispatch that follows still runs the kernel, which refuses a
 * governed wearer in that pot, and an ungoverned wearer keeps its structural
 * envelope. Throws when a source cannot be read, so the durable step retries
 * rather than authorizing on a partial read.
 */
export async function readIdentityReactionCeiling(input: {
  workspaceId: string;
  harnessSlug: string;
  role: string;
}): Promise<IdentityReactionCeiling> {
  const { potSlug, roles } = await readAdministratorPotRoles(input.workspaceId, input.harnessSlug);
  const overrides = await readEnvelopeOverrides(input.workspaceId);
  const ceilings: RoleEnvelope[] = [overrides.roleEnvelopes?.[input.role] ?? ROLE_ENVELOPES[input.role] ?? {}];
  const potRole = roles.find((entry) => entry.id === input.role);
  if (potRole?.capabilities !== undefined) ceilings.push({ allowCapabilities: potRole.capabilities });
  return { potSlug, ceilings, protectedAdditions: overrides.protectedAdditions ?? [] };
}

/** Validate resolved choices BEFORE installing packages or writing pot bindings. */
export async function validateIdentityInstallGrants(
  input: {
    workspaceId: string;
    potSlug: string;
    role?: string;
    resolution: CapabilityGrantResolutionVerdict;
  },
  readPolicy: PolicyReader = readIdentityGrantPolicy,
): Promise<readonly IdentityGrantFailure[]> {
  const failure = (cause: IdentityGrantFailure['cause'], classRef: string | null, toolName?: string): IdentityGrantFailure => ({
    code: 'capability_unsatisfied', cause, classRef, ...(toolName ? { toolName } : {}),
    routes: ['operator-notify', 'suggest-provider', 'needs_human'],
  });
  const classRefs = input.resolution.requirements.map((entry) => entry.classRef);
  if (!input.resolution.ok) return [failure('provider-unbound', classRefs[0] ?? null)];
  let policy: IdentityGrantPolicy;
  try {
    policy = await readPolicy({
      workspaceId: input.workspaceId, harnessSlug: input.potSlug, role: input.role, classRefs,
    });
  } catch {
    return [failure('policy-unavailable', classRefs[0] ?? null)];
  }
  if (policy.potSlug !== input.potSlug || !policy.policyRevision || !policy.ceilings.length) {
    return [failure('policy-unavailable', classRefs[0] ?? null)];
  }
  const failures: IdentityGrantFailure[] = [];
  for (const requirement of input.resolution.requirements) {
    if (requirement.optional && requirement.state === 'absent') continue;
    const selected = requirement.selection;
    const provider = requirement.binding ?? requirement.candidates?.find((candidate) =>
      candidate.providerPackage === selected?.providerPackage && candidate.providerVersion === selected?.providerVersion);
    if (!provider || provider.classRef !== requirement.classRef || provider.status !== 'active' ||
        provider.conformanceStatus !== 'passed') {
      failures.push(failure('provider-unbound', requirement.classRef));
      continue;
    }
    const current = policy.bindings.find((binding) => binding.classRef === requirement.classRef);
    if (requirement.binding && (!current ||
        current.providerPackage !== provider.providerPackage || current.providerVersion !== provider.providerVersion ||
        current.conformanceRunId !== provider.conformanceRunId || current.registryRevision !== provider.registryRevision ||
        Object.keys(current.verbBindings).length !== Object.keys(provider.verbBindings).length ||
        Object.entries(current.verbBindings).some(([verb, name]) => provider.verbBindings[verb] !== name))) {
      failures.push(failure('provider-changed', requirement.classRef));
      continue;
    }
    if (!requirement.binding && current) {
      failures.push(failure('provider-changed', requirement.classRef));
      continue;
    }
    // A recipe provider's verbBindings name recipes. Its reach is the tools its
    // inspected scripts call, so those are what the ceiling must admit (D-019).
    const toolNames = provider.providerKind === 'recipe'
      ? recipeProviderPins(provider)?.flatMap((pin) => pin.toolNames) ?? null
      : Object.values(provider.verbBindings);
    if (!toolNames) {
      failures.push(failure('provider-unbound', requirement.classRef));
      continue;
    }
    for (const toolName of new Set(toolNames)) {
      const cause = identityGrantToolFailure({ ...policy, toolName });
      if (cause) failures.push(failure(cause, requirement.classRef, toolName));
    }
  }
  return failures;
}

function denial(
  cause: IdentityGrantFailure['cause'],
  classRef: string | null,
  toolName: string,
  policyRevision?: string | null,
): KernelEnforcementResult {
  const failure: IdentityGrantFailure = {
    code: 'capability_unsatisfied', cause, classRef, toolName,
    routes: ['operator-notify', 'suggest-provider', 'needs_human'],
  };
  return {
    decision: 'deny', availability: 'available', applied: true,
    code: failure.code,
    reason: `Identity capability ${classRef ?? '(unresolved)'}: ${cause} (${toolName})`,
    policyRevision,
    obligations: { capabilityUnsatisfied: failure },
  };
}

/**
 * The identity plane's resync verb. `coord:orient({ afterCompaction: true })` is
 * the only caller of acknowledgeControlTransition (agent-tools/coordination/
 * tools/orient.ts), so it is the one verb that can converge a stranded
 * activation from inside the session that is stranded.
 */
const IDENTITY_RECOVERY_TOOL = RECOVERY_DOOR_TOOL;

/**
 * EI-23745120264597384: this gate's BREAK-GLASS contract, declared in code so a
 * test can enforce it instead of a reviewer having to notice.
 *
 * `causes` is the subset of {@link IdentityGrantFailure.cause} that is
 * SELF-SEALING. Each one means the identity plane cannot establish WHICH
 * specification is in force — precisely the condition
 * {@link IDENTITY_RECOVERY_TOOL} exists to clear. Denying the recovery verb
 * under one of them strands the session in the exact state it has a documented
 * cure for, and because both documented toolless fallbacks reach this same
 * server-side preflight, no change of client, port or transport can reopen it.
 *
 * Every OTHER cause is either a statement about authority (`outside-ceiling`,
 * `tool-unavailable`, `provider-*`) or about transient infrastructure
 * (`policy-unavailable`). Those are correct to enforce against every verb,
 * this one included: honouring a ceiling that genuinely excludes the recovery
 * verb is not self-sealing, because running the recovery verb would not clear
 * it. Keeping the set narrow is what makes this a door and not a hole.
 *
 * Enforced at a single chokepoint ({@link denyUnlessRecoveryDoor}) so adding a
 * cause here protects EVERY denial site at once; the companion test asserts the
 * implication across all of them rather than a hand-listed few.
 */
export const IDENTITY_BREAK_GLASS: {
  readonly tool: string;
  readonly causes: readonly IdentityGrantFailure['cause'][];
  /**
   * The single-target dispatch wrapper that forwards ONE named tool server-side.
   *
   * WI-10002028 shipped the door keyed on the tool name alone, and it could not
   * open on the path that actually bricks sessions: a TRIMMED su surface does not
   * carry {@link IDENTITY_RECOVERY_TOOL} in its seed, so the only way to reach the
   * recovery door is `tools:invoke { name: 'coord:orient' }`. The gate then sees
   * `tools:invoke`, the name comparison fails, and the door stays shut — measured
   * live 2026-09-20T10:43Z by su-56d0a9bd, whose own fix could not save them.
   *
   * Admitting the wrapper confers NOTHING on its own: `tools:invoke` forwards
   * through `ctx.dispatchTool`, so the inner tool runs its own full kernel
   * preflight and is gated exactly as a direct call. The outer denial therefore
   * protected nothing while making the brick permanent.
   */
  readonly dispatchWrapper: string;
} = {
  tool: IDENTITY_RECOVERY_TOOL,
  causes: ['stale-artifact', 'no-launch-record'],
  dispatchWrapper: RECOVERY_DOOR_DISPATCH_WRAPPER,
};

/**
 * WI-10002028: of every cause this port can raise, `stale-artifact` is the one
 * that is NOT a statement about the session's authority — it says the identity
 * plane cannot establish WHICH specification is in force. Refusing
 * {@link IDENTITY_RECOVERY_TOOL} on that basis makes the failure self-sealing:
 * every tool is denied, including the door the CTRL block's own `resync`
 * contract names, and BOTH documented toolless fallbacks reach this same
 * server-side preflight (scripts/mcp-call.mjs is a different transport, not a
 * different gate), so changing client, port or transport cannot open it.
 * Recovery then required an out-of-band sudo psql write.
 *
 * A recovery door must not ride the failure domain it recovers. This is not a
 * widening: the no-launch-record door above already admits the same verb on
 * strictly LESS identity evidence, so anyone able to corrupt a record into this
 * state could instead delete it and take the weaker door — gating on artifact
 * integrity protected nothing while bricking honest sessions. `applied: false`
 * confers no grants, so nothing reachable through this door can escalate, and
 * every other cause (outside-ceiling, policy-unavailable, a real capability
 * failure) still denies normally.
 */
function staleArtifact(
  request: KernelEnforcementRequest,
  toolName: string = request.toolName,
  policyRevision?: string | null,
): KernelEnforcementResult {
  return denyUnlessRecoveryDoor(request, 'stale-artifact', null, toolName, policyRevision);
}

/**
 * The one place this gate turns a cause into a denial.
 *
 * Routing EVERY denial site through here is the point: the recovery door used
 * to be opened by an explicit check sitting next to two of the six sites, which
 * left the others free to emit a self-sealing cause with the door shut. That is
 * not hypothetical — `denial(failure.cause, …)` on the envelope path forwards a
 * cause chosen at runtime, and {@link IdentityGrantFailure.cause} includes both
 * break-glass causes, so a producer returning one there bricked the session
 * while every hand-written test still passed. Centralising the decision means
 * the guarantee is a property of the gate rather than of whoever last added a
 * return statement.
 *
 * Authority is untouched: the door confers `applied: false` (no grants), and a
 * cause outside {@link IDENTITY_BREAK_GLASS.causes} still denies the recovery
 * verb exactly as before. Non-recovery tools keep their distinct diagnosis, so
 * operators are not sent chasing a revision mismatch that never existed.
 */
function denyUnlessRecoveryDoor(
  request: KernelEnforcementRequest,
  cause: IdentityGrantFailure['cause'],
  classRef: string | null,
  toolName: string = request.toolName,
  policyRevision?: string | null,
): KernelEnforcementResult {
  // Both the request's own name and the resolved MCP name are checked, and each
  // through the shared predicate — so the door opens whether the verb is named
  // directly or carried as the declared target of the single-target dispatch
  // wrapper. The wrapper route is not an edge case: on a TRIMMED surface it is
  // the ONLY route an affected session has to the door.
  const isRecoveryVerb =
    isRecoveryDoorCall(request.toolName, request.args) ||
    isRecoveryDoorCall(toolName, request.args);
  if (isRecoveryVerb && IDENTITY_BREAK_GLASS.causes.includes(cause)) {
    const diagnosis = cause === 'no-launch-record'
      ? 'identity launch record is missing'
      : 'identity artifact is unresolved';
    return {
      decision: 'allow',
      availability: 'available',
      applied: false,
      code: 'identity-recovery',
      reason: `${diagnosis}; ${IDENTITY_BREAK_GLASS.tool} is the recovery door`,
      ...(policyRevision !== undefined && policyRevision !== null ? { policyRevision } : {}),
    };
  }
  return denial(cause, classRef, toolName, policyRevision);
}

/**
 * The exact adv_sessions row version whose immutable identity artifact a kernel
 * decision evaluated: the database row id and the xmin actually read (the lazily
 * loaded body's xmin on a cache miss, not the earlier header's).
 */
export interface IdentityLaunchAuditStamp {
  advSessionId: string;
  xmin: string;
}

/**
 * Receives the audit stamp for an artifact this gate evaluated but does not
 * govern. `checkIdentityGrantKernel` returns `null` for that outcome so the
 * caller's structural verdict stands; this is how that verdict still names the
 * row it was judged against (D-007).
 */
export type UngovernedIdentityAuditSink = (stamp: IdentityLaunchAuditStamp) => void;

function identityLaunchAuditStamp(
  version: IdentityGrantKernelState['identityLaunchRecordVersion'],
): IdentityLaunchAuditStamp | null {
  return version?.sessionId && version.rowVersion
    ? { advSessionId: version.sessionId, xmin: version.rowVersion }
    : null;
}

export async function checkIdentityGrantKernel(
  request: KernelEnforcementRequest,
  state: IdentityGrantKernelState,
  rawRecord: unknown,
  readPolicy: PolicyReader = readIdentityGrantPolicy,
  readOperationEffectClaim: OperationEffectClaimReader = readCurrentOperationEffectClaim,
  onUngovernedEvaluated?: UngovernedIdentityAuditSink,
): Promise<KernelEnforcementResult | null> {
  // WI-10002721: the live resolver passes a header + loader instead of the
  // (hundreds-of-KB) record. The header carries exactly the fields this gate
  // reads before and after resolution, so a cache hit never loads the body.
  const lazy = isLazyIdentityLaunchRecord(rawRecord) ? rawRecord : null;
  let record: Record<string, unknown> | null = lazy
    ? (lazy.isObject ? {
        workspaceId: lazy.workspaceId, harnessSlug: lazy.harnessSlug,
        ...(lazy.hasAcceptedOperation ? { acceptedOperation: lazy.acceptedOperation } : {}),
      } : null)
    : object(rawRecord);
  let version = state.identityLaunchRecordVersion;
  const applied = state.activation?.applied ?? state.appliedRevision;
  // No launch artifact is the legacy, non-opted-in path. An acknowledged
  // identity with a missing receipt is not legacy: fail closed.
  //
  // "Acknowledged" is load-bearing and is what makes `no-launch-record` a fault
  // rather than a brick. A session_briefs row alone is NOT an identity: any
  // coord verb creates one, and the compaction watchdog writes one (carry +
  // control_state, no activation) for a session it force-compacts. A launch
  // that never registered an adv_sessions row (a consult-expiry-sweep
  // `psu --fork --owner-id` fork, measured 2026-09-23: 12 of 12 live forks had
  // no row) is therefore ungoverned until it is compacted — and was then denied
  // EVERY verb on this branch, with no activation for coord:orient to converge
  // and no wedged-identity escalation (that sweep already treats "no applied
  // receipt" as the legacy path, exactly as the comment above says). Gate the
  // fault on an activation being present so the kernel and the sweep agree.
  const acknowledged = Boolean(state.activation) || Boolean(applied);
  if (!record) {
    if (state.identityLaunchRecordMissing && acknowledged) {
      // coord:orient is the recovery verb named by the CTRL block. It is the
      // only tool allowed to run without the launch record; every other tool
      // receives a distinct diagnosis so operators do not chase a revision
      // mismatch that never existed.
      if (request.toolName === 'coord:orient') {
        return {
          decision: 'allow',
          availability: 'available',
          applied: false,
          code: 'identity-recovery',
          reason: 'identity launch record is missing; coord:orient is the recovery door',
          ...(state.policyRevision !== undefined ? { policyRevision: state.policyRevision } : {}),
        };
      }
      return denyUnlessRecoveryDoor(
        request, 'no-launch-record', null, request.toolName, state.policyRevision,
      );
    }
    return applied ? staleArtifact(request) : null;
  }
  // The decision itself lives in `resolveIdentityArtifact` (above) so the
  // WI-10002060 sweep can ask the same question instead of paraphrasing it.
  // This call site is behaviour-identical to the body it replaced.
  let resolution = lazy ? cachedIdentityResolution(record, applied, version) : null;
  if (lazy && !resolution) {
    // Cache miss: read the body. It is resolved AND keyed at the row version it
    // was read at, so a row updated between the header read and this one is
    // judged as one consistent snapshot rather than a header/body mix.
    const loaded = await lazy.load();
    const full = object(loaded?.record);
    // The row vanished or stopped being an object between the two reads:
    // exactly the "no usable record" outcome the header path would have given.
    if (!full) return applied ? staleArtifact(request) : null;
    record = full;
    version = version && loaded?.rowVersion
      ? { sessionId: version.sessionId, rowVersion: loaded.rowVersion }
      : undefined;
  }
  resolution ??= resolveIdentityArtifactForKernel(record, applied, version);
  if (resolution.kind === 'stale-artifact') return staleArtifact(request);
  if (resolution.kind === 'ungoverned') {
    // D-007: no live session carries configuration.grants, so without this
    // every identity-bearing invocation would persist with no row reference and
    // the per-call receipt could never be produced. Audit only: the caller's
    // structural verdict (and its decision) is unchanged.
    const stamp = identityLaunchAuditStamp(version);
    if (stamp) onUngovernedEvaluated?.(stamp);
    return null;
  }
  const { artifact, current } = resolution;
  const workspaceId = request.ctx.workspaceId ?? request.ctx.principal?.workspaceId;
  if (record.workspaceId !== workspaceId ||
      typeof record.harnessSlug !== 'string' || !record.harnessSlug) {
    return denyUnlessRecoveryDoor(request, 'policy-unavailable', null, request.toolName);
  }
  const classRefs = [...new Set([artifact, current].flatMap((specification) => [
    ...(specification.configuration.grants?.requires ?? []),
    ...(specification.configuration.grants?.optional ?? []),
  ]))].sort();
  let policy: IdentityGrantPolicy;
  try {
    policy = await readPolicy({
      workspaceId: record.workspaceId as string, harnessSlug: record.harnessSlug,
      role: request.ctx.role ?? 'su', classRefs,
    });
  } catch {
    return denyUnlessRecoveryDoor(
      request, 'policy-unavailable', classRefs[0] ?? null, request.toolName,
    );
  }
  const toolName = resolveMcpName(request.toolName)?.expose.mcp?.name ?? request.toolName;
  // The accepted operation's requested tools are a further ceiling carried by
  // the host-owned launch receipt. Tool arguments and nested dispatch cannot
  // alter this list. An empty list deliberately permits no operation tools.
  const accepted = 'acceptedOperation' in record ? object(record.acceptedOperation) : null;
  if ('acceptedOperation' in record) {
    const tools = accepted?.requiredTools;
    const pin = object(accepted?.pin);
    if (accepted?.kind !== 'blueprint-operation-worker' ||
        typeof accepted.workItemId !== 'string' || !accepted.workItemId ||
        typeof accepted.specificationRevision !== 'string' ||
        !/^[0-9a-f]{64}$/.test(accepted.specificationRevision) ||
        pin?.kind !== 'blueprint-operation' ||
        pin.operationId !== accepted.operationId ||
        pin.specificationRevision !== accepted.specificationRevision ||
        pin.harnessSlug !== record.harnessSlug ||
        !Array.isArray(tools) || !tools.every((name) => typeof name === 'string' && name.length > 0) ||
        !tools.includes(toolName)) {
      return denyUnlessRecoveryDoor(
        request, 'outside-ceiling', classRefs[0] ?? null, toolName, policy.policyRevision,
      );
    }
  }
  for (const specification of [artifact, current]) {
    const envelope = resolveIdentityGrantEnvelope({
      specification, appliedSpecificationRevision: specification.specificationRevision, ...policy,
    });
    if (!envelope.applied) return staleArtifact(request, toolName, policy.policyRevision);
    const failure = envelope.failures[0];
    // The runtime-chosen cause: `IdentityGrantFailure['cause']` spans both
    // break-glass causes, so this site can emit one. It must consult the
    // contract rather than deny unconditionally.
    if (failure) {
      return denyUnlessRecoveryDoor(
        request, failure.cause, failure.classRef, toolName, policy.policyRevision,
      );
    }
    if (!envelope.allowedTools.includes(toolName)) {
      return denyUnlessRecoveryDoor(
        request, 'outside-ceiling', classRefs[0] ?? null, toolName, policy.policyRevision,
      );
    }
  }
  // The accepted tool list narrows WHAT a role may call. A separate live
  // claim check narrows WHEN it may cause an effect. Read-only and claim doors
  // remain usable for pickup/recovery; every other direct, native or nested
  // dispatch checks the same current holder and immutable receipt.
  const claimDoors = new Set(['work_items:claim', 'work_items:claim_next', 'scheduler:get_next']);
  const readOnly = request.capabilities.length > 0 &&
    request.capabilities.every((capability) => capability.endsWith(':read'));
  if (accepted && !claimDoors.has(toolName) && !readOnly && toolName !== 'coord:orient') {
    const claim = {
      workspaceId: workspaceId as string,
      harnessSlug: record.harnessSlug as string,
      workItemId: accepted.workItemId as string,
      ownerId: state.operationOwnerId ?? null,
      advSessionId: state.identityLaunchRecordVersion?.sessionId ?? null,
      acceptedOperation: accepted,
    };
    let current = false;
    try { current = await readOperationEffectClaim(claim); } catch {
      return { decision: 'deny', code: 'operation-claim-unavailable',
        reason: 'current operation claim authority could not be read', availability: 'unavailable', applied: true,
        policyRevision: policy.policyRevision };
    }
    if (!current) return { decision: 'deny', code: 'operation-claim-stale',
      reason: 'operation worker no longer holds the item under its applied launch receipt',
      availability: 'available', applied: true, policyRevision: policy.policyRevision };
  }
  return {
    decision: 'allow', availability: 'available', applied: true,
    policyRevision: policy.policyRevision, executionRevision: applied, revisionSource: 'applied',
    // R1 needs every invocation receipt to identify the exact adv_sessions row
    // whose immutable identity artifact this decision evaluated. `sessionId`
    // is the database row id here; `rowVersion` is the xmin actually used after
    // any lazy body read, not necessarily the earlier header's xmin.
    ...(version?.sessionId && version.rowVersion
      ? { serverAudit: { identityLaunchRecord: { advSessionId: version.sessionId, xmin: version.rowVersion } } }
      : {}),
  };
}
