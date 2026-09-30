/**
 * GDPval end-to-end runner (plan benchmark-suite-gdpval-2026-06-17, P-005/P-007) — ties the pieces together:
 * load tasks → resolve the expert reference deliverables to text (P-004) → for each task, stage the input files
 * in a scratch dir + run the generation agent (P-005) → grade every produced deliverable with the live pairwise
 * judge (P-006) → aggregate the win-rate report + write predictions/report to disk.
 *
 * The per-task prediction construction ({@link buildGdpvalPrediction}) is pure + unit-tested; {@link runGdpval}
 * is the live orchestration (fetch / fs / python / LLM) — exercised by the gated pilot, not the unit suite.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GaiaAgentConfig } from '../gaia/agent';
import { makeLiveGaiaLlm } from '../gaia/agent-live';
import { makeLiveGaiaToolset } from '../gaia/tools-live';
import { gradeGdpval, type GdpvalPrediction, type GdpvalReport } from '../grader/gdpval';
import { loadBenchTaskSet } from '../task-sets';
import type { BenchTask } from '../types';
import { generateGdpvalDeliverable } from './agent';
import { makeLiveGdpvalJudge } from './judge-live';
import { defaultGdpvalPythonBin, makeLiveResolverDeps } from './reference-resolver';

/** Pure: build the prediction the autograder grades from a resolved task + its generation result. */
export function buildGdpvalPrediction(task: BenchTask, gen: { deliverableText: string }): GdpvalPrediction {
  const gm = (task.graderMeta ?? {}) as Record<string, unknown>;
  const refExcluded = gm.referenceExcludeReason as string | undefined;
  const excludeReason = refExcluded
    ? `reference unreadable: ${refExcluded}` // the EXPERT reference can't be read → can't grade this task fairly
    : !gen.deliverableText.trim()
      ? 'arm produced no readable deliverable'
      : undefined;
  return {
    taskId: task.instanceId,
    occupation: String(gm.occupation ?? 'unknown'),
    sector: String(gm.sector ?? 'unknown'),
    prompt: task.problemStatement,
    rubric: String(gm.rubric ?? ''),
    modelDeliverable: gen.deliverableText,
    referenceDeliverable: String(gm.referenceDeliverableText ?? ''),
    ...(excludeReason ? { excludeReason } : {}),
  };
}

/** Fetch each input-file URL into the scratch dir; returns the staged filenames (best-effort — a failed input is skipped). */
async function stageInputs(urls: string[], scratchDir: string): Promise<string[]> {
  const names: string[] = [];
  for (const url of urls) {
    const raw = (url.split('/').pop() ?? 'input').split('?')[0];
    const name = decodeURIComponent(raw) || 'input';
    try {
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      await writeFile(join(scratchDir, name), bytes);
      names.push(name);
    } catch {
      /* skip an unfetchable input */
    }
  }
  return names;
}

export interface RunGdpvalOptions {
  /** Task set (default 'gdpval-pilot' = 1/occupation). */
  taskSet?: string;
  /** Explicit task-id subset (validation gate — run 1-2 first). */
  taskIds?: string[];
  /** Cap the number of tasks. */
  limit?: number;
  /** Concurrent tasks (default 3 — bounds gateway pressure + disk). */
  concurrency?: number;
  outDir?: string;
  /** Office-extractor + run_python python (default the gdpval venv). */
  pythonBin?: string;
  /** Pin the gateway account / model for generation + judging. */
  account?: string;
  model?: string;
  /** Per-task agent caps (maxTurns / maxTotalTokens) — the spend lever. */
  agentConfig?: GaiaAgentConfig;
  log?: (m: string) => void;
}

/** Run the GDPval benchmark end-to-end. Returns the win-rate report + writes predictions/report to `outDir`. */
export async function runGdpval(
  opts: RunGdpvalOptions = {},
): Promise<{ report: GdpvalReport; predictions: GdpvalPrediction[]; outDir: string }> {
  const log = opts.log ?? (() => {});
  const pythonBin = opts.pythonBin ?? defaultGdpvalPythonBin();
  let tasks = await loadBenchTaskSet(opts.taskSet ?? 'gdpval-pilot', opts.taskIds);
  if (opts.taskIds?.length) tasks = tasks.filter((t) => opts.taskIds!.includes(t.instanceId));
  if (opts.limit) tasks = tasks.slice(0, opts.limit);
  log(`[gdpval] ${tasks.length} tasks | python=${pythonBin}`);

  const resolverDeps = makeLiveResolverDeps(pythonBin);
  tasks = await resolveGdpvalReferencesLogged(tasks, resolverDeps, log);

  const llm = makeLiveGaiaLlm({ ...(opts.model ? { model: opts.model } : {}), accountId: opts.account, priority: 'benchmark' });
  const officeExtract = resolverDeps.officeExtract;

  const predictions: (GdpvalPrediction | undefined)[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      const scratch = await mkdtemp(join(tmpdir(), 'gdpval-'));
      try {
        const inputs = ((task.graderMeta?.referenceInputUrls as string[]) ?? []).filter((u) => typeof u === 'string');
        const staged = await stageInputs(inputs, scratch);
        const tools = makeLiveGaiaToolset({ scratchDir: scratch, pythonBin });
        const gen = await generateGdpvalDeliverable(
          { instanceId: task.instanceId, prompt: task.problemStatement },
          {
            llm,
            tools,
            scratchDir: scratch,
            stagedInputFiles: staged,
            listFiles: (d) => readdir(d),
            readFileBytes: async (p) => new Uint8Array(await readFile(p)),
            officeExtract,
            agentConfig: opts.agentConfig,
          },
        );
        predictions[i] = buildGdpvalPrediction(task, gen);
        log(
          `[gdpval] ${i + 1}/${tasks.length} ${task.graderMeta?.occupation} — ${gen.outputFiles.length} files, ` +
            `${gen.deliverableText.length} chars, ${gen.agent.turns} turns, ${gen.agent.tokensIn + gen.agent.tokensOut} tok`,
        );
      } catch (e) {
        const p = buildGdpvalPrediction(task, { deliverableText: '' });
        p.excludeReason = `generation failed: ${e instanceof Error ? e.message : String(e)}`;
        predictions[i] = p;
        log(`[gdpval] ${i + 1}/${tasks.length} FAILED: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, Math.max(1, tasks.length)) }, () => worker()));

  const judge = makeLiveGdpvalJudge({ ...(opts.model ? { model: opts.model } : {}), accountId: opts.account, priority: 'benchmark' });
  const preds = predictions.filter((p): p is GdpvalPrediction => p !== undefined);
  log(`[gdpval] judging ${preds.length} deliverables (pairwise, dual-order)...`);
  const report = await gradeGdpval(preds, { judge });

  const outDir = opts.outDir ?? join(homedir(), '.papercusp', 'bench-results', 'gdpval', 'runs', `gdpval-${opts.taskSet ?? 'pilot'}-${tasks.length}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'predictions.jsonl'), preds.map((p) => JSON.stringify(p)).join('\n'));
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  log(
    `[gdpval] DONE — win-rate ${(report.overall.winRate * 100).toFixed(1)}% | win-or-tie ` +
      `${(report.overall.winOrTieRate * 100).toFixed(1)}% | scored ${report.overall.scored} | excluded ${report.excluded} → ${outDir}`,
  );
  return { report, predictions: preds, outDir };
}

/** resolveGdpvalReferences with a progress log (import kept local to avoid a top-level cycle with the resolver module). */
async function resolveGdpvalReferencesLogged(
  tasks: BenchTask[],
  deps: ReturnType<typeof makeLiveResolverDeps>,
  log: (m: string) => void,
): Promise<BenchTask[]> {
  const { resolveGdpvalReferences } = await import('./reference-resolver');
  log(`[gdpval] resolving ${tasks.length} expert reference deliverables to text...`);
  const out = await resolveGdpvalReferences(tasks, deps);
  const excluded = out.filter((t) => t.graderMeta?.referenceExcludeReason).length;
  log(`[gdpval] references resolved (${excluded} reference(s) unreadable → those tasks excluded from scoring)`);
  return out;
}
