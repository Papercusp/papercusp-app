/**
 * `graph:query` — the curated GitNexus call-graph facade, exposed as a tool.
 *
 * Plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-006 / WI-40206,
 * decision D-057.
 *
 * WHY THIS FILE EXISTS. `gitnexusFacade` (the GitNexus half of the read-only
 * code-intelligence plane) was built in P-012 and then reached by NOTHING: it
 * had zero non-test callers, and `configureGitnexusDispatch` was never called
 * outside tests. That is not a cosmetic gap. `code:run` exposes only
 * `tools.ns.verb(args)` — "no require/process/import" (see `code/run.ts`) — so
 * a facade with no tool of its own is unreachable from every agent surface,
 * and the curated plane silently degraded to "use the raw `gitnexus.*` plugin
 * tools", which is exactly what D-021 warns against: they answer with unranked,
 * unbudgeted results and no freshness contract, so a wrong answer is
 * indistinguishable from a confident one.
 *
 * NAMING. Deliberately NOT `gitnexus:query`. The bridge plugin already
 * registers a bare `query` handler, surfaced as `gitnexus.query`; a colon-form
 * `gitnexus:query` would collide with it in the `code:run` tool namespace
 * (`tools.gitnexus.query`) — the curated and uncurated planes would answer to
 * one name. `graph:` is a free namespace, and it names the plane rather than
 * the vendor, matching its sibling `lsp:query`.
 *
 * ONE tool with an op enum rather than five, because D-007 makes prompt weight
 * an acceptance criterion for this plan.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';

import {
  GITNEXUS_FACADE_OPS,
  GITNEXUS_NOT_ROUTABLE,
  gitnexusFacade,
  gitnexusRefusal,
  type GitnexusFacadeOp,
} from '../../code-intelligence/gitnexus-facade';
import type { CodeIntelIntent } from '../../code-intelligence/contracts';

// Keep the closed operation set, but also accept intents that the facade
// deliberately refuses. That lets an agent receive the typed `useInstead`
// guidance rather than a schema error with no redirect.
const OP_VALUES = [
  ...GITNEXUS_FACADE_OPS,
  ...Object.keys(GITNEXUS_NOT_ROUTABLE),
] as [string, ...string[]];

export default defineTool({
  name: 'graph:query',
  description:
    'Curated GitNexus topology: symbol | callers | callees | impact | health; refused intents return redirects. Returns `{sites, truncation, freshness, coverage, latencyMs, error}`; `line1` is one-indexed. Fresh or untruncated results do not prove source completeness. Missing/ambiguous symbols and backend failures carry errors; corroborate consumers in current source.',
  guidance: {
    when: 'You need call-graph topology: who calls a symbol, what it calls, or the blast radius of changing it.',
    notWhen:
      'Use lsp:query for compiler semantics and scoped rg for literals/current source; runtime diagnosis needs state/log tools. Use gitnexus.context or trace for known-symbol intents outside this operation set, with source corroboration.',
    chaining:
    'op:"symbol" to locate the symbol → op:"callers"/"callees" for its edges → op:"impact" for the change radius. If results look stale, op:"health" reports structured list_repos freshness. If you need references, diagnostics, text search, or another refused intent, pass that intent as `op` to receive its concrete useInstead redirect.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  // The bridge keeps a resident child per workspace, but a COLD first call pays
  // graph load on a multi-GiB index. Declared so the dispatch stack's budget
  // matches the backend's real worst case instead of timing out mid-load.
  timeoutSec: 90,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    op: z.enum(OP_VALUES).describe('Which read-only operation to run.'),
    name: z
      .string()
      .min(1)
      .optional()
      .describe('Symbol name. Required for every op except `health`.'),
    kind: z
      .string()
      .min(1)
      .optional()
      .describe(
        "GitNexus symbol kind ('Function', 'Class', ...). Optional; narrows an ambiguous name.",
      ),
    file_path: z
      .string()
      .min(1)
      .optional()
      .describe('symbol/callers/callees: defining file; picks one of several same-name symbols.'),
    uid: z
      .string()
      .min(1)
      .optional()
      .describe('symbol/callers/callees: exact uid from an ambiguity error candidate.'),
    direction: z
      .enum(['upstream', 'downstream', 'both'])
      .optional()
      .describe(
        '`impact` only: which way to walk the graph. Defaults to downstream (what this change breaks).',
      ),
    repo: z
      .string()
      .min(1)
      .optional()
      .describe('Repository name in the GitNexus index. Defaults to the papercusp index.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Cap on returned sites. Clamped to the facade budget.'),
  }),
  async handler(args, ctx) {
    const op = args.op as string;
    if (!GITNEXUS_FACADE_OPS.includes(op as GitnexusFacadeOp)) {
      // OP_VALUES admits these intentionally so the refusal map is reachable
      // through the actual agent-facing tool, not just through unit imports.
      const refusal = gitnexusRefusal(op as CodeIntelIntent, args.name ?? '');
      if (refusal) return { data: refusal };
    }

    // The dispatcher is passed PER CALL rather than installed into the module
    // global by this handler. It closes over `ctx` — which carries the calling
    // principal and workspace — so publishing it to a process-wide global would
    // hand this request's context to every concurrent caller. The facade
    // prefers an explicitly-passed dispatcher for exactly this reason.
    //
    // The bridge's handlers are registered under bare names (`context`,
    // `impact`, ...); namespacing to the plugin's tool id is this seam's job,
    // which is why the facade dispatches bare names.
    //
    // `dispatchTool` is OPTIONAL on the context — "present only on transports
    // with a server-side dispatcher (MCP)". On a transport without one we pass
    // NO dispatcher rather than crashing, which lands on the facade's wiring-
    // fault refusal. That refusal is the correct answer here: it says the plane
    // is unreachable in this process, where a thrown error would be reported as
    // a failed query and an empty result would be read as "no matches" — the
    // exact confusion this facade exists to prevent.
    const dispatchTool = ctx.dispatchTool;
    const dispatch = dispatchTool
      ? (tool: string, toolArgs: Record<string, unknown>) =>
          dispatchTool(`gitnexus.${tool}`, toolArgs)
      : undefined;

    const answer = await gitnexusFacade(
      op as GitnexusFacadeOp,
      {
        name: args.name,
        kind: args.kind,
        file_path: args.file_path,
        uid: args.uid,
        direction: args.direction,
        repo: args.repo,
        limit: args.limit,
      },
      dispatch,
    );
    return { data: answer };
  },
});
