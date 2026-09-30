/**
 * memory:sweep — corpus hygiene over OUR OWN memory pools
 * (memory-corpus-hygiene-and-release-distribution-2026-08-03 P-004).
 *
 * `knowledge_packs:sweep` covers a HIVE's pool; nothing covered
 * `harness:<slug>` or the user pool, which is where this fleet's working
 * knowledge actually lives. This is that sweep, reusing the same judge.
 *
 * Safety rules live in `memory/corpus-sweep.ts` (pool allowlist; local-only,
 * soft, duplicates-only auto-resolution) — read that header before changing
 * anything here.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { sweepCorpus } from '../../memory/corpus-sweep';
import { liveCorpusSweepDeps } from '../../memory/corpus-sweep-io';

const MAX_REPORTED = 40;

export default defineTool({
  name: 'memory:sweep',
  capability: 'memory:read',
  description:
    "Corpus hygiene over our OWN memory pools (harness:<slug>, hive:<slug>, the user pool): reports EXACT duplicates (deterministic, free) and — reusing knowledge_packs:sweep's conflict judge — contradiction pairs. Read-only by default; mode:'apply' soft-forgets duplicate rows ONLY (validity window closed, still retrievable via include_superseded), never a contradiction and never a federated/shareable row. Pools are allowlisted, so the bench-fixture pool and any unrecognized pool are skipped by construction.",
  guidance: {
    when:
      'Periodic corpus hygiene, or before selecting knowledge to distribute — duplicates skew any relevance/frequency signal. Run it read-only first and look at `duplicates` before passing mode:"apply".',
    notWhen:
      'For ONE hive\'s pack-vs-organic conflicts use knowledge_packs:sweep. To drop a specific memory you already judged wrong, memory:forget.',
    chaining:
      'memory:sweep (report) → read duplicates/conflicts → memory:sweep { mode:"apply" } for the duplicates → memory:forget / memory:update to resolve a contradiction deliberately.',
    seeAlso: [
      'knowledge_packs:sweep (one hive pool, contradictions only)',
      'memory:forget (resolve one side of a reported contradiction)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    mode: z
      .enum(['report', 'apply'])
      .optional()
      .describe('report (default) changes nothing; apply soft-forgets exact-duplicate rows only'),
    pools: z
      .array(z.string().min(1).max(200))
      .max(50)
      .optional()
      .describe('restrict to these pool keys (each still allowlist-checked); default = all real pools'),
    judgeConflicts: z
      .boolean()
      .optional()
      .describe('run the LLM contradiction layer (default true) — set false for a free duplicates-only pass'),
    maxPoolsJudged: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe('LLM cost bound: max pools sent to the judge (default 4)'),
  }),
  async handler(args) {
    const wired = await liveCorpusSweepDeps();
    if (!wired) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: false, reason: 'memory_store_unavailable' }) },
        ],
      };
    }
    try {
      const result = await sweepCorpus(
        {
          mode: args.mode,
          pools: args.pools,
          judgeConflicts: args.judgeConflicts,
          maxPoolsJudged: args.maxPoolsJudged,
        },
        wired.deps,
      );
      // The duplicate/conflict lists can be long; the totals are always exact,
      // the samples are capped so a big sweep never blows the result budget.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              mode: result.mode,
              // When true, every conflictPairs:0 below means NOT MEASURED.
              judgeUnavailable: result.judgeUnavailable,
              totals: result.totals,
              pools: result.pools,
              skippedPools: result.skippedPools,
              duplicates: result.duplicates.slice(0, MAX_REPORTED),
              duplicatesTruncated: result.duplicates.length > MAX_REPORTED,
              conflicts: result.conflicts.slice(0, MAX_REPORTED),
              conflictsTruncated: result.conflicts.length > MAX_REPORTED,
            }),
          },
        ],
      };
    } finally {
      await wired.close().catch(() => {});
    }
  },
});
