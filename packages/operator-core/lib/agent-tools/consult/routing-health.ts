/**
 * consult:routing-health — per selection policy, what happened to the answering
 * sessions the relevance router launched in a window (plan
 * review-routing-through-relevance-router-2026-09-26, P-004 / R-5).
 *
 * PROD BINDING ONLY — the derivation lives in lib/consult/consult-routing-health.ts.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';

const countsShape = z
  .object({
    consults: z.number(),
    consultsWithoutDispatchRecords: z.number(),
    launched: z.number(),
    answered: z.number(),
    declined: z.number(),
    failed: z.number(),
    failedReasons: z.record(z.string(), z.number()),
    hung: z.number(),
    pending: z.number(),
    skipped: z.number(),
    skippedReasons: z.record(z.string(), z.number()),
  })
  .passthrough();

export default defineTool({
  name: 'consult:routing-health',
  // @not-a-cell A caller-windowed report over persisted consult dispatch records; one door derives it and no other surface re-derives these counts.
  profile: 'engineer',
  description:
    'Is consultation delivery working? Reports separate launch-attempt and request-time cohorts. Request intent distinguishes dispatch, deliberate retrieval-only and unknown legacy intent; requested dispatch is partitioned into recorded feedback, honest decline, pending, unavailable, failed and unmeasured outcomes. Feedback receipts outrank later lifecycle labels. Default window: last 24 h.',
  guidance: {
    when:
      'You need the answer rate or failure reasons of routed reviews/consults (rubric vetting, acceptance grading, grading-integrity audits, ordinary consults) — instead of hand-written SQL over consult_state.',
    notWhen:
      'One consult’s own history → conversations:get on its conversation id. Asking a peer a question → consult:get_feedback.',
    chaining:
      'Read bounded.truncatedByLimit and consultsWithoutDispatchRecords before trusting a zero: consults routed before the dispatch recorder shipped carry no records.',
    returns:
      '{ ok, window:{since,until,cohort}, asOf, policies:[{ policy, consults, consultsWithoutDispatchRecords, launched, answered, declined, failed, failedReasons, hung, pending, skipped, skippedReasons }], totals, bounded:{ truncatedByLimit, consultsScanned, consultLimit, dispatchLogCapped } }.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z
    .object({
      hours: z
        .number()
        .positive()
        .max(24 * 14)
        .optional()
        .describe('Window length ending at `until` (default 24). Ignored when `since` is given.'),
      since: z.string().min(1).optional().describe('Window start, ISO-8601. Launches at or after it count.'),
      until: z.string().min(1).optional().describe('Window end, ISO-8601 (default now). Launches before it count.'),
    })
    .strict(),
  result: z
    .object({
      ok: z.boolean(),
      error: z.string().optional(),
      window: z.object({ since: z.string(), until: z.string(), cohort: z.literal('launch-time') }).optional(),
      asOf: z.string().optional(),
      policies: z.array(countsShape.extend({ policy: z.string() })).optional(),
      totals: countsShape.optional(),
      bounded: z
        .object({
          truncatedByLimit: z.boolean(),
          consultsScanned: z.number(),
          consultLimit: z.number(),
          dispatchLogCapped: z.number(),
        })
        .optional(),
      requestCohort: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const [{ getOrgPg }, health, conversations] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/consult-routing-health'),
      import('../coordination/conversations'),
    ]);
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );
    const nowMs = Date.now();
    const window = health.resolveRoutingHealthWindow(args, nowMs);
    if ('error' in window) {
      return { data: { ok: false, error: window.error } };
    }
    const { rows, truncated } = await health.readRoutingHealthRows(
      getOrgPg().sql as unknown as Parameters<typeof health.readRoutingHealthRows>[0],
      workspaceId,
      new Date(window.sinceMs).toISOString(),
      new Date(window.untilMs).toISOString(),
      undefined,
      new Date(nowMs).toISOString(),
    );
    const result = health.routingHealthFromRows(rows, { ...window, nowMs, truncatedByLimit: truncated });
    return { data: { ok: true, ...result } };
  },
});
