/** P-013 runtime for read-only recipe providers (D-009, D-017, D-019).
 *
 * A recipe provider runs only against the evidence its passing conformance run
 * recorded for the verb. Every call:
 *   1. resolves the wearer immediately before the call (the state-template seam),
 *      so grants are wearer ∩ declared needs ∩ pot/role ceiling at call time;
 *   2. re-runs the canonical inspector with expectedPin = the recorded pin, so a
 *      changed recipe revision, source or bindings refuses as inspection-pin-stale
 *      and a tool whose effect, egress or capabilities changed refuses too;
 *   3. runs the re-inspected script through runToolOrchestration with allowed =
 *      exactly the re-inspected tool names, the narrowed principal, the sink
 *      signal and the time left to the deadline;
 *   4. gates every dispatch at runtime: tools:invoke is resolved to its target,
 *      and a call whose classifyDurableCall result is not read-only, or whose
 *      tool has egress, is refused before it starts and voids the output;
 *   5. settles only after every inner dispatch it started has settled, so a
 *      non-cooperative tool keeps its session's admission slot (D-017);
 *   6. validates the output (schema, size, provenance) and fences a result that
 *      settles after the signal aborted.
 */
import {
  classifyDurableCall,
  runToolOrchestration,
  ToolDispatchError,
  type DispatchProjectedDeps,
  type OrchestrationInputs,
  type ProjectedTool,
  type WrapDispatch,
} from '@papercusp/tooldef';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { PROJECTED_DEPS } from '../projected-tool-deps';
import { bindCurrentCallerDispatch } from '../agent-tools/orchestration/current-caller-dispatch';
import type { SavedRecipeAdapter } from '../agent-tools/orchestration/saved-recipe-adapter';
import type { IdentityClassProviderResolution } from './class-provider';
import { validateIdentityProviderOutput, type IdentityProviderOutput } from './provider-output';
import {
  hasEgress,
  inspectIdentityRecipeProviderForRun,
  type IdentityRecipeConformance,
} from './recipe-provider-conformance';
import type { IdentityTemplateWearer } from './state-template-reader';

type RuntimeRefusal = 'effect-not-read' | 'egress-capability' | 'capability-denied' |
  'tool-unavailable' | 'dynamic-tool-target';

export type IdentityRecipeRunResult = {
  status: 'value';
  value: unknown;
  /** The provenance envelope validateIdentityProviderOutput produced. */
  text: string;
  bytes: number;
  dispatchCount: number;
} | {
  status: 'refused';
  code: 'recipe-unavailable' | 'deadline' | 'cancelled' | 'script-failed' | 'partial-execution' |
    Extract<IdentityRecipeConformance, { ok: false }>['code'] | RuntimeRefusal;
  detail?: string;
} | {
  status: 'omitted';
  reason: Extract<IdentityProviderOutput, { status: 'omitted' }>['reason'];
};

export interface IdentityRecipeCall {
  readonly resolution: Extract<IdentityClassProviderResolution, { ok: true }>;
  /** The worn identity the output is attributed to. */
  readonly identityRef: string;
  readonly signal: AbortSignal;
  /** Epoch ms; the script's worker timeout is the time left to it. */
  readonly deadlineAt: number;
  readonly maxBytes: number;
}

export interface IdentityRecipeRuntimeDeps {
  tools?: readonly ProjectedTool[];
  recipes?: SavedRecipeAdapter;
  dispatchDeps?: DispatchProjectedDeps;
  /** The host's own dispatch binding, applied after the read-only gate. */
  wrapDispatch?: WrapDispatch;
  now?: () => number;
}

/** A per-call producer. Like the template cell reader, the closure never pins
 * grants: the wearer is resolved again for every call. */
export function createIdentityRecipeProducer(input: {
  resolveWearer: () => Promise<IdentityTemplateWearer>;
  declaredNeeds: readonly string[];
}, deps: IdentityRecipeRuntimeDeps = {}): (call: IdentityRecipeCall) => Promise<IdentityRecipeRunResult> {
  return (call) => runIdentityRecipeProvider({ ...call, ...input }, deps);
}

export async function runIdentityRecipeProvider(
  input: IdentityRecipeCall & {
    resolveWearer: () => Promise<IdentityTemplateWearer>;
    declaredNeeds: readonly string[];
  },
  deps: IdentityRecipeRuntimeDeps = {},
): Promise<IdentityRecipeRunResult> {
  const refuse = (code: Extract<IdentityRecipeRunResult, { status: 'refused' }>['code'], detail?: string) =>
    ({ status: 'refused' as const, code, ...(detail ? { detail } : {}) });
  const now = deps.now ?? Date.now;
  const { provider, verb, contract, classRef } = input.resolution;
  const evidence = provider.providerKind === 'recipe' && provider.recipeInspections &&
    Object.hasOwn(provider.recipeInspections, verb) ? provider.recipeInspections[verb] : undefined;
  if (!evidence || evidence.ok !== true || evidence.recipe.id !== provider.verbBindings[verb]) {
    return refuse('recipe-unavailable');
  }
  if (input.signal.aborted) return refuse('cancelled');

  const wearer = await input.resolveWearer();
  const wearerCtx = wearer.context;
  if (!wearer.ownerId || !wearerCtx.principal || !wearerCtx.workspaceId || !wearerCtx.role ||
      wearerCtx.principal.workspaceId !== wearerCtx.workspaceId || wearerCtx.signal.aborted) {
    return refuse('authority-unavailable');
  }
  const signal = AbortSignal.any([input.signal, wearerCtx.signal]);
  const inspected = await inspectIdentityRecipeProviderForRun({
    recipe: evidence.recipe,
    ...(evidence.bindings ? { bindings: evidence.bindings } : {}),
    contract, outputSchema: evidence.outputSchema,
    declaredNeeds: input.declaredNeeds, capabilityCeiling: wearer.capabilityCeiling,
    context: { ...wearerCtx, signal }, expectedPin: evidence.inspectionPin,
  }, { ...(deps.tools ? { tools: deps.tools } : {}), ...(deps.recipes ? { recipes: deps.recipes } : {}) });
  if (!inspected.conformance.ok || !inspected.run) {
    return inspected.conformance.ok ? refuse('inspection-failed') : refuse(inspected.conformance.code);
  }
  const { source, inputs, capabilities, tools } = inspected.run;
  const allowed = new Set(inspected.conformance.toolNames);
  const remainingMs = input.deadlineAt - now();
  if (signal.aborted) return refuse('cancelled');
  if (remainingMs <= 0) return refuse('deadline');

  const byName = new Map(tools.map((tool) => [tool.expose.mcp?.name, tool]));
  let runtimeRefusal: RuntimeRefusal | undefined;
  const refuseCall = (name: string, code: RuntimeRefusal): never => {
    runtimeRefusal ??= code;
    throw new ToolDispatchError(name, 'capability_denied',
      `identity recipe providers may only make read-only, non-egress calls (${code})`);
  };
  /** Resolve every tools:invoke hop to its target, then require affirmative
   * read-only evidence for the call as it is actually made. */
  const assertReadOnly = (name: string, args: unknown): void => {
    const seen = new Set<string>();
    for (;;) {
      const tool = byName.get(name);
      if (!tool || !allowed.has(name) || seen.has(name)) refuseCall(name, 'tool-unavailable');
      seen.add(name);
      for (const cap of tool!.capabilities) {
        if (hasEgress(cap)) refuseCall(name, 'egress-capability');
        if (!capabilities.has(cap) && !capabilities.has('*')) refuseCall(name, 'capability-denied');
      }
      if (name === 'tools:invoke') {
        const nested = args as { name?: unknown; args?: unknown } | null;
        if (!nested || typeof nested !== 'object' || Array.isArray(nested) || typeof nested.name !== 'string') {
          refuseCall(name, 'dynamic-tool-target');
        }
        name = (nested!.name as string).trim();
        args = nested!.args;
        continue;
      }
      if (tool!.effectForCall) {
        let effect: string | undefined;
        try { effect = tool!.effectForCall(args); } catch { effect = undefined; }
        if (effect !== 'read') refuseCall(name, 'effect-not-read');
      }
      if (classifyDurableCall(tool!, name, args, tools) !== 'read-only') refuseCall(name, 'effect-not-read');
      return;
    }
  };
  // D-017: the producer does not settle while any call it started is running.
  const inFlight = new Set<Promise<unknown>>();
  const hostWrap = deps.wrapDispatch ?? bindCurrentCallerDispatch;
  const gate: WrapDispatch = (tool, name, args, ctx, next) => {
    assertReadOnly(name, args);
    const pending = Promise.resolve(hostWrap(tool, name, args, ctx, next));
    inFlight.add(pending);
    void pending.then(() => inFlight.delete(pending), () => inFlight.delete(pending));
    return pending;
  };
  const ctx: UnifiedToolContext = {
    ...wearerCtx, isSuperuser: false, gateBypass: undefined, codeMode: true, signal,
    principal: { ...wearerCtx.principal, capabilities: new Set(capabilities) },
  };
  const result = await runToolOrchestration(source, {
    ctx, deps: deps.dispatchDeps ?? PROJECTED_DEPS, tools, allowed,
    timeoutMs: remainingMs, wrapDispatch: gate, inputs: inputs as OrchestrationInputs,
  });
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);

  // A refused non-read call voids the output even when the script caught it.
  if (runtimeRefusal) return refuse(runtimeRefusal);
  if (!result.ok) {
    const error = typeof result.error === 'string' ? result.error : '';
    if (error.startsWith('script_aborted')) return refuse('cancelled');
    if (error.startsWith('script_timeout')) return refuse('deadline');
    return refuse('script-failed', error.slice(0, 200));
  }
  if (result.partial || (result.childFailures?.length ?? 0) > 0) return refuse('partial-execution');
  // Late-result fence: nothing that settles after the abort is consumed.
  if (signal.aborted) return refuse('cancelled');
  const summary = result.summary;
  const checked = validateIdentityProviderOutput({
    json: typeof summary === 'string' ? summary : JSON.stringify(summary ?? null),
    outputSchema: evidence.outputSchema,
    provenance: {
      author: provider.providerPackage, identityRef: input.identityRef,
      providerRef: `${provider.providerPackage}@${provider.providerVersion}`, classRef,
    },
    maxBytes: input.maxBytes,
  });
  if (checked.status === 'omitted') return { status: 'omitted', reason: checked.reason };
  return { status: 'value', value: checked.value, text: checked.text, bytes: checked.bytes,
    dispatchCount: result.dispatchCount ?? 0 };
}
