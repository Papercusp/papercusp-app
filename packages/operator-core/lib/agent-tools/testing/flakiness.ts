/**
 * testing:flakiness — flip-rate analytics over harness_shared.test_runs
 * (EI-6141). See testing-flakiness.ts for the aggregation logic + rationale.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  computeFlakiness,
  isQuarantineCandidate,
  QUARANTINE_CANDIDATE_THRESHOLD,
  QUARANTINE_CANDIDATE_MIN_RUNS,
} from '../../testing-flakiness';
import { searchWorkItems } from '../../work-items';
import { createOneWorkItem } from '../work_items/_create-core';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'testing:flakiness',
  description:
    'Rank test files by cross-run flip-rate (pass<->fail flips across consecutive harness_shared.test_runs rows) over a lookback window — "is this red MINE or a known flake" in one call instead of an anecdotal rerun. Optionally auto-files a `change` quarantine-candidate work item (evidence table + a mandatory de-quarantine follow-up note) for files crossing the flip-rate/run-count bar, deduped by file path against an existing open one.',
  guidance: {
    when: 'A test file is red and you want its recent flip history before treating it as a genuine regression vs a known flake — or triaging the green-checkpoint gate and want the ranked flaky-file list.',
    notWhen: 'A single ad-hoc rerun to check "is it green now" — just rerun the test. This reads cross-run history, not a live probe.',
    chaining: 'testing:flakiness → a red matching a high flipRate row here is a known flake (cite it in your completion) rather than a fresh investigation; autoFile:true files/dedupes the quarantine-candidate tracking item.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(80)
      .optional()
      .describe('scope to one harness (harness_slug). Omit for workspace-wide reads; autoFile requires a concrete slug.'),
    lookbackDays: z.number().int().min(1).max(90).optional().describe('default 14'),
    minRuns: z.number().int().min(1).max(500).optional().describe('minimum run count per file to be considered. default 4'),
    limit: z.number().int().min(1).max(100).optional().describe('max ranked rows returned. default 20'),
    autoFile: z.boolean().optional().describe('file a `change` quarantine-candidate work item for every row crossing the quarantine bar (flipRate>=0.3 & runs>=6 by default), deduped by file path against an existing open one.'),
    threshold: z.number().min(0).max(1).optional().describe('override the quarantine-candidate flipRate bar (default 0.3, autoFile only)'),
    minRunsForAutoFile: z.number().int().min(1).max(500).optional().describe('override the quarantine-candidate run-count floor (default 6, autoFile only)'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // The transport uses `'*'` as the operator/superuser ctx sentinel. It is a
    // valid scope selector for a workspace-wide read, but never a work-item
    // harness: passing it through to createOneWorkItem makes every auto-file
    // attempt fail downstream after the candidate has already been ranked.
    // Auto-file therefore requires the caller to name the concrete harness;
    // ordinary reads retain their workspace-wide behavior when none resolves.
    const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
    if (args.autoFile && !harnessSlug) {
      return harnessRequiredResult('testing:flakiness', ctx);
    }
    const rows = await computeFlakiness({
      harnessSlug,
      workspaceId: ctx.workspaceId,
      lookbackDays: args.lookbackDays,
      minRuns: args.minRuns,
      limit: args.limit,
    });
    const threshold = args.threshold ?? QUARANTINE_CANDIDATE_THRESHOLD;
    const minRunsForAutoFile = args.minRunsForAutoFile ?? QUARANTINE_CANDIDATE_MIN_RUNS;
    const candidates = rows.filter((r) => isQuarantineCandidate(r, { threshold, minRuns: minRunsForAutoFile }));

    let filed: Array<{ filePath: string; id?: string; skipped?: string }> | undefined;
    if (args.autoFile && candidates.length > 0) {
      filed = await Promise.all(
        candidates.map(async (c) => {
          const existing = await searchWorkItems(c.filePath, { kind: 'change', limit: 5 })
            .then((r) => r.items)
            .catch(() => []);
          const openDup = existing.find((w) => w.state === 'open' && w.title.includes(c.filePath));
          if (openDup) return { filePath: c.filePath, id: openDup.id, skipped: 'already_open' };
          const res = await createOneWorkItem(
            {
              kind: 'change',
              title: `Flaky-test quarantine candidate: ${c.filePath} (flip-rate ${Math.round(c.flipRate * 100)}%)`,
              summary: `${c.filePath} flipped pass<->fail ${c.flips}/${c.totalRuns - 1} consecutive-run transitions (flipRate ${c.flipRate}) over the lookback window. Recent statuses: ${c.recentStatuses.join(', ')}. Quarantine it accountably (quarantine.txt) with a MANDATORY de-quarantine follow-up work item — do not quarantine-and-forget.`,
              harness: harnessSlug ?? undefined,
              severity: 'minor',
              payload: { filePath: c.filePath, flipRate: c.flipRate, totalRuns: c.totalRuns, source: 'testing:flakiness' },
            },
            { ownerId: ident.ownerId, workspaceId: ctx.workspaceId, harnessSlug },
          );
          return res.ok
            ? { filePath: c.filePath, id: res.workItem.id }
            : { filePath: c.filePath, skipped: res.error ?? 'create_failed' };
        }),
      );
    }

    return {
      data: {
        ok: true,
        rows,
        candidates: candidates.map((c) => c.filePath),
        ...(filed ? { filed } : {}),
      },
    };
  },
});
