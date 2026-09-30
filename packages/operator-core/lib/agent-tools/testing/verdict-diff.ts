/**
 * testing:verdict_diff — "which test files changed verdict because of my
 * change?" (plan `test-verdict-diff-2026-08-31` P-002/P-003/P-005, filed as
 * EI-19316659347083806).
 *
 * The bucket logic is a pure function in ../../testing-verdict-diff. This file
 * owns only the POPULATION rules, which are where this table's traps live:
 *
 * D-001 — THE DIFF UNIT IS `run_group_id`, NEVER `commit_sha`. Measured across
 * three days of CI, nearly every gate run group spans ~15 distinct commit_sha
 * values over a 45-80 minute window. That is not sha drift recorded faithfully:
 * `resolveTestRunCommit()` prefers an explicit stamp but otherwise falls back to
 * a local `git rev-parse HEAD` inference under a 200ms fail-soft timeout that
 * degrades to NULL under fleet load (6,337 rows landed NULL on one day). So the
 * per-row sha is a mixture of observation, inference and null, while
 * `run_group_id` still carries the gate-run provenance.
 *
 * D-004 — DEFAULT POPULATION IS `source='ci' AND worktree_dirty=false`.
 * `resolveRecordedTestRunSource()` downgrades a dirty CI run to `local` at WRITE
 * time because "a run against a tree ~100 agents are concurrently mutating
 * proves nothing about any sha". That guard is newer than the data: 3,126 rows
 * landed `source='ci'` while dirty on one day alone, indistinguishable from real
 * gate evidence. The read filters anyway, or it reports fleet churn as blast
 * radius.
 *
 * NOT this tool: the failing files at ONE commit/run is `testing:runs`; flake
 * ranking is `testing:flakiness`; running tests is `testing:run`.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { toIso } from '../_pg-timestamp';
import {
  boundBucket,
  diffVerdicts,
  groupBySignature,
  RED_STATUSES,
  type VerdictRow,
} from '../../testing-verdict-diff';

const DEFAULT_LIMIT = 25;
const OUTPUT_TAIL_CHARS = 800;

/**
 * P-003 — the census fetch is pinned INDEPENDENTLY of the caller's `limit`, so
 * a caller asking for 5 files still gets true bucket counts. This ceiling is a
 * safety valve against an unbounded read, not a display limit: the largest real
 * gate group measured 9,783 files, so two of them sit near 20k.
 */
const MAX_CENSUS_ROWS = 40_000;

type GroupRow = {
  id: string;
  first_start: string | Date | null;
  last_finish: string | Date | null;
  rows: string;
  files: string;
  sha_count: string;
  one_sha: string | null;
};

/**
 * P-005 — NEVER PRESENT ONE ARBITRARY SHA AS "THE SHA THIS JUDGED".
 *
 * `testing:runs` already documents this hazard (`commitShaCount>1 means the
 * group spans several, so commitSha is one arbitrary member`). This tool
 * inherits the guard rather than reinventing it — and goes one step further:
 * where the row listing exposes a member and warns about it, a DIFF result is
 * read as a verdict about a change, so an ambiguous sha is reported as `null`.
 * A sample would just re-arm the trap it is meant to disarm.
 */
export function resolveJudgedSha(shaCount: number, oneSha: string | null): string | null {
  return shaCount === 1 ? oneSha : null;
}

/** A side of the diff whose file count is a tiny fraction of the other's did not
 *  run the same radius, so its presence buckets will dominate and read like a
 *  blast radius. Flag it instead of letting the shape mislead. */
export function isAsymmetricSelection(baselineFiles: number, candidateFiles: number): boolean {
  const smaller = Math.min(baselineFiles, candidateFiles);
  const larger = Math.max(baselineFiles, candidateFiles);
  if (larger === 0) return false;
  return smaller / larger < 0.1;
}

function describeSide(group: GroupRow) {
  const shaCount = Number(group.sha_count);
  return {
    runGroupId: group.id,
    /** null when the group spans several shas — see resolveJudgedSha. */
    commitSha: resolveJudgedSha(shaCount, group.one_sha),
    commitShaCount: shaCount,
    commitShaAmbiguous: shaCount > 1,
    files: Number(group.files),
    rows: Number(group.rows),
    firstStart: toIso(group.first_start),
    lastFinish: toIso(group.last_finish),
  };
}

export default defineTool({
  name: 'testing:verdict_diff',
  description:
    'Diff two gate run groups over harness_shared.test_runs: which test files CHANGED verdict (newlyFailing / newlyPassing / stillFailing) and which only ran on one side (onlyInCandidate / onlyInBaseline / notMeasured). Defaults to the two most recent CI run groups, source:"ci" and worktree_dirty=false. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'The gate is red and you need to know which of those reds are YOURS: a candidate red decomposes into newly-failing vs inherited. Also for the blast radius of a repo-wide change, where a grep only finds a failure shape you already know.',
    notWhen:
      'The failing files at ONE commit or run is testing:runs. Whether a red is a known flake is testing:flakiness. Running tests is testing:run. "Is my change live" is dev:pipeline_position.',
    chaining:
      'testing:verdict_diff → newlyFailing is the candidate\'s own blast radius → testing:runs { runGroup, filePath } for the full output tail → testing:flakiness on a file before treating its red as a genuine regression.',
    // Response docs live HERE, not in description/when — those are
    // prompt-weight budgeted (the guard refused an earlier routines:list edit).
    returns: [
      '{ ok, source, includeDirty, limit, baseline, candidate, newlyFailing, newlyPassing, stillFailing, onlyInCandidate, onlyInBaseline, notMeasured, unchangedPassing, totals, signatureClusters, warnings } — each bucket is { count, files:[{ filePath, baselineStatus, candidateStatus, signature? }], truncatedByLimit, omitted }.',
      '`count` on every bucket is the CENSUS count, computed independently of `limit`; only `files` is capped, and `truncatedByLimit`/`omitted` sit beside the number they bound. unchangedPassing is a count only — it holds ~6,600 files on a real gate pair.',
      'Each side reports { runGroupId, commitSha, commitShaCount, commitShaAmbiguous, files, rows, firstStart, lastFinish }. commitSha is NULL whenever the group spans several shas: a run group commonly spans ~15, so no single member is "the sha this judged".',
      'A file going pass→skip is notMeasured, never a verdict change: skip/cancelled/running are not outcomes, and an unrecognised status is treated as not-measured rather than as a pass.',
      'Refuses rather than answering vacuously: `insufficient_run_groups` (fewer than two groups in the population), `group_not_measured` (a named group has no rows under the population filter — an empty side would render every candidate file as onlyInCandidate), `census_truncated` (the population exceeded the internal census ceiling, so no honest count is possible).',
      'signatureClusters groups newlyFailing by a normalised failure signature — SECONDARY ORDERING ONLY. Measured 14 newly-failing files collapsed to ~6 signatures; it is not the diagnosis.',
    ].join(' '),
    seeAlso: [
      'testing:runs (the failing files at one commit/run, with output tails)',
      'testing:flakiness (is this red a known flake)',
      'dev:pipeline_position (is my change live / what is blocking it)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    baseline: z
      .string()
      .max(200)
      .optional()
      .describe('Exact run_group_id to diff FROM. Default: the second-most-recent group in the population.'),
    candidate: z
      .string()
      .max(200)
      .optional()
      .describe('Exact run_group_id to diff TO. Default: the most recent group in the population.'),
    source: z
      .enum(['ci', 'local', 'admin-ui', 'mutation-probe'])
      .optional()
      .describe('Which writer produced the rows. Default "ci" — local rows prove nothing about a sha.'),
    includeDirty: z
      .boolean()
      .optional()
      .describe('Include worktree_dirty rows. Default false: a run against a tree ~100 agents are mutating is churn, not blast radius.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(`Max files listed PER BUCKET (default ${DEFAULT_LIMIT}). Bucket counts are unaffected.`),
  }),
  result: z
    .object({
      ok: z.boolean(),
      source: z.enum(['ci', 'local', 'admin-ui', 'mutation-probe']),
      includeDirty: z.boolean(),
      limit: z.number().int().nonnegative(),
      baseline: z.unknown().optional(),
      candidate: z.unknown().optional(),
      newlyFailing: z.unknown().optional(),
      newlyPassing: z.unknown().optional(),
      stillFailing: z.unknown().optional(),
      onlyInCandidate: z.unknown().optional(),
      onlyInBaseline: z.unknown().optional(),
      notMeasured: z.unknown().optional(),
      unchangedPassing: z.number().int().nonnegative().optional(),
      totals: z.unknown().optional(),
      signatureClusters: z.unknown().optional(),
      warnings: z.array(z.string()).optional(),
      error: z.string().optional(),
      role: z.string().optional(),
      runGroupId: z.string().optional(),
      found: z.number().int().nonnegative().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  async handler(args: {
    baseline?: string;
    candidate?: string;
    source?: 'ci' | 'local' | 'admin-ui' | 'mutation-probe';
    includeDirty?: boolean;
    limit?: number;
  }) {
    const { sql } = getOrgPg();
    const limit = args.limit ?? DEFAULT_LIMIT;
    const source = args.source ?? 'ci';
    const includeDirty = args.includeDirty ?? false;

    const population = sql`
      WHERE run_group_id IS NOT NULL
        AND source = ${source}
        AND (${includeDirty}::boolean OR worktree_dirty = false)`;

    const named = [args.baseline, args.candidate].filter((value): value is string => typeof value === 'string');
    const explicit = named.length > 0 ? named : null;

    // Group census. When the caller named groups we look up exactly those (so a
    // named-but-empty group can be refused by name); otherwise we take the two
    // most recent by FIRST-SEEN, per D-001.
    const groups = await sql<GroupRow[]>`
      SELECT run_group_id AS id,
             min(started_at) AS first_start,
             max(finished_at) AS last_finish,
             count(*)::text AS rows,
             count(DISTINCT file_path)::text AS files,
             count(DISTINCT commit_sha)::text AS sha_count,
             min(commit_sha) AS one_sha
        FROM harness_shared.test_runs
        ${population}
         AND (${explicit}::text[] IS NULL OR run_group_id = ANY(${explicit}::text[]))
       GROUP BY 1
       ORDER BY min(started_at) DESC
       LIMIT ${explicit ? explicit.length : 2}`;

    const byId = new Map(groups.map((g) => [g.id, g]));
    const candidateGroup = args.candidate ? byId.get(args.candidate) : groups[0];
    const baselineGroup = args.baseline ? byId.get(args.baseline) : groups[1];

    for (const [role, requested, resolved] of [
      ['candidate', args.candidate, candidateGroup],
      ['baseline', args.baseline, baselineGroup],
    ] as const) {
      if (requested !== undefined && resolved === undefined) {
        // An empty side is NOT a diffable side: every candidate file would land
        // in onlyInCandidate and read as an enormous blast radius.
        return {
          data: {
            ok: false,
            error: 'group_not_measured',
            role,
            runGroupId: requested,
            source,
            includeDirty,
            message: `run group ${requested} has no rows under source='${source}'${includeDirty ? '' : ' with worktree_dirty=false'}. An empty side cannot be diffed.`,
          },
        };
      }
    }

    if (candidateGroup === undefined || baselineGroup === undefined) {
      return {
        data: {
          ok: false,
          error: 'insufficient_run_groups',
          found: groups.length,
          source,
          includeDirty,
          message: `need two run groups to diff; found ${groups.length} under source='${source}'. Name them explicitly with baseline/candidate, or widen source.`,
        },
      };
    }

    if (candidateGroup.id === baselineGroup.id) {
      return {
        data: {
          ok: false,
          error: 'insufficient_run_groups',
          found: 1,
          source,
          includeDirty,
          message: `baseline and candidate resolve to the same run group (${candidateGroup.id}); a group diffed against itself measures nothing.`,
        },
      };
    }

    const wanted = [baselineGroup.id, candidateGroup.id];
    const verdictRows = await sql<Array<{ run_group_id: string; file_path: string; status: string; output_tail: string | null }>>`
      WITH filtered AS (
        SELECT * FROM harness_shared.test_runs
        ${population}
           AND run_group_id = ANY(${wanted}::text[])
      ), latest AS (
        SELECT DISTINCT ON (run_group_id, file_path)
               run_group_id, file_path, status,
               CASE WHEN status = ANY(${RED_STATUSES as unknown as string[]}::text[])
                    THEN left(output_tail, ${OUTPUT_TAIL_CHARS}) END AS output_tail
          FROM filtered
         ORDER BY run_group_id, file_path, finished_at DESC NULLS LAST, id DESC
      )
      SELECT * FROM latest
       ORDER BY run_group_id, file_path
       LIMIT ${MAX_CENSUS_ROWS + 1}`;

    if (verdictRows.length > MAX_CENSUS_ROWS) {
      // Refuse instead of marking: a partially-fetched census would truncate ONE
      // group's rows and render the rest of the other group as present-on-one-side,
      // which is worse than no answer.
      return {
        data: {
          ok: false,
          error: 'census_truncated',
          censusCeiling: MAX_CENSUS_ROWS,
          message: `the two groups hold more than ${MAX_CENSUS_ROWS} per-file verdicts; a partial census cannot produce an honest diff.`,
        },
      };
    }

    const toRow = (r: { file_path: string; status: string; output_tail: string | null }): VerdictRow => ({
      filePath: r.file_path,
      status: r.status,
      outputTail: r.output_tail,
    });
    const baselineRows = verdictRows.filter((r) => r.run_group_id === baselineGroup.id).map(toRow);
    const candidateRows = verdictRows.filter((r) => r.run_group_id === candidateGroup.id).map(toRow);

    const diff = diffVerdicts({ baseline: baselineRows, candidate: candidateRows });

    const warnings: string[] = [];
    if (isAsymmetricSelection(diff.baselineFiles, diff.candidateFiles)) {
      warnings.push(
        `selection is asymmetric (${diff.baselineFiles} baseline files vs ${diff.candidateFiles} candidate files) — the presence buckets will dominate and are NOT verdict changes.`,
      );
    }
    for (const [role, group] of [
      ['baseline', baselineGroup],
      ['candidate', candidateGroup],
    ] as const) {
      if (Number(group.sha_count) > 1) {
        warnings.push(`${role} run group spans ${group.sha_count} commit shas, so no single sha is "the sha it judged".`);
      }
    }
    if (diff.duplicateRowsIgnored > 0) {
      warnings.push(`${diff.duplicateRowsIgnored} superseded row(s) ignored (latest attempt per file wins).`);
    }

    return {
      data: {
        ok: true,
        source,
        includeDirty,
        limit,
        baseline: describeSide(baselineGroup),
        candidate: describeSide(candidateGroup),
        newlyFailing: boundBucket(diff.newlyFailing, limit),
        newlyPassing: boundBucket(diff.newlyPassing, limit),
        stillFailing: boundBucket(diff.stillFailing, limit),
        onlyInCandidate: boundBucket(diff.onlyInCandidate, limit),
        onlyInBaseline: boundBucket(diff.onlyInBaseline, limit),
        notMeasured: boundBucket(diff.notMeasured, limit),
        unchangedPassing: diff.unchangedPassing,
        totals: {
          baselineFiles: diff.baselineFiles,
          candidateFiles: diff.candidateFiles,
          baselineRed: diff.baselineRed,
          candidateRed: diff.candidateRed,
        },
        signatureClusters: groupBySignature(diff.newlyFailing).slice(0, limit),
        warnings,
      },
    };
  },
});
