/**
 * GAIA dataset access + task loading (plan `benchmark-suite-gaia-2026-06-17`, P-001).
 *
 * GAIA (`gaia-benchmark/GAIA` on HF) is a **gated** dataset (CC-BY-4.0 + a no-reshare clause): a raw fetch
 * 401s without an HF token whose account has accepted the terms. The data is plain files in the repo, NOT a
 * packaged parquet split — for the `validation` split it is:
 *
 *   2023/validation/metadata.jsonl   ← one JSON row per task
 *   2023/validation/<file_name>      ← the optional attached file per task (pdf/xlsx/docx/csv/png/mp3/…)
 *
 * Each `metadata.jsonl` row (the **confirmed schema**, per the GAIA dataset card + paper appendix):
 *   {
 *     "task_id": "c61d22de-…",
 *     "Question": "…",
 *     "Level": "1" | "2" | "3",
 *     "Final answer": "…",            // gold — present in validation; "?" / withheld in test
 *     "file_name": "" | "x…xlsx",     // "" when the task has no attachment
 *     "file_path": "…",               // dataset-local path (we re-resolve against the staged dir)
 *     "Annotator Metadata": { Steps, "Number of steps", "How long did this take?", Tools, "Number of tools" }
 *   }
 *
 * This module is PURE w.r.t. the network — it loads from an already-provisioned local directory and maps
 * rows to {@link GaiaTask}. Provisioning (the gated download) is a SEPARATE, owner-gated step: see
 * {@link buildGaiaDownloadCommand} (returns the `huggingface_hub` snapshot command) and the CLI's
 * `provision` verb. The loader throws an actionable error when the corpus is absent rather than silently
 * running an empty set (the convention every other external-bench task-set follows).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { BenchTask } from '../types';
import { coerceLevel, type GaiaLevel } from '../grader/gaia';

/** The drop-file an owner can write a gated-HF token into to unblock provisioning (env-overridable). */
export function gaiaHfTokenFile(): string {
  return process.env.PAPERCUSP_GAIA_HF_TOKEN_FILE ?? join(homedir(), '.papercusp', 'gaia-hf-token');
}

/**
 * Resolve a gated-HF token from (in order): `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` env, then the drop-file
 * {@link gaiaHfTokenFile} (a token pasted into `~/.papercusp/gaia-hf-token`). Returns null when none is set.
 * This is the single unblock point for the GAIA gated dataset — an owner sets the env OR drops the file.
 */
export function resolveHfToken(): string | null {
  const env = (process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || '').trim();
  if (env) return env;
  const file = gaiaHfTokenFile();
  if (existsSync(file)) {
    const tok = readFileSync(file, 'utf8').trim();
    if (tok) return tok;
  }
  return null;
}

/** A GAIA task, normalized from a `metadata.jsonl` row. */
export interface GaiaTask {
  taskId: string;
  question: string;
  level: GaiaLevel;
  /** Gold `Final answer` — present for the validation split; empty/withheld for test. */
  finalAnswer: string;
  /** Attachment file name ("" when none). */
  fileName: string;
  /** Absolute path to the staged attachment (set by {@link loadGaiaTasks} when `fileName` is non-empty). */
  filePath?: string;
  /** Raw `Annotator Metadata` (Steps / Tools / etc.), carried through for analysis. */
  annotatorMetadata?: Record<string, unknown>;
}

/** The raw `metadata.jsonl` row shape — tolerant of the documented key spellings + a few variants. */
interface GaiaRawRow {
  task_id?: string;
  Question?: string;
  question?: string;
  Level?: string | number;
  level?: string | number;
  'Final answer'?: string;
  final_answer?: string;
  Answer?: string;
  file_name?: string;
  file_path?: string;
  'Annotator Metadata'?: Record<string, unknown>;
  annotator_metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Default home for the provisioned GAIA validation corpus (env-overridable). */
export function gaiaValidationDir(): string {
  return (
    process.env.PAPERCUSP_GAIA_VALIDATION_DIR ??
    join(homedir(), '.papercusp', 'bench-results', 'gaia', '2023', 'validation')
  );
}

/** Default home for the provisioned GAIA test corpus (leaderboard-only; answers withheld). */
export function gaiaTestDir(): string {
  return (
    process.env.PAPERCUSP_GAIA_TEST_DIR ?? join(homedir(), '.papercusp', 'bench-results', 'gaia', '2023', 'test')
  );
}

/**
 * Map ONE raw row → a {@link GaiaTask}. Pure + tolerant of key-spelling variants. `dir`, when given,
 * resolves a non-empty `file_name` to an absolute staged path. Throws on a missing question / unparseable
 * level (a malformed corpus should fail loudly, not silently drop tasks).
 */
export function parseGaiaRow(raw: GaiaRawRow, dir?: string): GaiaTask {
  const taskId = String(raw.task_id ?? raw['task_id'] ?? '').trim();
  const question = String(raw.Question ?? raw.question ?? '').trim();
  if (!taskId) throw new Error(`GAIA row missing task_id: ${JSON.stringify(raw).slice(0, 200)}`);
  if (!question) throw new Error(`GAIA row ${taskId} missing Question`);
  const level = coerceLevel(raw.Level ?? raw.level);
  const finalAnswer = String(raw['Final answer'] ?? raw.final_answer ?? raw.Answer ?? '').trim();
  const fileName = String(raw.file_name ?? '').trim();
  const annotatorMetadata = (raw['Annotator Metadata'] ?? raw.annotator_metadata) as
    | Record<string, unknown>
    | undefined;
  const task: GaiaTask = { taskId, question, level, finalAnswer, fileName };
  if (annotatorMetadata && typeof annotatorMetadata === 'object') task.annotatorMetadata = annotatorMetadata;
  if (fileName && dir) {
    // Prefer an explicit file_path if it is already absolute; otherwise resolve file_name under `dir`.
    const fp = typeof raw.file_path === 'string' && isAbsolute(raw.file_path) ? raw.file_path : join(dir, fileName);
    task.filePath = fp;
  }
  return task;
}

/** Parse a whole `metadata.jsonl` body (one JSON object per non-empty line) → {@link GaiaTask}[]. */
export function parseGaiaMetadataJsonl(body: string, dir?: string): GaiaTask[] {
  return body
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => parseGaiaRow(JSON.parse(line) as GaiaRawRow, dir));
}

/**
 * Load GAIA tasks from a provisioned local split directory (defaults to the validation dir). Reads
 * `<dir>/metadata.jsonl`. Throws an actionable error — pointing at {@link buildGaiaDownloadCommand} — when
 * the corpus is not present (gated; needs an HF token + accepted terms).
 */
export function loadGaiaTasks(dir: string = gaiaValidationDir()): GaiaTask[] {
  const metaPath = join(dir, 'metadata.jsonl');
  if (!existsSync(metaPath)) {
    throw new Error(
      `GAIA corpus not provisioned at ${metaPath}. GAIA is a GATED HF dataset — accept the terms at ` +
        `https://huggingface.co/datasets/gaia-benchmark/GAIA and provision with an HF token whose account ` +
        `has access. Run the provisioning command (see buildGaiaDownloadCommand / the gaia CLI 'provision' verb), ` +
        `or set PAPERCUSP_GAIA_VALIDATION_DIR to an existing checkout.`,
    );
  }
  return parseGaiaMetadataJsonl(readFileSync(metaPath, 'utf8'), dir);
}

/** Load the validation split (public gold answers → self-gradable). */
export function loadGaiaValidation(): GaiaTask[] {
  return loadGaiaTasks(gaiaValidationDir());
}

/** Per-level task counts. */
export function gaiaLevelCounts(tasks: GaiaTask[]): Record<GaiaLevel, number> {
  const counts: Record<GaiaLevel, number> = { 1: 0, 2: 0, 3: 0 };
  for (const t of tasks) counts[t.level] += 1;
  return counts;
}

/**
 * Deterministically select a stratified subset — up to `perLevel` tasks from EACH level (L1/L2/L3).
 * Selection is deterministic (sorted by taskId, then take the first `perLevel`) so a pilot is reproducible
 * with no RNG. Levels with fewer than `perLevel` tasks contribute all they have.
 */
export function stratifiedGaiaSubset(tasks: GaiaTask[], perLevel: number): GaiaTask[] {
  const out: GaiaTask[] = [];
  for (const level of [1, 2, 3] as GaiaLevel[]) {
    const atLevel = tasks.filter((t) => t.level === level).sort((a, b) => a.taskId.localeCompare(b.taskId));
    out.push(...atLevel.slice(0, perLevel));
  }
  return out;
}

/**
 * Map a {@link GaiaTask} → the shared {@link BenchTask} contract so a GAIA run can ride the external-bench
 * reporting (suite='gaia'). The `problemStatement` is the question (what the arm sees); the gold answer +
 * level + attachment ride `graderMeta` (the arm MUST NOT read graderMeta — keeps generation grader-agnostic).
 */
export function gaiaTaskToBenchTask(task: GaiaTask): BenchTask {
  return {
    benchmark: 'gaia',
    instanceId: task.taskId,
    problemStatement: task.question,
    graderMeta: {
      finalAnswer: task.finalAnswer,
      level: task.level,
      fileName: task.fileName,
      ...(task.filePath ? { filePath: task.filePath } : {}),
    },
  } satisfies BenchTask;
}

/**
 * Build the `huggingface_hub` snapshot-download command that provisions a GAIA split into `destRoot`. The
 * gated download is owner-gated (needs `HF_TOKEN`); this returns the exact command rather than running it,
 * so the CLI/script (or the owner) executes it with the right interpreter + token in env. `pythonBin` should
 * be a python with `huggingface_hub` installed (e.g. `~/.papercusp/competitors/venv/bin/python`).
 *
 * The resulting layout is `<destRoot>/2023/<split>/{metadata.jsonl, <attachments>}` — i.e. set
 * PAPERCUSP_GAIA_VALIDATION_DIR=`<destRoot>/2023/validation`.
 */
export function buildGaiaDownloadCommand(opts: {
  pythonBin: string;
  destRoot: string;
  split?: 'validation' | 'test';
}): { cmd: string; args: string[] } {
  const split = opts.split ?? 'validation';
  const py = [
    'import os, sys',
    'from huggingface_hub import snapshot_download',
    'tok = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")',
    'assert tok, "HF_TOKEN not set — GAIA is gated; provide a token whose account accepted the terms"',
    'p = snapshot_download(repo_id="gaia-benchmark/GAIA", repo_type="dataset", '
      + `allow_patterns=["2023/${split}/*"], local_dir=${JSON.stringify(opts.destRoot)}, token=tok)`,
    'print(p)',
  ].join('; ');
  return { cmd: opts.pythonBin, args: ['-c', py] };
}
