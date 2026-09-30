/**
 * config:doors-set-session — bind a context-door constants override to THIS session
 * (deterministic-context-carry P-023, the per-session leg).
 *
 * Bound to the CALLER's resolved agent identity (resolveAgentIdentity — the same key the
 * door enforcement sites resolve), provenance-stamped ({ setBy, provenance, setAt }) and
 * audited via the gateway-control harness. TTL = session: the override only ever governs
 * this session's own traffic, is age-capped as a GC bound, and is cleared with clear:true
 * (or by config:reset-overrides for the whole concern). A deliberate decision, never
 * runtime feedback (D-001).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  readContextDoorsConfig,
  writeSessionDoorsOverride,
  sanitizeDoorPatch,
  resolveDoorConstants,
  type DoorConstantsPatch,
  type SessionDoorsOverride,
} from '../../context-doors-config';
import { computeTurnDoors } from '../../context-doors';

const doorSplitSchema = z
  .object({
    output: z.number().gt(0).lt(1),
    resultEach: z.number().gt(0).lt(1),
    resultSlots: z.number().int().min(1).max(8),
    injections: z.number().gt(0).lt(1),
  })
  .describe('All-or-nothing; output + resultSlots×resultEach + injections must equal 1.');

export default defineTool({
  name: 'config:doors-set-session',
  description:
    'Bind a context-door constants override to THIS session (TTL = session, provenance-stamped, audited): maxTurn floor/cap/divisor, door split, compaction overhead. Only your own traffic is governed; clear:true drops it. A deliberate decision, never runtime feedback (D-001).',
  capability: 'coord:write',
  guidance: {
    when: 'Deliberately re-tuning YOUR OWN per-hop budgets for a specific task — e.g. widening the result door for a session paging large artifacts, without touching the workspace defaults.',
    notWhen: 'Fleet-wide — config:doors-set. To read the layers — config:doors-get. Never as a reaction to one capped result (runtime feedback, D-001) — page the spill pointer instead.',
    chaining: 'config:doors-get first (see your effective constants); set; clear:true when the task is done.',
    seeAlso: [
      'config:doors-get (your effective constants + every layer)',
      'config:doors-set (workspace defaults, SU roles)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    // Floor max raised 50K→100K (P-024, D-012): the sweep pins per-SESSION floors up to
    // the owner's 100K sweep point. Mirrored in doors-set.ts + maxturn-sweep.ts constants.
    maxTurnFloorTokens: z.number().int().min(1_000).max(100_000).optional(),
    maxTurnCapTokens: z.number().int().min(1_000).max(100_000).optional(),
    maxTurnWindowDivisor: z.number().min(1).max(1_000).optional(),
    doorSplit: doorSplitSchema.optional(),
    compactionOverheadTokens: z.number().int().min(0).max(100_000).optional(),
    clear: z.boolean().optional().describe('Drop this session’s override (ignores the other fields).'),
    dryRun: z.boolean().optional().describe('Preview the mutation without applying it.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = identity.ownerId;
    const patch: DoorConstantsPatch = args.clear
      ? {}
      : sanitizeDoorPatch({
          maxTurnFloorTokens: args.maxTurnFloorTokens,
          maxTurnCapTokens: args.maxTurnCapTokens,
          maxTurnWindowDivisor: args.maxTurnWindowDivisor,
          doorSplit: args.doorSplit,
          compactionOverheadTokens: args.compactionOverheadTokens,
        });
    if (!args.clear && Object.keys(patch).length === 0) {
      throw new Error(
        'set requires at least one valid override (or clear:true) — a doorSplit must sum to 1: output + resultSlots×resultEach + injections',
      );
    }
    const provenance = `role:${ctx.role ?? 'unknown'} source:${identity.source}`;

    const outcome = await runControlMutation<SessionDoorsOverride | null>(
      {
        action: 'config:doors-set-session',
        subject: `context-doors/session/${ownerId}`,
        actor: ownerId,
        capturePrev: async () => (await readContextDoorsConfig()).sessions?.[ownerId] ?? null,
        apply: async () => {
          const row = args.clear
            ? await writeSessionDoorsOverride(ownerId, null)
            : await writeSessionDoorsOverride(ownerId, { overrides: patch, setBy: ownerId, provenance });
          return row.sessions?.[ownerId] ?? null;
        },
        revertTo: async (prev) => {
          await writeSessionDoorsOverride(ownerId, prev ?? null);
        },
        verify: async (next) => {
          const ok = args.clear
            ? next == null
            : next != null && JSON.stringify(sanitizeDoorPatch(next.overrides)) === JSON.stringify(patch);
          return { ok, detail: ok ? undefined : 'session override did not persist as written' };
        },
        describe: (prev) => ({ current: prev, patch: args.clear ? 'clear' : patch, ownerId, provenance }),
      },
      { dryRun: args.dryRun },
    );

    const effective = resolveDoorConstants(await readContextDoorsConfig(), ownerId);
    return {
      data: {
        ok: true,
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
        ownerId,
        sessionOverride: outcome.next ?? null,
        effective,
        floorWindowDoors: computeTurnDoors(0, effective),
      },
    };
  },
});
