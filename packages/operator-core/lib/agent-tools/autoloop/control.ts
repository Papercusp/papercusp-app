/**
 * autoloop:control — pause/resume a harness's blueprint-scheduled autoloop, or
 * reset its error circuit (autoloop-pot-operator-rebuild-2026-06-05 P-010).
 *
 * The autoloop is no longer a process-local ticker — it is the durable routines
 * engine firing the harness's blueprint-declared schedule (`bp-schedule-*`
 * routines, materialized by harness:create). So:
 *   - pause/resume = flip those routine rows' `active` (durable, cross-process,
 *     survives restarts — unlike the old in-process timer clear).
 *   - reset-errors = zero `consecutive_errors` in autoloop_state, closing the
 *     P-009 backoff circuit so the next scheduled fire goes out immediately.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resetFireErrors } from '../../autoloop';
import { activeWorkspaceId } from '../../workspace-registry';
import { isWorkspaceCoordinationOn, workspaceBrainReadKeys } from '../../workspace-brain-scope';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

/** The blueprint-schedule routine-name prefix `materializeBlueprintTriggers` seeds. */
const BP_SCHEDULE_PREFIX = 'bp-schedule-';

/** The workspace-wide install_slug that `loop:arm` loops (the `loop-su-` /
 *  `loop-role-` roles) record their fire-gate under
 *  (loop-fire.ts `checkFireGate(installSlug, …)`). */
const LOOP_ARM_SCOPE = '*';

/**
 * PURE: which autoloop_state harness scopes a `reset-errors` op must clear.
 *
 * The per-harness brain scopes ([workspaceId, slug]) never include the `'*'`
 * workspace-wide scope, but `loop:arm` loops (the `loop-su-` / `loop-role-` roles)
 * record their fire-gate under install_slug='*'. So a ROLE-scoped reset must also clear `'*'` —
 * otherwise the remediation the chronic-failure watchdog explicitly prescribes
 * ("then autoloop:control reset-errors") can NEVER reach a loop-su-*@* row, and the
 * exact class of loops that triggers it stays un-resettable (EI-6753). A role-LESS
 * reset stays per-harness (never adds '*') so it can't silently wipe every
 * warm-session loop's counter across the workspace. Deduped, order-stable.
 */
export function resetErrorScopes(brainScopes: readonly string[], role: string | undefined): string[] {
  const scopes = role ? [...brainScopes, LOOP_ARM_SCOPE] : [...brainScopes];
  return [...new Set(scopes)];
}

export default defineTool({
  name: 'autoloop:control',
  profile: 'engineer',
  guidance: {
    when: 'User says "pause the autoloop", "turn autopilot back on", or a circuit-open harness needs its error counter reset after a fix. Per-harness, durable.',
    notWhen: 'For PAUSING all of the operator (silence-mode-style), use the operator-pause flag — autoloop is per-harness. For pausing git-sync or another non-schedule routine, flip that routine directly.',
    chaining:
      'autoloop:status first to see the schedule routines + circuit state; reset-errors after fixing whatever made the fires fail. ' +
      "A dead loop:arm loop's red counter lives under the workspace-wide '*' scope, not your harness — " +
      "reset-errors {harness, role:'<the dead loop's owner/role>'} clears BOTH scopes in one call (EI-6753); " +
      "literal harness:'*' is still rejected (P-004), pass any real harness.",
    seeAlso: [
      'autoloop:status (see schedule routines + circuit state first)',
      'operator:paused (pause ALL of the operator, not just one harness)',
    ],
  },
  description:
    "Pause/resume a harness's blueprint-scheduled autoloop (flips its bp-schedule-* routine rows — durable) or reset its error circuit (zeroes consecutive_errors so backoff stops withholding fires).",
  capability: 'autoloop:write',
  requirePrincipal: false,
  agentRoles: ['operator'],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    op: z.enum(['pause', 'resume', 'reset-errors']),
    harness: z.string().max(120).optional().describe('Harness slug (or via spawn ctx).'),
    role: z.string().max(80).optional().describe("reset-errors only: a single role's counter (default: all roles)."),
  }),
  // Declarative precondition (D-006): a harness must be named — by arg or ctx.
  requires: [
    {
      id: 'harness-slug',
      when: {
        any: [
          { 'args.harness': { truthy: true } },
          { 'ctx.harnessSlug': { truthy: true } },
        ],
      },
      error: 'autoloop:control — harness slug required (passed or in spawn ctx)',
    },
  ],
  async handler(args, ctx) {
    // The `harness-slug` precondition guarantees a slug arrived, but the operator
    // `'*'` auto-default is truthy and slips past it — route through the fail-loud
    // resolver so a `'*'`/all scope can't silently no-op the routine UPDATE (P-004).
    const slug = resolveConcreteHarnessSlug(args.harness, ctx);
    if (!slug) {
      return harnessRequiredResult('autoloop:control');
    }
    const { sql } = getOrgPg();

    if (args.op === 'reset-errors') {
      const workspaceId =
        typeof ctx.workspaceId === 'string' && ctx.workspaceId.trim()
          ? ctx.workspaceId.trim()
          : activeWorkspaceId();
      const brainScopes = workspaceBrainReadKeys(workspaceId, slug, await isWorkspaceCoordinationOn());
      // A role-scoped reset also clears the '*' (loop:arm) scope so the watchdog's
      // prescribed remediation actually reaches a loop-su-*@* row (EI-6753). See
      // `resetErrorScopes`.
      const scopes = resetErrorScopes(brainScopes, args.role);
      const results = [];
      for (const scope of scopes) {
        results.push({ harness: scope, rowsReset: await resetFireErrors(scope, args.role) });
      }
      const n = results.reduce((sum, r) => sum + r.rowsReset, 0);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              op: 'reset-errors',
              harness: slug,
              rowsReset: n,
              ...(results.length > 1 ? { scopes: results } : {}),
            }),
          },
        ],
      };
    }

    const active = args.op === 'resume';
    const rows = await sql<{ name: string }[]>`
      UPDATE harness_shared.routines
         SET active = ${active}, updated_at = now()
       WHERE install_slug = ${slug}
         AND name LIKE ${BP_SCHEDULE_PREFIX + '%'}
      RETURNING name
    `;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            op: args.op,
            harness: slug,
            routines: rows.map((r) => r.name),
            note: rows.length === 0 ? 'no bp-schedule-* routines for this harness (its blueprint declares no schedule)' : undefined,
          }),
        },
      ],
    };
  },
});
