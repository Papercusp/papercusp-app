/**
 * fleet:recolor — rebind a fleet's color scheme: PERSIST the new scheme on the
 * agent_fleets registry row AND live-recolor EVERY active session in the fleet,
 * with no relaunch (fleet-color-schemes / fleet-recolor-and-color-hardening-2026-06-30
 * P-001).
 *
 * Two effects, both reusing existing primitives:
 *   1. setFleetScheme → overwrites the otherwise-permanent agent_fleets.color_scheme
 *      binding, so EVERY window the fleet opens from now on uses the new scheme.
 *   2. recolorViaPty(oscRecolorSequence) fanned across the live roster
 *      (listFleetRoster) → each currently-open psu-pty window recolors immediately.
 *
 * The scheme must be a NAME from the curated catalog (console-color-schemes) — the
 * persisted value is a catalog name (resolveFleetScheme looks it up), so an unknown
 * name is rejected with the valid list rather than silently falling back to a hash.
 * The live recolor is best-effort per member (a headless / no-pty member just doesn't
 * land — its next window still opens in the new persisted scheme).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { setFleetScheme } from '../../agent-fleets-store';
import { COLOR_SCHEMES, oscRecolorSequence, schemeByName } from '../../console-color-schemes';
import { listFleetRoster } from '../../fleet/fleet-roster';
import { recolorViaPty } from '../../events/await/psu-pty-discovery';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:recolor',
  description:
    "Rebind a fleet's color scheme — PERSIST the new scheme on the fleet registry row AND live-recolor every active session in the fleet (no relaunch). The scheme must be a NAME from the curated catalog; an invalid name returns the valid list. Use this to CHANGE a fleet's color (coloring is already automatic on fleet:create / fleet:join).",
  guidance: {
    when: "Changing a fleet's color — updates both its persisted identity and all of its currently-open windows.",
    notWhen:
      'A brand-new fleet already gets a scheme at fleet:create, and joiners recolor at fleet:join — only use recolor to OVERRIDE an existing binding.',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:recolor',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug (from fleet:list).'),
    scheme: z
      .string()
      .min(1)
      .describe(
        'A color-scheme NAME from the curated catalog (e.g. "forest", "royal-purple", "deep-cyan"). An invalid name returns the full list of valid names.',
      ),
  }),
  async handler(args, ctx) {
    const { workspaceId } = resolveFleetCaller(ctx);

    // Validate against the curated catalog BEFORE any write — the persisted value
    // is a catalog name, so reject unknowns with the valid list (don't let an
    // unknown name slip in and silently resolve to a slug-hash fallback later).
    const scheme = schemeByName(args.scheme);
    if (!scheme) {
      return json(
        {
          ok: false,
          error: `unknown scheme '${args.scheme}' — pick one of the curated catalog names`,
          validNames: COLOR_SCHEMES.map((s) => s.name),
        },
        true,
      );
    }

    // 1. Persist the new binding. null ⇒ no such fleet in this workspace.
    const updated = await setFleetScheme(workspaceId, args.fleet, scheme.name);
    if (!updated) {
      return json(
        { ok: false, error: `no fleet '${args.fleet}' in this workspace — see fleet:list` },
        true,
      );
    }

    // 2. Live-recolor every active session labeled in this fleet. Best-effort per
    //    member: recolorViaPty returns false for a headless / no-pty / non-psu member
    //    (its next launched window still opens in the new persisted scheme).
    const roster = await listFleetRoster({ fleetSlug: updated.fleetSlug, workspaceId });
    const osc = oscRecolorSequence(scheme);
    const members = await Promise.all(
      roster.map(async (m) => ({
        agentId: m.agentId,
        label: m.ownerLabel ?? m.label,
        landed: await recolorViaPty(m.agentId, osc),
      })),
    );
    const recolored = members.filter((m) => m.landed).length;

    return json({
      ok: true,
      slug: updated.fleetSlug,
      scheme: scheme.name,
      persisted: true,
      memberCount: members.length,
      recolored,
      members,
    });
  },
});
