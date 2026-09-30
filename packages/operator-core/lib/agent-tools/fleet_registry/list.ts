/**
 * fleet:list — every persisted fleet in the workspace, each annotated with its LIVE
 * member count + an `available` flag (named-su-agent-fleets-2026-06-29 P-004 / D-003).
 *
 * The registry rows are durable (they survive all-members-killed, D-003), so this lists
 * fleets with ZERO live members too — `available` (>=1 live member, heartbeat within
 * PRESENCE_STALE_MS) is the routing/psu predicate layered on top.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { availableFleets, countRunningWorkspaceBees } from '../../fleet/fleet-roster';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:list',
  description:
    'List every persistent fleet in this workspace, each split as `memberCount` VISIBLE desktop su members / `beeCount` background autonomous-loop bees, plus an `available` flag (available = at least one live MEMBER — a desktop driver a plan can be handed to; a bee cannot). Durable fleets with zero live members are listed too. The result also carries `runningBees`: how many background bees are running in the whole workspace — a fleet showing 0 members while runningBees>0 has background bees but no visible desktop members; use fleet:launch-on-plan for desktop members. Use this to pick a fleet to join or hand a plan to.',
  guidance: {
    when: 'Choosing a fleet — to join (fleet:join), inspect (fleet:status), or hand a plan to (fleet:take-leadership). `available` fleets have a live desktop MEMBER (driver) right now — beeCount is background autonomous-loop workers, not a driver.',
    notWhen: 'For who is IN one fleet and what each is doing, use fleet:status { fleet }.',
    chaining: ROUTING_LADDER,
    // EI-21248152995233175 / EI-21825385718246336 / EI-22390116220854624 — three
    // independent filings, one shape: a caller passes `workspace` (and once `harness`
    // alongside it) to a tool that declares NO keys. The key was never a typo — this
    // tool reads its workspace AMBIENTLY from the caller's identity, so an agent
    // reasoning from the catalog's many workspace-scoped verbs guesses a parameter with
    // no counterpart here, and the bare unrecognized-key rejection ("accepts only: ")
    // reads as "this tool cannot be scoped", whose honest next move is to hunt for a
    // different tool. Same family as `workspace` on routines:list (EI-20206183390542424).
    //
    // OBJECT (corrective-call) form is REQUIRED, not preferred: with zero declared keys
    // `unknownArgHint` early-returns on `keys.length === 0`, so a D-004
    // `declaredKey — explanation` string has no key to name and would never render.
    argRedirects: {
      workspace: {
        tool: 'fleet:list',
        args: {},
        note:
          'this tool has NO `workspace` arg and needs none — it already resolves the workspace AMBIENTLY from your session identity, so the fleets you get back are that workspace\'s. DROP the key and call it with `{}`. There is no cross-workspace fleet listing: to read another workspace, run in a session scoped to it',
      },
      harness: {
        tool: 'fleet:list',
        args: {},
        note:
          'fleets are a WORKSPACE-level registry, not a harness one, so there is no harness to select and this tool declares no arg at all. DROP the key and call it with `{}`. To narrow to ONE fleet\'s membership use fleet:status { fleet }; for who is on what across fleets use fleet:assignments { fleet }',
      },
    },
  },
  capability: 'fleet:list',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({}),
  async handler(_args, ctx) {
    const { workspaceId } = resolveFleetCaller(ctx);
    // WI-1764 #4: split VISIBLE desktop members from BACKGROUND bees, and surface the
    // workspace-wide running-bee total so a "0 members / N bees" mismatch screams.
    const [fleets, runningBees] = await Promise.all([
      availableFleets(workspaceId),
      countRunningWorkspaceBees(workspaceId),
    ]);
    return json({
      ok: true,
      runningBees,
      fleets: fleets.map((f) => ({
        slug: f.fleetSlug,
        title: f.title,
        description: f.description,
        leader: f.leaderOwnerId,
        memberCount: f.liveMemberCount,
        beeCount: f.beeCount,
        // Back-compat alias — `liveMemberCount` was the pre-split field name.
        liveMemberCount: f.liveMemberCount,
        available: f.liveMemberCount > 0,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    });
  },
});
