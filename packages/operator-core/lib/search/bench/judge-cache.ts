/**
 * judge-cache.ts — durable reuse of PAID LLM relevance judgements.
 *
 * WHY (EI-20653219342536753)
 * The labelled-relevance bench used to persist judgements only to a JSON file
 * under `/tmp`. On 2026-08-16 every P-038 artifact was found reaped, taking
 * ~$21.68 of judge spend with it — and with it the "$0 re-sweep" (re-scoring
 * 1,933 already-judged pairs for free) and bench resume, both of which read
 * those files. Grades are PAID DATA, so they live in Postgres now; the JSON
 * report remains the human-readable artifact.
 *
 * WHAT THIS IS
 * A decorator around the `judge` function `runLabelledPass` already injects, so
 * the pass itself is untouched:
 *
 *     judge: (input) => judgeRelevance(input, llmCall)          // before
 *     judge: cache.judge                                        // after
 *
 * A hit returns the stored verdict with `judgeCostUsd: 0` — the caller is not
 * billed twice, so a run's reported cost stays an honest record of NEW spend.
 * The original cost is retained in the row, which is what lets a run also
 * report the spend it AVOIDED.
 *
 * ⚠ THE KEY EXCLUDES RANK AND TOOL, DELIBERATELY.
 * The bench's `pairId` is `${LABELLED_PASS_VERSION}:${tool}:${docId}:${rank}`
 * (labelled-relevance.ts:446), so the same logical (query, doc) pair carries a
 * DIFFERENT identity at a different rank — which is precisely why comparing a
 * rerank arm against a control arm used to need a fragile join across two run
 * files. The judge is shown only `query` and `docText`, so neither rank nor
 * tool can change its verdict. Keying on the judged TEXT makes reuse across
 * arms and across runs automatic, which is the whole point: the control arm is
 * the same documents in a different order.
 *
 * ⚠ `docTextHash` IS A CORRECTNESS GUARD, NOT AN OPTIMISATION.
 * The bench judges the RESULT AS PRESENTED (a 200-char excerpt + match-centred
 * headline, capped at DOC_CHARS). If that presentation changes, a stored grade
 * no longer describes what a judge would see, so it MUST miss rather than
 * quietly serve a stale label.
 */
import { createHash } from 'node:crypto';

import type { JudgeVerdict } from './judge-agreement';

/** The judge signature `runLabelledPass` injects. */
export interface JudgeInput {
  pairId: string;
  query: string;
  docId: string;
  docText: string;
}

export type JudgeFn = (input: JudgeInput) => Promise<JudgeVerdict>;

/**
 * The postgres.js surface this module uses. Declared structurally rather than
 * imported so the module stays testable against a fake without a live pool.
 */
export interface JudgeCacheSql {
  unsafe<T = unknown>(query: string, params?: unknown[]): Promise<T[]>;
}

export interface JudgeCacheOptions {
  sql: JudgeCacheSql;
  workspaceId: string;
  /** Frozen contract — a change to either makes every prior grade unreachable. */
  judgeModel: string;
  rubricVersion: string;
  /** Optional run identity, stored for forensics. */
  runId?: string;
  /** The real judge, called only on a miss. */
  inner: JudgeFn;
  /**
   * Read-through only. Grades are still written, but never served — for a
   * deliberate re-judge (auditing judge drift) without discarding the corpus.
   */
  bypassReads?: boolean;
  /** Non-fatal cache faults are reported here rather than thrown. */
  onWarn?: (message: string) => void;
}

export interface JudgeCacheStats {
  /** Grades served from the cache. */
  hits: number;
  /** Grades that had to be bought. */
  misses: number;
  /** NEW spend this run — the honest cost figure. */
  costUsd: number;
  /** What the hits originally cost: spend this run avoided. */
  reusedCostUsd: number;
  /** Cache faults that fell back to the live judge. Non-zero ⇒ investigate. */
  errors: number;
}

export interface CachedJudge {
  judge: JudgeFn;
  stats: () => JudgeCacheStats;
  /** One line for a run report. */
  summary: () => string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Is this output path somewhere the OS will eventually delete?
 *
 * Not a safety mechanism — grades are durable in Postgres regardless. It exists
 * so a reaped JSON report is never again mistaken for lost EVIDENCE, which is
 * what happened when D-096's and D-088's artifacts vanished and the underlying
 * judgements had no other home.
 */
export function isReapablePath(outPath: string): boolean {
  return /^(\/tmp|\/var\/tmp|\/private\/var\/folders|\/dev\/shm)(\/|$)/.test(outPath);
}

const SELECT_SQL = `
  SELECT relevance, judged_relevant, judge_notes, judge_cost_usd
    FROM harness_shared.search_judge_grades
   WHERE workspace_id = $1
     AND judge_model = $2
     AND rubric_version = $3
     AND query_hash = $4
     AND doc_id = $5
     AND doc_text_hash = $6
   LIMIT 1`;

// ON CONFLICT DO NOTHING: judgeConcurrency > 1 means two in-flight calls can
// race the same key. First writer wins; the verdict is the same either way.
const INSERT_SQL = `
  INSERT INTO harness_shared.search_judge_grades
    (workspace_id, judge_model, rubric_version, query_hash, doc_id, doc_text_hash,
     relevance, judged_relevant, judge_notes, judge_cost_usd, query_text, pair_id, run_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
  ON CONFLICT DO NOTHING`;

interface GradeRow {
  relevance: number | string;
  judged_relevant: boolean;
  judge_notes: string | null;
  judge_cost_usd: number | string;
}

/** postgres.js returns numeric/real as string depending on type + driver config. */
function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number.parseFloat(value);
}

export function createCachedJudge(opts: JudgeCacheOptions): CachedJudge {
  const stats: JudgeCacheStats = {
    hits: 0,
    misses: 0,
    costUsd: 0,
    reusedCostUsd: 0,
    errors: 0,
  };

  const warn = (message: string): void => {
    stats.errors += 1;
    // A cache fault must never fail a paid run — degrade to the live judge.
    (opts.onWarn ?? ((m: string) => console.warn(`[judge-cache] ${m}`)))(message);
  };

  const judge: JudgeFn = async (input) => {
    const queryHash = sha256(input.query);
    const docTextHash = sha256(input.docText);

    if (!opts.bypassReads) {
      try {
        const rows = await opts.sql.unsafe<GradeRow>(SELECT_SQL, [
          opts.workspaceId,
          opts.judgeModel,
          opts.rubricVersion,
          queryHash,
          input.docId,
          docTextHash,
        ]);
        const row = rows[0];
        if (row) {
          stats.hits += 1;
          stats.reusedCostUsd += toNumber(row.judge_cost_usd);
          return {
            relevance: toNumber(row.relevance),
            judgedRelevant: row.judged_relevant,
            // Already paid for. Billing it again would inflate every run's
            // reported cost above what it actually spent.
            judgeCostUsd: 0,
            ...(row.judge_notes ? { judgeNotes: row.judge_notes } : {}),
          };
        }
      } catch (err) {
        warn(`read failed for ${input.docId}, falling back to the live judge: ${String(err)}`);
      }
    }

    const verdict = await opts.inner(input);
    stats.misses += 1;
    stats.costUsd += verdict.judgeCostUsd;

    try {
      await opts.sql.unsafe(INSERT_SQL, [
        opts.workspaceId,
        opts.judgeModel,
        opts.rubricVersion,
        queryHash,
        input.docId,
        docTextHash,
        verdict.relevance,
        verdict.judgedRelevant,
        verdict.judgeNotes ?? null,
        verdict.judgeCostUsd,
        input.query,
        input.pairId,
        opts.runId ?? null,
      ]);
    } catch (err) {
      // The grade is bought either way — losing the write costs money later,
      // never correctness now, so it is loud but not fatal.
      warn(`WRITE FAILED for ${input.docId} — this grade was paid for and NOT persisted: ${String(err)}`);
    }

    return verdict;
  };

  return {
    judge,
    stats: () => ({ ...stats }),
    summary: () => {
      const total = stats.hits + stats.misses;
      const pct = total === 0 ? 0 : (stats.hits / total) * 100;
      return (
        `judge cache: ${stats.hits}/${total} reused (${pct.toFixed(1)}%), ` +
        `spent $${stats.costUsd.toFixed(3)}, avoided $${stats.reusedCostUsd.toFixed(3)}` +
        (stats.errors > 0 ? `, ⚠ ${stats.errors} cache error(s)` : '')
      );
    },
  };
}
