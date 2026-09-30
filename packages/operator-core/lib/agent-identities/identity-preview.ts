/**
 * The author preview (portable-identity-packages-2026-09-26 P-015, D-033).
 *
 * What a wearer would receive at each injection point, computed by the runtime
 * evaluators themselves. Exactly two inputs are substituted: the wearer anchor
 * (a sample wearer of this identity in the preview pot) and each provider's RAW
 * output (a sample JSON string per contribution or rule id). Everything between
 * them is the runtime's code: provider resolution for the pot, contract output
 * validation and the provenance envelope, allocation, budgets, the turn ceiling,
 * omission markers, fences, row ceilings and the package char budget. So the
 * preview cannot disagree with delivery without the runtime changing too.
 *
 * Read-only: it writes no row, dispatches no provider, charges no real turn and
 * never calls a resource driver's create, cancel or removeIfUnchanged.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import {
  BlueprintSourceDocumentSchema,
  CompositionCompilerError,
  compileAgentSpecification,
  resolveBlueprintSource,
  type BlueprintSourceDocument,
  type InjectionPoint,
  type InjectionTrigger,
} from '@papercusp/orchestrator/blueprint';
import type { Sql } from 'postgres';
import { parseBlueprintSource } from '../agent-tools/blueprint/_resolve';
import { operatorResolveExtends } from '../blueprint/installed-blueprints';
import { compileBlueprintWithPackages } from '../blueprint/compile-packages';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';
import { getMemoryBackend, type MemoryBackend } from '../memory/backend';
import { packageDocDriver } from '../blueprint/package-doc-resources';
import { packageMemoryDriver } from '../blueprint/package-memory-driver';
import { packageRecipeDriver } from '../blueprint/package-recipe-resources';
import { packageProviderBindingDriver, PROVIDER_BINDING_RESOURCE_KIND } from '../blueprint/package-provider-binding-resources';
import type {
  PackageExternalResource,
  PackageResourceAddress,
  PackageResourceDriver,
} from '../blueprint/package-resource-receipts';
import { resolveCapabilityGrants } from '../cupboard/capability-grant-resolver';
import {
  identityConsentSubjects,
  resolvedProviderBindings,
  type IdentityConsentSubjects,
} from '../cupboard/identity-install-consent';
import { capabilityGrantDepsForPot } from '../cupboard/install-blueprint-io';
import { validateIdentityInstallGrants } from '../capability-envelope/identity-grants-port';
import { getIdentitySource, inspectIdentitySource, localDirs } from './source';
import { IDENTITY_WEARER_ROLE } from './wearer-authority';
import { DEFAULT_SINK_HOST_LIMITS, type SinkHostLimits, type SinkInvocationResult } from './sink-evaluator';
import {
  defaultTurnStartPackageSinkDeps,
  evaluateTurnStartPackageSink,
  isDueAtTurnStart,
  type DueContextContribution,
  type PackageSinkWearer,
} from './turn-start-package-sink';
import {
  evaluateHookContextSink,
  evaluatePreToolGuards,
  memoryHookTurnStore,
  turnStartSyncRuleRequests,
  wornRulePins,
  wornSyncRules,
  type GuardVerdict,
  type WornRulePins,
  type WornSyncRules,
} from './sync-hook-rules';
import { appendPackageOrientationRows } from './package-orientation-classes';
import { IDENTITY_RULE_SUBSCRIPTION_KIND, identityRevisionTag } from './identity-async-rules';

/** The hook sinks a context rule can deliver at outside turn start. */
const HOOK_CONTEXT_PREVIEW_SINKS = ['post-tool', 'stop', 'compaction'] as const;

export interface IdentityPreviewInput {
  readonly workspaceId: string;
  /** The pot whose provider bindings and grant policy the preview resolves against. */
  readonly potSlug: string;
  /** Exactly one of identityId and source. */
  readonly identityId?: string;
  readonly source?: Record<string, unknown>;
  readonly repoDir?: string;
  /** The provider's RAW output (serialized JSON) per contribution id or rule id. */
  readonly samples?: Readonly<Record<string, string>>;
  /** A post-tool batch's tool names, matched against each rule's `tools` filter. */
  readonly tools?: readonly string[];
  /** A pending call to run the worn pre-tool guards against. */
  readonly pendingCall?: { readonly tool: string; readonly input: unknown };
  /** A session that wears this identity: adds the lifecycle section. */
  readonly ownerId?: string;
  readonly limits?: SinkHostLimits;
}

export interface PreviewIssue {
  readonly source: 'source' | 'compile' | 'grants';
  readonly code: string;
  readonly message: string;
  readonly ref?: string;
}

/** When a contribution or rule acts. Async rules act through operations, never context. */
export type PreviewTiming = 'every-turn' | 'mode-change' | 'on-demand' | `on event ${string}` | `at ${string}`;

export interface PreviewSinkDelivery {
  readonly sink: string;
  /** turn-start: the rendered package rows; hook sinks: the delivered text. */
  readonly text: string;
  readonly budget: SinkInvocationResult['budget'] | null;
  readonly allocation: SinkInvocationResult['allocation'];
  readonly deliveredTokens: number;
  readonly deliveries: readonly {
    readonly identityId: string; readonly contributionId: string; readonly allowance: number;
    readonly tokens: number; readonly truncated: boolean;
  }[];
  readonly omissions: readonly {
    readonly identityId: string; readonly contributionId: string; readonly reason: string;
    readonly detail?: string; readonly marker: string;
  }[];
  readonly error?: string;
}

export interface PreviewResourceOutcome {
  readonly dependentId: string;
  readonly resourceKind: string;
  readonly packageRef: string;
  readonly packageVersion: string;
  readonly itemKey: string;
  /** What an uninstall or a rollback past this installation would do to the resource. */
  readonly onRelease: 'kept-shared' | 'kept-edited' | 'kept-unowned' | 'removed' | 'already-deleted'
    | 'already-detached' | 'held-residue' | 'unknown';
  readonly sharedWith: number;
  readonly error?: string;
}

export interface IdentityPreview {
  readonly ok: boolean;
  readonly identityId: string | null;
  readonly potSlug: string;
  readonly validation: { readonly errors: readonly PreviewIssue[]; readonly warnings: readonly PreviewIssue[] };
  readonly declared: IdentityDeclaredSurface | null;
  readonly injection: {
    readonly limits: SinkHostLimits;
    readonly timing: readonly {
      readonly kind: 'contribution' | 'sync-rule' | 'async-rule';
      readonly id: string; readonly sinks: readonly string[]; readonly timing: PreviewTiming;
      readonly tokenBudget?: number; readonly priority?: number; readonly overBudget?: string;
      readonly tools?: readonly string[];
    }[];
    readonly sinks: readonly PreviewSinkDelivery[];
    readonly preTool: GuardVerdict | null;
  } | null;
  readonly consent: IdentityConsentSubjects | null;
  readonly lifecycle: IdentityLifecyclePreview | null;
}

export interface IdentityDeclaredSurface {
  readonly layers: readonly { readonly id: string; readonly sourceKind: string; readonly contentHash: string }[];
  readonly slots: readonly string[];
  readonly bundles: Readonly<Record<string, readonly string[]>>;
  readonly grants: { readonly requires: readonly string[]; readonly optional: readonly string[] };
  /** Each class the compiler pinned for the pot, with its contract and provider proof. */
  readonly classPins: readonly {
    readonly ref: string; readonly providerPackage: string; readonly providerVersion: string;
    readonly conformanceRunId: string; readonly registryRevision: string; readonly verbs: readonly string[];
    readonly context: { readonly requestedRef: string; readonly verb: string; readonly providerKind: string } | null;
  }[];
  readonly rules: {
    readonly sync: readonly { readonly id: string; readonly pinRef: string; readonly sink: string;
      readonly kind: 'context' | 'guard'; readonly tools?: readonly string[] }[];
    readonly async: readonly { readonly id: string; readonly pinRef: string; readonly on: string; readonly fire: string }[];
    readonly unreadable: readonly { readonly pinRef: string; readonly error: string }[];
  };
  /** Who can see each bundled resource once installed (D-021/D-022). */
  readonly visibility: readonly { readonly packageKind: string; readonly ref: string; readonly visibleTo: string }[];
}

/** The P-014 consent subjects: install computes them with the same function (D-034). */
export type { IdentityConsentSubjects } from '../cupboard/identity-install-consent';

export interface IdentityLifecyclePreview {
  readonly ownerId: string;
  readonly revisionTag: string | null;
  /** Reactions still `authorizing` under the current revision: a detach or upgrade refuses them. */
  readonly queuedReactions: readonly { readonly pinRef: string; readonly count: number }[];
  /** Worn-rule subscriptions a detach or upgrade cancels. */
  readonly subscriptions: readonly string[];
  readonly resources: readonly PreviewResourceOutcome[];
  readonly error?: string;
}

type Artifact = Awaited<ReturnType<typeof compileBlueprintWithPackages>>;

/** Read the identity and compile it for the pot. Never throws: failures are issues. */
async function loadIdentity(input: IdentityPreviewInput) {
  const errors: PreviewIssue[] = [];
  const warnings: PreviewIssue[] = [];
  const resolve = operatorResolveExtends({ localDirs: localDirs(input.repoDir) });
  let raw: Record<string, unknown>;
  let inspection;
  if (input.identityId) {
    inspection = await getIdentitySource(input.identityId, { repoDir: input.repoDir });
    if (!inspection.ok && !('errors' in inspection)) {
      return { errors: [{ source: 'source' as const, code: 'unavailable', message: inspection.error }], warnings };
    }
    if (!inspection.sourcePath) {
      return { errors: [{ source: 'source' as const, code: 'unavailable', message: 'identity has no source file' }], warnings };
    }
    raw = parseBlueprintSource(await readFile(inspection.sourcePath, 'utf8'));
  } else {
    raw = input.source ?? {};
    inspection = inspectIdentitySource(raw, { repoDir: input.repoDir });
    if (!inspection.ok && !('errors' in inspection)) {
      return { errors: [{ source: 'source' as const, code: 'parse', message: inspection.error }], warnings };
    }
  }
  for (const issue of inspection.errors ?? []) errors.push({ source: 'source', code: issue.code, message: issue.message });
  for (const issue of inspection.warnings ?? []) warnings.push({ source: 'source', code: issue.code, message: issue.message });
  const sourcePath = inspection.sourcePath ?? undefined;
  const merged = resolveBlueprintSource(raw, { sourcePath, resolve });
  const document = BlueprintSourceDocumentSchema.parse(merged.merged);
  let artifact: Artifact | null = null;
  let bindings: readonly { classRef: string; providerPackage: string; providerVersion: string }[] = [];
  const hasResources = Boolean(document.bundles?.length || document.grants?.requires?.length ||
    document.grants?.optional?.length || resolveSeedPackKey(document).packId ||
    document.contributions?.some((entry) => entry.inputKind === 'capability-provider' && entry.verb !== undefined));
  if (errors.length === 0) {
    try {
      artifact = hasResources
        ? await compileBlueprintWithPackages(raw, {
          workspaceId: input.workspaceId, harnessSlug: input.potSlug, sourcePath, resolve,
        })
        : compileAgentSpecification({ source: raw, sourcePath, resolve });
    } catch (error) {
      errors.push(error instanceof CompositionCompilerError
        ? { source: 'compile', code: error.code, message: error.message, ...(error.ref ? { ref: error.ref } : {}) }
        : { source: 'compile', code: 'compile-failed', message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (document.grants?.requires?.length || document.grants?.optional?.length) {
    // The install path's own check (install-blueprint-io.ts), against this pot's policy.
    const scope = { workspaceId: input.workspaceId, potSlug: input.potSlug };
    try {
      const resolution = await resolveCapabilityGrants(document.grants, capabilityGrantDepsForPot(scope), { mode: 'agent' });
      // The bindings install would write or reuse: its consent subjects (D-034).
      bindings = resolvedProviderBindings(resolution);
      // The install path refuses these before it judges the grants themselves.
      for (const ref of resolution.missingRequired) {
        errors.push({ source: 'grants', code: 'required_capability_provider_absent', message: `${ref}: no conformant provider in this pot`, ref });
      }
      for (const ref of resolution.requiresChoice) {
        errors.push({ source: 'grants', code: 'capability_provider_choice_required', message: `${ref}: several providers conform; the installer must choose`, ref });
      }
      for (const ref of resolution.missingOptional) {
        warnings.push({ source: 'grants', code: 'optional_capability_provider_absent', message: `${ref}: optional, no provider in this pot`, ref });
      }
      for (const failure of await validateIdentityInstallGrants({ ...scope, role: IDENTITY_WEARER_ROLE, resolution })) {
        errors.push({ source: 'grants', code: failure.cause,
          message: `${failure.classRef ?? '(unresolved)'}: ${failure.cause}${failure.toolName ? ` (${failure.toolName})` : ''}`,
          ...(failure.classRef ? { ref: failure.classRef } : {}) });
      }
    } catch (error) {
      errors.push({ source: 'grants', code: 'grants-unreadable', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { errors, warnings, inspection, document, artifact, bindings };
}

function timingOf(trigger: InjectionTrigger): PreviewTiming {
  return typeof trigger === 'string' ? trigger : `on event ${trigger.event}`;
}

function declaredSurface(
  inspection: { layers?: readonly { id: string; sourceKind: string; contentHash: string }[] },
  document: BlueprintSourceDocument, artifact: Artifact | null, pins: WornRulePins,
): IdentityDeclaredSurface {
  const bundles: Record<string, string[]> = {};
  for (const bundle of document.bundles ?? []) (bundles[bundle.kind] ??= []).push(bundle.ref);
  const inputs = artifact?.inputs ?? [];
  const visibility: IdentityDeclaredSurface['visibility'][number][] = [];
  for (const entry of inputs) {
    if (entry.kind !== 'package') continue;
    const visibleTo = entry.packageKind === 'knowledge-pack'
      ? 'wearers of an applied installation only (memories and guide parts; promotion to pool-wide is a separate reviewed act)'
      : entry.packageKind === 'rule' ? 'the wearer\'s own hooks only'
        : entry.packageKind === 'recipe' ? 'the workspace recipe store (an existing organic or edited recipe is never overwritten)'
          : entry.packageKind === 'rubric' ? 'the workspace rubric store'
            : 'the installed package closure';
    visibility.push({ packageKind: entry.packageKind, ref: entry.ref, visibleTo });
  }
  return {
    layers: (inspection.layers ?? []).map(({ id, sourceKind, contentHash }) => ({ id, sourceKind, contentHash })),
    slots: (document.slots ?? []).map((slot) => slot.slot),
    bundles,
    grants: { requires: [...(document.grants?.requires ?? [])], optional: [...(document.grants?.optional ?? [])] },
    classPins: inputs.flatMap((entry) => entry.kind !== 'capability-provider' ? [] : [{
      ref: entry.ref, providerPackage: entry.providerPackage, providerVersion: entry.providerVersion,
      conformanceRunId: entry.conformanceRunId, registryRevision: entry.registryRevision,
      verbs: Object.keys(entry.verbBindings).sort(),
      context: entry.context
        ? { requestedRef: entry.context.requestedRef, verb: entry.context.verb, providerKind: entry.context.providerKind }
        : null,
    }]),
    rules: {
      sync: pins.rules.flatMap(({ pinRef, rule }) => rule.delivery !== 'sync' ? [] : [{
        id: rule.id, pinRef, sink: rule.sink, kind: rule.guard ? 'guard' as const : 'context' as const,
        ...(rule.tools ? { tools: [...rule.tools] } : {}),
      }]),
      async: pins.rules.flatMap(({ pinRef, rule }) => rule.delivery !== 'async' ? []
        : [{ id: rule.id, pinRef, on: rule.on, fire: rule.fire }]),
      unreadable: pins.unreadable.map(({ pinRef, error }) => ({ pinRef, error })),
    },
    visibility,
  };
}


function sinkDelivery(sink: string, text: string, result: SinkInvocationResult | null, error?: string): PreviewSinkDelivery {
  return {
    sink, text, budget: result?.budget ?? null, allocation: result?.allocation ?? [],
    deliveredTokens: result?.deliveredTokens ?? 0,
    deliveries: (result?.deliveries ?? []).map((row) => ({
      identityId: row.identityId, contributionId: row.contributionId, allowance: row.allowance,
      tokens: row.tokens, truncated: row.truncated,
    })),
    omissions: (result?.omissions ?? []).map((row) => ({
      identityId: row.identityId, contributionId: row.contributionId, reason: row.reason,
      ...(row.detail ? { detail: row.detail } : {}), marker: row.marker,
    })),
    ...(error ? { error } : {}),
  };
}

/** The substituted provider: the sample stands in for the dispatch or recipe run. */
function sampleProvider(samples: Readonly<Record<string, string>>) {
  return async ({ call }: { call: { contribution: { id: string } } }) => {
    const sample = samples[call.contribution.id];
    if (sample === undefined) throw new Error(`preview:no-sample for ${call.contribution.id}`);
    return sample;
  };
}

async function previewInjection(
  input: IdentityPreviewInput, identityId: string, document: BlueprintSourceDocument, worn: WornSyncRules,
): Promise<NonNullable<IdentityPreview['injection']>> {
  const limits = input.limits ?? DEFAULT_SINK_HOST_LIMITS;
  // A fresh session per preview: the evaluator's turn ledgers and admission
  // semaphores are keyed by session, so previews never share or spend a real one.
  const sessionId = `identity-preview:${randomUUID()}`;
  const wearer: PackageSinkWearer = {
    stack: (document.slots ?? []).map((slot) => `${slot.slot}:${identityId}`),
    attachmentRevision: `preview:${sessionId}`,
    potSlug: input.potSlug,
  };
  const { produceContext } = defaultTurnStartPackageSinkDeps({ readProviderValue: sampleProvider(input.samples ?? {}) });
  const contributions = (document.contributions ?? []) as Array<Record<string, unknown>>;
  const due: DueContextContribution[] = contributions.filter(isDueAtTurnStart).map((entry) => ({
    id: String(entry.id), ref: String(entry.ref), verb: String(entry.verb), injection: entry.injection as InjectionPoint,
  }));
  const readWearer = async () => wearer;
  const readWornRules = async () => worn;
  const sinks: PreviewSinkDelivery[] = [];
  const turnStart = await evaluateTurnStartPackageSink({
    ownerId: sessionId, workspaceId: input.workspaceId, turnId: `${sessionId}:turn`,
    deps: {
      readWearer,
      readDueContributions: async (id) => id === identityId ? due : [],
      produceContext,
      readRuleRequests: (call) => turnStartSyncRuleRequests({ ...call, readWornRules }),
      limits,
    },
  });
  const rendered = appendPackageOrientationRows('', turnStart.classes);
  sinks.push(sinkDelivery('turn-start', rendered.packageRows.map((row) => row.text).join('\n'), turnStart.result,
    turnStart.error ?? turnStart.rulesError));
  const turns = memoryHookTurnStore();
  for (const sink of HOOK_CONTEXT_PREVIEW_SINKS) {
    const hook = await evaluateHookContextSink({
      ownerId: sessionId, workspaceId: input.workspaceId, sink, tools: input.tools ?? [],
      deps: { readWearer, readWornRules, produceContext, turns, limits },
    });
    if (hook.result || hook.error) sinks.push(sinkDelivery(sink, hook.text, hook.result, hook.error));
  }
  const timing: NonNullable<IdentityPreview['injection']>['timing'][number][] = [];
  for (const entry of contributions) {
    const injection = entry.injection as InjectionPoint | undefined;
    if (!injection) continue;
    timing.push({ kind: 'contribution', id: String(entry.id), sinks: [...injection.sinks],
      timing: timingOf(injection.trigger), tokenBudget: injection.tokenBudget,
      priority: injection.priority, overBudget: injection.overBudget });
  }
  for (const { rule } of worn.rules) {
    timing.push({ kind: 'sync-rule', id: rule.id, sinks: [rule.sink], timing: `at ${rule.sink}`,
      ...(rule.context ? { tokenBudget: rule.context.tokenBudget, priority: rule.context.priority,
        overBudget: rule.context.overBudget } : {}),
      ...(rule.tools ? { tools: [...rule.tools] } : {}) });
  }
  const preTool = input.pendingCall
    ? evaluatePreToolGuards(worn, { tool: input.pendingCall.tool, input: input.pendingCall.input, client: 'identity-preview' })
    : null;
  return { limits, timing, sinks, preTool };
}

/** The driver release would use for one resource kind; only its `recover` is called here. */
function recoverDriver(sql: Sql, address: PackageResourceAddress, backend: () => MemoryBackend): PackageResourceDriver | null {
  if (address.resourceKind === 'code-recipe') return packageRecipeDriver(sql, address, null);
  if (address.resourceKind === 'doc-part') return packageDocDriver(sql, address, null);
  if (address.resourceKind === 'memory') return packageMemoryDriver(backend(), '', { scope: address.memoryScope });
  if (address.resourceKind === PROVIDER_BINDING_RESOURCE_KIND) return packageProviderBindingDriver(sql, address, null);
  return null;
}

/** What releasePackageResource would decide, predicted from a read-only recover. */
function releaseOutcome(refs: readonly PackageExternalResource[]): PreviewResourceOutcome['onRelease'] {
  if (refs.some((ref) => ref.disposition === 'changed')) return 'kept-edited';
  if (refs.some((ref) => ref.owned === false)) return 'kept-unowned';
  return 'removed';
}

export async function previewIdentityLifecycle(
  sql: Sql, input: { workspaceId: string; ownerId: string; backend?: () => MemoryBackend },
): Promise<IdentityLifecyclePreview> {
  const [brief] = await sql<{ spec: string | null }[]>`
    SELECT control_state->'activation'->'applied'->>'specificationRevision' AS spec
      FROM harness_shared.session_briefs
     WHERE owner_id = ${input.ownerId} AND workspace_id = ${input.workspaceId}
     LIMIT 1`;
  const revisionTag = brief?.spec ? identityRevisionTag(brief.spec) : null;
  const queuedReactions = revisionTag ? (await sql<{ pin_ref: string; n: number }[]>`
    SELECT rule_id AS pin_ref, count(*)::int AS n
      FROM harness_shared.event_reactions
     WHERE workspace_id = ${input.workspaceId} AND status = 'authorizing'
       AND starts_with(dedup_id, 'identity-reaction:')
       AND position(${`:${input.ownerId}:${revisionTag}:`} in dedup_id) > 0
     GROUP BY rule_id ORDER BY rule_id`).map((row) => ({ pinRef: row.pin_ref, count: row.n })) : [];
  const subscriptions = (await sql<{ subscriber_id: string }[]>`
    SELECT subscriber_id FROM harness_shared.coord_entity_subscriptions
     WHERE starts_with(subscriber_id, ${`${IDENTITY_RULE_SUBSCRIPTION_KIND}:${input.ownerId}@`})
       AND cancelled_at IS NULL AND (expires_ts IS NULL OR expires_ts > now())
     ORDER BY subscriber_id`).map((row) => row.subscriber_id);
  const rows = await sql<Array<{
    dependent_id: string; memory_scope: string; package_kind: string; package_ref: string; package_version: string;
    package_hash: string; resource_kind: string; item_key: string; installed_hash: string; phase: string;
    write_key: string; shared_with: number;
  }>>`
    SELECT d.dependent_id, r.memory_scope, r.package_kind, r.package_ref, r.package_version, r.package_hash,
           r.resource_kind, r.item_key, r.installed_hash, r.phase, r.write_key,
           (SELECT count(*)::int FROM harness_shared.blueprint_package_dependents o
             WHERE o.workspace_id = d.workspace_id AND o.resource_key = d.resource_key
               AND o.dependent_id <> d.dependent_id AND o.phase <> 'released') AS shared_with
      FROM harness_shared.blueprint_package_installations i
      JOIN harness_shared.blueprint_package_dependents d USING (workspace_id, dependent_id)
      JOIN harness_shared.blueprint_package_resources r USING (workspace_id, resource_key)
     WHERE i.workspace_id = ${input.workspaceId} AND i.owner_id = ${input.ownerId}
       AND i.phase = 'applied' AND d.phase <> 'released'
     ORDER BY d.dependent_id, r.resource_key`;
  let backend: MemoryBackend | null = null;
  const memory = () => (backend ??= (input.backend ?? getMemoryBackend)());
  const resources: PreviewResourceOutcome[] = [];
  for (const row of rows) {
    const base = { dependentId: row.dependent_id, resourceKind: row.resource_kind, packageRef: row.package_ref,
      packageVersion: row.package_version, itemKey: row.item_key, sharedWith: row.shared_with };
    if (row.shared_with > 0) { resources.push({ ...base, onRelease: 'kept-shared' }); continue; }
    if (row.phase === 'deleted' || row.phase === 'detached') {
      resources.push({ ...base, onRelease: row.phase === 'deleted' ? 'already-deleted' : 'already-detached' });
      continue;
    }
    const address: PackageResourceAddress = { workspaceId: input.workspaceId, memoryScope: row.memory_scope,
      packageKind: row.package_kind, packageRef: row.package_ref, packageVersion: row.package_version,
      packageHash: row.package_hash, resourceKind: row.resource_kind, itemKey: row.item_key,
      installedHash: row.installed_hash };
    try {
      const driver = recoverDriver(sql, address, memory);
      if (!driver) { resources.push({ ...base, onRelease: 'held-residue' }); continue; }
      resources.push({ ...base, onRelease: releaseOutcome(await driver.recover(row.write_key)) });
    } catch (error) {
      resources.push({ ...base, onRelease: 'unknown', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ownerId: input.ownerId, revisionTag, queuedReactions, subscriptions, resources };
}

/**
 * The declared surface and validation of one identity, with no sample state:
 * what blueprint:validate and identities:validate report for an identity.
 */
export async function describeIdentity(input: Omit<IdentityPreviewInput, 'samples' | 'tools' | 'pendingCall' | 'ownerId'>) {
  const loaded = await loadIdentity(input);
  const pins = loaded.artifact ? wornRulePins(loaded.artifact) : { rules: [], unreadable: [] };
  return {
    loaded,
    declared: loaded.document && loaded.inspection ? declaredSurface(loaded.inspection, loaded.document, loaded.artifact ?? null, pins) : null,
  };
}

/**
 * What blueprint:validate and identities:validate add for an identity when the
 * caller has a pot to compile against: the compile and grant issues and the
 * declared surface. Source issues are already in the inspection they return.
 * Null without a workspace and pot. Never throws.
 */
export async function identityPackageValidation(input: {
  workspaceId: string | undefined;
  potSlug: string | undefined;
  identityId?: string;
  source?: Record<string, unknown>;
  repoDir?: string;
}) {
  if (!input.workspaceId || !input.potSlug) return null;
  try {
    const { loaded, declared } = await describeIdentity({
      workspaceId: input.workspaceId, potSlug: input.potSlug,
      ...(input.identityId ? { identityId: input.identityId } : { source: input.source ?? {} }),
      ...(input.repoDir ? { repoDir: input.repoDir } : {}),
    });
    const beyondSource = (issue: PreviewIssue) => issue.source !== 'source';
    return {
      potSlug: input.potSlug,
      ok: !loaded.errors.some(beyondSource),
      errors: loaded.errors.filter(beyondSource),
      warnings: loaded.warnings.filter(beyondSource),
      declared,
    };
  } catch (error) {
    return { potSlug: input.potSlug, ok: false, errors: [{ source: 'compile' as const, code: 'preview-failed',
      message: error instanceof Error ? error.message : String(error) }], warnings: [], declared: null };
  }
}

/** The full author preview. Never throws for an authoring error; they are validation issues. */
export async function previewIdentity(input: IdentityPreviewInput): Promise<IdentityPreview> {
  if ((input.identityId == null) === (input.source == null)) throw new Error('pass exactly one of identityId or source');
  const { loaded, declared } = await describeIdentity(input);
  const identityId = input.identityId ?? loaded.document?.id ?? null;
  const worn = loaded.artifact ? wornSyncRules(loaded.artifact) : { rules: [], unreadable: [] };
  const injection = loaded.document && identityId
    ? await previewInjection(input, identityId, loaded.document, worn) : null;
  let lifecycle: IdentityLifecyclePreview | null = null;
  if (input.ownerId) {
    try {
      lifecycle = await previewIdentityLifecycle(getOrgPg().sql, { workspaceId: input.workspaceId, ownerId: input.ownerId });
    } catch (error) {
      lifecycle = { ownerId: input.ownerId, revisionTag: null, queuedReactions: [], subscriptions: [], resources: [],
        error: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    ok: loaded.errors.length === 0,
    identityId,
    potSlug: input.potSlug,
    validation: { errors: loaded.errors, warnings: loaded.warnings },
    declared,
    injection,
    consent: declared && loaded.document ? identityConsentSubjects({
      grants: loaded.document.grants, providerBindings: loaded.bindings ?? [],
      contributions: loaded.document.contributions, inputs: loaded.artifact?.inputs ?? [],
    }) : null,
    lifecycle,
  };
}
