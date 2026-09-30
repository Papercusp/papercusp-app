/**
 * lexicon:active_pack — expose the active brand pack's term→label map over HTTP
 * (pui-hive-lexicon-2026-06-06).
 *
 * ONE source of truth: the Rust pui must NOT duplicate the term packs. It fetches
 * the resolved map from here at startup and routes its user-facing labels (tab
 * titles, dock pane names) through it. The pack is resolved by the SERVER TWIN
 * (`activeServerPackId`, kept fresh by the flag-bus on every `papercusp-the-hive`
 * flip), so a flag change is respected without any pui-side flag wiring.
 *
 * Returns the FULL map (every TermKey → { one, other }) for the active pack plus
 * the pack id. Flag off → `classic` (today's labels); flag on → `the-hive`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { getPack } from '@papercusp/lexicon';
import { activeServerPackId } from '../../lexicon';

export default defineTool({
  name: 'lexicon:active_pack',
  profile: 'engineer',
  description:
    "The active brand pack's full term→label map (every term key → singular/plural forms) plus the pack id. Resolved via the server-side lexicon twin so the `papercusp-the-hive` flag is respected. The single source of truth for any non-React/non-server surface (e.g. the Rust pui) that needs the live lexicon without duplicating the packs.",
  guidance: {
    when: 'A client outside the React/server lexicon wiring (the pui TUI, a CLI) needs the active term labels; fetch once at startup and re-fetch on a flag change if a push rail exists.',
    notWhen:
      'You are in React (use the useLexicon hook) or server code (import term() from the lexicon module) — those resolve in-process.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({}),
  async handler() {
    const packId = activeServerPackId();
    const pack = getPack(packId);
    // term key → { one, other } Title-Case forms (presentation only).
    const terms: Record<string, { one: string; other: string }> = {};
    for (const [key, forms] of Object.entries(pack.terms)) {
      terms[key] = { one: forms.one, other: forms.other };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            packId,
            label: pack.label,
            terms,
          }),
        },
      ],
    };
  },
});
