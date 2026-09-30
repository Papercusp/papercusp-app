import { z } from 'zod';
import {
  defineTool,
  listAllProjectedTools,
  generateToolFacadeTypes,
  listFacadeNamespaces,
  roleScopedToolNames,
  AGENT_ROLES,
} from '@papercusp/agent-mcp';

/**
 * `code:tools` — on-demand typed signatures for the `code:run` facade
 * (code-execution-tool-orchestration B-CX-API).
 *
 * `code:run` scripts call `tools.<ns>.<verb>(args)`. The exact arg shapes come from each tool's
 * schema — but dumping every tool's full signature into the prompt is the very per-prompt catalog
 * cost the code-mode feature exists to avoid. So instead the model fetches signatures ON DEMAND:
 *
 *   1. `code:tools {}`                      → the namespace index (ns + verb names, no arg types) — cheap.
 *   2. `code:tools { namespaces:['plans'] }`→ full typed signatures for just those namespaces.
 *   3. write the `code:run` script against the real signatures (fewer arg-shape errors).
 *
 * Signatures are generated from each tool's projected `inputSchema` (already JSON Schema) and
 * SCOPED to the caller's role-allowed set — identical scoping to `code:run`'s facade — so the model
 * only ever sees tools it can actually call. Read-only: this renders types; it dispatches nothing.
 */
export default defineTool({
  name: 'code:tools',
  description:
    'OPTIONAL pre-check of typed signatures for code:run — not required before a run (code:run ' +
    'returns the signatures inline if you name a tool wrong). No args → the namespace index (cheap). ' +
    '{ namespaces } / { names } → full TS `tools.ns.verb(args)` signatures for just those, scoped ' +
    'to your allowed set — each signature\'s `Promise<...>` return type + `@returns` comment is the ' +
    'tool\'s REAL response shape when it declared one (EI-13298): read it before mapping the result, ' +
    'do not guess keys — a wrong-key `||`-fallback fails SILENTLY (empty, not an error). Read the ' +
    'signatures, then write a code:run script.',
  guidance: {
    when:
      'OPTIONAL — only when you want to pre-check exact arg shapes before authoring a code:run ' +
      'script (you do NOT have to: code:run hands you the typed signatures inline if a name is ' +
      'wrong). Start with no args to list namespaces, then request the one or two you need.',
    notWhen:
      'A single direct tool call (no script), or you already know the signatures, or you would ' +
      'rather just write the code:run script and let a bad name return signatures inline. This is ' +
      'a lookup — it executes nothing.',
    chaining: 'OPTIONAL: code:tools {} → pick namespaces → code:tools { namespaces } → code:run { script }',
    seeAlso: [
      'code:run (write + run the script)',
    ],
  },
  // Read-only signature rendering over the tool catalog — same capability as agent_tools:list (its
  // code-mode sibling). The `:read` suffix infers effect:'read' (never dry-run-gated); agentRoles
  // mirrors code:run's audience (ALL ROLES, owner directive 2026-06-25) and the role-scoped allowed
  // set is the real boundary.
  capability: 'agent_tools:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    namespaces: z
      .array(z.string())
      .optional()
      .describe('Render full signatures for just these namespaces (e.g. ["work_items","coord"]).'),
    names: z
      .array(z.string())
      .optional()
      .describe('Render signatures for these exact tool names (e.g. ["plans:set-status"]). Union with namespaces.'),
  }),
  async handler(args, ctx) {
    const all = listAllProjectedTools();
    // Scope to tools this agent's role may call — identical to code:run's facade scoping. Exclude
    // the code-mode meta-tools so a script/catalog never surfaces code:run / code:tools themselves.
    const allowed = roleScopedToolNames(all, ctx.role, new Set(['code:run', 'code:tools']));

    const wantNs = args.namespaces?.length ? args.namespaces : undefined;
    const wantNames = args.names?.length ? args.names : undefined;

    if (!wantNs && !wantNames) {
      // The cheap index: namespaces + their verbs, no arg types. The model reads this, then asks
      // for the namespaces it needs.
      const namespaces = listFacadeNamespaces(all, allowed);
      const body = {
        namespaces,
        count: namespaces.reduce((n, e) => n + e.verbs.length, 0),
        hint: 'Call code:tools { namespaces:[...] } (or { names:[...] }) for the full typed signatures, then write a code:run script.',
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    }

    const dts = generateToolFacadeTypes(all, { allowed, namespaces: wantNs, names: wantNames });
    return { content: [{ type: 'text' as const, text: dts }] };
  },
});
