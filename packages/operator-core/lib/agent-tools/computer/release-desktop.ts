/**
 * computer:release_desktop — tear down a hive's sandbox desktop (kill the in-process
 * Xvfb + apps, free the display) without dissolving the hive. The inverse of
 * computer:provision_desktop. pot:dissolve also releases automatically (step 3.6); this
 * is the standalone teardown for a demo / when a hive no longer needs GUI work.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import { releaseHiveDesktop } from './desktop-lease';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'computer:release_desktop',
  profile: 'engineer',
  description:
    "Tear down a pot's sandbox desktop (kill its Xvfb + apps, free the display) without dissolving the pot. Idempotent — a no-op if the pot holds no desktop. (pot:dissolve releases automatically.)",
  guidance: {
    when: 'A pot is done with GUI work but stays alive — reclaim the Xvfb/display. Also good demo hygiene after computer:provision_desktop.',
    notWhen: 'Tearing down the whole pot — pot:dissolve already releases the desktop. There is nothing to release if the pot never provisioned one.',
    chaining: 'computer:list_desktops to see what is leased → computer:release_desktop { pot }.',
    seeAlso: [
      'computer:list_desktops (see what is leased first)',
      'computer:provision_desktop (stand one back up)',
      'pot:dissolve (tears down the whole pot incl desktop)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: QUEEN_PLACEMENT_ROLES,
  args: z
    .object({
      pot: entityRef('pot', { soft: true, max: 120, describe: "The pot's home-harness slug whose desktop to release." }),
    })
    .strict(),
  async handler(args) {
    const result = await releaseHiveDesktop(args.pot);
    const note =
      result.via === 'local'
        ? 'desktop torn down.'
        : result.via === 'registry'
          ? 'desktop torn down (it was provisioned by a sibling operator process — released via the cross-process registry handle).'
          : 'no desktop was leased (no-op).';
    return text({ ok: true, pot: args.pot, released: result.released, note });
  },
});
