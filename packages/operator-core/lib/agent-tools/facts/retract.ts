/**
 * facts:retract — soft-retract a standing fact by (scope, scopeRef, key) so it
 * stops folding into briefs/dossiers/orients (queen-memory-hybrid L1b).
 * A stale fact delivered verbatim is worse than no fact — retract promptly.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { retractFact, findFactKeyElsewhere, findFactKeyMatches, findFactKeyState, FACT_SCOPES } from '../../agent-facts/store';
import { resolveScopeRefFromCtx, resolveScopeRefAlias } from './scope-ctx';

export default defineTool({
  name: 'facts:retract',
  capability: 'coord:write',
  description:
    'Retract a standing fact by (scope, scopeRef, key) with a reason — it immediately stops folding into briefs/dossiers/orients. If the key identifies exactly one current fact, scope and scopeRef may be omitted. Soft-delete (actor and reason retained in the 30-day audit trail).',
  guidance: {
    when:
      'A previously-asserted fact is no longer true (the residue cleared, the plan unstalled, the workaround shipped). Retract PROMPTLY — facts fold verbatim, so a stale one actively misleads every future turn.',
    notWhen: 'To update/replace the conclusion — facts:assert with the same key overwrites in place.',
    chaining:
      'facts:list { scope } → facts:retract { scope, scopeRef, key, reason }. When the key is unique across current facts, scope and scopeRef may be omitted; an ambiguous key must be scoped explicitly.',
    seeAlso: ['facts:assert (re-assert same key = update)', 'facts:list'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: z.object({
    scope: z
      .enum(FACT_SCOPES)
      .optional()
      .describe('Optional only when key matches exactly one current fact; required when the key is ambiguous.'),
    scopeRef: z.string().max(120).optional(),
    scope_ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    ref: z.string().max(120).optional().describe('Alias for scopeRef (EI-7371) — prefer scopeRef.'),
    harness: z.string().max(120).optional().describe('Alias for scopeRef when scope:"harness" (EI-7371) — prefer scopeRef.'),
    key: z.string().min(1).max(120),
    reason: z.string().min(1).max(500).describe('Why this fact stopped being true, ≤500 chars (longer is refused) — retained in the 30-day audit trail.'),
  }),
  async handler(args, ctx) {
    const { resolveAgentIdentity } = await import('../coordination/identity');
    const identity = resolveAgentIdentity(ctx);
    let scope = args.scope;
    let scopeRefInput: string | null | undefined;

    if (!scope) {
      const suppliedScopeRef = args.scopeRef ?? args.scope_ref ?? args.ref ?? args.harness;
      if ((suppliedScopeRef ?? '').trim()) {
        return {
          data: {
            ok: false,
            retracted: false,
            error: 'scope_required',
            detail: 'Pass scope with scopeRef/ref/harness, or omit all scope fields for unique key-only resolution.',
          },
        };
      }
      const matches = await findFactKeyMatches({ key: args.key });
      if (matches.length === 0) return { data: { ok: true, retracted: false } };
      if (matches.length > 1) {
        return {
          data: {
            ok: false,
            retracted: false,
            error: 'ambiguous_key',
            matches,
            hint: `key '${args.key}' exists at multiple current fact scopes — pass scope and scopeRef explicitly.`,
          },
        };
      }
      const match = matches[0]!;
      scope = match.scope;
      scopeRefInput = match.scopeRef;
    } else {
      // EI-7371: resolve common misnamed aliases (scope_ref/ref/harness) first.
      scopeRefInput = resolveScopeRefAlias(scope, args);
    }
    // EI-7517: default an omitted scopeRef from the caller's context (owner = me,
    // harness = this harness, role = my role) so a fact asserted self-scoped
    // without a ref can be retracted the same way — symmetry with facts:assert.
    const scopeRef = await resolveScopeRefFromCtx(scope, scopeRefInput, ctx);
    const retracted = await retractFact({
      scope,
      scopeRef: scopeRef ?? null,
      key: args.key,
      retractedBy: identity.ownerId,
      reason: args.reason,
    });
    if (retracted) return { data: { ok: true, retracted } };

    // EI-19328780288425209: a miss here is ambiguous — "never existed" vs "exists at a
    // DIFFERENT scope" — and the latter left a wrong fact live and believed-retracted for
    // 5h+ in the incident that reported this. Check before returning a bare false.
    const elsewhere = await findFactKeyElsewhere({
      scope,
      scopeRef: scopeRef ?? '',
      key: args.key,
    });
    if (!elsewhere.length) {
      const state = await findFactKeyState({
        scope,
        scopeRef: scopeRef ?? null,
        key: args.key,
      });
      return {
        data: {
          ok: true,
          retracted: false,
          reason: state === 'already-retracted' || state === 'already-superseded' ? state : 'not-found',
        },
      };
    }

    const first = elsewhere[0]!;
    return {
      data: {
        ok: true,
        retracted: false,
        alsoFoundAtScopes: elsewhere,
        hint:
          `key '${args.key}' exists at scope:'${first.scope}'` +
          (first.scopeRef ? ` scopeRef:'${first.scopeRef}'` : '') +
          ` (not the scope you searched) — retract there instead of concluding it's gone.`,
      },
    };
  },
});
