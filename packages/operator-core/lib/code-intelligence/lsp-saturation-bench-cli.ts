/**
 * lsp-saturation-bench-cli.ts — the LSP SATURATION benchmark (plan
 * `lsp-fleet-scale-all-languages-2026-08-21`, item P-002, verdict D-002).
 *
 * QUESTION: does ONE warm language server survive a 100→1000-agent query load,
 * or is there a knee past which replicas-by-shard become mandatory?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEASURED, AND THE READING IT OVERTURNED
 *
 * The first run used the three TypeScript corpus cursors with a 2:1
 * definition:references mix, and produced a flat ~15 req/s from c=4 all the way
 * to c=1000. That looks exactly like a single-threaded server saturating, and
 * "one warm tsserver saturates at ~15 req/s" was nearly reported as the finding.
 *
 * It is wrong. Controls (`--intents definition --cursor 0`) reached **8,077
 * req/s at c=1000 with p95 140ms** — faster than rust-analyzer on the same box.
 * The ceiling was never the runtime. It was ONE QUESTION: `references` on
 * `managedSetInterval`, a repo-wide symbol, costs 0.3–18s per call and
 * head-of-line-blocks everything behind it on the single stdio pipe. Same warm
 * server, same code: 8,077 def/s alone, 15.6 req/s when a third of the trace is
 * that one scan — a 538x collapse caused by query MIX, not by capacity.
 *
 * That is why this bench is parameterised by intent mix and cursor: a
 * saturation number quoted without the trace that produced it is not a capacity
 * number, and will be read as one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * METHOD — closed-loop, FIXED REQUEST COUNT, deliberately not a wall-clock cut
 *
 * N virtual agents each issue exactly REQS_PER_AGENT queries back-to-back with
 * zero think time (worst case). Every request is allowed to COMPLETE before the
 * level is scored.
 *
 * Why not a deadline: cutting a level off at T seconds discards precisely the
 * requests still queued — the slowest ones — so p95 IMPROVES as the server
 * degrades. That survivorship bias makes saturation look like health, which is
 * the exact false signal this bench exists to detect. A level that cannot finish
 * inside HARD_LEVEL_TIMEOUT_MS is reported ABORTED (a finding), never as a fast
 * level with missing samples.
 *
 * Little's Law (N ≈ X × R) is reported per level so "are these requests resident
 * in the server, or queued in OUR process" is answerable from the data rather
 * than assumed — which is what P-004's queue model has to bound.
 *
 * USAGE
 *   npx tsx packages/operator-core/lib/code-intelligence/lsp-saturation-bench-cli.ts \
 *     [typescript|rust] [levels] [intentMix] [cursorIndex]
 *   # full ladder, realistic mixed trace:
 *   …lsp-saturation-bench-cli.ts typescript
 *   # the control that overturned the first reading:
 *   …lsp-saturation-bench-cli.ts typescript 1,8,64,256,1000 definition 0
 *   # isolate one query class's cost:
 *   …lsp-saturation-bench-cli.ts typescript 1,8,64 references 2
 */
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { freezeCompilerReplayConfig, materializeReplaySource, runDaemonReplay, type DaemonReplayConfig, type ReplayOracleInput } from './lsp-fleet-replay-runtime';
import { moduleRepoRoot } from '../module-repo-root';
import { isCliEntry } from '../util/cli-entry';

import {
  lspQuery,
  shutdownAllLspClients,
  lspClientInventory,
  resolveServerBin,
  type LspLanguage,
} from './lsp-adapter.ts';
import type { ResolvedCursor } from './code-intel-bench.ts';
import type { CodeIntelIntent } from './contracts.ts';

/** 100→1000 is the plan's stated range; the low rungs establish the unloaded baseline the knee is measured against. */
const DEFAULT_LEVELS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000];
const LEVELS = process.argv[3]
  ? process.argv[3].split(',').map((s) => Number(s.trim()))
  : DEFAULT_LEVELS;

/** Requests per virtual agent per level. Every one must complete. */
const REQS_PER_AGENT = 3;
/** A level that exceeds this is reported ABORTED — a finding, not missing data. */
const HARD_LEVEL_TIMEOUT_MS = 180_000;

/** The plan's stated trace shape; overridable to separate runtime cost from question cost. */
const INTENT_MIX: readonly CodeIntelIntent[] = process.argv[4]
  ? (process.argv[4].split(',').map((s) => s.trim()) as CodeIntelIntent[])
  : ['definition', 'definition', 'references'];

/** Restrict to a single cursor, so two languages can be asked a same-shaped question. */
const CURSOR_PIN = process.argv[5] ? Number(process.argv[5]) : null;

interface Sample {
  readonly latencyMs: number;
  readonly error: string | null;
  readonly siteCount: number;
}

export interface SaturationLevelReport {
  readonly concurrency: number;
  readonly issued: number;
  readonly completed: number;
  readonly errors: number;
  /** Answers that returned NO error and NO sites — the false-empty the design forbids. */
  readonly emptyAnswers: number;
  readonly elapsedMs: number;
  readonly throughputPerSec: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly littlesLawConcurrency: number | null;
  readonly rssMbAfter: number | null;
  readonly aborted: boolean;
  readonly abortReason: string | null;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)] * 10) / 10;
}

async function oneQuery(cursor: ResolvedCursor, intent: CodeIntelIntent): Promise<Sample> {
  const t0 = performance.now();
  try {
    const answer = await lspQuery(intent, {
      file: cursor.file,
      line1: cursor.line1,
      character: cursor.character,
      rootPath: cursor.rootPath,
    });
    return {
      latencyMs: performance.now() - t0,
      error: answer.error,
      siteCount: answer.sites.length,
    };
  } catch (err) {
    // lspQuery is documented never to throw for a server-side failure, so a
    // throw here is itself a finding — record it, never swallow it.
    return {
      latencyMs: performance.now() - t0,
      error: `THREW: ${err instanceof Error ? err.message : String(err)}`,
      siteCount: 0,
    };
  }
}

async function runLevel(
  concurrency: number,
  cursors: readonly ResolvedCursor[],
  sampleLspResources: typeof import('./code-intel-bench').sampleLspResources,
): Promise<SaturationLevelReport> {
  const samples: Sample[] = [];
  let aborted = false;
  let abortReason: string | null = null;

  const started = performance.now();
  const deadline = started + HARD_LEVEL_TIMEOUT_MS;

  const agent = async (agentIdx: number): Promise<void> => {
    for (let r = 0; r < REQS_PER_AGENT; r += 1) {
      if (performance.now() > deadline) {
        aborted = true;
        abortReason ??= `exceeded ${HARD_LEVEL_TIMEOUT_MS}ms`;
        return;
      }
      // Spread agents across cursors and intents deterministically so the mix is
      // identical at every level — otherwise a latency change between levels
      // could be a change of QUESTION rather than of load.
      const cursor = cursors[(agentIdx + r) % cursors.length];
      const intent = INTENT_MIX[(agentIdx * REQS_PER_AGENT + r) % INTENT_MIX.length];
      samples.push(await oneQuery(cursor, intent));
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, i) => agent(i)));
  const elapsedMs = performance.now() - started;

  const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const completed = samples.length;
  const mean = completed > 0 ? latencies.reduce((a, b) => a + b, 0) / completed : null;
  const throughputPerSec = elapsedMs > 0 ? (completed / elapsedMs) * 1000 : 0;

  let rssMbAfter: number | null = null;
  try {
    rssMbAfter = sampleLspResources().maxClientRssMb;
  } catch {
    rssMbAfter = null;
  }

  return {
    concurrency,
    issued: concurrency * REQS_PER_AGENT,
    completed,
    errors: samples.filter((s) => s.error !== null).length,
    emptyAnswers: samples.filter((s) => s.error === null && s.siteCount === 0).length,
    elapsedMs: Math.round(elapsedMs),
    throughputPerSec: Math.round(throughputPerSec * 100) / 100,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: percentile(latencies, 100),
    mean: mean === null ? null : Math.round(mean * 10) / 10,
    littlesLawConcurrency:
      mean === null ? null : Math.round(throughputPerSec * (mean / 1000) * 10) / 10,
    rssMbAfter,
    aborted,
    abortReason,
  };
}

export async function runSaturationCli(argv: readonly string[] = process.argv): Promise<void> {
  // Materialize first, then execute --freeze-replay with the COPIED CLI/runtime.
  // Running the shared CLI would still load its shared compiler/default libraries.
  if (argv[2] === '--materialize-replay') {
    if (!argv[3] || !argv[4] || !argv[5])
      throw new Error('--materialize-replay requires authored input, exclusive source directory and new input path');
    const input = JSON.parse(readFileSync(argv[3], 'utf8')) as ReplayOracleInput;
    const captured = materializeReplaySource(input, argv[4], { onProgress: progress =>
      console.error(JSON.stringify({ event: 'replay-source-progress', runId: input.runId, atMs: Date.now(), ...progress })) });
    writeFileSync(argv[5], JSON.stringify(captured, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ input: argv[5], rootPath: captured.rootPath,
      sourceSnapshot: captured.sourceSnapshot, runtimeFiles: captured.runtimeFiles, loadedRuntime: 'unmeasured' }));
    return;
  }
  // …lsp-saturation-bench-cli.ts --freeze-replay <authored-cursors.json> <new-frozen-config.json>
  if (argv[2] === '--freeze-replay') {
    if (!argv[3] || !argv[4]) throw new Error('--freeze-replay requires authored input and a new config path');
    const input = JSON.parse(readFileSync(argv[3], 'utf8')) as ReplayOracleInput;
    const config = freezeCompilerReplayConfig(input, { onProgress: progress =>
      console.error(JSON.stringify({ event: 'replay-oracle-progress', runId: input.runId, atMs: Date.now(), ...progress })) });
    writeFileSync(argv[4], JSON.stringify(config, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ config: argv[4], files: Object.keys(config.files).length,
      expectedDefinitions: config.corpus.definition.oracle.sites.length, expectedReferences: config.corpus['hot-references'].oracle.sites.length }));
    return;
  }
  // P-012 execution uses the same benchmark entry point and the real daemon seam.
  // Legacy adapter saturation remains the separately labelled historical control.
  // …lsp-saturation-bench-cli.ts --fleet-replay <frozen-config.json> <archive-parent>
  if (argv[2] === '--fleet-replay') {
    if (!argv[3] || !argv[4]) throw new Error('--fleet-replay requires frozen config and archive parent');
    const config = JSON.parse(readFileSync(argv[3], 'utf8')) as DaemonReplayConfig;
    const replay = await runDaemonReplay(config, argv[4]);
    console.log(JSON.stringify(replay));
    process.exitCode = replay.result.rating === 'healthy' ? 0 : 2;
    return;
  }
  // The historical benchmark builds Git-root-relative probes at module load.
  // Independent replay snapshots have no Git metadata and must not load it.
  const { BENCH_PROBES, resolveProbeCursor, sampleLspResources } = await import('./code-intel-bench.ts');
  const REPO_ROOT = moduleRepoRoot(import.meta.url);
  const wantLanguage = (argv[2] ?? 'typescript') as LspLanguage;

  const bin = resolveServerBin(wantLanguage);
  if (bin === null) {
    console.error(`ABORT: no server binary provisioned for ${wantLanguage}`);
    process.exitCode = 2;
    return;
  }
  console.log(`# lsp saturation — language=${wantLanguage} bin=${bin}`);
  console.log(`# repoRoot=${REPO_ROOT}`);

  const wantRust = wantLanguage === 'rust';
  const probes = BENCH_PROBES.filter((p) => p.file.endsWith('.rs') === wantRust);
  if (probes.length === 0) {
    console.error(`ABORT: no bench probes for ${wantLanguage}`);
    process.exitCode = 2;
    return;
  }
  const allCursors = probes.map((p) => resolveProbeCursor(p, REPO_ROOT));
  const cursors =
    CURSOR_PIN === null ? allCursors : [allCursors[CURSOR_PIN % allCursors.length]];
  console.log(
    `# probes=${probes.map((p) => p.caseId).join(', ')}` +
      (CURSOR_PIN === null ? '' : ` | PINNED to cursor ${CURSOR_PIN}`),
  );
  console.log(`# intentMix=${INTENT_MIX.join(',')} cursorsInUse=${cursors.length}`);

  // WARM the server first: cold start is a DIFFERENT measurement and would
  // otherwise land entirely inside level 1, inflating the baseline the knee is
  // measured against. Note the warmup time itself is a finding — warmth turned
  // out to be per-QUERY, not per-server (D-002): this server answers
  // `definition` in 2ms while its first repo-wide `references` still costs ~25s.
  const warmStart = performance.now();
  const warm = await oneQuery(cursors[0], 'definition');
  const coldMs = Math.round(performance.now() - warmStart);
  console.log(`# warmup: ${coldMs}ms sites=${warm.siteCount} error=${warm.error ?? 'none'}`);
  if (warm.error !== null) {
    console.error(`ABORT: warmup query failed — ${warm.error}`);
    process.exitCode = 3;
    return;
  }
  const warm2 = await oneQuery(cursors[0], 'definition');
  console.log(`# warm second query: ${Math.round(warm2.latencyMs)}ms`);
  console.log(`# resident servers: ${JSON.stringify(lspClientInventory())}`);

  const reports: SaturationLevelReport[] = [];
  for (const level of LEVELS) {
    const rep = await runLevel(level, cursors, sampleLspResources);
    reports.push(rep);
    console.log(
      `LEVEL c=${String(rep.concurrency).padStart(4)} ` +
        `done=${String(rep.completed).padStart(4)}/${String(rep.issued).padEnd(4)} ` +
        `err=${String(rep.errors).padStart(3)} ` +
        `empty=${String(rep.emptyAnswers).padStart(3)} ` +
        `elapsed=${String(rep.elapsedMs).padStart(6)}ms ` +
        `thr=${String(rep.throughputPerSec).padStart(7)}/s ` +
        `p50=${String(rep.p50).padStart(7)} p95=${String(rep.p95).padStart(8)} ` +
        `p99=${String(rep.p99).padStart(8)} max=${String(rep.max).padStart(8)} ` +
        `N̂=${String(rep.littlesLawConcurrency).padStart(6)} ` +
        `rss=${String(rep.rssMbAfter).padStart(6)}MB` +
        (rep.aborted ? `  ⚠ ABORTED (${rep.abortReason})` : ''),
    );
    if (rep.aborted) {
      console.log('# level aborted — stopping the ladder; higher rungs cannot be cleaner.');
      break;
    }
  }

  console.log(`\nJSON ${JSON.stringify({ language: wantLanguage, coldMs, reports })}`);
  console.log(`# shut down ${await shutdownAllLspClients()} client(s)`);
}

if (isCliEntry(import.meta.url)) void runSaturationCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
