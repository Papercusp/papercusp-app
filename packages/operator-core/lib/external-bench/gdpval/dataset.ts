/**
 * GDPval dataset access + task loading (plan `benchmark-suite-gdpval-2026-06-17`, Phase 1).
 *
 * `openai/gdpval` on HF is the PUBLIC 220-task gold subset (ungated, CC-license-ambiguous — research/eval
 * use; do NOT redistribute derived data without owner sign-off). Each row is a real professional task:
 *   - `prompt`            — what the professional was asked to produce
 *   - `reference_files`   — INPUT context files handed to the professional (data, templates)
 *   - `deliverable_files` — the EXPERT REFERENCE deliverable (what an arm's output is graded against)
 *   - `rubric_pretty` / `rubric_json` — the per-task grading rubric the pairwise judge applies
 *   - `sector` / `occupation` — the 9 GDP sectors × 44 occupations (per-group win-rate reporting)
 *
 * Pure w.r.t. the network: loads from an already-mirrored local `tasks.jsonl`. Provisioning (the public HF
 * download — no token) is {@link buildGdpvalDownloadCommand} / the CLI `provision` verb. The loader throws an
 * actionable error when absent rather than silently running an empty set (the external-bench convention).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BenchTask } from '../types';

/** A GDPval task, normalized from a dataset row. */
export interface GdpvalTask {
  taskId: string;
  sector: string;
  occupation: string;
  prompt: string;
  /** Human-readable rubric (`rubric_pretty`) the pairwise judge grades against. */
  rubric: string;
  /** Structured rubric criteria (`rubric_json`), carried for analysis. */
  rubricJson?: unknown;
  /** Input context file refs (HF resolve URLs) handed to the professional. */
  referenceInputUrls: string[];
  /** The EXPERT reference deliverable file refs (HF resolve URLs) — what an arm's output is graded against. */
  referenceDeliverableUrls: string[];
}

/** A raw GDPval row (tolerant of the documented column names + string/array spellings). */
interface GdpvalRawRow {
  task_id?: string;
  sector?: string;
  occupation?: string;
  prompt?: string;
  rubric_pretty?: string;
  rubric_json?: unknown;
  reference_file_urls?: string[] | string;
  deliverable_file_urls?: string[] | string;
  [k: string]: unknown;
}

/** Default home for the provisioned GDPval gold corpus (env-overridable). */
export function gdpvalTaskSetPath(): string {
  return process.env.PAPERCUSP_GDPVAL_JSONL ?? join(homedir(), '.papercusp', 'bench-results', 'gdpval', 'tasks.jsonl');
}

/** Coerce a field that may be a JSON-array string OR a real array → string[]. */
function asUrlList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      return [v];
    }
  }
  return [];
}

/** Map ONE raw row → a {@link GdpvalTask}. Throws on a missing task_id / prompt (a malformed corpus fails loud). */
export function parseGdpvalRow(raw: GdpvalRawRow): GdpvalTask {
  const taskId = String(raw.task_id ?? '').trim();
  const prompt = String(raw.prompt ?? '').trim();
  if (!taskId) throw new Error(`GDPval row missing task_id: ${JSON.stringify(raw).slice(0, 160)}`);
  if (!prompt) throw new Error(`GDPval row ${taskId} missing prompt`);
  return {
    taskId,
    sector: String(raw.sector ?? 'unknown').trim(),
    occupation: String(raw.occupation ?? 'unknown').trim(),
    prompt,
    rubric: String(raw.rubric_pretty ?? '').trim(),
    rubricJson: raw.rubric_json,
    referenceInputUrls: asUrlList(raw.reference_file_urls),
    referenceDeliverableUrls: asUrlList(raw.deliverable_file_urls),
  };
}

/** Parse a `tasks.jsonl` body → {@link GdpvalTask}[]. */
export function parseGdpvalJsonl(body: string): GdpvalTask[] {
  return body
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => parseGdpvalRow(JSON.parse(line) as GdpvalRawRow));
}

/** Load GDPval tasks from a provisioned `tasks.jsonl` (defaults to the gold corpus). Throws if absent. */
export function loadGdpvalTasks(path: string = gdpvalTaskSetPath()): GdpvalTask[] {
  if (!existsSync(path)) {
    throw new Error(
      `GDPval corpus not provisioned at ${path}. It is the PUBLIC openai/gdpval gold subset (no token). ` +
        `Provision with the gdpval CLI 'provision' verb (see buildGdpvalDownloadCommand) or set PAPERCUSP_GDPVAL_JSONL.`,
    );
  }
  return parseGdpvalJsonl(readFileSync(path, 'utf8'));
}

/** Per-occupation / per-sector counts. */
export function gdpvalGroupCounts(tasks: GdpvalTask[]): { occupations: number; sectors: number; tasks: number } {
  return {
    occupations: new Set(tasks.map((t) => t.occupation)).size,
    sectors: new Set(tasks.map((t) => t.sector)).size,
    tasks: tasks.length,
  };
}

/**
 * Deterministic 1-task-per-occupation pilot subset (the `gdpval-pilot` set — ~44 tasks). Sorted by taskId
 * within each occupation, take the first; reproducible with no RNG. The cheap representative cross-section.
 */
export function gdpvalPilotSubset(tasks: GdpvalTask[]): GdpvalTask[] {
  const byOcc = new Map<string, GdpvalTask[]>();
  for (const t of tasks) (byOcc.get(t.occupation) ?? byOcc.set(t.occupation, []).get(t.occupation)!).push(t);
  const out: GdpvalTask[] = [];
  for (const [, group] of [...byOcc.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push([...group].sort((a, b) => a.taskId.localeCompare(b.taskId))[0]);
  }
  return out;
}

/**
 * Map a {@link GdpvalTask} → the shared {@link BenchTask} contract (suite='gdpval', modality 'deliverable-bundle').
 * `problemStatement` is the prompt (+ a note about the input files the arm should fetch); the rubric + the
 * EXPERT REFERENCE deliverable refs ride `graderMeta` (the arm MUST NOT read graderMeta — keeps generation
 * grader-agnostic / un-gameable; the arm never sees the reference it's graded against). occupation/sector ride
 * graderMeta for per-group win-rate reporting.
 */
export function gdpvalTaskToBenchTask(task: GdpvalTask): BenchTask {
  const inputNote = task.referenceInputUrls.length
    ? `\n\nInput files for this task (fetch them):\n${task.referenceInputUrls.join('\n')}`
    : '';
  return {
    benchmark: 'gdpval',
    instanceId: task.taskId,
    problemStatement: `${task.prompt}${inputNote}`,
    graderMeta: {
      occupation: task.occupation,
      sector: task.sector,
      rubric: task.rubric,
      rubricJson: task.rubricJson,
      referenceDeliverableUrls: task.referenceDeliverableUrls,
      referenceInputUrls: task.referenceInputUrls,
    },
  } satisfies BenchTask;
}

/**
 * Build the `huggingface_hub` snapshot-download command for the PUBLIC gold subset (no token needed). Pulls
 * the parquet + the reference/deliverable files into `destRoot`. `pythonBin` needs `huggingface_hub` installed.
 * After download, convert the parquet → `tasks.jsonl` (the CLI `provision` verb does this).
 */
export function buildGdpvalDownloadCommand(opts: { pythonBin: string; destRoot: string }): { cmd: string; args: string[] } {
  const py = [
    'from huggingface_hub import snapshot_download',
    `p = snapshot_download(repo_id="openai/gdpval", repo_type="dataset", local_dir=${JSON.stringify(opts.destRoot)})`,
    'print(p)',
  ].join('; ');
  return { cmd: opts.pythonBin, args: ['-c', py] };
}
