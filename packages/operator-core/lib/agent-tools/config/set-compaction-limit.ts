/**
 * config:set-compaction-limit — set THIS session's soft compaction limit.
 *
 * agent-managed-compaction-2026-07-01. An agent tunes how large its context
 * grows before it steers toward a clean stopping point and self-compacts. The
 * limit is a SOFT target below the model's hard window; the live usage signal
 * (`context: N/limit (X%)`) is injected each turn, and near it the agent should
 * reach a stopping point and call `session:request-compaction`. Persisted per
 * session on `coord_presence.compaction_limit` (keyed by the session owner id).
 *
 * Runtime writes are accepted only when the requested value is within the
 * caller's model-derived ceiling (context-trimming-tiers D-001):
 * `limit × 1.2 ≤ window − margin`. The spec resolves best-effort via
 * resolveModelSpecForOwner (launch argv → session settings.json). An
 * unresolvable spec uses the fleet-default [1m] ceiling (825k for a self-set),
 * and an over-ceiling request is rejected so `ok:true` always means the
 * requested value was the value written. Lower-level seed/setup paths still
 * use the clamp helper directly.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { setCompactionLimit, getPresence } from '../coordination/presence';
import { estimateContextWindowForOwner, resolveModelSpecForOwner } from '../../compaction-usage';
import { clampCompactionLimit, selfSetCeilingForSpec, selfSetCeilingForWindow } from '../../agent-config-constants';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { setCompactionLimitForOwner } from './set-compaction-limit-core';

/** Soft limit applied when a session has set none. Read-time default (P-007).
 *  Superseded by the model-aware `defaultCompactionLimitForSpec` (context-
 *  trimming-tiers D-001 — 200k window derives 158k, ≈ this value); kept as the
 *  last-resort static fallback where no spec is in reach. */
export const DEFAULT_COMPACTION_LIMIT_TOKENS = 160_000;

export default defineTool({
  name: 'config:set-compaction-limit',
  description:
    "Set a soft compaction limit (tokens) — a target below the model window; near it, reach a stopping point and call session:request-compaction. Defaults to THIS session; pass `ownerId` to set a MEMBER's limit as its fleet leader (or queen/owner) — no more dispatching \"set your own limit\". Persisted per session; visible in coord:presence.",
  capability: 'coord:write',
  guidance: {
    when: 'Tune how large a session\'s context grows before it self-compacts — raise it for wide-context work, lower it to stay sharp on a tight task. As a fleet leader, pass ownerId to set a member\'s limit directly.',
    notWhen:
      'To compact right now — use session:request-compaction. To read your usage — it is injected each turn as `context: N/limit (X%)`. To set a member you do NOT lead — you cannot (leader/queen/owner only).',
    seeAlso: ['session:request-compaction (compact now, at a stopping point)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    limit: z
      .number()
      .int()
      .min(20_000)
      .max(900_000)
      .describe(
        'Soft compaction limit in tokens. Requests above the target session\'s model-and-role ceiling return ok:false with the ceiling and make no write; in-range requests persist verbatim.',
      ),
    ownerId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "P-006: the TARGET session to set (default: yourself). Setting ANOTHER session requires you to be the recorded leader of ITS fleet (or the queen / owner) — requests above THAT session's model + fleet-role ceiling are rejected with no write. Use to set a member's limit directly instead of asking it to.",
      ),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // P-006: cross-session set — a leader/queen/owner sets a MEMBER's limit directly.
    if (args.ownerId && args.ownerId !== identity.ownerId) {
      const result = await setCompactionLimitForOwner(ctx, args.ownerId, args.limit);
      return { data: result };
    }
    // Clamp to the caller's model-derived ceiling (context-trimming-tiers D-001):
    // `limit × 1.2 ≤ window − margin`, i.e. limit ≤ defaultCompactionLimitForSpec(spec).
    // The spec resolves best-effort (session settings.json → launch argv); an
    // unresolvable spec clamps to the fleet-default [1m] ceiling (400k, WI-3383) —
    // on this opus[1m]-default fleet a genuine small-window model is always
    // explicitly specced, so an unknown is a 1M session, not a haiku.
    // Codex publishes its effective context window from the live rollout. Prefer
    // that measurement over a launch-spec inference: the CLI can apply a smaller
    // window than the model spec implies, and accepting a limit above the measured
    // ceiling makes ok:true lie until the watchdog repairs it later.
    const measuredWindow = await estimateContextWindowForOwner(identity.ownerId).catch(() => null);
    const spec =
      measuredWindow == null ? await resolveModelSpecForOwner(identity.ownerId).catch(() => null) : null;
    // SELF-SET path ⇒ the self-set ceiling (825k on a [1m] window), not the SEEDED
    // default (400k). Until 2026-08-08 these were one constant, so this verb's own
    // stated purpose — "raise it for wide-context work" — was unreachable on the
    // fleet's default spec: every request above 400k silently clamped back to it.
    // Seeding still uses defaultCompactionLimitForSpec, so fleet-wide cost is unchanged.
    // A FLEET MEMBER has a tighter self-set ceiling than a leader. Resolve the
    // CALLER's own fleet role exactly as set-compaction-limit-core resolves the
    // TARGET's, and thread it into both the cap and the spec clamp below.
    // Omitting it made `roleCap` resolve to POSITIVE_INFINITY for members, so an
    // over-cap request returned ok:true and was persisted { explicit: true } —
    // then silently rewritten to the role cap by compaction-compliance-watchdog.
    // The false SUCCESS is the defect; the ceiling itself is deliberate policy.
    const selfFleet = (await fetchPresenceFleet([identity.ownerId]).catch(() => new Map())).get(
      identity.ownerId,
    );
    const selfRole: string | null = selfFleet?.fleetRole ?? null;
    const fleetMember = selfRole != null && selfRole !== 'leader';
    const cap =
      measuredWindow != null
        ? selfSetCeilingForWindow(measuredWindow, { fleetMember })
        : selfSetCeilingForSpec(spec, { fleetMember });
    if (args.limit > cap) {
      return {
        data: {
          ok: false,
          ownerId: identity.ownerId,
          requested: args.limit,
          cap,
          error: 'limit_exceeds_cap',
          message: `requested compaction limit ${args.limit} exceeds the model-derived ceiling ${cap}; no change was made`,
          note: 'The requested limit was not written because it exceeds the current model-derived ceiling.',
        },
      };
    }
    // A measured window is authoritative, so the spec-based clamp must not
    // silently lower an otherwise valid request after the measured-cap check.
    const applied =
      measuredWindow != null
        ? args.limit
        : clampCompactionLimit(args.limit, spec, { fleetMember, selfSet: true });
    if (applied !== args.limit) {
      return {
        data: {
          ok: false,
          ownerId: identity.ownerId,
          requested: args.limit,
          cap,
          error: 'limit_out_of_range',
          message: `requested compaction limit ${args.limit} is outside the allowed range; no change was made`,
          note: 'The requested limit was not written because it would require clamping.',
        },
      };
    }
    await setCompactionLimit(identity.ownerId, applied, { explicit: true });
    const presence = await getPresence(identity.ownerId);
    const persisted = presence?.compactionLimit ?? null;
    // { data } shape (tool-data-shape ratchet P-003): the framework owns wire encoding.
    return {
      data: {
        ok: persisted != null,
        ownerId: identity.ownerId,
        compactionLimit: persisted,
        ...(persisted == null ? { note: 'no live presence row for this session — limit not persisted' } : {}),
      },
    };
  },
});
