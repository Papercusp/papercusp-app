/**
 * operator:rate_limit_config — read / edit the live fleet rate-limit knobs
 * (rate-limit-layer-v2 D-004): `maxSimultaneousAgents` (the fleet-wide cap on
 * concurrently-running agent spawns) and `concurrencyFloor` (the AIMD floor, D-005).
 *
 * A `set` persists to PG (`operator_rate_limit_config`, migration 161) and propagates
 * LIVE through the in-process bus — the governor's global gate, the orchestrator
 * dispatch ceiling, and pty-bridge honor the new value on their next check, no restart.
 * Mirrors `operator:preferences` (read open, write operator/architect-gated).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import {
  RATE_LIMIT_SANITY_BOUND,
  GOVERNOR_PROVIDERS,
  readRateLimitConfig,
  writeRateLimitConfig,
} from '../../rate-limit-config';

const floorSchema = z
  .object({
    maxConcurrent: z.number().int().min(1).max(256).optional(),
    rpm: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();
// per-provider floor overrides, keyed by the governor providers (anthropic/openai/unknown).
const providerFloorsSchema = z
  .object(Object.fromEntries(GOVERNOR_PROVIDERS.map((p) => [p, floorSchema.optional()])))
  .strict();
const aimdSchema = z
  .object({
    cleanTurnsPerStep: z.number().int().min(1).max(1000).optional(),
    decreaseFactor: z.number().gt(0).lt(1).optional(),
  })
  .strict();

export default defineTool({
  name: 'operator:rate_limit_config',
  profile: 'engineer',
  description:
    'Read or edit the live fleet rate-limit config: maxSimultaneousAgents (fleet-wide concurrent-agent cap), concurrencyFloor (the AIMD floor), providerFloors (per-provider cold-start {maxConcurrent,rpm} floors — the subscription rpm gate), and aimd (the response-curve: cleanTurnsPerStep + decreaseFactor). Edits persist + propagate with zero restart.',
  capability: 'operator:write',
  guidance: {
    when: 'Throttle/open the fleet ("drop to 2 agents while I use Claude"), tune a provider\'s static rpm floor live (providerFloors.anthropic.rpm), or reshape the AIMD curve (slower recovery / gentler backoff) during a rate-limit incident — all without a deploy.',
    notWhen: 'READ the live pacing/pause/usage state — dev:rate_governor_status (this tool reads the persisted CONFIG, not the live bucket state). Per-TOOL call quotas → quota:set_tool.',
    chaining: 'After a set, dev:rate_governor_status shows the new floors/cap take effect; config:list-overrides shows every active override.',
    seeAlso: [
      'dev:rate_governor_status (the live pacing / cap after a set)',
      'config:list-overrides (every active override)',
      'quota:set_tool (per-tool call quotas)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      maxSimultaneousAgents: z.number().int().min(1).max(RATE_LIMIT_SANITY_BOUND).optional(),
      concurrencyFloor: z.number().int().min(1).max(RATE_LIMIT_SANITY_BOUND).optional(),
      // P-021: pass {} to clear all provider-floor overrides; omit to leave the current ones unchanged.
      providerFloors: providerFloorsSchema.optional(),
      // P-021: pass {} to restore the baked AIMD curve; omit to leave it unchanged.
      aimd: aimdSchema.optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      return { content: [{ type: 'text', text: JSON.stringify({ config: await readRateLimitConfig() }) }] };
    }
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('operator:rate_limit_config set requires operator, architect, or mug role');
    }
    if (
      args.maxSimultaneousAgents === undefined &&
      args.concurrencyFloor === undefined &&
      args.providerFloors === undefined &&
      args.aimd === undefined
    ) {
      throw new Error('set requires at least one of maxSimultaneousAgents / concurrencyFloor / providerFloors / aimd');
    }
    // Merge over the current config so a partial edit preserves the unspecified field groups
    // (a cap-only edit must NOT wipe an existing providerFloors / aimd override).
    const current = await readRateLimitConfig();
    const config = await writeRateLimitConfig({
      ...current,
      ...(args.maxSimultaneousAgents !== undefined ? { maxSimultaneousAgents: args.maxSimultaneousAgents } : {}),
      ...(args.concurrencyFloor !== undefined ? { concurrencyFloor: args.concurrencyFloor } : {}),
      ...(args.providerFloors !== undefined ? { providerFloors: args.providerFloors } : {}),
      ...(args.aimd !== undefined ? { aimd: args.aimd } : {}),
    });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, config }) }] };
  },
});
