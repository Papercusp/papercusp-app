/**
 * `orchestrator:spawn-roles` (D-004 — wraps the agent-spawn runner) — fan out a
 * set of role agents with injected context. The vote program's `fan-out` step:
 * one `voter` per lens (the anti-correlated-error defense, D-010) + one
 * `advocate`. Each spawned agent receives the injected question/options + (for a
 * per-lens role) its lens, plus the `conversation_id` it must post its structured
 * vote into.
 *
 * Cost guard (D-008): a per-role `per` array is capped at `max_voters` so a
 * payload with 50 lenses can't fan out 50 agents — the knob bounds spend
 * declaratively. The op AWAITS its agents (each posts before exiting) so the whole
 * fan-out is one checkpointed DBOS step (replay-safe); `collect` then reads the
 * posts. Individual agent failures are tolerated — `collect`'s quorum lets the
 * program proceed without every voter.
 */
import { z } from 'zod';
import type { CoordOp, ResolvedSpawn } from '../types.js';
import { registerCoordOp } from '../registry.js';

const roleSpec = z.object({
  role: z.string().min(1),
  /** Spawn one agent per item, injecting the item under the `as` key. */
  per: z.array(z.unknown()).optional(),
  /** The inject key for a `per` item (e.g. 'lens'). */
  as: z.string().optional(),
  /** Fixed count when there is no `per` (default 1). */
  count: z.number().int().positive().optional(),
  /** Optional persona override injected for these agents. */
  persona: z.string().optional(),
});

const args = z.object({
  conversation_id: z.string().min(1),
  roles: z.array(roleSpec).min(1),
  /** Base context injected into every spawned agent. */
  inject: z.record(z.string(), z.unknown()).default({}),
  /** Cap on a per-expanded role's agent count (cost guard — D-008). */
  max_voters: z.number().int().positive().default(5),
});

const result = z.object({
  spawned: z.array(
    z.object({ role: z.string(), inject: z.record(z.string(), z.unknown()), ok: z.boolean() }),
  ),
  launched: z.number().int(),
});

export const spawnRolesOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'orchestrator:spawn-roles',
  description: 'Spawn role agents (one per lens + an advocate) with injected context for a vote.',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const base = { ...a.inject, conversation_id: a.conversation_id };
    // The owning blueprint (stamped by runProgramCore) — so each spawned role
    // resolves its prompt from blueprints/<blueprintId>/prompts/<role>.md.
    const blueprintId = ctx.blueprintId;
    const specs: ResolvedSpawn[] = [];
    for (const r of a.roles) {
      if (r.per && r.per.length > 0) {
        const items = r.per.slice(0, a.max_voters); // cost guard (D-008)
        for (const item of items) {
          const inject: Record<string, unknown> = { ...base, role: r.role };
          if (r.as) inject[r.as] = item;
          if (r.persona) inject.persona = r.persona;
          specs.push({ role: r.role, inject, blueprintId });
        }
      } else {
        const n = r.count ?? 1;
        for (let i = 0; i < n; i++) {
          const inject: Record<string, unknown> = { ...base, role: r.role };
          if (r.persona) inject.persona = r.persona;
          specs.push({ role: r.role, inject, blueprintId });
        }
      }
    }
    ctx.log?.(`spawn-roles: launching ${specs.length} agents (${specs.map((s) => s.role).join(', ')})`);
    return ctx.caps.spawnRoles(specs);
  },
};

registerCoordOp(spawnRolesOp);
