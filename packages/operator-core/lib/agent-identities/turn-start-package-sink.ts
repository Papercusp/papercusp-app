/**
 * The turn-start sink invocation for package-declared injection points
 * (portable-identity-packages-2026-09-26 P-010; D-009, D-013, D-014).
 *
 * `sink-evaluator.ts` owns the budget, admission and fence rules, and
 * `package-orientation-classes.ts` owns the rendering. This module is the host
 * side that makes them run on a real turn:
 *
 *   1. WHO IS WORN. The wearer's identities are the control anchor's `stack`
 *      (explicit launch layers, fleet posture and active modes, projected by
 *      `stackRefsForSession`). The attachment revision is the anchor's APPLIED
 *      activation — a stack attach, detach or re-composition moves it.
 *   2. WHAT IS DUE. A contribution is due at turn start when its `injection`
 *      names the `turn-start` sink with the `every-turn` trigger. Compile already
 *      refused every other shape (schema superRefine → `validateInjectionPoint`).
 *   3. WHO PRODUCES IT. A due contribution is a context capability (D-013):
 *      `class@major` + `verb`. The pot's exact conformed provider is resolved
 *      (`resolveIdentityClassProvider` — it refuses operation providers and a
 *      recipe provider without inspected evidence). A tool binding is dispatched
 *      as a READ-ONLY tool under the sink's abort signal (`dispatchReadOnlyTool`);
 *      a recipe binding runs through the P-013 recipe runtime as the wearer,
 *      resolved again before every call (`resolvePackageSinkRecipeWearer`, D-031);
 *      and
 *      the output is validated against the contract's schema and provenance-
 *      enveloped (`validateIdentityProviderOutput`) before the evaluator may
 *      count or render it.
 *   4. ONE BUDGET. Every due contribution of every worn identity goes through
 *      ONE `evaluateSinkInvocation`, so the aggregate allowance, the per-turn
 *      ceiling and the per-session admission cap hold across identities.
 *   5. THE CONSUMER FENCE. The anchor is re-read after evaluation, and the
 *      classes are fenced to that re-read (`packageOrientationClasses`). A result
 *      evaluated against an attachment the wearer has since left never renders.
 *
 * Fail-open, visibly: a provider failure is an omission row the sink renders; a
 * discovery failure yields no package half at all and is reported in `error`,
 * never thrown into the turn.
 *
 * The production dependencies are imported statically, never per call. They
 * load when the endpoint loads this module, before the evaluator's clock
 * starts, so a cold module graph cannot spend the sink's wall-clock budget. A
 * per-call `import()` also let two concurrent providers bind different
 * instances of `@papercusp/db-org` (measured under a vitest mock: the second
 * provider resolved against another database).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import {
  BlueprintSourceDocumentSchema,
  resolveBlueprintSource,
  type InjectionPoint,
} from '@papercusp/orchestrator/blueprint';
import { parseBlueprintSource } from '../agent-tools/blueprint/_resolve';
import { operatorResolveExtends } from '../blueprint/installed-blueprints';
import { dispatchReadOnlyTool } from '../events/await/predicate-watch';
import {
  readIdentityReactionCeiling,
  type IdentityReactionCeiling,
} from '../capability-envelope/identity-grants-port';
import { resolveIdentityClassProvider } from './class-provider';
import { validateIdentityProviderOutput } from './provider-output';
import { runIdentityRecipeProvider, type IdentityRecipeRuntimeDeps } from './recipe-provider-runtime';
import type { IdentityTemplateWearer } from './state-template-reader';
import { IDENTITY_WEARER_ROLE, buildWearerToolContext, identityCeilingRefusal } from './wearer-authority';
import { getIdentitySource, localDirs } from './source';
import {
  DEFAULT_SINK_HOST_LIMITS,
  evaluateSinkInvocation,
  type SinkContributionRequest,
  type SinkHostLimits,
  type SinkInjectionRequest,
  type SinkInvocationResult,
} from './sink-evaluator';
import { packageOrientationClasses, type PackageOrientationClass } from './package-orientation-classes';

/** One context capability value, provenance envelope included — the binder's own bound (source.ts). */
const PACKAGE_CONTEXT_OUTPUT_MAX_BYTES = 16_384;
export const PACKAGE_SINK_SPAWN_ID = 'identity-sink:turn-start';

/** The worn stack and the revision a result must be fenced to. */
export interface PackageSinkWearer {
  /** Bound-layer refs `slot:id`. */
  readonly stack: readonly string[];
  readonly attachmentRevision: string;
  /** The pot whose capability-provider bindings resolve this wearer's classes. */
  readonly potSlug: string | null;
}

/** The declared fields a due context contribution carries. */
export interface DueContextContribution {
  readonly id: string;
  /** `class@major` (D-013). */
  readonly ref: string;
  readonly verb: string;
  readonly injection: SinkInjectionRequest;
}

export interface ProduceContextInput {
  readonly workspaceId: string;
  readonly potSlug: string;
  readonly ownerId: string;
  readonly identityId: string;
  readonly contribution: DueContextContribution;
  readonly signal: AbortSignal;
  /** Epoch ms: the sink invocation's deadline. A recipe script gets the time left to it. */
  readonly deadlineAt: number;
}

export interface TurnStartPackageSinkDeps {
  readonly readWearer: (ownerId: string, workspaceId: string) => Promise<PackageSinkWearer | null>;
  /** Every contribution of one identity that is due at turn start. */
  readonly readDueContributions: (identityId: string) => Promise<readonly DueContextContribution[]>;
  /** The provider's validated, provenance-enveloped text. Throws to omit. */
  readonly produceContext: (input: ProduceContextInput) => Promise<string>;
  /**
   * P-011: the worn sync context rules due at turn start, produced through
   * `produceContext`. Throws to omit the rule half only.
   */
  readonly readRuleRequests: (input: {
    ownerId: string;
    workspaceId: string;
    wearer: PackageSinkWearer;
    produceContext: (input: ProduceContextInput) => Promise<string>;
  }) => Promise<readonly SinkContributionRequest[]>;
  readonly limits?: SinkHostLimits;
}

export interface TurnStartPackageSink {
  /** Null when the wearer declares nothing due at turn start. */
  readonly result: SinkInvocationResult | null;
  /** Fenced to the anchor as re-read AFTER evaluation. */
  readonly classes: PackageOrientationClass[];
  /** Set when discovery itself failed (no package half this turn). */
  readonly error?: string;
  /** Set when the worn sync rules could not be read (no rule half this turn). */
  readonly rulesError?: string;
}

/** A contribution the turn-start sink evaluates every turn. */
export function isDueAtTurnStart(contribution: {
  source?: unknown; purpose?: unknown; inputKind?: unknown; verb?: unknown; injection?: unknown;
}): boolean {
  const injection = contribution.injection as Partial<InjectionPoint> | undefined;
  return contribution.source === 'provider' && contribution.purpose === 'resource' &&
    contribution.inputKind === 'capability-provider' && typeof contribution.verb === 'string' &&
    Array.isArray(injection?.sinks) && injection.sinks.includes('turn-start') &&
    injection.trigger === 'every-turn';
}

/** The identity id a bound-layer ref `slot:id` names. */
export function stackRefIdentity(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/**
 * Evaluate every due package contribution of the wearer under ONE aggregate
 * budget and return the fenced orientation classes. Never throws.
 */
export async function evaluateTurnStartPackageSink(input: {
  ownerId: string;
  workspaceId: string;
  turnId: string;
  signal?: AbortSignal;
  deps?: Partial<TurnStartPackageSinkDeps>;
}): Promise<TurnStartPackageSink> {
  const deps = { ...defaultTurnStartPackageSinkDeps(), ...(input.deps ?? {}) };
  let wearer: PackageSinkWearer | null;
  const requests: SinkContributionRequest[] = [];
  try {
    wearer = await deps.readWearer(input.ownerId, input.workspaceId);
    if (!wearer) return { result: null, classes: [] };
    const identities = [...new Set(wearer.stack.map(stackRefIdentity))];
    const due = await Promise.all(identities.map(async (identityId) =>
      ({ identityId, contributions: await deps.readDueContributions(identityId) })));
    const potSlug = wearer.potSlug;
    for (const { identityId, contributions } of due) {
      for (const contribution of contributions) {
        requests.push({
          identityId,
          contributionId: contribution.id,
          injection: contribution.injection,
          produce: async (call) => {
            if (!potSlug) throw new Error('the wearer has no pot scope to resolve a provider in');
            return deps.produceContext({
              workspaceId: input.workspaceId, potSlug, ownerId: input.ownerId,
              identityId, contribution, signal: call.signal, deadlineAt: call.deadlineAt,
            });
          },
        });
      }
    }
  } catch (error) {
    return { result: null, classes: [], error: error instanceof Error ? error.message : String(error) };
  }
  // Worn sync rules join the SAME invocation, so both halves share one budget.
  let rulesError: string | undefined;
  try {
    requests.push(...await deps.readRuleRequests({
      ownerId: input.ownerId, workspaceId: input.workspaceId, wearer, produceContext: deps.produceContext,
    }));
  } catch (error) {
    rulesError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }
  const rulesNote = rulesError ? { rulesError } : {};
  if (requests.length === 0) return { result: null, classes: [], ...rulesNote };
  const invocationRevision = wearer.attachmentRevision;
  // The evaluator's per-result check reads the revision this host last
  // observed; the authoritative re-read below is what the consumer fences to.
  let observedRevision = invocationRevision;
  const result = await evaluateSinkInvocation({
    invocation: {
      sessionId: input.ownerId, turnId: input.turnId, invocationId: randomUUID(),
      sink: 'turn-start', attachmentRevision: invocationRevision,
    },
    contributions: requests,
    limits: deps.limits ?? DEFAULT_SINK_HOST_LIMITS,
    currentAttachmentRevision: () => observedRevision,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  try {
    observedRevision = (await deps.readWearer(input.ownerId, input.workspaceId))?.attachmentRevision ?? '';
  } catch {
    // An unreadable anchor cannot prove the attachment is still current.
    observedRevision = '';
  }
  return {
    result,
    classes: packageOrientationClasses(result, {
      sessionId: input.ownerId, turnId: input.turnId, attachmentRevision: observedRevision,
    }),
    ...rulesNote,
  };
}

/**
 * The receipt the turn-start delivery persists: allocation, deliveries and
 * omissions. Delivered text rides along (the evaluator already bounded it to
 * the sink budget) because a row-ceiling disclosure points readers here.
 */
export function packageSinkReceipt(sink: TurnStartPackageSink): Record<string, unknown> | null {
  if (sink.error) return { version: 1, status: 'unavailable', error: sink.error.slice(0, 200) };
  const result = sink.result;
  const rulesNote = sink.rulesError ? { rulesError: sink.rulesError } : {};
  if (!result) return sink.rulesError ? { version: 1, status: 'rules-unavailable', ...rulesNote } : null;
  return {
    version: 1,
    status: sink.classes.length > 0 ? 'rendered' : 'fenced',
    ...rulesNote,
    invocationId: result.invocation.invocationId,
    turnId: result.invocation.turnId,
    attachmentRevision: result.invocation.attachmentRevision,
    budget: result.budget,
    allocation: result.allocation,
    deliveredTokens: result.deliveredTokens,
    deliveries: result.deliveries.map((row) => ({
      identityId: row.identityId, contributionId: row.contributionId, priority: row.priority,
      allowance: row.allowance, tokens: row.tokens, truncated: row.truncated,
      outputRevision: createHash('sha256').update(row.text).digest('hex'), text: row.text,
    })),
    omissions: result.omissions.map((row) => ({
      identityId: row.identityId, contributionId: row.contributionId, priority: row.priority,
      allowance: row.allowance, reason: row.reason, ...(row.detail ? { detail: row.detail } : {}),
    })),
    started: result.started,
    peakSessionInFlight: result.peakSessionInFlight,
    unsettledAtReturn: result.unsettledAtReturn,
  };
}

/**
 * P-018 (D-020, D-031): the wearer a turn-start recipe provider runs as,
 * resolved immediately before each call and never cached. The anchor is read
 * again, so a wearer that has since stopped wearing the identity, or has no
 * harness scope, is refused before any dispatch. The principal is the wearer;
 * its capabilities are the recipe's inspected requirements that the live
 * pot/role ceiling and the never-auto floor admit. A requirement they refuse is
 * absent, so re-inspection refuses the call as `capability-denied`. The
 * dispatcher's identity grant kernel then judges the wearer's own grants on
 * every call the recipe makes.
 */
export async function resolvePackageSinkRecipeWearer(input: {
  ownerId: string;
  workspaceId: string;
  identityId: string;
  requiredCapabilities: readonly string[];
  signal: AbortSignal;
}, deps: {
  readWearer: TurnStartPackageSinkDeps['readWearer'];
  readCeiling: NonNullable<PackageSinkHost['readCeiling']>;
}): Promise<IdentityTemplateWearer> {
  const wearer = await deps.readWearer(input.ownerId, input.workspaceId);
  if (!wearer || !wearer.stack.some((ref) => stackRefIdentity(ref) === input.identityId)) {
    throw new Error('capability-class:recipe-wearer-detached');
  }
  if (!wearer.potSlug) throw new Error('capability-class:recipe-wearer-unscoped');
  const ceiling = await deps.readCeiling({
    workspaceId: input.workspaceId, harnessSlug: wearer.potSlug, role: IDENTITY_WEARER_ROLE,
  });
  const capabilities = input.requiredCapabilities.filter((cap) => identityCeilingRefusal(cap, ceiling) === null);
  return {
    ownerId: input.ownerId,
    capabilityCeiling: new Set(capabilities),
    context: buildWearerToolContext({
      workspaceId: input.workspaceId, ownerId: input.ownerId, role: IDENTITY_WEARER_ROLE,
      harnessSlug: wearer.potSlug, capabilities, spawnId: PACKAGE_SINK_SPAWN_ID, signal: input.signal,
    }),
  };
}

/** The provider path's host seams. Production passes none: the P-013 runtime's
 * own defaults, the live pot/role ceiling read and a real dispatch. */
export interface PackageSinkHost {
  readonly runtime?: IdentityRecipeRuntimeDeps;
  readonly readCeiling?: (input: { workspaceId: string; harnessSlug: string; role: string }) =>
    Promise<Pick<IdentityReactionCeiling, 'ceilings' | 'protectedAdditions'>>;
  /**
   * P-015 (D-033): the author preview's substitute for the provider's RAW
   * output. When set, nothing is dispatched and no recipe runs; the value goes
   * through the same resolution, contract validation and provenance envelope
   * as that provider kind's real output.
   */
  readonly readProviderValue?: (input: { call: ProduceContextInput; providerKind: 'tool' | 'recipe' }) => Promise<unknown>;
}

/** Production wiring: the control anchor, the identity source catalog, the class registry and the read-only dispatcher. */
export function defaultTurnStartPackageSinkDeps(host: PackageSinkHost = {}): TurnStartPackageSinkDeps {
  const readWearer: TurnStartPackageSinkDeps['readWearer'] = async (ownerId, workspaceId) => {
    const rows = await getOrgPg().sql<{ control_state: unknown; control_generation: string | number | null }[]>`
      SELECT control_state, control_generation
        FROM harness_shared.session_briefs
       WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
       LIMIT 1`;
    const state = rows[0]?.control_state as {
      stack?: unknown; scope?: { harness?: unknown };
      activation?: { applied?: { specificationRevision?: unknown; stateRevision?: unknown } | null } | null;
    } | null | undefined;
    if (!state || !Array.isArray(state.stack)) return null;
    const applied = state.activation?.applied;
    const attachmentRevision = typeof applied?.specificationRevision === 'string' &&
      typeof applied.stateRevision === 'string'
      ? `${applied.specificationRevision}:${applied.stateRevision}`
      : `generation:${String(rows[0]!.control_generation ?? '')}`;
    return {
      stack: state.stack.filter((ref): ref is string => typeof ref === 'string'),
      attachmentRevision,
      potSlug: typeof state.scope?.harness === 'string' && state.scope.harness ? state.scope.harness : null,
    };
  };
  return {
    readWearer,
    readDueContributions: async (identityId) => {
      const identity = await getIdentitySource(identityId);
      // A layer the catalog cannot resolve declares nothing this sink can run.
      if (!identity.ok || !identity.sourcePath) return [];
      const raw = parseBlueprintSource(await readFile(identity.sourcePath, 'utf8'));
      const source = resolveBlueprintSource(raw, {
        sourcePath: identity.sourcePath, resolve: operatorResolveExtends({ localDirs: localDirs() }),
      });
      if (!source.validation.ok) return [];
      const document = BlueprintSourceDocumentSchema.parse(source.merged);
      const contributions = (document.contributions ?? []) as Array<Record<string, unknown>>;
      return contributions.filter(isDueAtTurnStart).map((entry) => ({
        id: String(entry.id), ref: String(entry.ref), verb: String(entry.verb),
        injection: entry.injection as InjectionPoint,
      }));
    },
    produceContext: async (call) => {
      const resolved = await resolveIdentityClassProvider(getOrgPg().sql, {
        workspaceId: call.workspaceId, potSlug: call.potSlug,
        classRef: call.contribution.ref, verb: call.contribution.verb,
      });
      if (!resolved.ok) throw new Error(`capability-class:${resolved.code}`);
      /** The contract check and provenance envelope a provider kind's real output gets. */
      const envelope = (value: unknown, outputSchema: typeof resolved.contract.outputSchema): string => {
        const checked = validateIdentityProviderOutput({
          json: typeof value === 'string' ? value : JSON.stringify(value ?? null),
          outputSchema,
          provenance: {
            author: resolved.provider.providerPackage, identityRef: call.identityId,
            providerRef: `${resolved.provider.providerPackage}@${resolved.provider.providerVersion}`,
            classRef: resolved.classRef,
          },
          maxBytes: PACKAGE_CONTEXT_OUTPUT_MAX_BYTES,
        });
        if (checked.status === 'omitted') throw new Error(`capability-output:${checked.reason}`);
        return checked.text;
      };
      if (resolved.provider.providerKind === 'recipe') {
        // A recipe binding names a saved recipe, not a tool: the P-013 runtime
        // re-inspects it against its recorded pin and runs it as the wearer
        // (D-020, D-031). Its declared needs are what that inspection recorded.
        const inspections = resolved.provider.recipeInspections;
        const evidence = inspections && Object.hasOwn(inspections, resolved.verb) ? inspections[resolved.verb] : undefined;
        if (host.readProviderValue) {
          // The runtime's own availability check, then its output contract.
          if (!evidence?.ok || evidence.recipe.id !== resolved.provider.verbBindings[resolved.verb]) {
            throw new Error('capability-class:recipe-recipe-unavailable');
          }
          return envelope(await host.readProviderValue({ call, providerKind: 'recipe' }), evidence.outputSchema);
        }
        const declaredNeeds = evidence?.ok ? evidence.requiredCapabilities : [];
        const run = await runIdentityRecipeProvider({
          resolution: resolved, identityRef: call.identityId, signal: call.signal,
          deadlineAt: call.deadlineAt, maxBytes: PACKAGE_CONTEXT_OUTPUT_MAX_BYTES, declaredNeeds,
          resolveWearer: () => resolvePackageSinkRecipeWearer({
            ownerId: call.ownerId, workspaceId: call.workspaceId, identityId: call.identityId,
            requiredCapabilities: declaredNeeds, signal: call.signal,
          }, { readWearer, readCeiling: host.readCeiling ?? readIdentityReactionCeiling }),
        }, host.runtime);
        if (run.status === 'value') return run.text;
        throw new Error(run.status === 'refused' ? `capability-class:recipe-${run.code}` : `capability-output:${run.reason}`);
      }
      if (resolved.provider.providerKind !== 'tool') {
        throw new Error(`capability-class:${resolved.provider.providerKind}-unavailable`);
      }
      const tool = resolved.provider.verbBindings[resolved.verb];
      if (typeof tool !== 'string' || !tool.trim()) throw new Error('capability-class:verb-unbound');
      const value = host.readProviderValue
        ? await host.readProviderValue({ call, providerKind: 'tool' })
        : await dispatchReadOnlyTool(tool.trim(), {}, {
          workspaceId: call.workspaceId, harnessSlug: call.potSlug, role: 'su',
          onBehalfOf: call.ownerId, spawnId: PACKAGE_SINK_SPAWN_ID, signal: call.signal,
        });
      return envelope(value, resolved.contract.outputSchema);
    },
    // Loaded on call: sync-hook-rules imports this module for its own defaults.
    readRuleRequests: async (call) => (await import('./sync-hook-rules')).turnStartSyncRuleRequests(call),
  };
}
