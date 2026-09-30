/**
 * autoloop:status — read autoloop_state rows for a harness slug.
 *
 * Returns null when no rows exist (autoloop hasn't fired for this
 * harness yet) so callers can distinguish "no data" from empty array.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { evaluateFireGate, getAutoLoopState } from '../../autoloop';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'autoloop:status',
  profile: 'engineer',
  guidance: {
    when: 'User asks "is the autoloop running?", "is the harness on autopilot?". Reads enabled/paused state + recent tick info.',
    notWhen: 'For TURNING the autoloop on/off, use `autoloop:control`. For harness liveness in general, use `harness:health`.',
    chaining: 'Pair with `autoloop:control` if the user wants to change state.',
    seeAlso: [
      'autoloop:control (turn the autoloop on / off)',
      'harness:health (harness liveness in general)',
    ],
  },
  description: 'Read autoloop_state rows (last_fired_at, last_status, consecutive_errors) for a harness slug.',
  capability: 'autoloop:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
  }),
  // Declarative precondition (D-006 proof migration): the former in-handler
  // `if (!slug) throw` guard, lifted. A non-empty slug must arrive via the
  // arg or the spawn ctx; the dispatcher rejects with `precondition_failed`
  // before the handler runs.
  requires: [
    {
      id: 'harness-slug',
      when: {
        any: [
          { 'args.harnessSlug': { truthy: true } },
          { 'ctx.harnessSlug': { truthy: true } },
        ],
      },
      error: 'autoloop:status — harness slug required (passed or in spawn ctx)',
    },
  ],
  async handler(args, ctx) {
    // The `harness-slug` precondition guarantees a slug arrived (arg or ctx), but
    // the operator/superuser `'*'` auto-default is truthy and slips past it —
    // route through the fail-loud resolver so `'*'`/all is rejected instead of
    // querying a nonexistent `'*'` install_slug bucket (P-004).
    const slug = resolveConcreteHarnessSlug(args.harnessSlug, ctx);
    if (!slug) {
      return harnessRequiredResult('autoloop:status');
    }
    const rows = await getAutoLoopState(slug);
    // P-009: surface the backoff verdict per fire-state row so "is the circuit
    // open?" is answerable here (autoloop:control reset-errors closes it).
    const gated = (rows ?? []).map((r) => ({
      ...r,
      gate: evaluateFireGate({
        lastFiredAt: r.last_fired_at ? new Date(r.last_fired_at) : null,
        consecutiveErrors: Number(r.consecutive_errors ?? 0),
      }),
    }));
    // P-010: the autoloop IS the harness's blueprint-scheduled routines now —
    // show them (the thing autoloop:control pauses/resumes).
    const { sql } = getOrgPg();
    const routines = await sql<
      Array<{ name: string; active: boolean; next_fire_at: Date | null; last_fired_at: Date | null }>
    >`
      SELECT name, active, next_fire_at, last_fired_at
        FROM harness_shared.routines
       WHERE install_slug = ${slug} AND name LIKE 'bp-schedule-%'
       ORDER BY name
    `;
    return { data: { harnessSlug: slug, rows: gated.length > 0 ? gated : null, scheduleRoutines: routines } };
  },
});
