/**
 * GAIA CLI (plan `benchmark-suite-gaia-2026-06-17`) — the operational entrypoint. Run with tsx:
 *
 *   npx tsx packages/operator-core/lib/external-bench/gaia/cli.ts <verb> [flags]
 *
 * Verbs:
 *   provision   Print/run the gated HF download for a split. GAIA is gated — needs HF_TOKEN whose account
 *               accepted the terms (https://huggingface.co/datasets/gaia-benchmark/GAIA). With --run it
 *               executes the snapshot via `huggingface_hub`; otherwise it just prints the command.
 *   selfcheck   No-LLM wiring smoke: exercises the live web_search / fetch_url / run_python tools (negligible
 *               cost) + probes the inference gateway. Makes ZERO model calls. Use to validate the live
 *               bindings before spending on a pilot.
 *   pilot       Run a stratified subset (default 10 per level) of the validation split through the agent +
 *               self-grade. Needs the provisioned corpus + gateway/Opus capacity.
 *   run         Run the full validation split (or --limit N) through the agent + self-grade.
 *
 * The pilot/run verbs spend Opus (owner-gated: gateway capacity + $). They write predictions JSONL + a
 * report under ~/.papercusp/bench-results/gaia/runs/<ts>/.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gatewayBaseUrl } from '../competitor-live';
import {
  buildGaiaDownloadCommand,
  gaiaHfTokenFile,
  gaiaLevelCounts,
  gaiaValidationDir,
  loadGaiaValidation,
  resolveHfToken,
  stratifiedGaiaSubset,
  type GaiaTask,
} from './dataset';
import { makeLiveGaiaLlm } from './agent-live';
import { makeLiveGaiaToolset } from './tools-live';
import { runHiveArm } from './hive-arm';
import {
  formatGaiaReportLine,
  makeLiveRunAgent,
  parsePredictionsJsonl,
  predictionsToJsonl,
  runGaiaSuite,
  toSubmissionJsonl,
  type GaiaRunResult,
} from './run';

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}
function log(...a: unknown[]): void {
   
  console.log(...a);
}

const DEFAULT_VENV_PYTHON = join(homedir(), '.papercusp', 'competitors', 'venv', 'bin', 'python');

/** True iff the validation corpus is already on disk. */
function corpusPresent(): boolean {
  return existsSync(join(gaiaValidationDir(), 'metadata.jsonl'));
}

/** Run the gated download for a split with a resolved token. Returns true on success. */
async function runDownload(token: string, split: 'validation' | 'test'): Promise<boolean> {
  const destRoot = arg('--dest', join(homedir(), '.papercusp', 'bench-results', 'gaia')) as string;
  const pythonBin = arg('--python', DEFAULT_VENV_PYTHON) as string;
  const { cmd, args } = buildGaiaDownloadCommand({ pythonBin, destRoot, split });
  const { spawn } = await import('node:child_process');
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, HF_TOKEN: token } });
    child.on('close', (code) => resolve(code === 0));
  });
}

async function provision(): Promise<void> {
  const split = (arg('--split', 'validation') as 'validation' | 'test') ?? 'validation';
  const destRoot = arg('--dest', join(homedir(), '.papercusp', 'bench-results', 'gaia')) as string;
  const pythonBin = arg('--python', DEFAULT_VENV_PYTHON) as string;
  const { cmd } = buildGaiaDownloadCommand({ pythonBin, destRoot, split });
  log('GAIA is a GATED dataset. Unblock with EITHER:');
  log('  • export HF_TOKEN=<token>   (account must have accepted the terms at');
  log('    https://huggingface.co/datasets/gaia-benchmark/GAIA )');
  log(`  • or drop the token into ${gaiaHfTokenFile()}`);
  log('');
  if (!has('--run')) {
    log(`(Dry run — pass --run to execute. Interpreter: ${cmd}.)`);
    return;
  }
  const token = resolveHfToken();
  if (!token) {
    log(`\nERROR: --run given but no HF token found (env HF_TOKEN or ${gaiaHfTokenFile()}). GAIA is gated; aborting.`);
    process.exitCode = 2;
    return;
  }
  const ok = await runDownload(token, split);
  log(ok ? `\nProvisioned → ${destRoot}/2023/${split}` : `\nDownload failed.`);
  if (!ok) process.exitCode = 2;
}

/** Ensure the validation corpus is on disk: present → true; absent but a token is available → auto-provision. */
async function ensureProvisioned(): Promise<boolean> {
  if (corpusPresent()) return true;
  const token = resolveHfToken();
  if (!token) return false;
  log('Corpus absent; a token is available — auto-provisioning the validation split…');
  return runDownload(token, 'validation');
}

async function selfcheck(): Promise<void> {
  log('GAIA wiring self-check (no LLM calls)\n');
  const scratch = join(homedir(), '.papercusp', 'bench-results', 'gaia', '_selfcheck');
  mkdirSync(scratch, { recursive: true });
  const tools = makeLiveGaiaToolset({ scratchDir: scratch });

  // 1) python sandbox
  try {
    const out = await tools.handlers.run_python({ code: 'print("py", 40 + 2)' });
    log(`run_python : ${out.includes('42') ? 'OK' : 'UNEXPECTED'}  ${out.split('\n').join(' ').slice(0, 80)}`);
  } catch (e) {
    log(`run_python : FAIL  ${e instanceof Error ? e.message : String(e)}`);
  }
  // 2) web_search (Brave)
  if (process.env.BRAVE_API_KEY) {
    try {
      const out = await tools.handlers.web_search({ query: 'capital of France', count: 3 });
      log(`web_search : ${/paris/i.test(out) ? 'OK' : 'RETURNED'}  ${out.split('\n')[0].slice(0, 80)}`);
    } catch (e) {
      log(`web_search : FAIL  ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    log('web_search : SKIP (BRAVE_API_KEY not set)');
  }
  // 3) fetch_url
  try {
    const out = await tools.handlers.fetch_url({ url: 'https://example.com' });
    log(`fetch_url  : ${/example/i.test(out) ? 'OK' : 'RETURNED'}  ${out.slice(0, 60).replace(/\n/g, ' ')}`);
  } catch (e) {
    log(`fetch_url  : FAIL  ${e instanceof Error ? e.message : String(e)}`);
  }
  // 4) gateway probe (no model call)
  const base = gatewayBaseUrl();
  try {
    const res = await fetch(base, { method: 'GET' }).catch((e) => {
      throw e;
    });
    log(`gateway    : reachable at ${base} (HTTP ${res.status})`);
  } catch (e) {
    log(`gateway    : NOT reachable at ${base} (${e instanceof Error ? e.message : String(e)}) — pilot/run need it up`);
  }
  log('\nSelf-check done. (Agent loop + LLM mapping are unit-tested; pilot/run additionally need a provisioned corpus + gateway capacity.)');
}

async function runTasks(tasks: GaiaTask[], label: string): Promise<GaiaRunResult> {
  const concurrency = Number(arg('--concurrency', '4'));
  const accountId = arg('--account');
  // The gateway funnels through one active() account + failover-on-429 (no load-balancing), so under fleet
  // contention pin a healthy account (--account) and request interactive priority (default) to avoid being
  // starved behind the fleet's batch work.
  const priority = arg('--priority', 'interactive');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(homedir(), '.papercusp', 'bench-results', 'gaia', 'runs', `${label}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const partialPath = join(dir, 'predictions.partial.jsonl');

  // RESUME: reuse prior predictions from a --resume <dir> (skips already-answered tasks → no re-spend).
  // Accepts either a finished predictions.jsonl or a crashed run's predictions.partial.jsonl.
  const resumeDir = arg('--resume');
  let priorPredictions: GaiaRunResult['predictions'] | undefined;
  if (resumeDir) {
    const fin = join(resumeDir, 'predictions.jsonl');
    const part = join(resumeDir, 'predictions.partial.jsonl');
    const src = existsSync(fin) ? fin : existsSync(part) ? part : null;
    if (src) {
      priorPredictions = parsePredictionsJsonl(readFileSync(src, 'utf8'));
      log(`Resuming: ${priorPredictions.length} prior predictions from ${src}`);
    }
  }
  log(`Running ${tasks.length} GAIA tasks (${JSON.stringify(gaiaLevelCounts(tasks))}) @ concurrency ${concurrency} → ${dir}`);
  const llm = makeLiveGaiaLlm({ accountId, priority });
  const runAgent = makeLiveRunAgent({ llm });
  // CHECKPOINT: append each freshly-completed record so a crash mid-run loses at most the in-flight tasks.
  let done = 0;
  const onRecord = (rec: GaiaRunResult['predictions'][number]) => {
    appendFileSync(partialPath, JSON.stringify(rec) + '\n');
    done++;
    if (done % 10 === 0) log(`  …${done} tasks completed`);
  };
  const result = await runGaiaSuite(tasks, { runAgent }, { concurrency, priorPredictions, onRecord });
  writeFileSync(join(dir, 'predictions.jsonl'), predictionsToJsonl(result.predictions));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ report: result.report, totals: result.totals }, null, 2));
  log('\n' + formatGaiaReportLine(result));
  log(`reused ${result.totals.reused} prior · wrote predictions + report to ${dir}`);
  return result;
}

async function pilot(): Promise<void> {
  if (!(await ensureProvisioned())) {
    log(`Cannot pilot — GAIA corpus not provisioned and no HF token. See \`provision\`.`);
    process.exitCode = 3;
    return;
  }
  const perLevel = Number(arg('--per-level', '10'));
  const tasks = stratifiedGaiaSubset(loadGaiaValidation(), perLevel);
  await runTasks(tasks, `pilot-${perLevel}`);
}

async function run(): Promise<void> {
  if (!(await ensureProvisioned())) {
    log(`Cannot run — GAIA corpus not provisioned and no HF token. See \`provision\`.`);
    process.exitCode = 3;
    return;
  }
  let tasks = loadGaiaValidation();
  const limit = arg('--limit');
  if (limit) tasks = tasks.slice(0, Number(limit));
  await runTasks(tasks, 'validation');
}

/**
 * AUTORUN — the loop workhorse. If the corpus is reachable (or a token lets us provision it), run the pilot
 * then the full validation and exit 0 (DONE). If no token/corpus yet, exit 7 (NOT-YET) so a driving loop knows
 * to wait and retry. Idempotent: pass `--resume <dir>` to continue a partial run.
 */
async function autorun(): Promise<void> {
  if (!(await ensureProvisioned())) {
    log(`GAIA: still blocked — no corpus + no HF token (env HF_TOKEN or ${gaiaHfTokenFile()}). Nothing to run yet.`);
    process.exitCode = 7; // NOT-YET sentinel for the driving loop
    return;
  }
  log('GAIA corpus available — running pilot then full validation.');
  if (!has('--skip-pilot')) {
    const perLevel = Number(arg('--per-level', '10'));
    await runTasks(stratifiedGaiaSubset(loadGaiaValidation(), perLevel), `pilot-${perLevel}`);
  }
  await runTasks(loadGaiaValidation(), 'validation');
  log('\nGAIA autorun DONE (pilot + full validation complete).');
}

/** P-007: run the hive-decomposition arm on the L3 validation tasks and compare to the single-opus baseline. */
async function hiveL3(): Promise<void> {
  if (!(await ensureProvisioned())) {
    log('Cannot run — GAIA corpus not provisioned. See `provision`.');
    process.exitCode = 3;
    return;
  }
  const limit = arg('--limit');
  const accountId = arg('--account');
  const priority = arg('--priority', 'interactive');
  let l3 = loadGaiaValidation().filter((t) => t.level === 3);
  if (limit) l3 = l3.slice(0, Number(limit));
  log(`Hive-decomposition arm on ${l3.length} L3 tasks (account=${accountId ?? 'pool'} priority=${priority})…`);
  const planLlm = makeLiveGaiaLlm({ accountId, priority });
  const subLlm = makeLiveGaiaLlm({ accountId, priority });
  const runSubAgent = makeLiveRunAgent({ llm: subLlm });
  const runAgent = (task: GaiaTask) => runHiveArm(task, { llm: planLlm, runSubAgent });
  const result = await runGaiaSuite(l3, { runAgent }, { concurrency: Number(arg('--concurrency', '2')) });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(homedir(), '.papercusp', 'bench-results', 'gaia', 'runs', `hive-l3-${stamp}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'predictions.jsonl'), predictionsToJsonl(result.predictions));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ report: result.report, totals: result.totals }, null, 2));
  log('\nHIVE ' + formatGaiaReportLine(result));
  log(`(compare the L3 accuracy here vs the single-opus baseline's L3 number) → ${dir}`);
}

/** P-006: build the GAIA leaderboard submission JSONL from a run dir's predictions. */
async function submission(): Promise<void> {
  const dir = arg('--dir');
  if (!dir || !existsSync(join(dir, 'predictions.jsonl'))) {
    log('Usage: submission --dir <run dir with predictions.jsonl>');
    process.exitCode = 2;
    return;
  }
  const preds = parsePredictionsJsonl(readFileSync(join(dir, 'predictions.jsonl'), 'utf8'));
  const out = join(dir, 'submission.jsonl');
  writeFileSync(out, toSubmissionJsonl(preds));
  log(`Wrote ${preds.length}-row leaderboard submission → ${out}`);
  log('Submit at https://huggingface.co/spaces/gaia-benchmark/leaderboard (test split; iterate on validation first).');
}

async function main(): Promise<void> {
  const verb = process.argv[2];
  switch (verb) {
    case 'provision':
      return provision();
    case 'submission':
      return submission();
    case 'hive-l3':
      return hiveL3();
    case 'selfcheck':
      return selfcheck();
    case 'autorun':
      return autorun();
    case 'pilot':
      return pilot();
    case 'run':
      return run();
    default:
      log('Usage: tsx gaia/cli.ts <provision|selfcheck|autorun|pilot|run> [flags]');
      log('  provision [--split validation|test] [--dest <root>] [--python <bin>] [--run]');
      log('  selfcheck');
      log('  autorun   [--per-level N] [--skip-pilot] [--concurrency N] [--account <id>] [--resume <dir>]');
      log('              exit 0 = done · exit 7 = NOT-YET (no token/corpus, loop should wait + retry)');
      log('  pilot [--per-level N] [--concurrency N] [--account <id>] [--priority interactive] [--resume <dir>]');
      log('  run   [--limit N] [--concurrency N] [--account <id>] [--priority interactive] [--resume <dir>]');
      log('  hive-l3   [--limit N] [--concurrency N] [--account <id>]   (P-007: decomposition arm on L3 vs baseline)');
      log('  submission --dir <run dir>                                  (P-006: leaderboard JSONL)');
      process.exitCode = verb ? 2 : 0;
  }
}

// Run only when invoked directly (not when imported).
const invokedDirectly = process.argv[1] && /gaia[/\\]cli\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => {
     
    console.error(e instanceof Error ? e.stack : String(e));
    process.exitCode = 1;
  });
}

export { main };
