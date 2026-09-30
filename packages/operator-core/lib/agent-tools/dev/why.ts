/**
 * dev:why — "why is nothing shipping?" causal-chain explainer (EI-7349).
 *
 * Walks gate -> deploy -> pool top-down and renders one causal sentence per
 * stage plus a ROOT CAUSE line naming the upstream-most blocking leaf, instead
 * of an agent manually stitching together release:deploy status, test_runs,
 * and accounts:status by hand (the 13h 2026-07-03/04 deploy-freeze forensic
 * exercise this item was filed from). Deterministic, no LLM — see why-chain.ts.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { computeWhyChain } from '../../why-chain';

export default defineTool({
  name: 'dev:why',
  profile: 'engineer',
  description:
    '"Why is nothing shipping / why is everything SLOW?" — the symptom-first decisive read. Walks green-checkpoint gate -> deploy -> gateway ADMISSION -> account pool, and returns the standard runtime diagnostic fields { configured, effective, evidence, rootCause, nextVerb } plus the detailed stages/summary. The ADMISSION stage catches QUEUED work while concurrency slots sit IDLE — definitionally a bug, not a capacity shortage. Deterministic, read-only.',
  capability: 'intel:read',
  guidance: {
    when: 'The owner or an agent asks "why is nothing shipping / deploying", OR agents/turns are SLOW or queueing, OR you are about to conclude "the pool is capacity-crunched" — this is the top-down causal chain in one call instead of manually cross-referencing dev:pipeline_position, testing:flakiness, gateway:status and accounts:status.',
    notWhen: 'To check ONE specific path/sha\'s position, use dev:pipeline_position. To rank flaky files over a longer window, use testing:flakiness. This is the top-down "what is the root blocker right now" read.',
    chaining: 'dev:why (find the blocking stage) → then the stage\'s detail tool: gate → testing:flakiness; deploy → dev:pipeline_position / release:deploy; admission → gateway:status (per-tier caps/queues); pool → accounts:status.',
    returns: '{ configured, effective, evidence, rootCause, nextVerb, stages, summary, recentFailingFiles }',
    seeAlso: [
      'gateway:status (per-tier admission detail — the ADMISSION stage\'s drill-down)',
      'dev:pipeline_position (per-path/sha probe)',
      'accounts:status (per-account detail)',
      'testing:flakiness (flip-rate history)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [
    'operator', 'mug', 'architect', 'worker', 'scoper', 'validator', 'reviewer',
    'debugger', 'documenter', 'curator', 'cup', 'papercup', 'papercup-deep', 'kettle',
    'release-fixer', 'merge-resolver', 'content-fixer', 'release-manager',
  ],
  args: z.object({
    workspace: z.string().max(200).optional().describe('Workspace id to scope the account-pool read to (default: active workspace).'),
    harness: z.string().max(120).optional().describe('Harness slug to scope the recent-test-failures read to (default: workspace-wide).'),
  }),
  result: z
    .object({
      configured: z.unknown().optional(),
      effective: z.unknown().optional(),
      evidence: z.unknown().optional(),
      rootCause: z.unknown().optional(),
      nextVerb: z.unknown().optional(),
      stages: z.unknown().optional(),
      summary: z.unknown().optional(),
      recentFailingFiles: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const result = await computeWhyChain({
      workspaceId: args.workspace ?? ctx.workspaceId,
      harnessSlug: args.harness ?? ctx.harnessSlug,
    });
    return { data: result };
  },
});
