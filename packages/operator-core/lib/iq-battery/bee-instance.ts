/**
 * bee-instance.ts — the real `runInstance` effect + the live signal loaders for the
 * Apiary gen-0 battery (`apiary-generation-0-battery` P-001 / D-002 / D-003).
 *
 * D-002: for gen-0, "an instance" = a sandboxed fleet bee. `runInstance` administers ONE corpus
 * case to ONE bee (D-003): it spawns a `role:bee` agent via the hardened fleet path
 * (`spawnAgentInHarness`), hands it the case prompt as its brief, then awaits a terminal state with
 * a bounded timeout. The bee runs opus-4-8 @ xhigh (the runner pins `AGENT_MODELS`; bees have no
 * committed `ROLE_MODEL_DEFAULTS` floor — see role-models.ts).
 *
 * Terminal-state mapping (what the battery does with the outcome):
 *   - `done` / `failed`     → the instance RAN; return the handle so collectAndDistill + the judge
 *                              read the real outcome. A bee that attempted-but-failed the case is a
 *                              valid scored data point, NOT a runInstance error.
 *   - `cancelled` / `reaped` → an INVALID run (manual cancel / host died mid-flight) → throw, so the
 *                              orchestrator records it `errored` (re-runnable), never a fake "failed
 *                              the task".
 *   - never reached terminal within the timeout → throw (a harness hang, not a task outcome).
 *
 * The spawn + poll host-effects are INJECTED (`BeeRunDeps`) so the await/timeout/mapping logic
 * unit-tests with fakes — zero spawn, zero spend. `liveBeeRunDeps` / `makeLiveBeeTraceLoaders` bind
 * the real ones (fleet spawn + org-PG + on-disk transcript) for the runner (P-004).
 */
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { classifySubprocessResult } from '@papercusp/papercusp-shared/agent';
import { spawnAgentInHarness } from '../fleet/operator-spawn';
import type { BeekeeperRunInput } from './beekeeper-runner';
import type { InstanceRunHandle } from './instance-manifest';
import {
  locateBeeTranscript,
  type BeeSpawnRow,
  type BeeRunTokens,
  type BeeTraceLoaders,
} from './bee-trace';

/** Terminal spawned_agents states. */
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'reaped']);

export interface SpawnOnceResult {
  ok: boolean;
  spawnId: string | null;
  error: string | null;
}

/** The host effects `runInstance` needs, injected for testability. */
export interface BeeRunDeps {
  /** Launch one bee with the case prompt as its brief; resolve once the child is launched.
   *  `timeoutMs` (EI-172) is the CALLER'S actual per-spawn kill budget (the runner's
   *  `--timeout-ms`/`BeeRunConfig.timeoutMs`) — forward it to the spawn path so a heavy
   *  case's bee is killed on the RUNNER's budget, not the orchestrator's fixed 600s
   *  `INVOKE_TIMEOUT_MS` default. */
  spawn(input: { brief: string; runInput: BeekeeperRunInput; timeoutMs?: number }): Promise<SpawnOnceResult>;
  /** The bee's current spawned_agents status, or null if the row isn't visible yet. */
  pollStatus(spawnId: string): Promise<string | null>;
  /** Total solver $cost for the run so far (agent_usage_samples), for the handle + spend cap. */
  loadCost(spawnId: string): Promise<number>;
  /** output_tail + error_message of a `failed` bee — to classify a transient rate-limit/overload
   *  (→ relaunch) vs a genuine task failure (→ score). */
  loadFailureText(spawnId: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Fired before a rate-limited/overloaded bee is relaunched (observability). */
  onRateLimitRetry?(info: { spawnId: string; attempt: number; backoffMs: number; cls: string }): void;
}

export interface BeeRunConfig {
  /** Bounded wall-clock per case — on overrun the run is `errored`, never hangs the battery. */
  timeoutMs: number;
  /** Poll cadence while awaiting a terminal state. */
  pollMs: number;
  /** Max RELAUNCHES when a bee fails on a transient rate-limit/overload (the owner's hit-limit →
   *  relaunch loop; the fleet AIMD governor lowers concurrency in parallel). 0 = no retry. */
  maxRateRetries: number;
  /** Floor backoff before a rate-limit relaunch; the server's retry-after wins when larger. */
  rateBackoffMs: number;
}

/**
 * Build the real `runInstance`: spawn one bee for the case, await a terminal state, map it, and
 * return an `InstanceRunHandle` keyed to the bee's spawn id (which IS the instanceId collectAndDistill
 * reads). Throws on spawn rejection, timeout, or an invalid (cancelled/reaped) terminal.
 */
export function makeBeeRunInstance(cfg: BeeRunConfig, deps: BeeRunDeps) {
  const handleFor = async (spawnId: string, variant: string): Promise<InstanceRunHandle> => ({
    instanceId: spawnId,
    instanceUrl: `bee://${spawnId}`,
    targetSlug: variant,
    costUsd: await deps.loadCost(spawnId).catch(() => 0),
  });

  return async (input: BeekeeperRunInput): Promise<InstanceRunHandle> => {
    // Relaunch loop: a bee that FAILS on a transient rate-limit / overload is re-spawned (a FRESH
    // bee) up to maxRateRetries, after a backoff (the server's retry-after, floored). The fleet
    // AIMD governor halves the effective concurrency in parallel, so each relaunch lands at a
    // lower cap — the owner's hit-limit → lower-cap → relaunch → converge loop.
    for (let attempt = 0; ; attempt++) {
      // EI-172: forward the RUNNER's own timeout budget to the actual spawn/kill path — without
      // this the bee is killed by the orchestrator's fixed 600s default regardless of --timeout-ms.
      const res = await deps.spawn({ brief: input.case.prompt, runInput: input, timeoutMs: cfg.timeoutMs });
      if (!res.ok || !res.spawnId) {
        throw new Error(`runInstance: spawn rejected for case ${input.case.id}: ${res.error ?? 'unknown'}`);
      }
      const spawnId = res.spawnId;

      const deadline = deps.now() + cfg.timeoutMs;
      let status: string | null = null;
      while (deps.now() < deadline) {
        await deps.sleep(cfg.pollMs);
        status = await deps.pollStatus(spawnId);
        if (status && TERMINAL.has(status)) break;
      }

      if (!status || !TERMINAL.has(status)) {
        throw new Error(
          `runInstance: bee ${spawnId} did not reach a terminal state within ${cfg.timeoutMs}ms (last=${status ?? 'unseen'})`,
        );
      }
      if (status === 'done') return handleFor(spawnId, input.case.variant);
      if (status === 'cancelled' || status === 'reaped') {
        throw new Error(`runInstance: bee ${spawnId} ended '${status}' — invalid run, re-runnable`);
      }

      // status === 'failed' — classify the cause from the bee's output (the canonical classifier
      // scans stdout on failure, incl. claude's stdout-only "· Rate limited" line).
      const failText = await deps.loadFailureText(spawnId).catch(() => '');
      const te = classifySubprocessResult({ exitCode: 1, stdout: failText });
      const transient = te.class === 'rate_limited' || te.class === 'overloaded';

      if (transient && attempt < cfg.maxRateRetries) {
        const backoffMs = Math.max(cfg.rateBackoffMs, te.retryAfterMs ?? 0);
        deps.onRateLimitRetry?.({ spawnId, attempt, backoffMs, cls: te.class });
        await deps.sleep(backoffMs);
        continue; // relaunch a FRESH bee for the same case
      }
      if (transient || te.class === 'usage_limit') {
        // Exhausted retries (or a hard usage cap) → surface as rate-limited so the orchestrator
        // records `rate_limited` (NOT a scored task-failure). The 'rate-limited' in the message
        // triggers the orchestrator's isRateLimitError.
        throw new Error(
          `runInstance: bee ${spawnId} rate-limited (${te.class}) after ${attempt} relaunch${attempt === 1 ? '' : 'es'} — giving up`,
        );
      }
      // Genuine task failure (agent_crash, etc.) → a real, scoreable outcome.
      return handleFor(spawnId, input.case.variant);
    }
  };
}

// ───────────────────────────── live bindings (for the runner, P-004) ─────────────────────────────

/** Read the columns bee-trace needs from a spawned_agents row. */
async function readSpawnRow(sql: postgres.Sql, spawnId: string): Promise<BeeSpawnRow | null> {
  const rows = await sql<
    {
      status: string;
      run_id: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      duration_ms: string | null;
      output_tail: string | null;
      error_message: string | null;
    }[]
  >`
    SELECT status, run_id, started_at, finished_at, duration_ms, output_tail, error_message
      FROM harness_shared.spawned_agents
     WHERE spawn_id = ${spawnId}
     LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  return {
    status: r.status,
    runId: r.run_id,
    // The org pool returns timestamptz as STRINGS (not Date) — the collectors call .getTime(),
    // so coerce. (The testcontainer connection returns Dates, which is why tests didn't catch it.)
    startedAt: r.started_at ? new Date(r.started_at) : null,
    finishedAt: r.finished_at ? new Date(r.finished_at) : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    outputTail: r.output_tail,
    errorMessage: r.error_message,
  };
}

/** Sum a run's token totals from agent_usage_samples (null when none landed → transcript fallback). */
async function readRunTokens(sql: postgres.Sql, runId: string): Promise<BeeRunTokens | null> {
  const rows = await sql<{ input_tokens: string | null; output_tokens: string | null }[]>`
    SELECT SUM(COALESCE(input_tokens, 0))::text AS input_tokens,
           SUM(COALESCE(output_tokens, 0))::text AS output_tokens
      FROM harness_shared.agent_usage_samples
     WHERE run_id = ${runId}`;
  const r = rows[0];
  if (!r || (r.input_tokens == null && r.output_tokens == null)) return null;
  const inputTokens = Number(r.input_tokens ?? 0);
  const outputTokens = Number(r.output_tokens ?? 0);
  if (!inputTokens && !outputTokens) return null;
  return { inputTokens, outputTokens };
}

/** Sum a run's $cost from agent_usage_samples (0 when none priced). */
async function readRunCostByRunId(sql: postgres.Sql, runId: string): Promise<number> {
  const rows = await sql<{ cost_usd: string | null }[]>`
    SELECT SUM(COALESCE(cost_usd, 0))::text AS cost_usd
      FROM harness_shared.agent_usage_samples
     WHERE run_id = ${runId}`;
  return Number(rows[0]?.cost_usd ?? 0) || 0;
}

/** Live `BeeTraceLoaders`: org-PG spawn/token reads + the on-disk transcript. */
export function makeLiveBeeTraceLoaders(sql: postgres.Sql, transcriptBaseDir?: string): BeeTraceLoaders {
  return {
    loadSpawn: (spawnId) => readSpawnRow(sql, spawnId),
    loadRunTokens: (runId) => readRunTokens(sql, runId),
    loadTranscript: async (spawnId) => {
      const path = locateBeeTranscript(spawnId, transcriptBaseDir);
      if (path) {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          /* raced with archive-at-death — fall through to the archive */
        }
      }
      // Archive fall-through (session-db-archive-retire-dirs P-010): a dead
      // bee's per-spawn CLAUDE_CONFIG_DIR is archived-then-DELETED ~15s after
      // its session ends, so a post-run trace must read the permanent copy —
      // session_archives keyed by owner = spawnId (the dir name IS the owner).
      try {
        const rows = await sql<{ session_id: string }[]>`
          SELECT session_id FROM harness_shared.session_archives
           WHERE source_kind = 'claude' AND owner = ${spawnId}
           ORDER BY archived_at DESC
           LIMIT 1`;
        const sid = rows[0]?.session_id;
        if (!sid) return null;
        const { pgSessionArchiveStore, decompressArchiveBlob } = await import('../session-archive');
        const files = (await pgSessionArchiveStore().readFiles('claude', sid))
          .filter((f) => f.relpath.includes('projects/') && f.relpath.endsWith('.jsonl'))
          .sort((a, b) => (b.mtime?.getTime() ?? 0) - (a.mtime?.getTime() ?? 0));
        if (!files.length) return null;
        return (await decompressArchiveBlob(files[0])).toString('utf8');
      } catch {
        return null; // best-effort: a lost transcript degrades the trace, never aborts the battery
      }
    },
  };
}

/** Resolve a spawn's run_id then sum its solver cost — the handle's `costUsd` (for the spend cap). */
async function loadCostBySpawn(sql: postgres.Sql, spawnId: string): Promise<number> {
  const rows = await sql<{ run_id: string | null }[]>`
    SELECT run_id FROM harness_shared.spawned_agents WHERE spawn_id = ${spawnId} LIMIT 1`;
  const runId = rows[0]?.run_id;
  return runId ? readRunCostByRunId(sql, runId) : 0;
}

/**
 * Live `BeeRunDeps`: the fleet spawn path + org-PG status/cost polls. `harness` + `workspaceId` scope
 * the spawn; the case prompt is delivered as the bee's `brief`. (A richer delivery — a work_item per
 * case — is a P-008 refinement if a brief-only spawn proves taskless; the brief carries a complete,
 * self-contained corpus prompt, which is a real task.)
 */
export function liveBeeRunDeps(args: {
  sql: postgres.Sql;
  workspaceId: string;
  harness: string;
  parentSpawnId?: string | null;
  planSlug?: string | null;
}): BeeRunDeps {
  return {
    async spawn({ brief, runInput, timeoutMs }) {
      const res = await spawnAgentInHarness({
        // Descriptive attribution for the observe-only governor receipt (D-011).
        // NOTE: this is the EIGHTH door — the plan's "7 callers" does not name it,
        // so P-012 must not claim sole-chokepoint status until it is accounted for.
        spawnCaller: 'iq-battery/bee-instance',
        workspaceId: args.workspaceId,
        harness: args.harness,
        role: 'cup',
        brief,
        parentSpawnId: args.parentSpawnId ?? null,
        parentRole: 'apiary-runner',
        planSlug: args.planSlug ?? null,
        extras: [`APIARY_CASE=${runInput.case.id}`, `APIARY_REPEAT=${runInput.repeat}`],
        // EI-172: without this, every bee gets the orchestrator's fixed 600s
        // INVOKE_TIMEOUT_MS default regardless of the runner's --timeout-ms.
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return { ok: res.ok, spawnId: res.spawnId, error: res.error };
    },
    async pollStatus(spawnId) {
      const rows = await args.sql<{ status: string }[]>`
        SELECT status FROM harness_shared.spawned_agents WHERE spawn_id = ${spawnId} LIMIT 1`;
      return rows[0]?.status ?? null;
    },
    async loadFailureText(spawnId) {
      const rows = await args.sql<{ output_tail: string | null; error_message: string | null }[]>`
        SELECT output_tail, error_message FROM harness_shared.spawned_agents WHERE spawn_id = ${spawnId} LIMIT 1`;
      const r = rows[0];
      return `${r?.error_message ?? ''}\n${r?.output_tail ?? ''}`;
    },
    loadCost: (spawnId) => loadCostBySpawn(args.sql, spawnId),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
