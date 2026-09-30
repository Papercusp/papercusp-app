/**
 * Named benchmark task-set loader (benchmark-evaluation-ui-2026-06-16 P-004).
 *
 * Maps a task_set_id the launch form sends → the BenchTask[] the engine runs.
 * The Row→BenchTask mapping mirrors the CLI launcher (_xbench_realqueen_compare.ts
 * loadTasks) — same SWE-bench Pro JSONL shape, same grader-meta derivation — so a
 * UI launch and a CLI launch produce identical tasks.
 *
 *   '11-task-pilot'      → the locked 11-task public SWE-bench Pro pilot (the m3 set).
 *   'stratified-30'      → 10 EASY + 10 MEDIUM + 10 HARD difficulty-stratified tasks
 *                          (benchmark-arms-su-vs-queen-expansion-2026-06-16 P-005),
 *                          tiered by empirical per-task solve rate + a structural score.
 *                          Each task carries its `tier` so resolved% reports per-tier.
 *   'custom'             → the pilot set filtered to an explicit instance-id list.
 *   'swe-bench-pro-full' → the full ~731-task set (NOT yet provisioned on disk —
 *                          throws an honest error rather than silently running a
 *                          partial set; wiring the full dataset is owner-gated).
 *
 * SWE-bench Verified is a SEPARATE family/suite (benchmark-arms-su-vs-queen-expansion P-006).
 * Verified is the ORIGINAL `princeton-nlp/SWE-bench_Verified` ecosystem — NOT SWE-bench Pro:
 * the original SWE-bench `swebench` harness (`python -m swebench.harness.run_evaluation`), the
 * original `docker.io/swebench/sweb.eval.*` images (NOT `jefzda/sweap-images`), real JSON-array
 * FAIL_TO_PASS/PASS_TO_PASS, and an un-prefixed `instance_id` (`astropy__astropy-12907`, NOT
 * `instance_…`). So Verified rows map through {@link verifiedRowToBenchTask}, NOT
 * {@link rowToBenchTask}, and carry `benchmark: 'swe-bench-verified'`:
 *
 *   'verified-pilot-10'    → a 10-instance representative subset (1 per repo, all tiers).
 *   'swe-bench-verified'   → the full 500-instance test split.
 *   'swe-bench-verified-custom' → the verified set filtered to an explicit instance-id list.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BenchTask } from './types';
import { gaiaTaskToBenchTask, loadGaiaValidation } from './gaia/dataset';
import { gdpvalPilotSubset, gdpvalTaskToBenchTask, loadGdpvalTasks } from './gdpval/dataset';
import { isSwarmBenchTaskSet, swarmbenchScenarios, swarmScenarioToBenchTask } from './swarmbench-backlog';

/** A SWE-bench Pro task row as persisted in the pilot JSONL. */
interface TaskRow {
  instance_id: string;
  repo?: string;
  base_commit?: string;
  problem_statement: string;
  fail_to_pass?: string;
  selected_test_files_to_run?: string;
  language?: string;
  /** Difficulty tier — only present on stratified rows (see {@link stratifiedTaskSetPath}). */
  tier?: 'easy' | 'medium' | 'hard';
}

/**
 * A SWE-bench **Verified** task row as written to `~/.papercusp/bench-results/swe-bench-verified/tasks.jsonl`
 * (P-006). Maps the `princeton-nlp/SWE-bench_Verified` dataset row → a TaskRow-shaped record. Differences
 * from {@link TaskRow}: the `instance_id` is UN-prefixed (`astropy__astropy-12907`), `fail_to_pass`/
 * `pass_to_pass` are REAL JSON-array strings (double-quoted, e.g. `["test::foo"]`, NOT Pro's Python-ish
 * single-quoted literals), and the grader needs `test_patch` + `version` + `environment_setup_commit` rather
 * than Pro's `selected_test_files_to_run` + dockerhub tag. The gold `patch` is deliberately NOT persisted
 * (the arm must never see it — un-gameable task set). `swebench_difficulty` is the upstream human effort label.
 */
interface VerifiedTaskRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  /** JSON-array string of fully-qualified test ids the patch must turn green. */
  fail_to_pass?: string;
  /** JSON-array string of tests that must stay green. */
  pass_to_pass?: string;
  /** The hidden test-file patch the grader applies before running the suite. */
  test_patch?: string;
  /** Upstream `version` — selects the env/install recipe the swebench harness uses. */
  version?: string;
  /** Commit the harness sets the env up at (distinct from base_commit for some repos). */
  environment_setup_commit?: string;
  created_at?: string;
  /** Upstream human-annotated effort label (`<15 min fix` | `15 min - 1 hour` | `1-4 hours` | `>4 hours`). */
  swebench_difficulty?: string;
  /** Derived easy/medium/hard tier (mapped from {@link swebench_difficulty}). */
  tier?: 'easy' | 'medium' | 'hard';
}

/** The canonical 11-task pilot JSONL (env-overridable). */
export function pilotTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_PILOT_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'm3-realqueen-2026-06-16', 'tasks-sample.jsonl')
  );
}

/** The difficulty-stratified 30-task JSONL (env-overridable). */
export function stratifiedTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_STRATIFIED_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'stratified-30', 'tasks.jsonl')
  );
}

/** The stratified set's tier map (instance_id → tier + difficulty score), env-overridable. */
export function stratifiedTiersPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_STRATIFIED_TIERS ??
    join(homedir(), '.papercusp', 'bench-results', 'stratified-30', 'tiers.json')
  );
}

/** The full SWE-bench Verified 500-task JSONL (env-overridable). */
export function verifiedTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_VERIFIED_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'swe-bench-verified', 'tasks.jsonl')
  );
}

/** The 10-instance SWE-bench Verified representative pilot JSONL (env-overridable). */
export function verifiedPilotTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_VERIFIED_PILOT_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'swe-bench-verified', 'verified-pilot-10.jsonl')
  );
}

/** The full TheAgentCompany 175-task manifest JSONL (env-overridable). */
export function theAgentCompanyTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_TAC_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'the-agent-company', 'tasks.jsonl')
  );
}

/** The TheAgentCompany pilot-subset JSONL (10–20 tasks spanning categories), env-overridable. */
export function theAgentCompanyPilotTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_TAC_PILOT_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'the-agent-company', 'pilot.jsonl')
  );
}

/** Local repo checkout root the engine clones tasks under (env-overridable). */
function reposRoot(): string {
  return process.env.XBENCH_REPOS_ROOT ?? join(homedir(), '.papercusp', 'bench-repos');
}

/** Parse a Python-ish list literal ("['a', 'b']") → string[]. */
function pyList(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s.replace(/'/g, '"')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Derive the official grader's dockerhub tag (mirrors the CLI launcher). */
function dockerhubTag(instanceId: string, repo: string): string {
  const [repoBase, repoNameRaw] = repo.toLowerCase().split('/');
  let repoNameOnly = repoNameRaw;
  let hsh = instanceId.replace(/^instance_/, '');
  if (instanceId === 'instance_element-hq__element-web-ec0f940ef0e8e3b61078f145f34dc40d1938e6c5-vnan') {
    repoNameOnly = 'element-web';
  } else if (repo.toLowerCase().includes('element-hq') && repo.toLowerCase().includes('element-web')) {
    repoNameOnly = 'element';
    if (hsh.endsWith('-vnan')) hsh = hsh.slice(0, -5);
  } else if (hsh.endsWith('-vnan')) {
    hsh = hsh.slice(0, -5);
  }
  let tag = `${repoBase}.${repoNameOnly}-${hsh}`;
  if (tag.length > 128) tag = tag.slice(0, 128);
  return tag;
}

function shortName(instanceId: string): string {
  return instanceId.replace(/^instance_/, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
}

/** Map one JSONL row → a BenchTask (same shape the CLI builds). `tier` (when set) is
 *  carried both as a first-class field and inside graderMeta for per-tier reporting. */
export function rowToBenchTask(r: TaskRow): BenchTask {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: r.instance_id,
    problemStatement: r.problem_statement,
    repo: `${reposRoot()}/${shortName(r.instance_id)}`,
    baseCommit: r.base_commit ?? '',
    language: r.language,
    ...(r.tier ? { tier: r.tier } : {}),
    graderMeta: {
      dockerhub_tag: dockerhubTag(r.instance_id, r.repo ?? ''),
      FAIL_TO_PASS: pyList(r.fail_to_pass),
      PASS_TO_PASS: [],
      testFiles: pyList(r.selected_test_files_to_run),
      ...(r.tier ? { tier: r.tier } : {}),
    },
  } satisfies BenchTask;
}

function readJsonl(path: string): TaskRow[] {
  if (!existsSync(path)) {
    throw new Error(`bench task set not found at ${path} — the corpus is not provisioned on this host`);
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TaskRow);
}

/* ------------------------------- SWE-bench Verified ------------------------------- */

/** Parse a REAL JSON-array string (`["a","b"]`) → string[]. Verified ships proper JSON (unlike Pro's
 *  Python-ish single-quoted literals that {@link pyList} repairs), so a plain JSON.parse is correct. */
function jsonStrList(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Derive the canonical SWE-bench docker image name the ORIGINAL `swebench` harness pulls for a Verified
 * instance. The harness normalizes the instance_id to lowercase and replaces `__` → `_1776_` only in older
 * versions; the current convention is `docker.io/swebench/sweb.eval.<arch>.<instance_id_lower>:latest` with
 * `__` preserved. We emit the namespaced repo name WITHOUT a tag (the grader/harness owns the tag + arch)
 * so the value is informational provenance, not a hardcoded pull target. Arch defaults to x86_64.
 *
 * ⚠ The EXACT image name (arch suffix, tag, any `__`→`_1776_` munge) is harness-version-specific and is NOT
 * verified here against a real pull (P-006 is metadata-only). The verified GRADER resolves the real image via
 * the `swebench` harness itself — this is a best-effort label for the run card / `graderMeta`, never the
 * grading source of truth.
 */
function verifiedImageName(instanceId: string, arch = 'x86_64'): string {
  return `swebench/sweb.eval.${arch}.${instanceId.toLowerCase()}`;
}

/** Map one SWE-bench Verified row → a BenchTask. Mirrors {@link rowToBenchTask} but carries the
 *  Verified family + the swebench-harness grader inputs (FAIL_TO_PASS / PASS_TO_PASS / test_patch /
 *  version / environment_setup_commit) and the informational image name. */
export function verifiedRowToBenchTask(r: VerifiedTaskRow): BenchTask {
  return {
    benchmark: 'swe-bench-verified',
    instanceId: r.instance_id,
    problemStatement: r.problem_statement,
    repo: `${reposRoot()}/${shortName(r.instance_id)}`,
    baseCommit: r.base_commit ?? '',
    ...(r.tier ? { tier: r.tier } : {}),
    graderMeta: {
      // The official swebench harness keys (the grader reads these; the arm never does).
      image_name: verifiedImageName(r.instance_id),
      FAIL_TO_PASS: jsonStrList(r.fail_to_pass),
      PASS_TO_PASS: jsonStrList(r.pass_to_pass),
      test_patch: r.test_patch ?? '',
      version: r.version ?? '',
      environment_setup_commit: r.environment_setup_commit ?? '',
      upstream_repo: r.repo,
      ...(r.swebench_difficulty ? { swebench_difficulty: r.swebench_difficulty } : {}),
      ...(r.tier ? { tier: r.tier } : {}),
    },
  } satisfies BenchTask;
}

function readVerifiedJsonl(path: string): VerifiedTaskRow[] {
  if (!existsSync(path)) {
    throw new Error(
      `SWE-bench Verified task set not found at ${path} — run the dataset acquisition (P-006) to provision it`,
    );
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VerifiedTaskRow);
}

/** Load a SWE-bench Verified task set → BenchTask[]. `verified-pilot-10` reads the 10-instance subset;
 *  `swe-bench-verified` the full 500; `swe-bench-verified-custom` filters the full set to `taskIds`. */
export function loadVerifiedTaskSet(taskSetId: string, taskIds?: string[]): BenchTask[] {
  const path = taskSetId === 'verified-pilot-10' ? verifiedPilotTaskSetPath() : verifiedTaskSetPath();
  let tasks = readVerifiedJsonl(path).map(verifiedRowToBenchTask);
  if (taskSetId === 'swe-bench-verified-custom') {
    const want = new Set(taskIds ?? []);
    if (want.size === 0) throw new Error('task set "swe-bench-verified-custom" requires a non-empty taskIds list');
    tasks = tasks.filter((t) => want.has(t.instanceId));
    if (tasks.length === 0) throw new Error('no tasks in the Verified corpus matched the custom taskIds');
  }
  return tasks;
}

/** The SWE-bench Verified task-set ids this loader serves. */
export const VERIFIED_TASK_SET_IDS = ['verified-pilot-10', 'swe-bench-verified', 'swe-bench-verified-custom'] as const;

/** True iff `taskSetId` is a SWE-bench Verified set (routes to {@link loadVerifiedTaskSet}). */
export function isVerifiedTaskSet(taskSetId: string): boolean {
  return (VERIFIED_TASK_SET_IDS as readonly string[]).includes(taskSetId);
}

/* ------------------------------- TheAgentCompany ------------------------------- */

/**
 * One TheAgentCompany task row (plan benchmark-suite-theagentcompany-2026-06-17), as written to
 * `~/.papercusp/bench-results/the-agent-company/{tasks,pilot}.jsonl` by the provisioning step (Phase 1,
 * owner-gated). TheAgentCompany is a NON-coding suite: each task is a docker image (the simulated company +
 * the task's decoupled evaluator); the FULL brief lives inside the container at `/instruction/task.md` (the
 * arm reads it there), so `problem_statement` here is only a short title/descriptor. There is no git repo /
 * base commit — the grader runs the in-image `eval.py`; the runner pulls `image`.
 */
interface TheAgentCompanyTaskRow {
  /** Stable task name / id, e.g. 'sde-add-unit-test', 'hr-resume-screening'. */
  task_name: string;
  /** Professional category: sde | hr | pm | admin | ds | finance | qa | ml | research | other. */
  category?: string;
  /** The task's docker image ref (GHCR), e.g. 'ghcr.io/theagentcompany/<task>-image:1.0.0'. */
  image?: string;
  /** Short title/descriptor (the full brief is /instruction/task.md inside the container). */
  problem_statement?: string;
  /** Max points = Σtotal across the task's checkpoints, if the manifest records it (informational). */
  max_points?: number;
  /** Difficulty tier if the provisioning step computed one. */
  tier?: 'easy' | 'medium' | 'hard';
}

/** Map one TheAgentCompany row → a BenchTask. The `in-container` family — no repo/baseCommit; the runner
 *  pulls `image` + drives the services, the grader runs the in-image evaluator. `category` rides graderMeta
 *  (and `tier`, when present, both first-class + in graderMeta) for per-category / per-tier reporting. */
export function theAgentCompanyRowToBenchTask(r: TheAgentCompanyTaskRow): BenchTask {
  return {
    benchmark: 'the-agent-company',
    instanceId: r.task_name,
    problemStatement: r.problem_statement ?? `TheAgentCompany task ${r.task_name} (brief in /instruction/task.md)`,
    ...(r.tier ? { tier: r.tier } : {}),
    graderMeta: {
      image: r.image ?? '',
      category: r.category ?? 'other',
      task_name: r.task_name,
      ...(typeof r.max_points === 'number' ? { max_points: r.max_points } : {}),
      ...(r.tier ? { tier: r.tier } : {}),
    },
  } satisfies BenchTask;
}

function readTheAgentCompanyJsonl(path: string): TheAgentCompanyTaskRow[] {
  if (!existsSync(path)) {
    throw new Error(
      `TheAgentCompany task set not found at ${path} — provision the corpus (plan ` +
        `benchmark-suite-theagentcompany-2026-06-17 Phase 1) before launching it (owner-gated).`,
    );
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TheAgentCompanyTaskRow);
}

/** Load a TheAgentCompany task set → BenchTask[]. `the-agent-company-pilot` reads the pilot subset;
 *  `the-agent-company` the full 175; `the-agent-company-custom` filters the full set to `taskIds`. */
export function loadTheAgentCompanyTaskSet(taskSetId: string, taskIds?: string[]): BenchTask[] {
  const path =
    taskSetId === 'the-agent-company-pilot' ? theAgentCompanyPilotTaskSetPath() : theAgentCompanyTaskSetPath();
  let tasks = readTheAgentCompanyJsonl(path).map(theAgentCompanyRowToBenchTask);
  if (taskSetId === 'the-agent-company-custom') {
    const want = new Set(taskIds ?? []);
    if (want.size === 0) throw new Error('task set "the-agent-company-custom" requires a non-empty taskIds list');
    tasks = tasks.filter((t) => want.has(t.instanceId));
    if (tasks.length === 0) throw new Error('no tasks in the TheAgentCompany corpus matched the custom taskIds');
  }
  return tasks;
}

/** The TheAgentCompany task-set ids this loader serves. */
export const TAC_TASK_SET_IDS = ['the-agent-company-pilot', 'the-agent-company', 'the-agent-company-custom'] as const;

/** True iff `taskSetId` is a TheAgentCompany set (routes to {@link loadTheAgentCompanyTaskSet}). */
export function isTheAgentCompanyTaskSet(taskSetId: string): boolean {
  return (TAC_TASK_SET_IDS as readonly string[]).includes(taskSetId);
}

/* --------------------------------- METR HCAST --------------------------------- */

/** The full METR HCAST corpus JSONL (env-overridable) — written by the P-001 vendoring step. */
export function metrHcastTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_METR_HCAST_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'metr-hcast', 'tasks.jsonl')
  );
}

/** The METR HCAST pilot-subset JSONL (the cheapest horizon-eligible tasks), env-overridable. */
export function metrHcastPilotTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_METR_HCAST_PILOT_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'metr-hcast', 'pilot.jsonl')
  );
}

/**
 * One METR HCAST task row (plan benchmark-suite-metr-hcast-2026-06-17 P-001), as written to
 * `~/.papercusp/bench-results/metr-hcast/{tasks,pilot}.jsonl` by the vendoring step. METR HCAST is an
 * M2 in-container suite where EACH task brings its own Task-Standard Docker image + its own `score()` —
 * we don't author a verifier. There is no git repo/base commit; the runner pulls `image`, drives the arm
 * inside the container as the unprivileged `agent` user, then scores via the Task Standard's taskhelper.py
 * (D-001/taskhelper: the public path, since the private `mtb` bridge won't install). `humanMinutes` is the
 * human-expert baseline that powers the HORIZON fit — carried in graderMeta (NOT arm-facing: the arm must
 * never see the difficulty). `horizonEligible` flags the 18 tasks with a released human-time baseline.
 */
interface MetrHcastTaskRow {
  /** Stable instance id, `<family>__<task>` (slash-free). */
  instanceId: string;
  /** Original METR task id `<family>/<task>`. */
  taskId?: string;
  /** Task family (the importable TaskFamily module name), e.g. 'local_research'. */
  family: string;
  /** Task variant / sample id within the family, e.g. 'atari_epochs' (the taskhelper TASK_NAME). */
  task: string;
  sampleId?: string;
  /** The TaskFamily version (the image tag suffix). */
  version?: string;
  /** Pre-built Task-Standard Docker image, `metrevals/public-tasks:<family>-<version>`. */
  image: string;
  /** Short descriptor; the real brief comes from taskhelper `setup` (get_instructions) at run time. */
  problemStatement?: string;
  /** Human-expert completion time (minutes) — the horizon-fit difficulty axis. null when no baseline. */
  humanMinutes?: number | null;
  /** Provenance of `humanMinutes`: 'baseline' | 'qa' | 'estimate' (increasing → decreasing reliability). */
  humanSource?: string | null;
  /** True iff a released human-time baseline exists → this task contributes to the horizon fit. */
  horizonEligible?: boolean;
}

/** Map one METR HCAST row → a BenchTask. `in-container`: no repo/baseCommit; the runner pulls `image` and
 *  drives taskhelper. `family`/`task`/`sampleId` (the taskhelper args), the `humanMinutes` baseline, and
 *  `horizonEligible` all ride graderMeta so the runner + the horizon report can read them; the ARM never
 *  sees graderMeta (un-gameable — and crucially the arm cannot see the human-time baseline). */
export function metrHcastRowToBenchTask(r: MetrHcastTaskRow): BenchTask {
  return {
    benchmark: 'metr-hcast',
    instanceId: r.instanceId,
    problemStatement: r.problemStatement ?? `METR HCAST task ${r.instanceId} (instructions via taskhelper setup)`,
    graderMeta: {
      image: r.image,
      family: r.family,
      task: r.task,
      sampleId: r.sampleId ?? r.task,
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.version ? { version: r.version } : {}),
      humanMinutes: r.humanMinutes ?? null,
      humanSource: r.humanSource ?? null,
      horizonEligible: r.horizonEligible ?? r.humanMinutes != null,
    },
  } satisfies BenchTask;
}

function readMetrHcastJsonl(path: string): MetrHcastTaskRow[] {
  if (!existsSync(path)) {
    throw new Error(
      `METR HCAST task set not found at ${path} — vendor the corpus (plan ` +
        `benchmark-suite-metr-hcast-2026-06-17 P-001) before launching it.`,
    );
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MetrHcastTaskRow);
}

/**
 * Load a METR HCAST task set → BenchTask[]. `metr-hcast-pilot` reads the cheapest horizon-eligible subset;
 * `metr-hcast` the full ~31 runnable tasks; `metr-hcast-horizon` the 18 horizon-eligible (baseline-carrying)
 * tasks only — the set the horizon FIT should run over; `metr-hcast-custom` filters the full set to `taskIds`.
 */
export function loadMetrHcastTaskSet(taskSetId: string, taskIds?: string[]): BenchTask[] {
  const path = taskSetId === 'metr-hcast-pilot' ? metrHcastPilotTaskSetPath() : metrHcastTaskSetPath();
  let tasks = readMetrHcastJsonl(path).map(metrHcastRowToBenchTask);
  if (taskSetId === 'metr-hcast-horizon') {
    tasks = tasks.filter((t) => t.graderMeta?.['horizonEligible'] === true);
    if (tasks.length === 0) throw new Error('no horizon-eligible METR HCAST tasks (none carry a human-time baseline)');
  }
  if (taskSetId === 'metr-hcast-custom') {
    const want = new Set(taskIds ?? []);
    if (want.size === 0) throw new Error('task set "metr-hcast-custom" requires a non-empty taskIds list');
    tasks = tasks.filter((t) => want.has(t.instanceId));
    if (tasks.length === 0) throw new Error('no tasks in the METR HCAST corpus matched the custom taskIds');
  }
  return tasks;
}

/** The METR HCAST task-set ids this loader serves. */
export const METR_HCAST_TASK_SET_IDS = [
  'metr-hcast-pilot',
  'metr-hcast',
  'metr-hcast-horizon',
  'metr-hcast-custom',
] as const;

/** True iff `taskSetId` is a METR HCAST set (routes to {@link loadMetrHcastTaskSet}). */
export function isMetrHcastTaskSet(taskSetId: string): boolean {
  return (METR_HCAST_TASK_SET_IDS as readonly string[]).includes(taskSetId);
}

/* ----------------------------- FrontierSWE ----------------------------- */

/** The full FrontierSWE corpus JSONL (env-overridable) — written by the P-001 ingest of the vendored repo. */
export function frontierSweTaskSetPath(): string {
  return (
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL ??
    join(homedir(), '.papercusp', 'bench-results', 'frontier-swe', 'tasks.jsonl')
  );
}

/**
 * One FrontierSWE task row (plan benchmark-suite-frontier-swe-2026-06-18 P-001), ingested from the vendored
 * `Proximal-Labs/frontier-swe` repo (task.toml + instruction.md) to `~/.papercusp/bench-results/frontier-swe/
 * tasks.jsonl`. FrontierSWE is an M2 in-container, CONTINUOUS-score suite: each task ships its OWN scorer
 * (`tests/test.sh` → `compute_reward.py` → `/logs/verifier/reward.txt`), so we don't author a verifier. There is
 * no git repo/base commit — the runner pulls `dockerImage`, drives the arm inside the container over a long
 * horizon, then runs `verifierCmd` and reads the reward. Everything the grader/runner needs rides graderMeta; the
 * ARM only ever sees `problemStatement` (the instruction.md brief) → generation stays grader-agnostic/un-gameable.
 */
export interface FrontierSweTaskRow {
  /** Stable instance id = the task dir name, e.g. 'cranelift-codegen-opt'. */
  instanceId: string;
  /** FrontierSWE's canonical fine-grained category (task.toml [metadata].category), e.g. 'ml-systems-optimization'. */
  category?: string;
  /** Coarse bucket for per-tier (C8) reporting: implementation|performance|research (OUR mapping; `category` is canonical). */
  tier?: 'implementation' | 'performance' | 'research';
  difficulty?: string;
  tags?: string[];
  /** The agent brief (instruction.md). */
  prompt: string;
  /** Prebuilt task image, `ghcr.io/proximal-labs/frontier-swe/<task>:vN`. */
  dockerImage: string;
  /** Agent wall-clock budget (s) — 4–20h. Load-bearing for the C3 iso-budget WALL-CLOCK cap. */
  agentTimeoutSec?: number;
  /** Verifier wall-clock budget (s). */
  verifierTimeoutSec?: number;
  cpus?: number;
  memoryMb?: number;
  storageMb?: number;
  /** Datacenter GPU count + types (B200/H100); >0 ⇒ NOT runnable on a CPU host (infra gate — 5 of 17 tasks). */
  gpus?: number;
  gpuTypes?: string[];
  allowInternet?: boolean;
  /** The verifier entrypoint run inside the container (`bash /tests/test.sh`). */
  verifierCmd: string;
  /** In-container paths the verifier writes: the bare [0,1] scalar + the structured reward. */
  rewardPath: string;
  rewardJsonPath?: string;
  /** The gold/oracle reference command (`bash /solution/solve.sh`) for the C9 positive control — null for 6 tasks. */
  solutionCmd?: string | null;
  /** Whether the task ships an oracle.yaml (the gold-run config). */
  hasOracle?: boolean;
}

/** Map one FrontierSWE row → a BenchTask. `in-container`: no repo/baseCommit; the runner pulls `dockerImage`,
 *  drives the arm, runs `verifierCmd`, reads the reward. The scorer cmd + image + budgets + reward paths + the
 *  coarse `bucket` all ride graderMeta (the arm never sees it). BenchTask.tier (easy/medium/hard) is left unset —
 *  FrontierSWE's implementation/performance/research bucket lives in graderMeta.bucket for per-tier reporting. */
export function frontierSweRowToBenchTask(r: FrontierSweTaskRow): BenchTask {
  return {
    benchmark: 'frontier-swe',
    instanceId: r.instanceId,
    problemStatement: r.prompt,
    graderMeta: {
      category: r.category ?? null,
      bucket: r.tier ?? null,
      difficulty: r.difficulty ?? null,
      tags: r.tags ?? [],
      dockerImage: r.dockerImage,
      agentTimeoutSec: r.agentTimeoutSec ?? null,
      verifierTimeoutSec: r.verifierTimeoutSec ?? null,
      cpus: r.cpus ?? null,
      memoryMb: r.memoryMb ?? null,
      storageMb: r.storageMb ?? null,
      gpus: r.gpus ?? 0,
      gpuTypes: r.gpuTypes ?? [],
      allowInternet: r.allowInternet ?? false,
      verifierCmd: r.verifierCmd,
      rewardPath: r.rewardPath,
      rewardJsonPath: r.rewardJsonPath ?? null,
      solutionCmd: r.solutionCmd ?? null,
      hasOracle: r.hasOracle ?? false,
    },
  } satisfies BenchTask;
}

function readFrontierSweJsonl(path: string): FrontierSweTaskRow[] {
  if (!existsSync(path)) {
    throw new Error(
      `FrontierSWE task set not found at ${path} — ingest the corpus (plan ` +
        `benchmark-suite-frontier-swe-2026-06-18 P-001: vendor Proximal-Labs/frontier-swe, then build tasks.jsonl) ` +
        `before launching it.`,
    );
  }
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FrontierSweTaskRow);
}

/** Pick 1 representative task per bucket (implementation/performance/research) — the cheapest runnable: prefer
 *  GPU-free, then a gold-solution control, then the shortest agent budget. The 3-task pilot (plan P-014). */
export function frontierSwePilotSubset(rows: FrontierSweTaskRow[]): FrontierSweTaskRow[] {
  const byTier = new Map<string, FrontierSweTaskRow[]>();
  for (const r of rows) {
    const t = r.tier ?? 'implementation';
    const list = byTier.get(t) ?? [];
    list.push(r);
    byTier.set(t, list);
  }
  const pick = (rs: FrontierSweTaskRow[]) =>
    [...rs].sort(
      (a, b) =>
        (a.gpus ?? 0) - (b.gpus ?? 0) ||
        (a.solutionCmd ? 0 : 1) - (b.solutionCmd ? 0 : 1) ||
        (a.agentTimeoutSec ?? 0) - (b.agentTimeoutSec ?? 0) ||
        (a.memoryMb ?? 0) - (b.memoryMb ?? 0),
    )[0];
  const out: FrontierSweTaskRow[] = [];
  for (const rs of byTier.values()) {
    const p = pick(rs);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Load a FrontierSWE task set → BenchTask[]. `frontier-swe` = the full 17; `frontier-swe-pilot` = 1 task/bucket
 * (the cheap cross-section, P-014); `frontier-swe-cpu` = the GPU-free subset (runnable without B200/H100 — the
 * 5 GPU tasks are infra-gated, D-006); `frontier-swe-custom` filters the full set to `taskIds`.
 */
export function loadFrontierSweTaskSet(taskSetId: string, taskIds?: string[]): BenchTask[] {
  const rows = readFrontierSweJsonl(frontierSweTaskSetPath());
  let selected = rows;
  if (taskSetId === 'frontier-swe-pilot') selected = frontierSwePilotSubset(rows);
  if (taskSetId === 'frontier-swe-cpu') {
    selected = rows.filter((r) => (r.gpus ?? 0) === 0);
    if (selected.length === 0) throw new Error('no CPU-only FrontierSWE tasks in the corpus');
  }
  let tasks = selected.map(frontierSweRowToBenchTask);
  if (taskSetId === 'frontier-swe-custom') {
    const want = new Set(taskIds ?? []);
    if (want.size === 0) throw new Error('task set "frontier-swe-custom" requires a non-empty taskIds list');
    tasks = tasks.filter((t) => want.has(t.instanceId));
    if (tasks.length === 0) throw new Error('no tasks in the FrontierSWE corpus matched the custom taskIds');
  }
  return tasks;
}

/** The FrontierSWE task-set ids this loader serves. */
export const FRONTIER_SWE_TASK_SET_IDS = [
  'frontier-swe-pilot',
  'frontier-swe',
  'frontier-swe-cpu',
  'frontier-swe-custom',
] as const;

/** True iff `taskSetId` is a FrontierSWE set (routes to {@link loadFrontierSweTaskSet}). */
export function isFrontierSweTaskSet(taskSetId: string): boolean {
  return (FRONTIER_SWE_TASK_SET_IDS as readonly string[]).includes(taskSetId);
}

/** The tiers.json shape (instance_id → tier + difficulty diagnostics). */
type TierEntry = { tier: 'easy' | 'medium' | 'hard'; score?: number };

/** Read the stratified set's tier map; missing file → empty map (rows then carry no tier). */
function readTiers(path: string): Map<string, 'easy' | 'medium' | 'hard'> {
  const out = new Map<string, 'easy' | 'medium' | 'hard'>();
  if (!existsSync(path)) return out;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, TierEntry>;
  for (const [iid, entry] of Object.entries(raw)) {
    if (entry?.tier === 'easy' || entry?.tier === 'medium' || entry?.tier === 'hard') out.set(iid, entry.tier);
  }
  return out;
}

/** Load the difficulty-stratified 30-task set → BenchTask[], tier merged from tiers.json. */
export function loadStratifiedTaskSet(): BenchTask[] {
  const rows = readJsonl(stratifiedTaskSetPath());
  const tiers = readTiers(stratifiedTiersPath());
  return rows.map((r) => rowToBenchTask({ ...r, tier: r.tier ?? tiers.get(r.instance_id) }));
}

/** Load a named task set → BenchTask[]. */
/* ------------------------------- GAIA ------------------------------- */

/** The GAIA task-set ids this loader serves — all reuse the provisioned validation corpus + the standalone
 *  gaia/dataset loader; `benchmark:'gaia'`, gold answer carried in graderMeta (qa modality). */
export const GAIA_TASK_SET_IDS = ['gaia-validation', 'gaia-l1', 'gaia-l2', 'gaia-l3', 'gaia-custom'] as const;

/** True iff `taskSetId` is a GAIA set (routes to {@link loadGaiaBenchTaskSet}). */
export function isGaiaTaskSet(taskSetId: string): boolean {
  return (GAIA_TASK_SET_IDS as readonly string[]).includes(taskSetId);
}

/** Load a GAIA task set → BenchTask[] (graderMeta carries the gold answer + level). `gaia-l3` is the L3
 *  subset (the hive-vs-su comparison set); `gaia-validation` is all 165; `gaia-custom` filters to taskIds. */
function loadGaiaBenchTaskSet(taskSetId: string, taskIds?: string[]): BenchTask[] {
  let gaia = loadGaiaValidation();
  if (taskSetId === 'gaia-l1') gaia = gaia.filter((t) => t.level === 1);
  else if (taskSetId === 'gaia-l2') gaia = gaia.filter((t) => t.level === 2);
  else if (taskSetId === 'gaia-l3') gaia = gaia.filter((t) => t.level === 3);
  let tasks = gaia.map(gaiaTaskToBenchTask);
  if (taskSetId === 'gaia-custom') {
    const want = new Set(taskIds ?? []);
    if (want.size === 0) throw new Error('task set "gaia-custom" requires a non-empty taskIds list');
    tasks = tasks.filter((t) => want.has(t.instanceId));
    if (tasks.length === 0) throw new Error('no tasks in the GAIA corpus matched the custom taskIds');
  }
  return tasks;
}

/** The GDPval task-set ids this loader serves — the public openai/gdpval gold subset (deliverable-bundle
 *  modality; rubric + expert reference deliverable carried in graderMeta). */
export const GDPVAL_TASK_SET_IDS = ['gdpval-gold-220', 'gdpval-pilot', 'gdpval-custom'] as const;

/** True iff `taskSetId` is a GDPval set (routes to {@link loadGdpvalBenchTaskSet}). */
export function isGdpvalTaskSet(taskSetId: string): boolean {
  return (GDPVAL_TASK_SET_IDS as readonly string[]).includes(taskSetId);
}

/** Load a GDPval task set → BenchTask[]. `gdpval-gold-220` is the full public subset; `gdpval-pilot` is one
 *  task per occupation (~44, the cheap representative cross-section); `gdpval-custom` filters to taskIds. */
function loadGdpvalBenchTaskSet(taskSetId: string, taskIds?: string[]): BenchTask[] {
  let gdpval = loadGdpvalTasks();
  if (taskSetId === 'gdpval-pilot') gdpval = gdpvalPilotSubset(gdpval);
  let tasks = gdpval.map(gdpvalTaskToBenchTask);
  if (taskSetId === 'gdpval-custom') {
    const want = new Set(taskIds ?? []);
    if (want.size === 0) throw new Error('task set "gdpval-custom" requires a non-empty taskIds list');
    tasks = tasks.filter((t) => want.has(t.instanceId));
    if (tasks.length === 0) throw new Error('no tasks in the GDPval corpus matched the custom taskIds');
  }
  return tasks;
}

export function loadBenchTaskSet(taskSetId: string, taskIds?: string[]): Promise<BenchTask[]> {
  if (isVerifiedTaskSet(taskSetId)) {
    // Wrap so a synchronous validation throw surfaces as a rejected promise (the Pro branch convention).
    try {
      return Promise.resolve(loadVerifiedTaskSet(taskSetId, taskIds));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  if (isTheAgentCompanyTaskSet(taskSetId)) {
    try {
      return Promise.resolve(loadTheAgentCompanyTaskSet(taskSetId, taskIds));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  if (isMetrHcastTaskSet(taskSetId)) {
    try {
      return Promise.resolve(loadMetrHcastTaskSet(taskSetId, taskIds));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  if (isFrontierSweTaskSet(taskSetId)) {
    try {
      return Promise.resolve(loadFrontierSweTaskSet(taskSetId, taskIds));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  if (isSwarmBenchTaskSet(taskSetId)) {
    try {
      // Programmatic scenarios (task × grid × agents × seed × view) — not a download. The pilot set is cheap;
      // the full 'swarmbench' set is the expensive sweep (D-004), gated by its explicit id.
      let scenarios = swarmbenchScenarios(taskSetId);
      if (taskIds?.length) scenarios = scenarios.filter((s) => taskIds.includes(swarmScenarioToBenchTask(s).instanceId));
      return Promise.resolve(scenarios.map(swarmScenarioToBenchTask));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  if (taskSetId === 'swe-bench-pro-full') {
    return Promise.reject(
      new Error(
        'task set "swe-bench-pro-full" (~731 tasks) is not yet provisioned on this host — ' +
          'wire the full SWE-bench Pro dataset before launching it (owner-gated). Use "11-task-pilot" or "custom".',
      ),
    );
  }
  if (taskSetId === 'stratified-30') {
    return Promise.resolve(loadStratifiedTaskSet());
  }
  if (isGdpvalTaskSet(taskSetId)) {
    try {
      return Promise.resolve(loadGdpvalBenchTaskSet(taskSetId, taskIds));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  if (isGaiaTaskSet(taskSetId)) {
    try {
      return Promise.resolve(loadGaiaBenchTaskSet(taskSetId, taskIds));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
  const rows = readJsonl(pilotTaskSetPath());
  let tasks = rows.map(rowToBenchTask);
  if (taskSetId === 'custom') {
    const want = new Set(taskIds ?? []);
    if (want.size === 0) {
      return Promise.reject(new Error('task set "custom" requires a non-empty taskIds list'));
    }
    tasks = tasks.filter((t) => want.has(t.instanceId));
    if (tasks.length === 0) {
      return Promise.reject(new Error('no tasks in the corpus matched the custom taskIds'));
    }
  }
  return Promise.resolve(tasks);
}

/** Write the grader's sample JSONL (the raw rows, filtered to `instanceIds` when
 *  given) to `destPath` — the --raw_sample_path the official grader reads. */
export function writeTaskSampleJsonl(taskSetId: string, instanceIds: string[] | undefined, destPath: string): number {
  if (taskSetId === 'swe-bench-pro-full') {
    throw new Error('swe-bench-pro-full sample is not provisioned on this host');
  }
  const rows = readJsonl(taskSetId === 'stratified-30' ? stratifiedTaskSetPath() : pilotTaskSetPath());
  const want = instanceIds && instanceIds.length > 0 ? new Set(instanceIds) : null;
  const selected = want ? rows.filter((r) => want.has(r.instance_id)) : rows;
  writeFileSync(destPath, selected.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return selected.length;
}

/** The task sets the launch form offers (id + label + count when known). */
export function knownTaskSets(): Array<{ id: string; label: string; count: number | null }> {
  let pilotCount: number | null = null;
  try {
    pilotCount = readJsonl(pilotTaskSetPath()).length;
  } catch {
    pilotCount = null;
  }
  let stratifiedCount: number | null = null;
  try {
    stratifiedCount = readJsonl(stratifiedTaskSetPath()).length;
  } catch {
    stratifiedCount = null;
  }
  let verifiedCount: number | null = null;
  try {
    verifiedCount = readVerifiedJsonl(verifiedTaskSetPath()).length;
  } catch {
    verifiedCount = null;
  }
  let verifiedPilotCount: number | null = null;
  try {
    verifiedPilotCount = readVerifiedJsonl(verifiedPilotTaskSetPath()).length;
  } catch {
    verifiedPilotCount = null;
  }
  let tacCount: number | null = null;
  try {
    tacCount = readTheAgentCompanyJsonl(theAgentCompanyTaskSetPath()).length;
  } catch {
    tacCount = null;
  }
  let tacPilotCount: number | null = null;
  try {
    tacPilotCount = readTheAgentCompanyJsonl(theAgentCompanyPilotTaskSetPath()).length;
  } catch {
    tacPilotCount = null;
  }
  let metrCount: number | null = null;
  let metrHorizonCount: number | null = null;
  try {
    const rows = readMetrHcastJsonl(metrHcastTaskSetPath());
    metrCount = rows.length;
    metrHorizonCount = rows.filter((r) => (r.horizonEligible ?? r.humanMinutes != null)).length;
  } catch {
    metrCount = null;
    metrHorizonCount = null;
  }
  let metrPilotCount: number | null = null;
  try {
    metrPilotCount = readMetrHcastJsonl(metrHcastPilotTaskSetPath()).length;
  } catch {
    metrPilotCount = null;
  }
  let gdpvalGoldCount: number | null = null;
  let gdpvalPilotCount: number | null = null;
  try {
    const g = loadGdpvalTasks();
    gdpvalGoldCount = g.length;
    gdpvalPilotCount = gdpvalPilotSubset(g).length;
  } catch {
    gdpvalGoldCount = null;
    gdpvalPilotCount = null;
  }
  let frontierSweCount: number | null = null;
  let frontierSwePilotCount: number | null = null;
  let frontierSweCpuCount: number | null = null;
  try {
    const fsw = readFrontierSweJsonl(frontierSweTaskSetPath());
    frontierSweCount = fsw.length;
    frontierSwePilotCount = frontierSwePilotSubset(fsw).length;
    frontierSweCpuCount = fsw.filter((r) => (r.gpus ?? 0) === 0).length;
  } catch {
    frontierSweCount = null;
    frontierSwePilotCount = null;
    frontierSweCpuCount = null;
  }
  return [
    { id: '11-task-pilot', label: '11-task pilot (public SWE-bench Pro)', count: pilotCount },
    {
      id: 'stratified-30',
      label: 'Difficulty-stratified 30 (10 easy / 10 medium / 10 hard)',
      count: stratifiedCount,
    },
    { id: 'swe-bench-pro-full', label: 'Full SWE-bench Pro (~731)', count: 731 },
    { id: 'verified-pilot-10', label: 'SWE-bench Verified pilot (10, representative)', count: verifiedPilotCount },
    { id: 'swe-bench-verified', label: 'Full SWE-bench Verified (500)', count: verifiedCount },
    {
      id: 'the-agent-company-pilot',
      label: 'TheAgentCompany pilot (10–20, spans categories)',
      count: tacPilotCount,
    },
    { id: 'the-agent-company', label: 'TheAgentCompany full (175 professional tasks)', count: tacCount },
    { id: 'metr-hcast-pilot', label: 'METR HCAST pilot (cheapest horizon-eligible)', count: metrPilotCount },
    { id: 'metr-hcast-horizon', label: 'METR HCAST horizon set (baseline-carrying)', count: metrHorizonCount },
    { id: 'metr-hcast', label: 'METR HCAST full (~31 open Task-Standard tasks)', count: metrCount },
    { id: 'swarmbench-pilot', label: 'SwarmBench pilot (Pursuit+Sync, small grid, 3 seeds)', count: swarmbenchScenarios('swarmbench-pilot').length },
    { id: 'swarmbench', label: 'SwarmBench full (5 tasks × 10 agents × 100 rounds — EXPENSIVE)', count: swarmbenchScenarios('swarmbench').length },
    { id: 'gdpval-pilot', label: 'GDPval pilot (1 task/occupation, deliverable win-rate)', count: gdpvalPilotCount },
    { id: 'gdpval-gold-220', label: 'GDPval gold subset (220, pairwise-judge win-rate vs expert)', count: gdpvalGoldCount },
    { id: 'frontier-swe-pilot', label: 'FrontierSWE pilot (1 task/bucket — impl/perf/research)', count: frontierSwePilotCount },
    { id: 'frontier-swe-cpu', label: 'FrontierSWE CPU-only (GPU-free subset, no B200/H100)', count: frontierSweCpuCount },
    { id: 'frontier-swe', label: 'FrontierSWE full (17 ultra-long-horizon tasks)', count: frontierSweCount },
    { id: 'custom', label: 'Custom instance ids', count: null },
  ];
}
