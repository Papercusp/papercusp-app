/**
 * config:doors-set — set the WORKSPACE-DEFAULT overrides of the context-door /
 * compaction-threshold constants (deterministic-context-carry P-023).
 *
 * Replace-wholesale over the workspace layer (pass only the keys to override; omitted
 * keys revert to baked; clear:true wipes the layer). Overrides are DELIBERATE decisions
 * — never runtime feedback (plan D-001) — and run through the gateway-control harness:
 * dryRun preview, post-apply verify, audit record, one-call revert. doorSplit is
 * all-or-nothing and must sum to 1 (output + resultSlots×resultEach + injections).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readContextDoorsConfig,
  writeContextDoorsDefaults,
  sanitizeDoorPatch,
  resolveDoorConstants,
  type DoorConstantsPatch,
} from '../../context-doors-config';
import { BAKED_DOOR_CONSTANTS, computeTurnDoors } from '../../context-doors';

const doorSplitSchema = z
  .object({
    output: z.number().gt(0).lt(1).describe('Model-output share of maxTurn (baked 0.5).'),
    resultEach: z.number().gt(0).lt(1).describe('Per-tool-result share (baked 0.1875).'),
    resultSlots: z.number().int().min(1).max(8).describe('Result slots budgeted (baked 2).'),
    injections: z.number().gt(0).lt(1).describe('Injection share (baked 0.125).'),
  })
  .describe('All-or-nothing; output + resultSlots×resultEach + injections must equal 1.');

export default defineTool({
  name: 'config:doors-set',
  profile: 'engineer',
  description:
    'Set the workspace-default overrides of the context-door / compaction-threshold constants (maxTurn floor/cap/divisor, door split, compaction overhead). Replace-wholesale over the workspace layer; clear:true reverts to baked. Audited + one-call-revertible (gateway-control harness). Overrides are deliberate decisions, never runtime feedback (D-001).',
  capability: 'operator:write',
  guidance: {
    when: 'Deliberately re-tuning the per-hop budgets fleet-wide — e.g. raising the maxTurn floor for a workspace running large-window models, or re-splitting the doors.',
    notWhen: 'For ONE session only — config:doors-set-session. To read the layers — config:doors-get. Never as a reaction to a single fat hop (that is runtime feedback, D-001).',
    chaining: 'config:doors-get first; set with dryRun:true to preview; config:list-overrides shows the active override; config:reset-overrides reverts the concern.',
    seeAlso: [
      'config:doors-get (read every layer + operating points)',
      'config:doors-set-session (your session only, TTL = session)',
      'config:reset-overrides (revert this concern to baked)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    // Floor max raised 50K→100K (deterministic-context-carry P-024, D-012 live-leg
    // prerequisite): pinning maxTurn=100K for a sweep cell requires floor=100K, and the
    // owner's sweep range is 2K–100K. Aligned with the cap's ceiling below.
    maxTurnFloorTokens: z.number().int().min(1_000).max(100_000).optional().describe('Per-hop budget floor (baked 8000).'),
    maxTurnCapTokens: z.number().int().min(1_000).max(100_000).optional().describe('Per-hop budget cap (baked 15000). Must stay ≥ the effective floor.'),
    maxTurnWindowDivisor: z.number().min(1).max(1_000).optional().describe('Window divisor between the knees (baked 26).'),
    doorSplit: doorSplitSchema.optional(),
    compactionOverheadTokens: z.number().int().min(0).max(100_000).optional().describe('Fixed per-hop overhead reserve in the threshold math (baked 4000).'),
    clear: z.boolean().optional().describe('Wipe the workspace layer back to baked (ignores the other fields).'),
    dryRun: z.boolean().optional().describe('Preview the mutation without applying it.'),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('config:doors-set requires operator, architect, or mug role');
    }
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

    const outcome = await runControlMutation<DoorConstantsPatch>(
      {
        action: 'config:doors-set',
        subject: 'context-doors',
        actor: `role:${ctx.role}`,
        capturePrev: async () => sanitizeDoorPatch((await readContextDoorsConfig()).defaults),
        apply: async () => sanitizeDoorPatch((await writeContextDoorsDefaults(patch)).defaults),
        revertTo: async (prev) => {
          await writeContextDoorsDefaults(prev ?? {});
        },
        verify: async (next) => {
          const ok = JSON.stringify(next ?? {}) === JSON.stringify(patch);
          return { ok, detail: ok ? undefined : 'workspace defaults did not persist as written' };
        },
        describe: (prev) => ({ current: prev, patch, baked: BAKED_DOOR_CONSTANTS }),
      },
      { dryRun: args.dryRun },
    );

    const effective = resolveDoorConstants(await readContextDoorsConfig(), null);
    return {
      data: {
        ok: true,
        dryRun: outcome.dryRun,
        applied: outcome.applied,
        reverted: outcome.reverted,
        preview: outcome.preview,
        verify: outcome.verify,
        auditId: outcome.auditId,
        workspaceDefaults: outcome.next ?? patch,
        effectiveWorkspace: effective,
        floorWindowDoors: computeTurnDoors(0, effective),
      },
    };
  },
});
