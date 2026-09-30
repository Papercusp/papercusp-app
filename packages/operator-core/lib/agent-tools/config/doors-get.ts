/**
 * config:doors-get — read the context-door / compaction-threshold constants
 * (deterministic-context-carry P-023): baked defaults, the workspace override layer,
 * the per-session override layer (yours in full; others as a summary), the EFFECTIVE
 * constants for YOUR session, and the operating points they produce (the floor-window
 * doors + the Ornith/400K compaction thresholds).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  BAKED_DOOR_CONSTANTS,
  computeCompactionThresholds,
  computeTurnDoors,
} from '../../context-doors';
import { readContextDoorsConfig, resolveDoorConstants, sanitizeDoorPatch } from '../../context-doors-config';

export default defineTool({
  name: 'config:doors-get',
  profile: 'engineer',
  description:
    'Read the context-door / compaction-threshold constants: baked defaults, the workspace override layer, the session override layer, your EFFECTIVE constants, and the operating points they produce (floor-window doors; Ornith/400K compaction thresholds).',
  capability: 'coord:read',
  guidance: {
    when: 'Before tuning the doors (config:doors-set / config:doors-set-session), or to check which layer is governing the per-hop budgets right now.',
    notWhen: 'To change a value — config:doors-set (workspace defaults) or config:doors-set-session (your session only).',
    seeAlso: [
      'config:doors-set (workspace-default overrides, audited)',
      'config:doors-set-session (your session only, TTL = session)',
      'config:list-overrides (this concern among all runtime-config overrides)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  rolesQuota: { operator: { perRun: 60 } },
  args: z.object({}),
  async handler(_args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const row = await readContextDoorsConfig();
    const effective = resolveDoorConstants(row, identity.ownerId);
    const sessions = Object.entries(row.sessions ?? {});
    return {
      data: {
        ok: true,
        ownerId: identity.ownerId,
        baked: BAKED_DOOR_CONSTANTS,
        workspaceDefaults: sanitizeDoorPatch(row.defaults),
        yourSessionOverride: row.sessions?.[identity.ownerId] ?? null,
        otherSessionOverrides: sessions
          .filter(([ownerId]) => ownerId !== identity.ownerId)
          .map(([ownerId, s]) => ({ ownerId, setBy: s.setBy, setAt: s.setAt, keys: Object.keys(sanitizeDoorPatch(s.overrides)) })),
        effective,
        operatingPoints: {
          floorWindowDoors: computeTurnDoors(0, effective),
          ornith204800: computeCompactionThresholds(204_800, effective),
          window400k: computeCompactionThresholds(400_000, effective),
        },
      },
    };
  },
});
