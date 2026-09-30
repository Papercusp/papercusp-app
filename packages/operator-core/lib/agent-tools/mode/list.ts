/**
 * mode:list — the mode catalog: every official mode's id, axis, and one-liner,
 * plus which ones YOU currently have active
 * (modes-and-intake-ux-2026-07-05 P-006/P-008).
 *
 * This is the cheap INDEX (P-008 context diet): one line per mode. The full
 * binding contract loads at activation — mode:set returns it; coord:orient
 * re-injects active contracts each wake.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { MODES } from '../../modes/registry';
import { getModesWithLiveness } from '../../modes/liveness';
import { getSelectedModeCatalog } from '../../agent-identities/source';

export default defineTool({
  name: 'mode:list',
  profile: 'engineer',
  description:
    'The official mode catalog: id, axis (autonomy | work-source | overlay), one-liner, and which modes you have ' +
    'active. Same-axis modes exclude each other (mode:set auto-switches); cross-axis modes stack.',
  guidance: {
    when: 'Orienting on what modes exist / which apply to a user ask, before offering one or calling mode:set.',
    notWhen: 'Reading a PEER’s modes — that is mode:get { agent } (or coord:presence ambiently).',
    chaining: 'mode:list → mode:set { mode, reason } → read the returned contract.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler(_args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const resolved = await getModesWithLiveness(ident.workspaceId ?? 'default', ident.ownerId).catch(() => null);
    const activeIds = new Set((resolved?.modes ?? []).map((r) => r.mode));
    let selected;
    try {
      selected = await getSelectedModeCatalog();
    } catch (error) {
      return { data: { ok: false, error: 'selected-mode-catalog-unavailable',
        detail: error instanceof Error ? error.message : String(error) } };
    }
    const byId = new Map(selected.entries.map((entry) => [entry.id, entry]));
    const missing = MODES.find((mode) => mode.id !== 'cold-auto' && !byId.has(mode.id));
    if (missing) {
      return { data: { ok: false, error: 'selected-mode-catalog-incomplete', mode: missing.id } };
    }
    const catalog = MODES.map((mode) => {
      // cold-auto is a runtime carry variant of AUTO, not a separate authored
      // catalog component; its short index line remains host-owned.
      const entry = mode.id === 'cold-auto' ? null : byId.get(mode.id);
      return { mode: mode.id, axis: mode.axis, title: entry?.title ?? mode.title,
        oneLiner: entry?.oneLiner ?? mode.oneLiner, active: activeIds.has(mode.id),
        ...(entry ? { sourceRevision: entry.sourceHash } : {}) };
    });
    return {
      data: {
        ok: true,
        sessionState: resolved?.sessionState ?? null,
        live: resolved?.live ?? null,
        axes: 'same-axis modes exclude each other (auto-switch on set); cross-axis modes stack; overlays stack with everything',
        catalogRevision: selected.revision,
        modes: catalog,
      },
    };
  },
});
