/**
 * jev-live-drop-quality-cli.ts — grade the Jev memory filter's live drops
 * (WI-10004485 step B). The method and the pure logic are in
 * jev-live-drop-quality.ts; this file is the IO.
 *
 *   npx tsx packages/operator-core/lib/memory/bench/jev-live-drop-quality-cli.ts \
 *     --since 2026-10-01T01:49:00Z [--until <iso>] [--calls 80] [--concurrency 4] [--rescore-v2]
 *
 * Reads: decision_model_calls (consumer memory-injection, answered), the
 * mid-turn sessions in memory_recall_stats, their Claude transcripts under
 * ~/.papercusp/session-claude/<owner>/projects/, and memory texts from
 * memory_canonical. Writes: the relevance judge's grade cache (the same cache
 * the admission bench uses), the JSON report (--out), and, with --rescore-v2,
 * Jev calls ledgered as consumer `memory-bench` (never counted as live traffic).
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getOrgPg } from '@papercusp/db-org';

// The hook's own digest (clamps every field to 400 chars), so a rebuilt query
// is the query the server received. Imported by path: it is a client script.
// @ts-expect-error -- plain .mjs hook module, no declaration file
import { buildDigest } from '../../../../../apps/operator/scripts/hooks/inject/core.mjs';
import type { BatchCall } from '../../endpoint-route/routes/agent-mcp/mid-turn-context';
import { llmCall } from '../../llm-testing/llm-client';
import { DOC_CHARS, JUDGE_AGREEMENT_MODEL, JUDGE_AGREEMENT_RUBRIC_VERSION, judgeRelevance, RELEVANCE_PASS_BAR } from '../../search/bench/judge-agreement';
import { createCachedJudge } from '../../search/bench/judge-cache';
import { judgeAdmission } from '../jev-admission-request';
import { JEV_MEMORY_ENCODING, JEV_MEMORY_VARIANT } from '../jev-memory-gate';
import { ensureJevDecisionClient } from '../jev-settings';
import { initializeQueryForHarness } from '../mcp-prelude';
import {
  dropQuality,
  gateStateSha,
  midTurnQueryOf,
  pYesByIndex,
  transcriptBatches,
  transcriptPrompts,
  turnStartQueryOf,
  type DropQuality,
  type GradedCandidate,
} from './jev-live-drop-quality';
import { PRECISION_BENCH_JEV_CONSUMER } from './precision-monitor';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SINCE = new Date(argValue('--since') ?? '2026-10-01T01:49:00Z');
const UNTIL = new Date(argValue('--until') ?? new Date().toISOString());
const CALLS = Number(argValue('--calls') ?? 80);
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency') ?? 4));
const WORKSPACE = argValue('--workspace') ?? 'papercusp-workspace';
const RESCORE_V2 = process.argv.includes('--rescore-v2');
const V2_RESCORE_TIMEOUT_MS = Math.max(400, Number(argValue('--v2-timeout-ms') ?? 5_000));
/**
 * Per-call bound on one relevance-judge request. Without it a single stalled
 * request hung the whole run: a 106-call turn-start bench sat at 90/106 for
 * 15 min at 0 CPU until its task deadline killed it, writing no report. A call
 * that times out is counted in `judgeFailures` like any other judge error.
 */
const JUDGE_CALL_TIMEOUT_MS = Math.max(1_000, Number(argValue('--judge-timeout-ms') ?? 120_000));
const boundedLlmCall: typeof llmCall = (opts) => {
  const timeout = AbortSignal.timeout(JUDGE_CALL_TIMEOUT_MS);
  return llmCall({ ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
};
/**
 * Which injection port's Jev calls to grade (memory_recall_stats.surface).
 * mid-turn and turn-start rebuild queries from Claude transcripts; initialize's
 * query is one fixed string per harness (mcp-prelude initializeQueryForHarness).
 */
const SURFACES = ['mid-turn', 'turn-start', 'initialize'] as const;
type Surface = (typeof SURFACES)[number];
const SURFACE = (argValue('--surface') ?? 'mid-turn') as Surface;
if (!SURFACES.includes(SURFACE)) throw new Error(`--surface must be one of ${SURFACES.join(', ')}`);
/** The live build at measurement time asked v1 at 0.30; the shipped code asks v2-content at 0.35. */
const THRESHOLDS = [0.3, 0.35];
/** Batches up to this far outside the window can still match an in-window call. */
const SLACK_MS = 5 * 60_000;

const log = (m: string): void => console.error(`[jev-drop-quality] ${m}`);
const digest = buildDigest as (calls: BatchCall[]) => BatchCall[];

async function mapPool<T, R>(items: readonly T[], width: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Every rebuilt query for SURFACE in one owner's transcripts, keyed by its gate state hash. */
function queriesForOwner(owner: string, into: Map<string, string>): { files: number; batches: number } {
  const root = path.join(os.homedir(), '.papercusp', 'session-claude', owner, 'projects');
  let files = 0;
  let batches = 0;
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return { files, batches };
  }
  for (const project of projects) {
    const dir = path.join(root, project);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < SINCE.getTime() - SLACK_MS) continue;
      files += 1;
      const entries: unknown[] = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* a torn last line from a live writer */
        }
      }
      const inWindow = (iso: string): boolean => {
        const at = Date.parse(iso);
        return at >= SINCE.getTime() - SLACK_MS && at <= UNTIL.getTime() + SLACK_MS;
      };
      const rebuilt =
        SURFACE === 'turn-start'
          ? transcriptPrompts(entries).filter((p) => inWindow(p.at)).map((p) => turnStartQueryOf(p.text))
          : transcriptBatches(entries).filter((b) => inWindow(b.at)).map((b) => midTurnQueryOf(b.calls, digest));
      for (const q of rebuilt) {
        batches += 1;
        if (q) {
          const sha = gateStateSha(q);
          if (!into.has(sha)) into.set(sha, q);
        }
      }
    }
  }
  return { files, batches };
}

/** Deterministic order without a PRNG: by a hash of the state hash. */
const orderKey = (s: string): string => createHash('sha256').update(`jev-drop-quality|${s}`).digest('hex');
const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function line(label: string, q: DropQuality): string {
  return (
    `${label} @${q.threshold}: drop ${pct(q.dropRate)} (${q.drops}/${q.candidates}) · drops correct ${pct(q.dropPrecision)} ` +
    `· relevant lost ${pct(q.relevantLossRate)} (${q.dropsRelevant}/${q.relevant}) · precision ${pct(q.precisionWithout)} → ${pct(q.precisionWith)}`
  );
}

async function main(): Promise<void> {
  const { sql } = getOrgPg();
  const runId = `jev-drop-quality-${SURFACE}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;

  const ledger = (await sql.unsafe(
    `SELECT id::text, state_sha256, subject_ids, answers
       FROM harness_shared.decision_model_calls
      WHERE consumer = 'memory-injection' AND outcome = 'answered'
        AND workspace_id = $1 AND started_at >= $2 AND started_at < $3`,
    [WORKSPACE, SINCE.toISOString(), UNTIL.toISOString()],
  )) as { id: string; state_sha256: string; subject_ids: string[]; answers: unknown }[];
  const owners = (await sql.unsafe(
    `SELECT DISTINCT session_id FROM harness_shared.memory_recall_stats
      WHERE surface = $4 AND workspace_id = $1 AND session_id IS NOT NULL
        AND created_at >= $2 AND created_at < $3`,
    [WORKSPACE, SINCE.toISOString(), UNTIL.toISOString(), SURFACE],
  )) as { session_id: string }[];

  const queries = new Map<string, string>();
  let ownersWithTranscript = 0;
  let files = 0;
  let batches = 0;
  if (SURFACE === 'initialize') {
    // No transcript needed: one fixed query per harness. pot_slug names the harness.
    const slugs = (await sql.unsafe(
      `SELECT DISTINCT pot_slug FROM harness_shared.memory_recall_stats
        WHERE surface = 'initialize' AND workspace_id = $1 AND pot_slug IS NOT NULL
          AND created_at >= $2 AND created_at < $3`,
      [WORKSPACE, SINCE.toISOString(), UNTIL.toISOString()],
    )) as { pot_slug: string }[];
    for (const { pot_slug } of slugs) {
      const q = initializeQueryForHarness(pot_slug);
      if (q) queries.set(gateStateSha(q), q);
    }
    batches = slugs.length;
  } else {
    for (const { session_id } of owners) {
      const r = queriesForOwner(session_id, queries);
      if (r.files > 0) ownersWithTranscript += 1;
      files += r.files;
      batches += r.batches;
    }
  }

  // The judged unit. Mid-turn queries are nearly unique, so one row per state
  // (step B's sample, kept reproducible). Turn-start prompts repeat ("continue")
  // and initialize has ONE query per harness, so there the unit is the state
  // plus its candidate set; keying by state alone would collapse every
  // initialize call into a single sample.
  const unitKey = (row: (typeof ledger)[number]): string =>
    SURFACE === 'mid-turn' ? row.state_sha256 : `${row.state_sha256}|${[...row.subject_ids].sort().join(',')}`;
  const firstBySha = new Map<string, (typeof ledger)[number]>();
  let matchedRows = 0;
  for (const row of ledger) {
    if (!queries.has(row.state_sha256)) continue;
    matchedRows += 1;
    const key = unitKey(row);
    if (!firstBySha.has(key)) firstBySha.set(key, row);
  }
  const recovery = {
    ledgerAnsweredRows: ledger.length,
    ledgerDistinctStates: new Set(ledger.map((r) => r.state_sha256)).size,
    surface: SURFACE,
    surfaceOwners: owners.length,
    ownersWithClaudeTranscript: ownersWithTranscript,
    transcriptFiles: files,
    batchesInWindow: batches,
    distinctRebuiltQueries: queries.size,
    matchedRows,
    matchedDistinctStates: firstBySha.size,
  };
  log(`recovery: ${JSON.stringify(recovery)}`);
  if (firstBySha.size === 0) {
    log('NO ledger row matched a rebuilt query: the rebuild has drifted from production, or no transcript covers the window. Nothing measured.');
    process.exitCode = 2;
    return;
  }

  const sample = [...firstBySha.values()].sort((a, b) => orderKey(a.state_sha256).localeCompare(orderKey(b.state_sha256))).slice(0, CALLS);
  const ids = [...new Set(sample.flatMap((r) => r.subject_ids))];
  const texts = new Map(
    ((await sql.unsafe(`SELECT id::text AS id, payload->>'data' AS text FROM harness_shared.memory_canonical WHERE id::text = ANY($1)`, [ids])) as {
      id: string;
      text: string | null;
    }[]).map((r) => [r.id, r.text ?? '']),
  );

  const judge = createCachedJudge({
    sql: sql as unknown as Parameters<typeof createCachedJudge>[0]['sql'],
    workspaceId: WORKSPACE,
    judgeModel: JUDGE_AGREEMENT_MODEL,
    rubricVersion: JUDGE_AGREEMENT_RUBRIC_VERSION,
    runId,
    inner: (input) => judgeRelevance(input, boundedLlmCall, JUDGE_AGREEMENT_MODEL),
    onWarn: (m) => log(m),
  });
  const client = RESCORE_V2 ? ensureJevDecisionClient() : null;

  let judgeFailures = 0;
  let firstJudgeError: string | null = null;
  let missingText = 0;
  let v2Failures = 0;
  const v2FailureReasons: Record<string, number> = {};
  const perCall = await mapPool(sample, CONCURRENCY, async (row, i) => {
    const query = queries.get(row.state_sha256)!;
    const live = pYesByIndex(row.answers, row.subject_ids.length);
    const cands = row.subject_ids
      .map((id, idx) => ({ id, idx, text: texts.get(id) ?? '' }))
      .filter((c) => {
        if (c.text.trim() && live[c.idx] !== null) return true;
        missingText += 1;
        return false;
      });
    let v2: number[] | null = null;
    if (client && cands.length > 0) {
      // A QUALITY rescore, not a latency probe: the production 400 ms bound turned 93 of
      // 100 rescores into timeouts (2026-10-01 05:25Z, a provider-latency window) and left
      // the v2 rows measuring Jev's latency instead of its judgement. Latency is read from
      // the live memory-injection ledger rows; here the call gets a generous bound.
      const j = await judgeAdmission(query, cands, JEV_MEMORY_ENCODING, JEV_MEMORY_VARIANT, (request, call) =>
        client.decide(request, {
          consumer: PRECISION_BENCH_JEV_CONSUMER,
          subjectIds: call.candidates.map((ci) => cands[ci].id),
          timeoutMs: V2_RESCORE_TIMEOUT_MS,
        }),
      );
      if ('failure' in j.result) {
        v2Failures += 1;
        v2FailureReasons[j.result.failure] = (v2FailureReasons[j.result.failure] ?? 0) + 1;
      } else v2 = [...j.result.scores];
    }
    const graded: { id: string; live: number; v2: number | null; relevance: number | null }[] = [];
    for (const [k, c] of cands.entries()) {
      let relevance: number | null = null;
      try {
        const v = await judge.judge({ pairId: `${row.state_sha256.slice(0, 16)}|${c.id}`, query, docId: c.id, docText: c.text.slice(0, DOC_CHARS) });
        relevance = v.relevance;
      } catch (e) {
        judgeFailures += 1;
        firstJudgeError ??= e instanceof Error ? e.message : String(e);
      }
      graded.push({ id: c.id, live: live[c.idx] as number, v2: v2 ? v2[k] : null, relevance });
    }
    if ((i + 1) % 10 === 0) log(`judged ${i + 1}/${sample.length} calls`);
    return { ledgerId: row.id, stateSha: row.state_sha256, query, graded };
  });

  const judged = perCall.flatMap((c) => c.graded.filter((g) => g.relevance !== null));
  const asLive: GradedCandidate[] = judged.map((g) => ({ pYes: g.live, relevant: (g.relevance as number) >= RELEVANCE_PASS_BAR }));
  const asV2: GradedCandidate[] = judged.filter((g) => g.v2 !== null).map((g) => ({ pYes: g.v2 as number, relevant: (g.relevance as number) >= RELEVANCE_PASS_BAR }));
  const results = {
    live: THRESHOLDS.map((t) => dropQuality(asLive, t)),
    v2: asV2.length > 0 ? THRESHOLDS.map((t) => dropQuality(asV2, t)) : null,
  };
  // Calls where Jev would drop EVERY candidate although the judge found one relevant.
  const wipedRelevant = (t: number, key: 'live' | 'v2'): number =>
    perCall.filter((c) => {
      const g = c.graded.filter((x) => x.relevance !== null && x[key] !== null);
      return g.length > 0 && g.every((x) => (x[key] as number) < t) && g.some((x) => (x.relevance as number) >= RELEVANCE_PASS_BAR);
    }).length;

  const report = {
    runId,
    window: { since: SINCE.toISOString(), until: UNTIL.toISOString(), workspace: WORKSPACE, surface: SURFACE },
    judge: { model: JUDGE_AGREEMENT_MODEL, rubricVersion: JUDGE_AGREEMENT_RUBRIC_VERSION, passBar: RELEVANCE_PASS_BAR, failures: judgeFailures, firstError: firstJudgeError, stats: judge.stats() },
    recovery,
    sample: { calls: sample.length, pairsJudged: judged.length, candidatesWithoutText: missingText, v2Rescored: RESCORE_V2, v2TimeoutMs: V2_RESCORE_TIMEOUT_MS, v2Failures, v2FailureReasons },
    results,
    wipedRelevantCalls: Object.fromEntries(THRESHOLDS.flatMap((t) => [[`live@${t}`, wipedRelevant(t, 'live')], [`v2@${t}`, RESCORE_V2 ? wipedRelevant(t, 'v2') : null]])),
    perCall,
  };
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
  const out = argValue('--out') ?? path.join(repoRoot, '.papercusp', 'scratch', 'jev-live-drop-quality', `${runId}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`recovered ${recovery.matchedDistinctStates} distinct live contexts (${recovery.matchedRows}/${recovery.ledgerAnsweredRows} ledger rows) from ${recovery.ownersWithClaudeTranscript}/${recovery.surfaceOwners} ${SURFACE} sessions`);
  console.log(`judged ${judged.length} pairs over ${sample.length} calls (judge failures ${judgeFailures}, no text ${missingText})`);
  if (RESCORE_V2) console.log(`v2 rescore (bound ${V2_RESCORE_TIMEOUT_MS} ms): ${v2Failures}/${sample.length} calls failed ${JSON.stringify(v2FailureReasons)}`);
  for (const q of results.live) console.log(line('live (ledger P(yes))', q));
  if (results.v2) for (const q of results.v2) console.log(line('v2-content rescore', q));
  console.log(`calls where Jev drops everything but the judge found a relevant memory: ${JSON.stringify(report.wipedRelevantCalls)}`);
  console.log(`report: ${out}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
