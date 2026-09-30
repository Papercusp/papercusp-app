/**
 * fleet:reconfigure-member — a fleet LEADER reconfigures ONE live member's RUNTIME-adjustable
 * settings WITHOUT a respawn (per-member-declarative-launch-specs P-007, D-003). The three
 * no-respawn levers, bundled behind a single member-targeted call so the leader does not have
 * to fan out three separate tools:
 *   • compactionLimit → the P-006 cross-session setter (setCompactionLimitForOwner), rejected
 *     when above the MEMBER's spec + fleet-role ceiling (no clamped write).
 *   • claimSpec       → the member's versioned claim spec (scheduler:set_claim_spec's cupId path)
 *     — validated, then stored under the member's own cupId so its next scheduler:get_next applies
 *     it. For the write-time pool-collapse guard use scheduler:set_claim_spec directly.
 *   • brief           → a next-wake brief: a durable coord message the member reads on its next
 *     wake/orient (no forced wake).
 *
 * Boot-baked settings (model/effort/account/carry/contextSize/agent) need a respawn — that is
 * fleet:respawn-member (P-008), not this. Member resolution + the leader / Overwatch-pane / owner auth
 * grades (classifyFleetControlInvoker — its `'queen'` grade is reached by a LIVE Overwatch session,
 * whose presence role IS the string `kettle`, so do not read that literal as tier residue) live in the
 * shared resolveFleetMemberTarget (member-target.ts), shared with fleet:respawn-member.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { sendMessage } from '../coordination/messages';
import { validateClaimSpec } from '../../scheduler/claim-spec';
import { resolveClaimSpecWorkspace, setClaimSpec } from '../../scheduler/claim-spec-store';
import { setCompactionLimitForOwner } from '../config/set-compaction-limit-core';
import { resolveFleetMemberTarget } from './member-target';
import { json, ROUTING_LADDER } from './_shared';

export default defineTool({
  name: 'fleet:reconfigure-member',
  description:
    "Reconfigure ONE live fleet member's RUNTIME settings WITHOUT a respawn (as its leader, an Overwatch pane, or the owner): `compactionLimit` (rejected above the member's own spec+role ceiling; no clamped write), `claimSpec` (its versioned claim spec — validated, applied on its next scheduler:get_next), and/or `brief` (a next-wake message it reads on its next orient). `fleet` defaults to the one fleet you lead. For BOOT-BAKED settings (model/effort/account/carry/contextSize/agent) use fleet:respawn-member instead.",
  guidance: {
    when: 'Adjust a member you lead in place — retune its compaction window, re-steer its claim lane, or stage a next-wake brief — without the cost of a respawn. Pass just the fields you want to change.',
    notWhen:
      'To change boot-baked settings (model/effort/account/carry/contextSize/agent) — those need fleet:respawn-member. To steer with the write-time pool-collapse guard — scheduler:set_claim_spec directly. To stand the whole fleet down — fleet:wind-down.',
    chaining: ROUTING_LADDER,
    seeAlso: [
      'fleet:respawn-member (boot-baked settings, via a respawn)',
      'config:set-compaction-limit (set your OWN limit)',
      'scheduler:set_claim_spec (guarded claim-spec steering)',
      'fleet:status (who the members are)',
    ],
  },
  capability: 'fleet:reconfigure-member',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      member: z
        .string()
        .min(1)
        .describe("The target member — its coord ownerId (or a unique prefix/substring). Must be a member of the fleet."),
      fleet: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Fleet slug (or name — slugified). Defaults to the single fleet you lead; required if you lead several, or if you are acting over another fleet as an Overwatch pane or the owner.'),
      compactionLimit: z
        .number()
        .int()
        .min(20_000)
        .max(900_000)
        .optional()
        .describe("New soft compaction limit (tokens) for the member — rejected with ok:false when above ITS model+fleet-role ceiling (a member's leaner [1m] cap), not yours; no clamped write is made."),
      claimSpec: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A claim spec (same shape scheduler:set_claim_spec takes: { specVersion:"1.0", specId, revision, view:{filter}, rank, states? }) — validated, then stored under the member\'s cupId; applied on its next scheduler:get_next. No write-time pool-collapse guard here — use scheduler:set_claim_spec for that.'),
      brief: z
        .string()
        .min(1)
        .max(4000)
        .optional()
        .describe('A next-wake brief — a durable coord message the member reads on its next wake/orient (does NOT force an immediate wake).'),
    })
    .refine((a) => a.compactionLimit != null || a.claimSpec != null || a.brief != null, {
      message: 'pass at least one of compactionLimit / claimSpec / brief',
    }),
  async handler(args, ctx) {
    // Defense-in-depth (the zod refine covers the MCP path): at least one lever.
    if (args.compactionLimit == null && args.claimSpec == null && args.brief == null) {
      return json({ ok: false, error: 'nothing_to_do', message: 'pass at least one of compactionLimit / claimSpec / brief' }, true);
    }

    const target = await resolveFleetMemberTarget(ctx, args.member, args.fleet);
    if (!target.ok) {
      return json(target as unknown as Record<string, unknown>, true);
    }
    const { identity, callerId, workspaceId, slug, memberOwnerId, invokedAs } = target;

    // Apply each requested lever, collecting a per-lever result.
    const applied: Record<string, unknown> = {};

    if (args.compactionLimit != null) {
      // Reuse the P-006 cross-session setter (rejects requests above the MEMBER's
      // spec+role ceiling before writing).
      applied.compactionLimit = await setCompactionLimitForOwner(ctx, memberOwnerId, args.compactionLimit);
    }

    if (args.claimSpec != null) {
      const validated = validateClaimSpec(args.claimSpec);
      if (!validated.ok || !validated.spec) {
        applied.claimSpec = { ok: false, errors: validated.errors };
      } else {
        try {
          // Federate under the caller's harness when harness-scoped (mirrors set_claim_spec); else local.
          const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
          const potSlug =
            typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : null;
          const res = await setClaimSpec({
            cupId: memberOwnerId,
            workspaceId: resolveClaimSpecWorkspace(workspaceId),
            spec: args.claimSpec,
            updatedBy: callerId,
            potSlug,
          });
          // `res` already carries its own `ok` (setClaimSpec can itself report `ok: false`
          // — e.g. a pool-collapse guard rejection — even though no exception was thrown),
          // so trust it verbatim rather than forcing `ok: true` ahead of it.
          applied.claimSpec = { ...res };
        } catch (e) {
          applied.claimSpec = { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
        }
      }
    }

    if (args.brief != null) {
      try {
        const env = await sendMessage(identity, {
          to: [memberOwnerId],
          summary: `Fleet ${slug} reconfigure brief (from leader ${callerId})`,
          body: args.brief,
          expectsReply: false,
        });
        applied.brief = { ok: true, msgId: (env as { msg_id?: string })?.msg_id ?? null };
      } catch (e) {
        applied.brief = { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
      }
    }

    const anyFail = Object.values(applied).some((r) => r != null && (r as { ok?: boolean }).ok === false);
    return json({ ok: !anyFail, fleet: slug, member: memberOwnerId, invokedAs, applied }, anyFail);
  },
});
