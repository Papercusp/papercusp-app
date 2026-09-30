/**
 * events:lost-wake-check — read `harness_shared.event_awaits` and report awaitable event keys
 * whose LIVE real-fire rate is degenerate (EI-10869).
 *
 * The direct analogue of `gates:degenerate-check` (EI-10609) on the sibling table: gates
 * decide, awaits wake, and both are degenerate when their rate pins to an extreme. A CONVICTED
 * finding carries independent witness evidence that the underlying condition occurred while
 * the wake did not (EI-10800's exact shape — a real green-checkpoint verdict landed 88 times
 * with 0 real event fires). A SUSPECT has no declared witness (or the witness could not
 * confirm) and is a review item, not a proven bug — see `events/await/lost-wake-detect.ts` for
 * why the witness leg is required to avoid a false-positive machine.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { findLostWakes } from '../../events/await/lost-wake-detect';

const EVENTS_SCOPE_NOTE =
  'Workspace-global read surface: scope comes from request context; do not pass `harness` or `workspace` as JSON arguments (those keys are rejected).';

export default defineTool({
  name: 'events:lost-wake-check',
  description:
    `Read event_awaits for keys with enough settled awaits but few real event fires. CONVICTED means an independent witness confirms the condition occurred without a wake; SUSPECT means the witness is absent or unconfirmed. Timeout settlements are not tool calls and cannot be diagnosed from tool_invocations. ${EVENTS_SCOPE_NOTE}`,
  guidance: {
    when:
      'Audit whether events:await fires on live traffic, including suspected zero-fire paths and silent missing emits.',
    notWhen:
      'Below minSettled, the sample is insufficient. Frequent timeouts on a legitimately rare event do not prove a bug; unwitnessed findings remain suspects.',
    chaining:
      'Read a convicted finding\'s witness and emit call site; fix any teardown race by awaiting the emit. For a suspect, investigate or add a witness to LOST_WAKE_WITNESSES in events/await/lost-wake-detect.ts.',
    seeAlso: ['gates:degenerate-check', 'events:status', 'events:catalog'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sinceDays: z
      .number()
      .positive()
      .max(90)
      .optional()
      .describe('Window to judge over, in days (default 7 — awaits can sit parked a long time before timing out, so a short window under-samples low-traffic keys).'),
    minSettled: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Settled awaits (fired + timed-out) a key needs before its rate means anything (default 5).'),
    degenerateRatePct: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('A real-fire rate at or below this percentage is a suspect (default 10 — separates known-degenerate 0–2% keys from known-healthy 15.8%+ keys on live data).'),
  }),
  async handler(args) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const findings = await findLostWakes(getOrgPg().sql, {
      sinceMs: args.sinceDays != null ? args.sinceDays * 24 * 60 * 60 * 1000 : undefined,
      minSettled: args.minSettled,
      degenerateRatePct: args.degenerateRatePct,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            windowDays: args.sinceDays ?? 7,
            convictedCount: findings.filter((f) => f.verdict === 'convicted').length,
            suspectCount: findings.filter((f) => f.verdict === 'suspect').length,
            findings,
          }),
        },
      ],
    };
  },
});
