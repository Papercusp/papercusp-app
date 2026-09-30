/**
 * PaperBench paper-replication DRIVER (plan benchmark-suite-paperbench-2026-06-17, #18 — Code-Dev first).
 *
 * The TS counterpart of `paperbench/hive_solver.py`. The Python `HiveSolver._drive_hive` shells to this
 * with `--paper-id --paper-dir --out --arm --budget-usd [--code-only]` (+ env `PAPERCUSP_PB_RUN_ID`); it
 * reads the paper context from `--paper-dir`, drives the Papercup opus arm to produce the replication
 * CODEBASE (+ a root `reproduce.sh`, NOT executed — Code-Dev decouples reproduction so no GPU is needed),
 * writes that tree into `--out` (which the Python side uploads to the sandbox SUBMISSION_DIR), and exits
 * 0 on a non-empty submission / non-zero on failure (so the solver records the error).
 *
 * DESIGN — narrow seam, stable core. Everything arm-specific sits behind ONE injected op
 * ({@link PaperReplicationOps.drive}); the CLI + the never-throw core ({@link drivePaperReplication}) +
 * the paper reader + the tree validation (non-empty, reproduce.sh present) are pure and unit-tested with
 * a fake `drive` (NO arm / NO LLM / NO docker). The REAL `drive` ({@link realPaperReplicationOps})
 * reuses the in-flux su-independent / hive arm machinery (createHive → enroll a paper-seeded member →
 * FIFO spawn → collect the produced tree → teardown), lazy-imported. It is exercised end-to-end only
 * once the bench-harness-live DRIVE binding makes a spawned bee actually run the spine — until then a
 * spawned bee infra-fails at $0 (the same gate the su-vs-queen probes hit), and this driver reports it.
 *
 * Unlike the SWE arm (clone a repo @ base → extract a unified diff), PaperBench is empty-start →
 * produce a fresh tree, so the seed is the PAPER context and the collect is the WHOLE worktree tree.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from '../util/cli-entry';
import { resolveBenchWorkspace } from './bench-workspace';

/** The paper context the harness drops in the sandbox (mirrors `PAPER_TEXT_FILES` in hive_solver.py). */
export interface PaperContext {
  paperId: string;
  paperDir: string;
  instructions: string;
  paperMd: string;
  addendum: string;
  blacklist: string;
  /** Absolute path to paper.pdf if present (binary — passed by ref, not inlined). */
  pdfPath: string | null;
}

export interface PaperReplicationRequest {
  paperId: string;
  paperContext: PaperContext;
  /** The local dir the arm must populate with the replication tree (+ root reproduce.sh). */
  outDir: string;
  arm: string;
  budgetUsd: number;
  /** Code-Dev mode: produce code + reproduce.sh WITHOUT running it (no GPU). */
  codeOnly: boolean;
  runId: string;
  workspaceId: string;
}

/** The ONE arm-specific seam — drives the chosen arm over the paper and WRITES the tree into req.outDir. */
export interface PaperReplicationOps {
  drive(req: PaperReplicationRequest): Promise<{ filesWritten: number; costUsd: number; agentId: string | null }>;
}

export interface PaperReplicationResult {
  ok: boolean;
  paperId: string;
  /** Ground-truth file count re-read from outDir after the drive (not what the op claimed). */
  filesWritten: number;
  costUsd: number;
  agentId: string | null;
  /** Code-Dev requires a root reproduce.sh — surfaced (never fabricated; the grade reflects reality). */
  hasReproduceSh: boolean;
  error?: string;
}

const PAPER_TEXT_FILES = ['instructions.txt', 'paper.md', 'addendum.md', 'blacklist.txt'] as const;

function readIfPresent(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/** Read the downloaded paper context out of `paperDir` (a missing optional file → ''). */
export function readPaperContext(paperId: string, paperDir: string): PaperContext {
  const get = (name: string): string => readIfPresent(join(paperDir, name));
  const pdf = join(paperDir, 'paper.pdf');
  return {
    paperId,
    paperDir,
    instructions: get('instructions.txt'),
    paperMd: get('paper.md'),
    addendum: get('addendum.md'),
    blacklist: get('blacklist.txt'),
    pdfPath: existsSync(pdf) ? pdf : null,
  };
}

/** Count the files (not dirs) under a tree — the ground-truth submission size. */
export function countTreeFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) n += countTreeFiles(p);
    else n += 1;
  }
  return n;
}

/** PaperBench Code-Dev grades a root `reproduce.sh` (Code-Development leaf). Present-or-not, never faked. */
export function hasReproduceSh(dir: string): boolean {
  return existsSync(join(dir, 'reproduce.sh'));
}

/**
 * Never-throws core: drive the arm over the paper, then validate the produced tree from DISK (ground
 * truth), surfacing an empty submission or a missing reproduce.sh as a non-ok result (the caller maps
 * that to a non-zero exit so the Python solver records the error — base.run() still grades what exists).
 */
export async function drivePaperReplication(
  req: PaperReplicationRequest,
  ops: PaperReplicationOps,
): Promise<PaperReplicationResult> {
  const base: PaperReplicationResult = {
    ok: false,
    paperId: req.paperId,
    filesWritten: 0,
    costUsd: 0,
    agentId: null,
    hasReproduceSh: false,
  };
  let costUsd = 0;
  let agentId: string | null = null;
  try {
    const t = await ops.drive(req);
    costUsd = t.costUsd;
    agentId = t.agentId;
  } catch (e) {
    return { ...base, costUsd, agentId, error: `arm drive failed for ${req.paperId}: ${String(e)}` };
  }
  const files = countTreeFiles(req.outDir); // re-read from disk — the op's count is advisory
  const repro = hasReproduceSh(req.outDir);
  const res: PaperReplicationResult = {
    ok: files > 0,
    paperId: req.paperId,
    filesWritten: files,
    costUsd,
    agentId,
    hasReproduceSh: repro,
  };
  if (files === 0) res.error = 'empty submission (the arm produced no files in out_dir)';
  else if (req.codeOnly && !repro) {
    // Non-fatal: a Code-Dev submission without reproduce.sh still grades (just incompletely). Surface loud.
    console.error(`[pb] WARNING: no root reproduce.sh in submission for ${req.paperId} — Code-Dev grade will be incomplete`);
  }
  return res;
}

/**
 * The REAL arm binding. Reuses the su-independent / hive arm machinery (paper-seeded), lazy-imported so
 * the pure core + tests never load the arm. Exercised end-to-end only once the bench-harness-live DRIVE
 * binding makes a spawned bee run the spine; until then the drive returns an empty tree (bee infra-fails
 * at $0) and the core reports an empty submission. Implemented as the paper-shaped adapter over the arm's
 * hive lifecycle + FIFO spawn seam (createHive → seed an empty worktree with the paper → enroll + spawn →
 * copy the produced /submission tree into outDir → teardown).
 */
export function realPaperReplicationOps(): PaperReplicationOps {
  return {
    async drive(req) {
      const mod = await import('./paperbench-arm-binding');
      return mod.drivePaperViaArm(req);
    },
  };
}

interface ParsedArgs {
  paperId: string;
  paperDir: string;
  out: string;
  arm: string;
  budgetUsd: number;
  codeOnly: boolean;
}

/** Parse the CLI the Python solver passes. Throws (caught by main) on a missing required flag. */
export function parsePbArgs(argv: string[]): ParsedArgs {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const paperId = val('paper-id');
  const paperDir = val('paper-dir');
  const out = val('out');
  if (!paperId || !paperDir || !out) {
    throw new Error('usage: _pb_hive_solve.ts --paper-id <id> --paper-dir <dir> --out <dir> [--arm hive] [--budget-usd 40] [--code-only]');
  }
  return {
    paperId,
    paperDir,
    out,
    arm: val('arm') ?? 'hive',
    budgetUsd: Number(val('budget-usd') ?? '40'),
    codeOnly: argv.includes('--code-only'),
  };
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parsePbArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(2);
  }
  const workspaceId = resolveBenchWorkspace(process.env.PAPERCUSP_BENCH_WORKSPACE); // dedicated benchmark workspace, never production (plan benchmark-workspace-isolation)
  const runId = process.env.PAPERCUSP_PB_RUN_ID ?? `pb-${args.paperId}`;
  const req: PaperReplicationRequest = {
    paperId: args.paperId,
    paperContext: readPaperContext(args.paperId, args.paperDir),
    outDir: args.out,
    arm: args.arm,
    budgetUsd: args.budgetUsd,
    codeOnly: args.codeOnly,
    runId,
    workspaceId,
  };
  const res = await drivePaperReplication(req, realPaperReplicationOps());
  console.log(JSON.stringify({ paperBenchDriver: res }));
  // NOT process.exit(): stdout is async on a pipe and exit() does not drain it, so a
  // consumer parsing this driver result would silently get a truncated prefix.
  // See scripts/check-undrained-stdout-exit.mjs.
  if (!res.ok) {
    console.error(`[pb] ${res.error ?? 'failed'}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

// Run as a CLI only when invoked directly (so the test can import the pure functions).
if (isCliEntry(import.meta.url)) {
  await main();
}
