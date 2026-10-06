/**
 * Real-adapter wiring for the P-014 A/B harness (`ab-runner.ts`).
 *
 * Binds the injected `AbDeps` to the SAME smoke-proven operations the single-run spine
 * uses, so a bounded real A/B reuses validated pieces:
 *   runPipeline       → runGymPipeline (P-001) over real GymRunnerPorts (createGymRunnerPorts)
 *                       + attributed canonical pipeline usage (P-027)
 *   collectAndDistill → collectTrace (P-002) + distillTrace (P-029) over the gym PG + clone
 *   judge             → the caller's `llmCall` (real anthropic-direct opus-4-8, or a fake for tests)
 *   store             → store.ts over the gym PG (createGymStore)
 *
 * `llmCall` is a REQUIRED config field (not imported here) so this module never pulls in
 * the llm-client graph — the runnable entrypoint passes the real one; tests pass
 * a fake. I/O (git diff, bundle write) uses execFile (no shell) + node:fs.
 */
import { execFile as execFileCb } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { runGymPipeline, type GymRunnerPorts, type GymRunSpec } from './gym-runner';
import { collectTraceByStrategy, type CollectStrategy } from './collect-strategies';
import { writeTraceBundle } from './collector';
import { distillTrace } from './distill';
import { ratePauseEventHooks } from './rate-pause-events';
import {
  insertVariant,
  insertTask,
  insertRun,
  insertRunParams,
  finishRun as storeFinishRun,
  insertScore,
  compareVariants,
} from './store';
import type { AbStore, AbDeps, AbRunInput, AbRunHandle } from './ab-runner';
import type { JudgeLlmCall } from './judge';
import { loadHarnessPipelineSpend } from '../harness-insights/load-spend';

const execFileP = promisify(execFileCb);

/** AbStore backed by the gym PG — a thin adapter over store.ts (P-012/P-013). */
export function createGymStore(sql: Sql): AbStore {
  return {
    async upsertVariant(v) {
      await insertVariant(sql, { variantId: v.variantId, label: v.label, overlay: v.overlay });
    },
    async upsertTask(t) {
      await insertTask(sql, {
        taskId: t.taskId,
        pool: t.pool,
        repoUrl: t.repoUrl,
        repoCommit: t.repoCommit,
        spec: t.spec,
        intent: t.intent,
        corpus: t.corpus,
      });
    },
    async startRun(r) {
      await insertRun(sql, {
        runId: r.runId,
        variantId: r.variantId,
        taskId: r.taskId,
        cycle: r.cycle,
        repeat: r.repeat,
        harnessSlug: r.harnessSlug,
        workflowId: r.workflowId,
      });
      if (r.params) await insertRunParams(sql, r.runId, r.params);
    },
    async finishRun(runId, fields) {
      await storeFinishRun(sql, runId, {
        terminalState: fields.terminalState,
        deterministicSignals: fields.deterministicSignals,
        traceRef: fields.traceRef,
      });
    },
    async recordScore(runId, score) {
      await insertScore(sql, runId, score);
    },
    async comparison(a, b, rubricHash) {
      return compareVariants(sql, a, b, rubricHash);
    },
  };
}

export interface RealAbDepsConfig {
  /** A postgres-js client connected to the gym PG. */
  gymSql: Sql;
  /** Real runner ports (clone/register/overlay/file/start/poll) — createGymRunnerPorts(...). */
  ports: GymRunnerPorts;
  /** The judge LLM call — pass the real llmCall for a real run, or a fake in tests. */
  llmCall: JudgeLlmCall;
  /** Hard wall-clock cap per pipeline run. */
  timeoutMs: number;
  /** Delay between status polls. */
  pollIntervalMs: number;
  /** Scratch root for clones + trace bundles. */
  scratchRoot: string;
  /** Retained trace files; must outlive scratch cleanup. Defaults to ~/.papercusp/gym/traces. */
  traceRoot?: string;
  /**
   * The TARGET blueprint's `gym.collectTrace` (D-015, P-014). `git-diff` (default)
   * diffs the clone — the coding zero-regression path; `work-item-output` collects
   * the work-item output + transcripts with NO git, so a `requiresRepo:false` target
   * (research / gym) is traceable. Defaults to `git-diff` to preserve the existing
   * coding A/B; the gym-blueprint caller passes the resolved target strategy.
   */
  collectStrategy?: CollectStrategy;
}

export function buildAbDeps(cfg: RealAbDepsConfig): AbDeps {
  const sql = cfg.gymSql;
  const traceRoot = resolve(cfg.traceRoot ?? join(homedir(), '.papercusp', 'gym', 'traces'));
  const fromScratch = relative(resolve(cfg.scratchRoot), traceRoot);
  if (fromScratch === '' || (fromScratch !== '..' && !fromScratch.startsWith(`..${sep}`) && !isAbsolute(fromScratch))) {
    throw new Error('Gym traceRoot must be outside pipeline scratchRoot');
  }
  // The target blueprint's collectTrace seam (D-015). `git-diff` is the coding
  // default (diff the clone); `work-item-output` is the repo-less path.
  const collectStrategy: CollectStrategy = cfg.collectStrategy ?? 'git-diff';
  return {
    store: createGymStore(sql),

    async runPipeline(input: AbRunInput): Promise<AbRunHandle> {
      const spec: GymRunSpec = {
        task: {
          id: input.task.taskId,
          source: input.task.repoUrl,
          commit: input.task.repoCommit,
          spec: input.task.spec,
          intent: input.task.intent,
          ...(input.task.oracle ? { oracle: input.task.oracle } : {}),
        },
        variant: { id: input.variant.variantId, overlay: input.variant.overlay },
        cycle: input.cycle,
        repeat: input.repeat,
        harnessCommit: input.harnessCommit,
        workspaceId: input.workspaceId,
        scratchRoot: input.scratchRoot,
        timeoutMs: cfg.timeoutMs,
        pollIntervalMs: cfg.pollIntervalMs,
      };
      const result = await runGymPipeline(spec, cfg.ports);
      const pipelineSpend = await loadHarnessPipelineSpend({
        workspace_id: input.workspaceId, harness_slug: result.harnessSlug,
        runQuery: async <T>(query: string, params: unknown[]) =>
          await sql.unsafe(query, params as never[]) as unknown as T[],
      });
      return {
        harnessSlug: result.harnessSlug,
        clonePath: result.clonePath,
        workflowID: result.workflowID,
        outcome: result.outcome,
        pipelineUsd: pipelineSpend.knownUsd,
        pipelineSpend,
        ...(result.deterministicSignals ? { deterministicSignals: result.deterministicSignals } : {}),
      };
    },

    async collectAndDistill({ handle, task, maxChars }) {
      // Dispatch on the TARGET's collectTrace seam (D-015): `git-diff` execs the
      // clone diff; `work-item-output` reads the produced work-item output with NO
      // git (the repo-less path). Both share the run-output + bundle effects.
      const { rawTrace, traceRef } = await collectTraceByStrategy(
        collectStrategy,
        {
          harnessSlug: handle.harnessSlug,
          clonePath: handle.clonePath,
          baseCommit: task.repoCommit,
          terminalState: handle.outcome,
          signals: handle.deterministicSignals,
        },
        {
          readRunOutputs: async (slug) => {
            const rows = await sql<{ run_id: string; role: string | null; out_body: string }[]>`
              SELECT run_id, role, out_body FROM harness_shared.harness_run_output
               WHERE harness_slug = ${slug} ORDER BY started_at`;
            return rows.map((r) => ({ runId: r.run_id, role: r.role ?? '', outBody: r.out_body }));
          },
          gitDiff: async (clonePath, base) => {
            const { stdout } = await execFileP('git', ['-C', clonePath, 'diff', base, 'HEAD'], {
              maxBuffer: 64 * 1024 * 1024,
            });
            return stdout;
          },
          // The repo-less artifact: the final produced work-item output (the terminal
          // role's out_body) — the "produced work" when there is no diff to collect.
          readWorkItemOutput: async (slug) => {
            const rows = await sql<{ out_body: string }[]>`
              SELECT out_body FROM harness_shared.harness_run_output
               WHERE harness_slug = ${slug} ORDER BY started_at DESC LIMIT 1`;
            return rows[0]?.out_body ?? '';
          },
          writeBundle: (text) => writeTraceBundle(traceRoot, text),
        },
      );
      const distilled = distillTrace(rawTrace, { maxChars });
      return { distilledTrace: distilled.text, traceRef, rawSignals: rawTrace.signals ?? {} };
    },

    llmCall: cfg.llmCall,
    newRunId: (v, t, r) => `${v}::${t}::r${r}`,
    now: () => Date.now(),
    // await-event P-010: real runs surface judge rate-pauses as awaitable
    // rate-limit:paused/reset:gym-ab events (unit fakes stay pure).
    ratePauseHooks: ratePauseEventHooks('gym-ab'),
  };
}
