/** P004 recipe admission. Reuses orchestrate:inspect; never executes a recipe.
 * Persistence belongs to the existing conformance report, and runtime admission
 * still belongs to P013. A successful inspection alone is not an execution grant.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { listAllProjectedTools, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { classifyDurableCall, roleScopedToolNames, type ProjectedTool } from '@papercusp/tooldef';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { CapabilityClassRow, CapabilityClassVerb, ProviderConformanceReport } from '../capability-class-registry-store';
import { isCompilableSchema } from '../json-schema-validation';
import { inspectOrchestration } from '../agent-tools/orchestration/inspect';
import { currentCallerRecipeCatalog, inspectScriptContract,
  ORCHESTRATION_RECURSION_EXCLUSIONS } from '../agent-tools/orchestration/contract-preflight';
import type { SavedRecipeAdapter, SavedRecipeSelector } from '../agent-tools/orchestration/saved-recipe-adapter';
import { orchestrationSourceArgsSchema } from '../agent-tools/orchestration/public-contract';

const pinSchema = orchestrationSourceArgsSchema.shape.inspectionPin.unwrap().extend({
  recipeRevision: z.string().regex(/^[0-9a-f]{64}$/),
});
export type IdentityRecipeInspectionPin = z.infer<typeof pinSchema>;

const inspectionSchema = z.object({
  ok: z.literal(true),
  normalized: z.object({
    recipe: z.object({ id: z.string().min(1), revision: z.string().min(1) }),
    script: z.object({ source: z.string().min(1).max(20_000) }),
    staticToolCalls: z.array(z.object({ tool: z.string(), args: z.unknown(), dynamicArgs: z.boolean() })).max(200),
    bindings: z.object({ values: z.record(z.string(), z.unknown()) }),
    durability: z.object({ pin: pinSchema }),
    execution: z.object({ mode: z.literal('server'), lifecycle: z.literal('foreground') }),
  }),
});

export type IdentityRecipeConformance = {
  ok: true;
  recipe: { id: string; revision: string };
  inspectionPin: IdentityRecipeInspectionPin;
  toolNames: string[];
  requiredCapabilities: string[];
  outputSchema: Record<string, unknown>;
  /** The binding values the pin was taken over. The runtime re-inspects with
   * exactly these, so it reproduces the pinned bindingsSha256 (P-013, D-019). */
  bindings?: { values: Record<string, unknown> };
} | {
  ok: false;
  code: 'authority-unavailable' | 'output-schema-mismatch' | 'inspection-failed' |
    'inspection-pin-stale' | 'dynamic-tool-target' | 'tool-unavailable' |
    'effect-not-read' | 'egress-capability' | 'capability-denied';
};

/** Stored in the existing conformance run's report JSON. Per-verb evidence is
 * immutable with that run; it does not grant authority to execute a recipe. */
export interface IdentityRecipeClassConformanceReport extends Omit<ProviderConformanceReport, 'schemaVersion'> {
  schemaVersion: 'capability-class-recipe-v1';
  providerKind: 'recipe';
  latencyClass: 'sync';
  recipes: Record<string, Extract<IdentityRecipeConformance, { ok: true }>>;
}

/** Storage-boundary consistency check, using the registry's current immutable
 * class contract. Only the host inspector can supply evidence; this rejects
 * accidentally mixed report/binding tuples without executing the provider.
 */
export function assertIdentityRecipeClassConformance(input: {
  report: IdentityRecipeClassConformanceReport;
  capabilityClass: Pick<CapabilityClassRow, 'ref' | 'interfaceVerbs' | 'behavioralSuiteRef'>;
  verbBindings: Record<string, string>;
}): void {
  const { report, capabilityClass, verbBindings } = input;
  const verbs = Object.keys(capabilityClass.interfaceVerbs).sort();
  const checked = report.checks.map((check) => check.verb).sort();
  const expectedChecks = [...new Set([...verbs, ...Object.keys(verbBindings)])].sort();
  if (report.schemaVersion !== 'capability-class-recipe-v1' || report.providerKind !== 'recipe' ||
      report.latencyClass !== 'sync' || report.classRef !== capabilityClass.ref ||
      canonicalJson(checked) !== canonicalJson(expectedChecks) || !checked.length ||
      report.ok !== report.checks.every((check) => check.ok) ||
      report.checks.some((check) => check.tool !== null || check.ok !== (check.problems.length === 0)) ||
      report.behavioral.suiteRef !== capabilityClass.behavioralSuiteRef ||
      report.behavioral.status !== (capabilityClass.behavioralSuiteRef ? 'not-run' : 'not-required')) {
    throw new Error('recipe conformance report does not match the class contract and bindings');
  }
  for (const [verb, evidence] of Object.entries(report.recipes)) {
    const check = report.checks.find((entry) => entry.verb === verb);
    const contract = Object.hasOwn(capabilityClass.interfaceVerbs, verb) ? capabilityClass.interfaceVerbs[verb] : undefined;
    const pin = pinSchema.safeParse(evidence.inspectionPin);
    if (!contract || !check || evidence.ok !== true ||
        !Object.hasOwn(verbBindings, verb) || evidence.recipe.id !== verbBindings[verb] ||
        !pin.success || pin.data.recipeRevision !== evidence.recipe.revision ||
        !contract.outputSchema || !isCompilableSchema(contract.outputSchema) ||
        canonicalJson(evidence.outputSchema) !== canonicalJson(contract.outputSchema)) {
      throw new Error('recipe conformance inspection evidence does not match its verb binding');
    }
  }
  for (const check of report.checks) {
    if (check.ok && (!Object.hasOwn(report.recipes, check.verb) || !verbs.includes(check.verb))) {
      throw new Error('passing recipe conformance requires inspected evidence for every declared verb');
    }
  }
  if (report.ok && canonicalJson(Object.keys(report.recipes).sort()) !== canonicalJson(verbs)) {
    throw new Error('passing recipe conformance requires the exact declared verb set');
  }
}

/** Inspect every declared verb, preserving failed/missing/extra bindings in the
 * same report shape used by tool providers. The host supplies class/registry
 * metadata; packages cannot author their own passing inspection evidence. */
export async function inspectIdentityRecipeClassProvider(input: {
  capabilityClass: Pick<CapabilityClassRow, 'ref' | 'interfaceVerbs' | 'behavioralSuiteRef'>;
  providerPackage: string;
  providerVersion: string;
  registryRevision: string;
  recipes: Record<string, { recipe: SavedRecipeSelector & { revision: string };
    bindings?: { values: Record<string, unknown> }; outputSchema: Record<string, unknown> }>;
  declaredNeeds: readonly string[];
  capabilityCeiling: ReadonlySet<string>;
  context: UnifiedToolContext;
}, deps: { tools?: readonly ProjectedTool[]; recipes?: SavedRecipeAdapter } = {}): Promise<IdentityRecipeClassConformanceReport> {
  const checks: ProviderConformanceReport['checks'] = [];
  const recipes: IdentityRecipeClassConformanceReport['recipes'] = {};
  for (const verb of [...new Set([...Object.keys(input.capabilityClass.interfaceVerbs), ...Object.keys(input.recipes)])].sort()) {
    const contract = Object.hasOwn(input.capabilityClass.interfaceVerbs, verb) ? input.capabilityClass.interfaceVerbs[verb] : undefined;
    const binding = Object.hasOwn(input.recipes, verb) ? input.recipes[verb] : undefined;
    const problems: string[] = [];
    if (!contract) problems.push('binding names a verb the class does not declare');
    if (!binding) problems.push('missing provider recipe binding');
    if (contract && binding) {
      const result = await inspectIdentityRecipeProvider({ ...binding, contract,
        declaredNeeds: input.declaredNeeds, capabilityCeiling: input.capabilityCeiling, context: input.context }, deps);
      if (!result.ok) problems.push(result.code);
      else Object.defineProperty(recipes, verb, { value: result, enumerable: true });
    }
    checks.push({ verb, tool: null, ok: problems.length === 0, problems });
  }
  // Cancellation invalidates the whole inspection, including earlier verbs.
  if (input.context.signal.aborted) {
    for (const check of checks) {
      check.ok = false;
      if (!check.problems.includes('authority-unavailable')) check.problems.push('authority-unavailable');
    }
  }
  return { schemaVersion: 'capability-class-recipe-v1', providerKind: 'recipe', latencyClass: 'sync',
    ok: checks.length > 0 && checks.every((check) => check.ok),
    classRef: input.capabilityClass.ref, providerPackage: input.providerPackage,
    providerVersion: input.providerVersion, registryRevision: input.registryRevision, checks, recipes,
    behavioral: { status: input.capabilityClass.behavioralSuiteRef ? 'not-run' : 'not-required',
      suiteRef: input.capabilityClass.behavioralSuiteRef } };
}

/** External network rights have two existing spellings: capability:net for
 * host fetch and net:* for plugin confinement. Wildcard tool requirements
 * cannot prove absence of egress either. */
export function hasEgress(capability: string): boolean {
  return capability === '*' || capability === 'capability:*' || capability === 'capability:net' ||
    capability === 'net' || capability.startsWith('net:');
}

/** Inspect only direct, literal facade targets. The general script parser also
 * permits aliases/higher-order calls which its static call census cannot prove
 * complete. Such scripts remain ordinary recipes; identity admission refuses
 * them. No eval, alternate executor, or new tool-name resolver is introduced.
 */
async function hasIndirectFacadeUse(source: string): Promise<boolean> {
  const loaded = await import('typescript');
  const ts = loaded.default ?? loaded;
  const file = ts.createSourceFile('identity-recipe.ts', source, ts.ScriptTarget.Latest, true);
  let indirect = false;
  const literal = (node: import('typescript').Node | undefined): string | null =>
    node && ts.isStringLiteralLike(node) ? node.text : null;
  function visit(node: import('typescript').Node): void {
    // Dynamic code and reflection have no complete static tool-call census.
    if ((ts.isIdentifier(node) && ['eval', 'Function', 'Reflect', 'globalThis'].includes(node.text)) ||
        (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') ||
        (ts.isElementAccessExpression(node) &&
          (literal(node.argumentExpression) === null || literal(node.argumentExpression) === 'constructor')) ||
        node.kind === ts.SyntaxKind.ImportKeyword) indirect = true;
    // In tools.tools.invoke the second identifier is a property name, not a
    // second reference to the facade root.
    if (ts.isIdentifier(node) && node.text === 'tools' &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      let current: import('typescript').Node = node;
      const parts: string[] = [];
      while (current.parent &&
        ((ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) ||
         (ts.isElementAccessExpression(current.parent) && current.parent.expression === current))) {
        const parent = current.parent;
        const key = ts.isPropertyAccessExpression(parent) ? parent.name.text : literal(parent.argumentExpression);
        if (key === null) { indirect = true; break; }
        parts.push(key);
        current = parent;
      }
      const call = current.parent;
      if (!call || !ts.isCallExpression(call) || call.expression !== current ||
          !((parts.length === 2 && parts[0] !== 'call') ||
            (parts.length === 1 && parts[0] === 'call' && literal(call.arguments[0]) !== null))) {
        indirect = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return indirect;
}

/** Grants = wearer ∩ declared needs ∩ pot/role ceiling; '*' in one set admits
 * whatever the others name. Shared by inspection and the runtime (P-013). */
export function narrowIdentityCapabilities(
  wearer: ReadonlySet<string>, declaredNeeds: readonly string[], ceiling: ReadonlySet<string>,
): Set<string> {
  const sets = [wearer, new Set(declaredNeeds), ceiling];
  const candidates = new Set(sets.flatMap((set) => [...set]));
  return new Set([...candidates].filter((cap) => sets.every((set) => set.has(cap) || set.has('*'))));
}

type IdentityRecipeInspectionInput = {
  recipe: SavedRecipeSelector & { revision: string };
  bindings?: { values: Record<string, unknown> };
  contract: CapabilityClassVerb;
  outputSchema: Record<string, unknown>;
  declaredNeeds: readonly string[];
  capabilityCeiling: ReadonlySet<string>;
  context: UnifiedToolContext;
  expectedPin?: IdentityRecipeInspectionPin;
};
type IdentityRecipeInspectionDeps = { tools?: readonly ProjectedTool[]; recipes?: SavedRecipeAdapter };

/** What the runtime needs beyond the persisted evidence. Never stored: the
 * source and bound inputs are re-derived by re-inspection on every call. */
export interface IdentityRecipeRunMaterial {
  source: string;
  inputs: Record<string, unknown>;
  capabilities: ReadonlySet<string>;
  tools: readonly ProjectedTool[];
}

/** Installation-time inspection under the wearer, narrowed by declared needs
 * and the host's pot/role ceiling. Tools/recipes deps are trusted host seams,
 * never values accepted from an identity package.
 */
export async function inspectIdentityRecipeProvider(
  input: IdentityRecipeInspectionInput, deps: IdentityRecipeInspectionDeps = {},
): Promise<IdentityRecipeConformance> {
  return (await inspectRecipe(input, deps)).conformance;
}

/** The same inspection, for the P-013 runtime: a passing result also carries
 * the re-inspected script and inputs, so what runs is what was just pinned. */
export async function inspectIdentityRecipeProviderForRun(
  input: IdentityRecipeInspectionInput & { expectedPin: IdentityRecipeInspectionPin },
  deps: IdentityRecipeInspectionDeps = {},
): Promise<{ conformance: IdentityRecipeConformance; run?: IdentityRecipeRunMaterial }> {
  return inspectRecipe(input, deps);
}

async function inspectRecipe(
  input: IdentityRecipeInspectionInput, deps: IdentityRecipeInspectionDeps,
): Promise<{ conformance: IdentityRecipeConformance; run?: IdentityRecipeRunMaterial }> {
  const refuse = (code: Extract<IdentityRecipeConformance, { ok: false }>['code']) =>
    ({ conformance: { ok: false as const, code } });
  const ctx = input.context;
  if (!ctx.principal || !ctx.role || !ctx.workspaceId || ctx.principal.workspaceId !== ctx.workspaceId ||
      ctx.signal.aborted) return refuse('authority-unavailable');
  if (!input.contract.outputSchema || !isCompilableSchema(input.contract.outputSchema) ||
      canonicalJson(input.contract.outputSchema) !== canonicalJson(input.outputSchema)) {
    return refuse('output-schema-mismatch');
  }
  const capabilities = narrowIdentityCapabilities(ctx.principal.capabilities, input.declaredNeeds,
    input.capabilityCeiling);
  const context: UnifiedToolContext = {
    ...ctx, isSuperuser: false, gateBypass: undefined,
    principal: { ...ctx.principal, capabilities },
  };
  const tools = deps.tools ?? listAllProjectedTools();
  // A nested general-purpose runner would escape this recipe's inspected call
  // set. Keep the canonical recursion exclusions and cover the saved-recipe door.
  const allowed = roleScopedToolNames(tools, ctx.role,
    new Set([...ORCHESTRATION_RECURSION_EXCLUSIONS, 'recipes:run']));
  const inspected = await inspectOrchestration({
    recipe: input.recipe, ...(input.bindings ? { bindings: input.bindings } : {}),
    execution: { mode: 'server', lifecycle: 'foreground' }, capture: { mode: 'never' },
  }, context, {
    ...(deps.recipes ? { recipes: deps.recipes } : {}), projectedTools: tools,
    inspectScript: (args) => inspectScriptContract({ ...args,
      surface: { tools, allowed, catalog: currentCallerRecipeCatalog(tools, allowed) },
    }),
  });
  if (ctx.signal.aborted) return refuse('authority-unavailable');
  const parsed = inspectionSchema.safeParse((inspected as { data?: unknown }).data);
  if (!parsed.success) return refuse('inspection-failed');
  const normalized = parsed.data.normalized;
  const pin = normalized.durability.pin;
  if (normalized.recipe.id !== input.recipe.id || normalized.recipe.revision !== input.recipe.revision ||
      pin.recipeRevision !== input.recipe.revision ||
      pin.sourceSha256 !== createHash('sha256').update(normalized.script.source).digest('hex') ||
      (input.expectedPin && canonicalJson(input.expectedPin) !== canonicalJson(pin))) {
    return refuse('inspection-pin-stale');
  }
  if (await hasIndirectFacadeUse(normalized.script.source)) return refuse('dynamic-tool-target');
  const byName = new Map(tools.map((tool) => [tool.expose.mcp?.name, tool]));
  const required = new Set<string>();
  const names = new Set<string>();
  for (const call of normalized.staticToolCalls) {
    let name = call.tool;
    let args = call.args;
    const seen = new Set<string>();
    // Resolve every tools:invoke hop, not merely the first one. Metadata on the
    // wrapper cannot launder the target's effect, network rights or capabilities.
    for (;;) {
      const tool = byName.get(name);
      if (!tool || !allowed.has(name) || seen.has(name)) return refuse('tool-unavailable');
      seen.add(name);
      names.add(name);
      for (const cap of tool.capabilities) {
        if (hasEgress(cap)) return refuse('egress-capability');
        if (!capabilities.has(cap) && !capabilities.has('*')) return refuse('capability-denied');
        required.add(cap);
      }
      if (name === 'tools:invoke') {
        if (call.dynamicArgs || !args || typeof args !== 'object' || Array.isArray(args) ||
            !('name' in args) || typeof args.name !== 'string') return refuse('dynamic-tool-target');
        const nested = args as { name: string; args?: unknown };
        name = nested.name.trim();
        args = nested.args;
        continue;
      }
      // General dry-run classifiers may fall back on static metadata after an
      // error. A read-only identity needs affirmative per-call evidence instead.
      if (tool.effectForCall) {
        if (call.dynamicArgs) return refuse('effect-not-read');
        try { if (tool.effectForCall(args) !== 'read') return refuse('effect-not-read'); }
        catch { return refuse('effect-not-read'); }
      }
      if (classifyDurableCall(tool, name, args, tools) !== 'read-only') return refuse('effect-not-read');
      break;
    }
  }
  return {
    conformance: { ok: true, recipe: normalized.recipe, inspectionPin: pin,
      toolNames: [...names].sort(), requiredCapabilities: [...required].sort(),
      outputSchema: JSON.parse(canonicalJson(input.contract.outputSchema)) as Record<string, unknown>,
      ...(input.bindings ? { bindings: { values: input.bindings.values } } : {}) },
    run: { source: normalized.script.source, inputs: normalized.bindings.values, capabilities, tools },
  };
}
