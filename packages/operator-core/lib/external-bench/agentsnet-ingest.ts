/**
 * AgentsNet result ingest (plan benchmark-suite-agentsnet-2026-06-17, P-004).
 *
 * AgentsNet (route A: opus-as-nodes) runs in its OWN vendored harness
 * (~/.papercusp/bench-harnesses/agentsnet) and writes one results/*.json per
 * (graph × task) via its save_results(). This module maps those files into the
 * canonical reproducibility store as suite='agentsnet' rows so the coordination
 * score renders alongside every other suite (store.ts → buildSuiteReport → P-020).
 *
 * The DUAL metric (D-003) maps onto the existing row cleanly:
 *   - `resolved` = (get_score === 1.0)  → passAt1 = the OFFICIAL BINARY headline
 *     (fraction of fully-correct networks).
 *   - `score`    = the continuous get_score in [0,1] → the coordination nuance
 *     (persisted on TaskRunResult.score; mean = the continuous coordination score).
 *
 * Honest fit (D-002): AgentsNet is decentralized/local-only, so this is a
 * MODEL-coordination number, not queen orchestration. Route A → arm
 * 'baseline-b-native' (opus in the benchmark's native harness); route B (our
 * substrate as the neighbor transport) → arm 'papercusp'. Both are allowed by the
 * run_result.arm CHECK.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArmId } from '@papercusp/bench-metrics';
import { emitRollout } from './reproducibility/emit';
import type { EmitOptions } from './reproducibility/emit';
import { preregister } from './reproducibility/prereg';
import type { EmitRolloutInput } from './reproducibility/schema';

/** The subset of AgentsNet's save_results() JSON the ingest reads (other keys ignored). */
export interface AgentsnetResultFile {
  task: string;
  num_nodes: number;
  graph_generator: string;
  graph_index: number;
  rounds?: number;
  model_name: string;
  /** get_score() in [0,1], or null on a failed run. */
  score: number | null;
  successful?: boolean;
  tokens_in?: number;
  tokens_out?: number;
  diameter?: number;
  error_message?: string | null;
}

/** Pinned grader id for pre-registration provenance (the AgentsNet arXiv id). */
export const AGENTSNET_GRADER_VERSION = 'agentsnet@arxiv-2507.08616';

/** Stable per-(graph × task) id: agentsnet_<generator>_<nodes>_<index>_<task>. */
export function agentsnetTaskId(r: AgentsnetResultFile): string {
  return `agentsnet_${r.graph_generator}_${r.num_nodes}_${r.graph_index}_${r.task}`;
}

export interface AgentsnetIngestCtx {
  runId: string;
  preregHash: string;
  /** Route A → 'baseline-b-native'; route B (substrate transport) → 'papercusp'. */
  arm: ArmId;
  /** Exact model id for the price table (e.g. 'claude-opus-4-8'). */
  modelId: string;
  /** Blueprint+sha of the vendored harness (e.g. 'agentsnet@<git-sha>'). */
  harnessVersion: string;
  graderVersion?: string;
  /** Attempt ordinal (default 0 — taskId already encodes the distinct graph). */
  seed?: number;
}

/**
 * Map one AgentsNet result file → EmitRolloutInput. Pure (no IO) so it is unit-
 * testable without a DB. A failed run (successful=false / score=null) → an INFRA
 * row (resolved=null, generation/grader status 'error'), excluded from accuracy.
 */
export function agentsnetResultToEmitInput(
  r: AgentsnetResultFile,
  ctx: AgentsnetIngestCtx,
): EmitRolloutInput {
  const scored = (r.successful ?? r.score != null) && r.score != null;
  const score = scored ? Number(r.score) : null;
  const resolved = scored ? Number(r.score) >= 1.0 : null;
  const tokensIn = r.tokens_in ?? 0;
  const tokensOut = r.tokens_out ?? 0;
  return {
    runId: ctx.runId,
    preregHash: ctx.preregHash,
    suite: 'agentsnet',
    taskId: agentsnetTaskId(r),
    arm: ctx.arm,
    seed: ctx.seed ?? 0,
    // AgentsNet's grader is an offline deterministic pure-function (get_score) over a
    // multi-agent run, not a code diff — closest canonical modality is 'in-container'.
    modality: 'in-container',
    generation: {
      status: scored ? 'completed' : 'error',
      error: scored ? null : r.error_message ?? 'agentsnet run did not complete',
      tokensIn,
      tokensOut,
      tokensTotal: tokensIn + tokensOut,
      wallClockMs: 0,
      turns: r.rounds ?? 0,
      modelId: ctx.modelId,
      harnessVersion: ctx.harnessVersion,
    },
    grading: {
      resolved,
      score,
      status: scored ? (resolved ? 'passed' : 'failed') : 'error',
      family: 'agentsnet',
      version: ctx.graderVersion ?? AGENTSNET_GRADER_VERSION,
      error: scored ? null : 'run did not complete (no deterministic score)',
      rawOutput: JSON.stringify(r),
    },
  };
}

/** Read + parse every AgentsNet result JSON in a dir (skips non-AgentsNet / malformed files). */
export function readAgentsnetResults(resultsDir: string): AgentsnetResultFile[] {
  const out: AgentsnetResultFile[] = [];
  let names: string[];
  try {
    names = readdirSync(resultsDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(resultsDir, name), 'utf8')) as Partial<AgentsnetResultFile>;
      if (typeof d.task === 'string' && typeof d.num_nodes === 'number' && 'score' in d) {
        out.push(d as AgentsnetResultFile);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export interface IngestAgentsnetOptions extends EmitOptions {
  resultsDir: string;
  runId: string;
  label?: string;
  /** Default 'baseline-b-native' (route A: opus-as-nodes in the native harness). */
  arm?: ArmId;
  /** Default 'claude-opus-4-8'. */
  modelId?: string;
  /** Default 'agentsnet@unknown'. */
  harnessVersion?: string;
  /** Skip the preregister() call (caller already registered the runId). */
  skipPrereg?: boolean;
  /** Override the repo root for preregister() (tests). */
  repoRoot?: string;
}

/**
 * Ingest a directory of AgentsNet result files into the reproducibility store as
 * suite='agentsnet' rows. Pre-registers the run config (the tune-to-test firewall)
 * unless skipPrereg, then emits one rollout+run_result per result file. Idempotent
 * (deterministic rolloutId → re-ingest upserts). Returns the count emitted.
 */
export async function ingestAgentsnetResults(
  opts: IngestAgentsnetOptions,
): Promise<{ ingested: number; runId: string; preregHash: string }> {
  const arm: ArmId = opts.arm ?? 'baseline-b-native';
  const modelId = opts.modelId ?? 'claude-opus-4-8';
  const harnessVersion = opts.harnessVersion ?? 'agentsnet@unknown';
  const results = readAgentsnetResults(opts.resultsDir);

  const config = {
    suite: 'agentsnet',
    arm,
    modelId,
    harnessVersion,
    graderVersion: AGENTSNET_GRADER_VERSION,
    label: opts.label ?? null,
  };

  let preregHash: string;
  if (opts.skipPrereg) {
    const { computePreregHash } = await import('./reproducibility/prereg');
    preregHash = computePreregHash(config);
  } else {
    const pr = await preregister({
      runId: opts.runId,
      label: opts.label ?? `agentsnet ${arm}`,
      suites: ['agentsnet'],
      config,
      repoRoot: opts.repoRoot,
      sql: opts.sql,
      workspaceId: opts.workspaceId,
    });
    preregHash = pr.preregHash;
  }

  const ctx: AgentsnetIngestCtx = {
    runId: opts.runId,
    preregHash,
    arm,
    modelId,
    harnessVersion,
  };

  let ingested = 0;
  for (const r of results) {
    await emitRollout(agentsnetResultToEmitInput(r, ctx), {
      sql: opts.sql,
      workspaceId: opts.workspaceId,
      priceTable: opts.priceTable,
    });
    ingested++;
  }
  return { ingested, runId: opts.runId, preregHash };
}
