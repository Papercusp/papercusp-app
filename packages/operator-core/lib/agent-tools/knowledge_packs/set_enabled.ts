/**
 * knowledge_packs:set_enabled — mute/unmute one OR many packs' injection without
 * uninstalling (learning-packs-2026-06-11 P-009; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21). hive_settings-backed
 * (`knowledge-packs:disabled`); the pre-turn injection filters disabled packs.
 *
 * Bulk by default (the house keyed-array contract): flip ONE inline ({ pot,
 * pack, enabled }), MANY packs for the SAME hive+enabled (hive + packs:[…] +
 * enabled), or MANY heterogeneous (items:[{ pot, pack, enabled }]) → { ok,
 * results:[{ ok, hive, pack, enabled? | error }], counts }. Each result
 * self-describes its hive+pack; one failure never fails the rest.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  pot: entityRef('pot', { soft: true, max: 120 }),
  pack: z.string().min(1).max(120),
  enabled: z.boolean(),
});

interface FlipItem {
  pot: string;
  pack: string;
  enabled: boolean;
}

export default defineTool({
  name: 'knowledge_packs:set_enabled',
  capability: 'memory:write',
  description:
    "Enable or disable one OR many knowledge packs' injection for a hive WITHOUT uninstalling them — the rows stay stored; agents just stop recalling them. Cheap to flip, fully reversible. Single: { pot, pack, enabled }. Many packs same hive: { pot, packs:[…], enabled }. Many heterogeneous: items:[{ pot, pack, enabled }]. Returns { ok, results:[{ ok, hive, pack, enabled? | error }], counts } — correlate by hive+pack, not by position; one failure never fails the rest.",
  guidance: {
    when: 'Trying out whether a pack helps, or quarantining one that seems to misdirect agents — before reaching for uninstall. Flip several at once via packs:[…] or items:[…].',
    notWhen: 'Permanently removing a pack — knowledge_packs:uninstall.',
    chaining: 'knowledge_packs:list { pot } shows enabled state per installed pack. Bulk: single | items[] (or packs) → { ok, results, counts }; correlate by hive+pack not position; one failure never fails the rest.',
    seeAlso: [
      'knowledge_packs:uninstall (permanently remove instead of disabling)',
      'knowledge_packs:list (enabled state per installed pack)',
    ],
  },
  crossWorkspace: true,
  args: z
    .object({
      pot: entityRef('pot', { soft: true, max: 120, describe: 'the pot — for the inline pack / every pack in `packs`' }).optional(),
      pack: z.string().min(1).max(120).optional().describe('single-flip shorthand: the pack id (use with `pot`, `enabled`)'),
      enabled: z.boolean().optional().describe('enabled state for the inline pack / every pack in `packs`'),
      packs: z.array(z.string().min(1).max(120)).min(1).max(200).optional().describe('flip MANY packs for the same `pot` + `enabled` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('flip many packs at once — each { pot, pack, enabled }'),
      workspace: z.string().max(120).optional(),
    })
    .refine(
      (a) =>
        (a.items?.length ?? 0) > 0 ||
        (Boolean(a.pot) && a.enabled !== undefined && ((a.packs?.length ?? 0) > 0 || Boolean(a.pack))),
      {
        message:
          'pass { pot, pack, enabled } for one, { pot, packs:[…], enabled } for many of the same hive, or items:[{ pot, pack, enabled }] for many',
      },
    ),
  async handler(args, ctx) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.principal?.workspaceId);
    const { setPackEnabled } = await import('../../knowledge-packs/manage');

    const list: FlipItem[] = args.items?.length
      ? args.items
      : args.packs?.length
        ? args.packs.map((pack) => ({ pot: args.pot as string, pack, enabled: args.enabled as boolean }))
        : [{ pot: args.pot as string, pack: args.pack as string, enabled: args.enabled as boolean }];

    const env = await runBulk(
      list,
      async (it) => {
        // setPackEnabled returns { ok:true, disabled } or THROWS — a throw becomes
        // this item's { ok:false, hive, pack, error } via runBulk's keyOf catch.
        await setPackEnabled({
          workspaceId,
          potSlug: it.pot,
          packId: it.pack,
          enabled: it.enabled,
        });
        return { ok: true as const, pot: it.pot, pack: it.pack, enabled: it.enabled };
      },
      { keyOf: (it) => ({ pot: it.pot, pack: it.pack }) },
    );
    return bulkContent(env);
  },
});
