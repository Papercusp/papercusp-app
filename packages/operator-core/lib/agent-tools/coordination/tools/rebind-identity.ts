/**
 * coord:rebind-identity — migrate every ownerId-keyed surface from a dead
 * predecessor sid to the caller's live one (compaction-continuity-hardening
 * P-007). The verb behind the SessionStart recovery hook's auto-rebind; also
 * callable by hand when the hook's banner surfaces a refused/failed rebind.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../identity';
import { COORD_ROLES } from '../roles';
import { rebindIdentity } from '../rebind-identity';
// The SU-locks (file locks + lock waiters) owner rebind lives in a SEPARATE
// side-database (`papercusp_su`) that rebindIdentity's own `sql` (harness_shared,
// main org db) can never reach — go through the operator-side locks shim (which
// guarantees `./configure`'s host-seam wiring ran first) rather than
// `@papercusp/locks` directly (EI-8999/P-002).
import { rebindLockOwner } from '../../locks/su-lock-store';

export default defineTool({
  name: 'coord:rebind-identity',
  profile: 'engineer',
  description:
    'Migrate every ownerId-keyed surface from a DEAD predecessor sid to a live one after a relaunch/recovery ' +
    'changed your PAPERCUSP_SID: armed loop routine, loop carry-note (+walls), plan/work-item claims, scheduler ' +
    'claim-spec, standing awaits, fleet membership/leadership, open held work-items, owner-scoped facts, held ' +
    'FILE LOCKS + lock waiters (EI-8999/P-002 — a separate side-database, rekeyed too). ' +
    'Idempotent — re-run to finish a partial pass. Refuses while the old sid still resolves LIVE through the ' +
    'shared liveness oracle (sessionState live/parked/draining/recorded) unless force:true — a warm heartbeat on ' +
    'an ENDED session does NOT refuse, so the ordinary relaunch needs no force. Returns { ok, from, to, ' +
    'fromSessionState, surfaces:[{surface,moved,…}], totalMoved }.',
  guidance: {
    when:
      'Your session recovered under a NEW PAPERCUSP_SID (the SessionStart banner names both ids, or coord:whoami ' +
      'disagrees with the id that armed your loop/claims): rebind from the old id to yours, or your loop fires at ' +
      'a dead owner and your carry-note, claims, awaits and held items never follow you.',
    notWhen:
      'Both ids belong to LIVE sessions — this migrates a dead identity, it does not merge two live ones. ' +
      'Routine wake/claim issues without an id change — that is coord:orient / loop:status territory.',
    chaining:
      'After a successful rebind run coord:orient { afterCompaction:true } — the recovery block re-reads the ' +
      'moved surfaces under your live id.',
    seeAlso: ['coord:whoami (your resolved identity)', 'loop:status (whose id the loop targets)'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      from: z.string().min(1).max(120).describe('The dead predecessor ownerId (sid) whose surfaces to migrate.'),
      to: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Target ownerId (default: your own resolved identity).'),
      force: z
        .boolean()
        .optional()
        .describe(
          'Override the from-appears-live LIVENESS guard. Rarely needed: the guard reads the derived sessionState, ' +
            'so a dead predecessor with a still-warm heartbeat already rebinds without it. Pass it only when the ' +
            'oracle reports the old id live/parked/draining and you have independently confirmed it is dead.',
        ),
    })
    .strict(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const to = args.to ?? identity.ownerId;
    const result = await rebindIdentity(args.from, to, { force: args.force, rebindLockOwner });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
});
