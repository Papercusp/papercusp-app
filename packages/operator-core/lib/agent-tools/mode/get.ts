/**
 * mode:get — read the current mode set of yourself or any agent
 * (modes-and-intake-ux-2026-07-05 P-006/P-007).
 *
 * The read side of modes-as-data: presence/orient show modes ambiently; this
 * is the direct point read (with optional full contracts).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { modeById } from '../../modes/registry';
import { getModesWithLiveness } from '../../modes/liveness';
import { getSelectedModeDefinitions, type SelectedModeDefinition } from '../../agent-identities/source';

export default defineTool({
  name: 'mode:get',
  profile: 'engineer',
  description:
    "Read an agent's registered modes and live session state: { agent? (default you), contracts? }. Returns " +
    'tri-state live (true | false | null), sessionState, mode provenance, and optionally the full contracts.',
  guidance: {
    when:
      "Before redirecting a peer (is it owner-directed? then request, don't override) or to re-read your own binding " +
      'contracts mid-session. Ambient visibility is already in coord:presence / coord:orient — reach for this for the detail.',
    notWhen: 'Fleet-wide mode surveys — read coord:presence once instead of N mode:get calls.',
    chaining: 'mode:get { agent } → mode:set { agent, mode, reason } (or a coord:send request when ownerDirected).',
    /* EI-20356723237531047: the coordination family's TARGETED-READ key drifted.
       coord:presence canonicalised `owner` (declaring `ownerId`/`owners`/`ownerIds`
       as aliases) and lists `agent` among its LEGACY keys — while mode:get/mode:set
       kept `agent` as theirs. So the same concept is canonical in one of these reads
       and rejected-as-legacy in the other, and a caller carrying one shape across
       both pays a retry per hop. `ownerId` is accepted as a declared alias below;
       these redirects cover the remaining near-misses at ZERO prompt weight, paid
       only on the failure path (the same mechanism, and the same reason, as
       coord:inbox's argRedirects.since). */
    argRedirects: {
      owner: 'agent',
      ownerIds: 'agent',
      agentId: 'agent',
    },
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z.string().max(120).optional().describe('target ownerId (exact); omit for yourself'),
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Compatibility alias for `agent`, for callers carrying the roster/presence field name; normalized to `agent` before lookup. Pass one or the other — `agent` wins if both are given.',
      ),
    contracts: z.boolean().optional().describe('include each active mode’s full contract text'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // Normalize the alias at the boundary so everything below consumes the
    // canonical `agent` selector only (coord:presence does the same for its
    // ownerId → owner alias).
    const target = (args.agent ?? args.ownerId)?.trim() || ident.ownerId;
    const resolved = await getModesWithLiveness(ident.workspaceId ?? 'default', target);
    let selected = new Map<string, SelectedModeDefinition>();
    if (args.contracts) {
      try {
        selected = await getSelectedModeDefinitions(
          resolved.modes.filter((row) => modeById(row.mode)).map((row) => row.mode),
        );
      } catch (error) {
        return { data: { ok: false, agent: target, error: 'selected-mode-definition-unavailable',
          detail: error instanceof Error ? error.message : String(error) } };
      }
    }
    const modes = resolved.modes.map((r) => {
      const def = modeById(r.mode);
      const definition = selected.get(r.mode);
      return {
        mode: r.mode,
        axis: def?.axis ?? r.axisKey,
        reason: r.reason,
        setBy: r.setBy,
        ownerDirected: r.ownerDirected,
        setAt: r.setAt,
        ...(args.contracts && definition
          ? { contract: definition.contract, definitionRevision: definition.contractRevision,
              sourceRevision: definition.sourceRevision }
          : {}),
      };
    });
    return {
      data: {
        ok: true,
        agent: target,
        sessionState: resolved.sessionState,
        live: resolved.live,
        modes,
      },
    };
  },
});
