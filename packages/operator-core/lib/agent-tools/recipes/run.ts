/**
 * recipes:run — THE REUSE PATH (code-recipes-2026-06-21 Phase 2, P-005 / P-006 /
 * D-004 / D-012; bulk-standardized per bulk-endpoint-standardization-2026-06-21).
 *
 * Load one OR many saved code:run RECIPEs by id and execute each script — but
 * under the REUSER's role-scoped envelope, NOT the author's. A recipe is just a
 * script; no privilege travels with it. The facade is built from
 * `roleScopedToolNames(all, ctx.role, exclude code:run)` — the SAME role-scoped
 * allow-set code:run itself builds for the CALLER — so when agent B runs agent A's
 * recipe, the script can only touch tools B may already call (D-004, the tested
 * security invariant P-006). A recipe authored by an operator and run by a worker
 * is scoped to worker-allowed tools.
 *
 * On a successful, non-dry-run reuse, records a run with `reused: true` (the
 * distinct-from-authored signal Phase-3 graduation reads). Best-effort recording —
 * a failure there must not fail the run. Returns each script's summary like
 * code:run.
 *
 * Bulk by default (the house keyed-array contract): run ONE inline ({ id, dryRun?,
 * timeoutSec? }), MANY with the SAME dryRun/timeout (ids:[…] + dryRun?), or MANY
 * heterogeneous (items:[{ id, dryRun?, timeoutSec? }]) → { ok, results:[{ ok, id,
 * result? | error }], counts }. Each result self-describes its id; a recipe that
 * fails to run never fails the rest (top-level ok = "the batch ran",
 * counts.failed is the truth). Per-recipe exec semantics are preserved exactly.
 *
 * Server-only.
 */
import { z } from 'zod';
import {
  defineTool,
  listAllProjectedTools,
  runToolOrchestration,
  roleScopedToolNames,
  AGENT_ROLES,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveLearningPotSlug } from '../../learning/pot-scope';
import { getRecipe, recordRecipeRun } from '../../code-recipes-store';
import { PROJECTED_DEPS } from '../../projected-tool-deps';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { DISPATCH_WRAPPER_METADATA_KEY } from '../sessions/automatic-tool-names';
import { dispatchWrapperMarkEnabled } from '../../telemetry-dispatch-wrapper';
import {
  resolveLiveBoundRefs,
  recipeAuthorityContextFromRefs,
  recipeAuthorityMatchesLiveRefs,
  validateRecipeAuthorityProof,
  type RecipeAuthorityMetadata,
  type RecipeAuthorityRefs,
  type RecipeAuthorityProof,
} from '../../recipe-authority';
import { deriveFleetMembership } from '../coordination/identity';
import { resolvePresenceFleet } from '../coordination/presence-fleet';
import { getTxPool } from '../locks/su-lock-store';
import { readIdentity } from '../locks/identity';
import { FOREGROUND_TIMEOUT_CEILING_MS } from '../capability/foreground-transport-cap';
import { validateRecipeScriptAgainstCatalog } from './recipe-schema-validation';
import { bindCurrentCallerDispatch } from '../orchestration/current-caller-dispatch';
import { normalizeExecutionTrace } from '../../orchestration-trace';
import {
  deriveLegacyForegroundManifest,
  preflightRecipeContract,
  projectedToolName,
  type CurrentCallerCapabilityCatalog,
  type LogicalCapability,
  type RecipeBindingSet,
  type RecipeContractFailure,
  type ReplayClass,
} from '../../recipe-contract';
import {
  currentCallerRecipeCatalog,
  ORCHESTRATION_RECURSION_EXCLUSIONS,
  runtimeRecipeReplayClass,
} from '../orchestration/contract-preflight';

interface RunItem {
  id: string;
  dryRun?: boolean;
  timeoutSec?: number;
  authority?: RecipeAuthorityProof | RecipeAuthorityMetadata;
  bindings?: RecipeBindingSet;
}

const authorityContextSchema = z.object({
  workspace: z.string().min(1).optional(),
  fleet: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  items: z.array(z.string().min(1)).max(100).optional(),
  resources: z.array(z.string().min(1)).max(100).optional(),
}).strict();

const authorityProofSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  context: authorityContextSchema,
}).strict();

const authorityMetadataSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  refs: z.object({
    workspaces: z.array(z.string().min(1)),
    fleets: z.array(z.string().min(1)),
    plans: z.array(z.string().min(1)),
    harnesses: z.array(z.string().min(1)),
    items: z.array(z.string().min(1)),
    resources: z.array(z.string().min(1)),
  }).strict(),
  requiresContext: z.boolean(),
  runnable: z.boolean(),
  // WI-40896 / D-048: recipes:get now also emits `refsMeasured` + `unresolvedCause`
  // so an UNMEASURED authority set is distinguishable from an empty one. This
  // schema is `.strict()`, so those keys MUST be declared here or round-tripping
  // recipes:get's own metadata straight back into recipes:run would be rejected
  // as an unrecognized key. Both are optional: older stored payloads predate them.
  // `unresolvedCause` is accepted but deliberately not re-validated here — it is a
  // 10-variant discriminated union that this handler never reads (the proof context
  // is derived from `refs`), so restating it would be a second copy of a type the
  // authority module already owns, free to drift.
  refsMeasured: z.boolean().optional(),
  // ACCEPTED, NEVER READ, DELIBERATELY NOT REVALIDATED. This key exists only so
  // recipes:get's own metadata survives the `.strict()` round-trip back into
  // recipes:run; the proof context is derived from `refs`, so this handler never
  // reads the value. Three alternatives were tried and each is WRONG here —
  // recorded because every one of them looks correct until it fails:
  //   - restating the 9-variant union as Zod: a second copy of a type
  //     recipe-authority.ts owns, free to drift from it;
  //   - `z.unknown()`: widens the inferred field to `unknown`, which is NOT
  //     assignable to RecipeAuthorityMetadata['unresolvedCause'] and strands the
  //     `const list: RunItem[]` assignment below with TS2322 (measured: it did);
  //   - `z.custom<RecipeUnresolvedCause>()`: typechecks CLEAN, then breaks the
  //     ENTIRE tool catalog at runtime — custom types cannot be represented in
  //     JSON Schema, and that conversion runs when tools/list is served, so one
  //     unrepresentable schema kills tool discovery for every client.
  // `z.any()` is JSON-Schema representable AND assignable to the target type.
  unresolvedCause: z.any().optional(),
}).strict();

const authorityInputSchema = z.union([authorityProofSchema, authorityMetadataSchema]);

function isAuthorityMetadata(
  authority: RecipeAuthorityProof | RecipeAuthorityMetadata,
): authority is RecipeAuthorityMetadata {
  return 'refs' in authority;
}

const bindingsInputSchema = z
  .object({ values: z.record(z.string(), z.unknown()) })
  .strict();

function preflightResult(id: string, failure: RecipeContractFailure): BulkItemResult {
  return {
    ok: false,
    id,
    phase: failure.phase,
    executed: failure.executed,
    error: failure.error.code,
    diagnostic: failure.error,
  };
}

export default defineTool({
  name: 'recipes:run',
  description:
    'Run saved code:run recipes by id under YOUR role-scoped tool envelope (not the author\'s); recipes carry no privilege. ' +
    'Use exact authority/runArgs from recipes:search or recipes:get; both are revalidated against the stored revision and YOUR live lane. ' +
    'Use dryRun:true before write-effect runs. Contracted recipes accept non-secret bindings:{ values:{…} } validated against the stored revision. ' +
    'Supports single { id,… }, homogeneous ids:[…], or heterogeneous items:[…]. Returns { ok, results, counts }; correlate by id; one failure does not fail others.',
  guidance: {
    when:
      'Reuse a recipe from recipes:search/recipes:list or code:run.similarRecipes instead of re-authoring it. ' +
      'Batch with ids:[…] or items:[…]; reuse is limited to tools allowed for YOUR role.',
    notWhen:
      'When no recipe fits, author code:run (it auto-captures + dedups). Preview writes with dryRun:true; on authority_unresolved, read `reason`.',
    chaining:
      'recipes:search { query } → recipes:get { ids:[…] } → recipes:run { id, authority, dryRun:true } → recipes:run { id }. ' +
      'Bulk: ids:[…] or items:[…]; correlate results by id.',
    seeAlso: [
      'recipes:get (inspect the recipe\'s script before running)',
      'recipes:search (find the right recipe to run)',
      'code:run (author a fresh script when no recipe fits)',
    ],
  },
  // Match code:run's orchestration entry gate. Evidence-only principals such as
  // judges may reuse recipes containing only their authorized reads; every inner
  // call still passes through the caller's role-scoped facade and dispatcher.
  capability: 'agent_tools:read',
  effect: 'write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-run shorthand: the recipe id / kebab slug'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Preview: record effect:write tool calls without executing them (reads still run). Applies to the inline id / every id in `ids`.'),
      timeoutSec: z
        .number()
        .int()
        .min(1)
        .max(FOREGROUND_TIMEOUT_CEILING_MS / 1000)
        .optional()
        .describe(
          `Wall-clock budget (default 30s; maximum ${FOREGROUND_TIMEOUT_CEILING_MS / 1000}s). ` +
            `Applies to the inline id / every id in ids; larger values are rejected because ` +
            `recipe execution is foreground-only.`,
        ),
      authority: authorityInputSchema.optional().describe('Exact proof from a recommendation\'s runArgs, or authority metadata from recipes:get; required for entity-bound recipes.'),
      bindings: bindingsInputSchema.optional().describe('Runtime values validated against this recipe revision\'s stored binding schema; secret refs never enter the script VM.'),
      ids: z.array(z.string().min(1)).min(1).max(50).optional().describe('run MANY recipes with the same dryRun/timeoutSec (homogeneous)'),
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            dryRun: z.boolean().optional(),
            timeoutSec: z
              .number()
              .int()
              .min(1)
              .max(FOREGROUND_TIMEOUT_CEILING_MS / 1000)
              .optional(),
            authority: authorityInputSchema.optional(),
            bindings: bindingsInputSchema.optional(),
          }),
        )
        .min(1)
        .max(50)
        .optional()
        .describe('run many recipes at once — each { id, dryRun?, timeoutSec? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const sql = getOrgPg().sql;
    const list: RunItem[] = args.items?.length
      ? args.items.map((it) => ({
          id: it.id,
          dryRun: it.dryRun ?? args.dryRun,
          timeoutSec: it.timeoutSec ?? args.timeoutSec,
          authority: it.authority ?? args.authority,
          bindings: it.bindings ?? args.bindings,
        }))
      : args.ids?.length
        ? args.ids.map((id) => ({
            id,
            dryRun: args.dryRun,
            timeoutSec: args.timeoutSec,
            authority: args.authority,
            bindings: args.bindings,
          }))
        : [{
            id: args.id as string,
            dryRun: args.dryRun,
            timeoutSec: args.timeoutSec,
            authority: args.authority,
            bindings: args.bindings,
          }];

    // Resolve the REUSER's identity ONCE (used by every per-recipe run-record).
    // Best-effort: a recipe run does not require an identity to execute.
    let ownerId: string | null = null;
    let coordinationDomain: string | null = null;
    try {
      const identity = readIdentity(ctx);
      ownerId = identity.ownerId;
      coordinationDomain = identity.coordinationDomain;
    } catch {
      ownerId = null;
      coordinationDomain = null;
    }
    let liveFleet: string | null = null;
    try {
      liveFleet = (await resolvePresenceFleet(ownerId ?? undefined, deriveFleetMembership())).fleetSlug;
    } catch {
      liveFleet = null;
    }
    const liveAuthorityContext = {
      workspace: workspaceId,
      ...(liveFleet ? { fleet: liveFleet } : {}),
      ...(ctx.harnessSlug ? { harness: ctx.harnessSlug } : {}),
    };
    // P-012 (census double-count): aggregate inner dispatches across the whole batch —
    // each wrote its own telemetry row, so this row is wrapper overhead when > 0.
    let totalInnerDispatches = 0;
    let liveBoundRefsPromise: Promise<RecipeAuthorityRefs> | null = null;
    let runPotSlugPromise: Promise<string | null> | null = null;
    const runPotSlug = (): Promise<string | null> => {
      runPotSlugPromise ??= resolveLearningPotSlug({
        workspaceId,
        harnessSlug: ctx.harnessSlug ?? null,
      });
      return runPotSlugPromise;
    };
    const liveBoundRefs = (): Promise<RecipeAuthorityRefs> | null => {
      if (!ownerId || !coordinationDomain) return null;
      liveBoundRefsPromise ??= resolveLiveBoundRefs(sql, getTxPool(), ownerId, coordinationDomain);
      return liveBoundRefsPromise;
    };

    const all = listAllProjectedTools();
    // SECURITY INVARIANT (D-004 / P-006): scope to the REUSER's role (ctx.role) —
    // NEVER recipe.authorRole. A recipe carries no privilege; the facade only
    // contains tools the running agent may already call. Exclude code:run so a
    // recipe can't recursively nest code-mode. Computed ONCE — the same envelope
    // gates every recipe in the batch.
    const allowed = roleScopedToolNames(all, ctx.role, ORCHESTRATION_RECURSION_EXCLUSIONS);

    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const recipe = await getRecipe(sql, it.id);
        if (!recipe) {
          return { ok: false, id: it.id, error: 'not_found' };
        }
        // A recipe can outlive a tool-schema change. Validate the statically
        // provable calls against the CURRENT catalog before execution so a
        // removed enum/argument (e.g. checkpoint-run op:"status") fails with
        // an actionable stale-recipe result instead of a runtime surprise.
        const schemaValidation = await validateRecipeScriptAgainstCatalog(recipe.script, all);
        if (!schemaValidation.ok) {
          return {
            ok: false,
            id: it.id,
            error: 'recipe_schema_stale',
            schemaIssues: schemaValidation.issues,
          };
        }
        const staticToolNames = [...new Set([
          ...schemaValidation.staticToolNames.map(projectedToolName),
          ...recipe.toolsUsed.map(projectedToolName),
        ])].sort();
        const contract = preflightRecipeContract({
          manifest: recipe.capabilityManifest ?? deriveLegacyForegroundManifest(staticToolNames),
          bindingSchema: recipe.bindingSchema ?? undefined,
          bindings: it.bindings,
          staticToolNames,
          lifecycle: 'foreground',
          derivedReplayClass: runtimeRecipeReplayClass(staticToolNames, all),
          catalog: currentCallerRecipeCatalog(all, allowed),
        });
        if (!contract.ok) return preflightResult(it.id, contract);
        const authority = await validateRecipeAuthorityProof({
          script: recipe.script,
          updatedAt: recipe.updatedAt,
          bindingSchema: recipe.bindingSchema,
          capabilityManifest: recipe.capabilityManifest,
          proof: it.authority
            ? isAuthorityMetadata(it.authority)
              ? {
                  version: it.authority.version,
                  revision: it.authority.revision,
                  context: recipeAuthorityContextFromRefs(it.authority.refs),
                }
              : it.authority
            : undefined,
          liveContext: liveAuthorityContext,
        });
        if (!authority.ok) {
          // EI-12057: `reason` distinguishes a PERMANENT, by-design limitation
          // (authority_unresolved — the recipe embeds an opaque/unprovable call,
          // e.g. dev:pg_query; no proof, nested or top-level, can ever fix it) from
          // a FIXABLE one (authority_required — go get a proof), so a caller who
          // hit this via a nested `tools.recipes.run(...)` composition doesn't
          // mistake it for "nesting is broken" when the target recipe itself
          // simply can't be authority-verified.
          return { ok: false, id: it.id, error: authority.error, reason: authority.reason };
        }
        const needsLiveRefs =
          authority.descriptor.refs.plans.length > 0 ||
          authority.descriptor.refs.items.length > 0 ||
          authority.descriptor.refs.resources.length > 0;
        if (needsLiveRefs) {
          const pendingRefs = liveBoundRefs();
          if (!pendingRefs) return { ok: false, id: it.id, error: 'authority_live_context_unavailable' };
          let refs: RecipeAuthorityRefs;
          try {
            refs = await pendingRefs;
          } catch {
            return { ok: false, id: it.id, error: 'authority_live_context_unavailable' };
          }
          if (!recipeAuthorityMatchesLiveRefs(authority.descriptor, refs)) {
            return { ok: false, id: it.id, error: 'authority_entity_mismatch' };
          }
        }
        const dryRun = it.dryRun ?? false;
        const result = await runToolOrchestration(recipe.script, {
          // EI-20066912585022608: a recipe script consumes tool results as JS VALUES,
          // exactly like the code:run script it was captured FROM — so it has to be
          // told the same thing, or a handler that renders text for a model (and
          // structure for a script) hands a recipe replay the raw string. That would
          // silently change the shape of a script that was authored and verified under
          // code:run: `r.output` verified fine, then reads undefined on every replay.
          ctx: { ...ctx, codeMode: true },
          deps: PROJECTED_DEPS,
          tools: all,
          allowed,
          dryRun,
          timeoutMs: it.timeoutSec ? it.timeoutSec * 1000 : undefined,
          wrapDispatch: bindCurrentCallerDispatch,
          inputs: contract.value.bindings.inputs,
        });
        // P-012: counted before any early return below — a failed item's dispatches
        // still wrote their own telemetry rows.
        totalInnerDispatches += result.dispatchCount ?? 0;
        const { callRecords, ...publicResult } = result;

        // EI-20224785432797349: code-mode tracks reads of fields that are absent from a
        // child tool result. Treat those misses as a failed recipe reuse, even when the
        // script itself returned normally with partial:false. Otherwise a saved recipe
        // can keep reporting ok:true while its compact summary is silently populated with
        // undefined values after a tool-schema change. The caller must update the recipe
        // script before it is eligible for a successful reuse record again.
        const fieldMisses = Array.isArray(result.fieldMisses) ? result.fieldMisses : [];
        const successfulReuse = Boolean(result.ok) && fieldMisses.length === 0;

        // P-013: every EXECUTED saved script gets one normalized trace row,
        // including failures and dry-run previews. Only a successful committing
        // reuse moves the parent recipe's popularity counters, preserving their
        // established meaning while making all execution evidence durable.
        try {
          const executionTrace = await normalizeExecutionTrace({
            script: recipe.script,
            backend: 'server',
            tools: all,
            allowed,
            callRecords,
          });
          await recordRecipeRun(sql, {
            recipeId: recipe.id,
            workspaceId,
            potSlug: await runPotSlug(),
            agentOwner: ownerId,
            agentRole: ctx.role ?? null,
            success: successfulReuse,
            reused: true,
            executionTrace,
            countTowardRecipe: successfulReuse && !dryRun,
          });
        } catch (err) {
          ctx.log(`recipes:run trace record failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
        }

        if (fieldMisses.length > 0) {
          return {
            ok: false,
            id: it.id,
            error: 'recipe_field_miss',
            fieldMisses,
            reason:
              'the saved recipe read fields absent from current tool results; update the recipe script before reusing it',
            result: publicResult,
          };
        }

        // The script's own ok/error rides inside `result`; the item is "ok" in the
        // sense that the recipe RAN — mirror the result's ok so counts.failed
        // reflects scripts that failed, not just recipes that were absent.
        return { ok: Boolean(result.ok), id: it.id, result: publicResult };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );

    // P-012: mark this row as a dispatch wrapper only when the batch actually
    // dispatched inner tools (a dry-run or not-found batch stays countable).
    if (totalInnerDispatches > 0 && (await dispatchWrapperMarkEnabled())) {
      ctx.metadata?.({
        [DISPATCH_WRAPPER_METADATA_KEY]: true,
        dispatchedToolCalls: totalInnerDispatches,
      });
    }

    return bulkContent(env);
  },
});
