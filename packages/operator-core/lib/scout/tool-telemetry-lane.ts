/**
 * tool-telemetry-lane.ts — the TOOL-TELEMETRY digest lane
 * (blender-self-learning-2026-07-12 P-009 / WI-4454).
 *
 * Every tool call is measured: tool_invocations records the call count, error
 * count, p50/p95 latency, and same-tool over-call within a spawn for every tool
 * the fleet touches. That is the fleet's MEASURED developer-experience friction —
 * which tools actually fail, hang, reject args, or get hammered one-at-a-time —
 * and none of it reached ideation: the Blender saw DX pain only when an agent
 * SELF-REPORTED it (improvements:capture), which is sparse and biased toward
 * whoever bothered to file. This lane feeds the raw telemetry straight into the
 * corpus digest as grounded, citable patterns (`ref` = `tool:error-rate:<tool>` /
 * `tool:p95:<tool>` / `tool:limit-failure:<tool>` / `tool:retry-loop:<tool>`), so
 * ideation targets the tools that are objectively costing the fleet — the
 * measured-DX counterpart of the watchdog-health (P-007), gate/pipeline-health
 * (P-010), and coord-health (P-008) lanes.
 *
 * Deterministic + fail-soft, populated by the cycle seam (cycle-deps readCorpus)
 * exactly like watchdogHealth / gatePipelineHealth / coordHealth: an outage here
 * never disturbs the digest or the cycle. REUSES the hardened readers rather than
 * re-deriving their SQL — telemetryRollup (per-tool count/errors/p95/over-call)
 * and readLimitFailureRate (per-tool arg-limit rejections) — the same reuse-over-
 * re-derive discipline the coord-health lane applied to fetchUnansweredDirected.
 */
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';

/** One tool's telemetry aggregate over the window (the pure builder input). */
export interface ToolTelemetryStat {
  tool: string;
  calls: number;
  /** Calls deliberately refused by a guard; these are excluded from errors. */
  refusals: number;
  errors: number;
  /** 95th-percentile latency in ms (null when unmeasured). */
  p95Ms: number | null;
  /** Same-tool calls beyond the first within one spawn — the batching-waste /
   *  retry-loop signal (a tool hammered one-at-a-time instead of batched). */
  repeatWithinSpawn: number;
}

/** One tool's arg-limit-rejection failure count (from readLimitFailureRate). */
export interface ToolLimitFailure {
  tool: string;
  errs: number;
}

/** The pure builder's input — the window's per-tool telemetry + limit-failure aggregate. */
export interface ToolTelemetryInput {
  tools: readonly ToolTelemetryStat[];
  limitFailures: readonly ToolLimitFailure[];
}

export interface ToolTelemetryOpts {
  /** volume floor before an error-rate / p95 is statistically meaningful. */
  minCalls?: number;
  /** min error fraction (errors/calls) to surface a failing tool. */
  minErrorRate?: number;
  /** min p95 latency (ms) to surface a slow tool. */
  minP95Ms?: number;
  /** min same-tool over-calls within a spawn to surface a retry/batching-waste loop. */
  minRepeatWithinSpawn?: number;
  /** min per-tool arg-limit rejections to surface a limit-failure pattern. */
  minLimitFailures?: number;
  /** cap on emitted patterns. */
  limit?: number;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'unknown'
  );
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.round(s / 60)}m`;
}

/**
 * PURE: the per-tool telemetry aggregate → digest patterns.
 *
 * Emits (most-acute first): tools with a high ERROR RATE (genuine non-refused
 * failing calls, volume-
 * gated so a 1/1 fluke doesn't surface), then per-tool ARG-LIMIT rejections (a
 * cap too tight), then RETRY / batching-waste loops (a tool hammered one-at-a-time
 * — the code:run-batching target), then chronic P95 latency (slow tools). Sorted
 * acute→chronic, capped.
 */
export function buildToolTelemetryPatterns(
  input: ToolTelemetryInput,
  opts: ToolTelemetryOpts = {},
): MetaPattern[] {
  const minCalls = opts.minCalls ?? 20;
  const minErrorRate = opts.minErrorRate ?? 0.2;
  const minP95Ms = opts.minP95Ms ?? 20_000;
  const minRepeat = opts.minRepeatWithinSpawn ?? 25;
  const minLimit = opts.minLimitFailures ?? 10;
  const limit = opts.limit ?? 10;

  const out: MetaPattern[] = [];

  // 1. High error-rate tools — volume-gated (a fluke on tiny N is not a pattern).
  const failing = input.tools
    .filter((t) => t.calls >= minCalls && t.errors / t.calls >= minErrorRate)
    .map((t) => ({ ...t, rate: t.errors / t.calls }))
    .sort((a, b) => b.rate * b.calls - a.rate * a.calls); // by absolute failed-call impact
  for (const t of failing) {
    const refusalContext =
      t.refusals > 0 ? `; a further ${t.refusals} call(s) were refused by guards` : '';
    out.push({
      category: 'tool-telemetry',
      ref: `tool:error-rate:${slug(t.tool)}`,
      summary: `${t.tool} fails ${pct(t.rate)} of calls (${t.errors}/${t.calls} in window)${refusalContext} — a chronically failing tool`,
      detail: `${t.errors} genuine error(s) across ${t.calls} call(s) — a measured non-refusal error rate the fleet works around silently; ${t.refusals > 0 ? `${t.refusals} deliberate refusal(s) are excluded from this count; ` : ''}the tool's contract, args, or a dependency is friction-prone (verify against tool_invocations before assuming the cause).`,
      weight: Math.min(1, 0.6 + t.rate),
    });
  }

  // 2. Arg-limit rejections — a validation cap rejecting args as "too long" instead
  //    of the caller batching/truncating; a tight cap or a regressed fix.
  const limitFails = [...input.limitFailures]
    .filter((l) => l.errs >= minLimit)
    .sort((a, b) => b.errs - a.errs);
  for (const l of limitFails) {
    out.push({
      category: 'tool-telemetry',
      ref: `tool:limit-failure:${slug(l.tool)}`,
      summary: `${l.tool} rejected ${l.errs} call(s) on an arg-length cap in window — a limit too tight`,
      detail: `${l.errs} arg-limit rejection(s) — the tool rejects a long arg instead of truncating/accepting it; widen the cap, or the caller should split the payload (measuring-code-run-adoption metric #1).`,
      weight: Math.min(0.7, 0.3 + l.errs / 200),
    });
  }

  // 3. Retry / batching-waste loops — a tool over-called one-at-a-time within a
  //    spawn (the code:run-batching target — N round-trips a single bulk call saves).
  const retry = input.tools
    .filter((t) => t.repeatWithinSpawn >= minRepeat)
    .sort((a, b) => b.repeatWithinSpawn - a.repeatWithinSpawn);
  for (const t of retry) {
    out.push({
      category: 'tool-telemetry',
      ref: `tool:retry-loop:${slug(t.tool)}`,
      summary: `${t.tool} over-called ${t.repeatWithinSpawn}× one-at-a-time within spawns — a retry / batching-waste loop`,
      detail: `${t.repeatWithinSpawn} same-tool call(s) beyond the first per spawn — either a retry loop (the call keeps failing) or one-at-a-time calls a single bulk (items[]) call or a code:run script would collapse into one round-trip.`,
      weight: 0.5,
    });
  }

  // 4. Slow tools — chronic p95 latency (volume-gated).
  const slow = input.tools
    .filter((t) => t.calls >= minCalls && (t.p95Ms ?? 0) >= minP95Ms)
    .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
  for (const t of slow) {
    out.push({
      category: 'tool-telemetry',
      ref: `tool:p95:${slug(t.tool)}`,
      summary: `${t.tool} p95 latency ${humanMs(t.p95Ms ?? 0)} over ${t.calls} call(s) — a chronically slow tool`,
      detail: `95th-percentile latency ${humanMs(t.p95Ms ?? 0)} — a slow tool on the fleet's hot path burns wall-clock every call; a caching, pagination, or query-shape fix would compound across the fleet.`,
      weight: 0.5,
    });
  }

  return out.slice(0, Math.max(1, limit));
}

/**
 * The PG edge: the window's per-tool telemetry (REUSING telemetryRollup) + the
 * per-tool arg-limit-rejection aggregate (REUSING readLimitFailureRate), scoped to
 * the active workspace's tool usage. Returns [] on any failure (fail-soft lane).
 */
export async function buildToolTelemetryLane(
  opts: { workspaceId?: string; hours?: number } = {},
): Promise<MetaPattern[]> {
  try {
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const hours = opts.hours ?? 24;
    const { telemetryRollup } = await import('../dev-data');
    const { entries } = await telemetryRollup({ workspaceIds: [ws], hours, limit: 300 });

    // Arg-limit rejections — best-effort (a fleet-wide DX add-on; the reader has no
    // per-workspace scope, so an outage here just drops the limit-failure signal).
    let limitFailures: ToolLimitFailure[] = [];
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readLimitFailureRate } = await import('../limit-failure-rate');
      const { sql } = getOrgPg();
      const runQuery = async <T = unknown>(query: string, params: unknown[]) =>
        (await sql.unsafe(query, params as never)) as unknown as T[];
      const sinceDays = Math.max(1, Math.ceil(hours / 24));
      const rollup = await readLimitFailureRate(runQuery, { sinceDays });
      limitFailures = rollup.byTool.map((r) => ({ tool: r.toolName, errs: Number(r.errs) || 0 }));
    } catch {
      /* best-effort — the limit-failure signal is optional decoration */
    }

    return buildToolTelemetryPatterns({
      tools: entries.map((e) => ({
        tool: e.tool_name,
        calls: Number(e.call_count) || 0,
        refusals: Number(e.refused_count) || 0,
        errors: Number(e.error_count) || 0,
        p95Ms: e.p95_ms == null ? null : Number(e.p95_ms),
        repeatWithinSpawn: Number(e.repeat_within_spawn) || 0,
      })),
      limitFailures,
    });
  } catch {
    return [];
  }
}
