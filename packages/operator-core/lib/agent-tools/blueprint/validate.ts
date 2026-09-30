/**
 * blueprint:validate — check a blueprint (a built-in id, or inline YAML/JSON)
 * against the schema + the semantic validator (reachability, termination, guards,
 * bounded recursion). Returns errors + warnings instead of throwing, so an agent
 * can iterate on an authored blueprint.
 *
 * harness-blueprint-orchestration-2026-06-03 P-007 / B1.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readFileSync } from 'node:fs';
import { builtinBlueprintPath, loadBlueprintFromFile, parseBlueprintSourceDocument } from '@papercusp/orchestrator/blueprint';
import { COORD_ROLES } from '../coordination/roles';
import { operatorResolveExtends } from '../../blueprint/installed-blueprints';
import { inspectIdentitySource } from '../../agent-identities/source';
import { parseBlueprintSource, resolveAndValidate, type ResolveResult } from './_resolve';

function summarize(r: ResolveResult) {
  if (r.parseError) return { ok: false, parseError: r.parseError };
  const bp = r.blueprint!;
  return {
    ok: r.ok,
    errors: r.validation!.errors,
    warnings: r.validation!.warnings,
    summary: {
      id: bp.id,
      version: bp.version,
      workItemKind: bp.workItem.kind,
      roles: bp.roles.map((x) => x.id),
      // `edges` is absent on a program-mode spine (coord-op steps + gate) — show
      // its step ids instead so the summary is non-empty for vote/deliberate.
      spineVerbs: Object.keys(bp.spine.edges ?? {}),
      spineSteps: (bp.spine.steps ?? []).map((s) => s.id),
      requiresRepo: bp.knobs.requiresRepo,
    },
  };
}

/**
 * P-015 (D-033): a runnable identity is also compiled in the caller's pot, so
 * compile and grant issues and the declared surface appear here too.
 */
async function summarizeIdentity(
  result: ReturnType<typeof inspectIdentitySource>,
  target: { workspaceId?: string; potSlug?: string; identityId?: string; source?: Record<string, unknown> },
) {
  if (!result.ok && !('errors' in result)) {
    return { ok: false, parseError: result.error };
  }
  const identity = result.identity;
  let pkg = null;
  if (result.ok && result.runnable) {
    const { identityPackageValidation } = await import('../../agent-identities/identity-preview');
    pkg = await identityPackageValidation({ workspaceId: target.workspaceId, potSlug: target.potSlug,
      ...(target.identityId ? { identityId: target.identityId } : { source: target.source }) });
  }
  return {
    ok: result.ok && (pkg?.ok ?? true),
    errors: result.errors,
    warnings: result.warnings,
    ...(pkg ? { package: pkg } : {}),
    summary: {
      id: identity?.id,
      version: identity?.version,
      sourceKind: 'identity' as const,
      runnable: result.runnable,
      slots: identity?.slots?.map((slot) => slot.slot) ?? [],
      layers: result.layers?.map((layer) => layer.id) ?? [],
    },
  };
}

/**
 * Workspace provisioning may materialize an exact copy of an official identity
 * into the installed tier so prompt composition can resolve it by id. That copy
 * is still the built-in document, not an independently published layer, so use
 * the canonical path for trust classification while preserving the composed
 * resolver for its parents. A changed installed override remains subject to the
 * installed-layer attestation requirement.
 */
function trustPathForIdentity(id: string, resolvedPath: string): string {
  const builtinPath = builtinBlueprintPath(id);
  try {
    if (readFileSync(resolvedPath, 'utf8') === readFileSync(builtinPath, 'utf8')) return builtinPath;
  } catch {
    // Keep the resolved path; the identity inspector will report its actual error.
  }
  return resolvedPath;
}

export default defineTool({
  name: 'blueprint:validate',
  description:
    'Validate a Harness Blueprint — a blueprint id (resolved installed → built-in, e.g. "coding" or a Cupboard-installed id) OR inline YAML/JSON. Returns {ok, errors, warnings, summary} (errors/warnings instead of throwing) so you can iterate. Checks the Zod schema + reachability/termination/guards/bounded-recursion.',
  guidance: {
    when: 'Before persisting a blueprint you authored (with blueprint:create/extend) or to inspect a built-in. Always validate before writing .papercusp/blueprint.yaml or calling harness:create.',
    notWhen: 'To run a blueprint — that is the orchestrator. To create a harness — harness:create.',
    chaining: 'blueprint:create/extend → blueprint:validate → (write .papercusp/blueprint.yaml or harness:create).',
    seeAlso: [
      'blueprint:create (author a blueprint to validate)',
      'blueprint:extend (extend one)',
      'harness:create (create a harness from the validated blueprint)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('A blueprint id — resolved installed → built-in (coding, base, …)'),
      source: z.string().min(1).optional().describe('Inline blueprint as YAML or JSON'),
    })
    .refine((a) => a.id != null || a.source != null, { message: 'pass either id or source' }),
  async handler(args, ctx) {
    let result: ResolveResult;
    const pot = { workspaceId: ctx?.workspaceId, potSlug: ctx?.harnessSlug };
    if (args.id != null) {
      try {
        const resolver = operatorResolveExtends();
        const file = resolver(args.id);
        if (!file) throw new Error(`no blueprint "${args.id}" in the installed or built-in tiers`);
        const raw = parseBlueprintSource(readFileSync(file, 'utf8'));
        if (parseBlueprintSourceDocument(raw).kind === 'identity') {
          const sourcePath = trustPathForIdentity(args.id, file);
          const summary = await summarizeIdentity(inspectIdentitySource(raw, { sourcePath }), { ...pot, identityId: args.id });
          return { content: [{ type: 'text' as const, text: JSON.stringify(summary) }] };
        }
        const loaded = loadBlueprintFromFile(file, resolver);
        result = { ok: loaded.validation.ok, blueprint: loaded.blueprint, validation: loaded.validation };
      } catch (e) {
        result = { ok: false, parseError: e instanceof Error ? e.message : String(e) };
      }
    } else {
      try {
        const raw = parseBlueprintSource(args.source!);
        if (parseBlueprintSourceDocument(raw).kind === 'identity') {
          const summary = await summarizeIdentity(inspectIdentitySource(raw), { ...pot, source: raw });
          return { content: [{ type: 'text' as const, text: JSON.stringify(summary) }] };
        }
        result = resolveAndValidate(raw);
      } catch (e) {
        result = { ok: false, parseError: e instanceof Error ? e.message : String(e) };
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(summarize(result)) }] };
  },
});
