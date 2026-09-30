/**
 * gaia-backlog-support.ts — the GAIA-specific seam shared by the two REAL-orchestration arms
 * (su-independent + hive-realqueen) so they run the GAIA L3 set through the SAME backlog drivers
 * the SWE-bench Pro arms use (plan `benchmark-suite-gaia-2026-06-17`).
 *
 * THE THREE GAIA SWAPS vs the SWE-bench coding path (everything else — the pool/Queen drive, the
 * cost-reading `readMemberUsage`, the never-throw contract, the fleet spawn routing — is unchanged):
 *
 *   1. CLONE → a scratch dir. `cloneTaskRepo` THROWS for a GAIA task (no repo/baseCommit). This module's
 *      {@link gaiaCloneTask} mkdtemps a fresh dir, `git init`s it (so the fleet's requiresRepo cwd
 *      resolution + the agent's `Write answer.txt` have a stable home), stages `graderMeta.filePath` (the
 *      optional GAIA attachment) into it, and returns a {@link TaskCheckout} with `repo:''`/`baseCommit:''`.
 *   2. BRIEF → the work-item spec is the GAIA question + the answer.txt instruction (see {@link gaiaBrief}),
 *      NOT a code-fix directive. The bee researches with its native web/fetch/bash/file tools and writes its
 *      final answer to `answer.txt` in its cwd (= checkout.dir).
 *   3. EXTRACT → instead of `extractDiff` (git diff), {@link extractGaiaAnswer} reads `<checkout.dir>/answer.txt`
 *      and returns it as the qa-modality answer (the caller puts it on `ArmAttempt.answer`, diff:'').
 *
 * The member harness blueprint is {@link GAIA_MEMBER_BLUEPRINT} ('gaia-agent' — a general-assistant single
 * agent, NOT the coding spine `external-bench`).
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp as mkdtempCb, rm as rmCb, copyFile as copyFileCb, readFile as readFileCb } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { BenchTask, TaskCheckout } from './types';

const execFileP = promisify(execFileCb);
const mkdtempP = promisify(mkdtempCb);
const rmP = promisify(rmCb);
const copyFileP = promisify(copyFileCb);
const readFileP = promisify(readFileCb);

/** The general-assistant single-agent blueprint a GAIA bee runs (NOT the coding spine). */
export const GAIA_MEMBER_BLUEPRINT = 'gaia-agent';

/** The fixed filename the bee writes its final answer into (in its cwd = the scratch checkout dir). */
export const GAIA_ANSWER_FILE = 'answer.txt';

/**
 * The work-item spec / directive a GAIA bee receives — the question + the answer.txt instruction in the
 * GAIA normalized format. This is BOTH the seeded feature `spec` AND the `place_batch` brief, so a bee
 * placed by the FIFO/Queen path (which only sees the brief) still has the full instruction. It deliberately
 * mirrors the `gaia-agent` persona so the directive holds even if the persona file doesn't resolve.
 */
export function gaiaBrief(task: BenchTask): string {
  const hasFile = typeof task.graderMeta?.['filePath'] === 'string' && (task.graderMeta['filePath'] as string).length > 0;
  const fileName = String(task.graderMeta?.['fileName'] ?? '').trim();
  const fileLine = hasFile
    ? `\n\nThis question has an ATTACHED FILE staged in your current working directory: "${fileName || basename(String(task.graderMeta!['filePath']))}". Read it (use Read, or Bash+python for binary formats like xlsx/pdf/mp3/docx) as part of your research.`
    : '';
  return [
    'You are answering ONE question from the GAIA benchmark (General AI Assistants). Research this question',
    'using your native web_search / fetch / bash(python) / file tools, chasing every hop and verifying facts',
    'from the actual sources. When done, write ONLY your final answer to a file named',
    `"${GAIA_ANSWER_FILE}" in your current working directory (use the Write tool), in the GAIA normalized`,
    'format: a number OR as few words as possible OR a comma-separated list of numbers/strings; no commas in',
    'numbers, no units or articles or abbreviations unless the question explicitly asks for them. You may end',
    'the file with a line "FINAL ANSWER: <answer>". That file is your ENTIRE submission — nothing else you do',
    'is graded. Once answer.txt is written, mark this work-item complete (`work_items:complete`) and emit DONE.',
    'Do NOT exit without writing answer.txt; if genuinely uncertain, still write your single best exact answer.',
    '',
    'QUESTION:',
    task.problemStatement,
    fileLine,
  ].join(' ').replace(' \n\n ', '\n\n').trim() + '\n';
}

/** Injected IO for the GAIA clone (fakes in tests; real `git`/fs in production). */
export interface GaiaCloneDeps {
  git?: (args: string[], cwd?: string) => Promise<void>;
  mkdtemp?: (prefix: string) => Promise<string>;
  rm?: (path: string) => Promise<void>;
  copyFile?: (src: string, dest: string) => Promise<void>;
}

/**
 * Clone-equivalent for a GAIA task: mkdtemp a scratch dir, `git init` it (empty repo — satisfies the fleet
 * requiresRepo cwd resolution + gives `Write answer.txt` a stable home), stage the optional attachment, and
 * return a {@link TaskCheckout} with empty repo/baseCommit. NEVER reaches a benchmark repo (GAIA has none).
 */
export async function gaiaCloneTask(task: BenchTask, deps: GaiaCloneDeps = {}): Promise<TaskCheckout> {
  const git =
    deps.git ??
    (async (args: string[], cwd?: string) => {
      await execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    });
  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => mkdtempP(prefix));
  const rm = deps.rm ?? ((p: string) => rmP(p, { recursive: true, force: true }));
  const copyFile = deps.copyFile ?? ((s: string, d: string) => copyFileP(s, d));

  const dir = await mkdtemp(join(tmpdir(), 'gaia-bench-'));
  try {
    // Empty git repo so the worktree is a real (clean) repo — the fleet's requiresRepo cwd resolution is
    // satisfied and the bee's file writes have a stable home. No remote, no base commit.
    await git(['init', '--quiet'], dir);
    // Stage the optional GAIA attachment into the cwd so the bee can read it (the persona/brief point at it).
    const filePath = task.graderMeta?.['filePath'];
    const fileName = String(task.graderMeta?.['fileName'] ?? '').trim();
    if (typeof filePath === 'string' && filePath.length > 0) {
      const destName = fileName || basename(filePath);
      await copyFile(filePath, join(dir, destName)).catch(() => {
        /* a missing/unreadable attachment must not abort the clone — the agent will note it absent */
      });
    }
  } catch (err) {
    await rm(dir).catch(() => {});
    throw err;
  }

  return {
    dir,
    repo: '',
    baseCommit: '',
    cleanup: () => rm(dir).catch(() => {}),
  };
}

/** Injected IO for the answer extraction (a fake readFile in tests). */
export interface GaiaExtractDeps {
  readFile?: (path: string) => Promise<string>;
}

/**
 * Extract the GAIA answer the bee wrote — read `<checkout.dir>/answer.txt`. Returns the trimmed file body
 * (the grader's {@link extractFinalAnswer} pulls a trailing `FINAL ANSWER:` marker if present, else uses the
 * whole string). Returns '' when the file is absent/empty (a no-answer run — graded as unresolved, not an
 * infra error). NEVER throws.
 */
export async function extractGaiaAnswer(checkout: TaskCheckout, deps: GaiaExtractDeps = {}): Promise<string> {
  const readFile = deps.readFile ?? ((p: string) => readFileP(p, 'utf8'));
  const answerPath = join(checkout.dir, GAIA_ANSWER_FILE);
  try {
    const body = await readFile(answerPath);
    const trimmed = body.trim();
    if (process.env.PAPERCUSP_GAIA_DEBUG) {
      console.log(`[gaia-extract] OK ${answerPath} len=${trimmed.length} → ${JSON.stringify(trimmed.slice(0, 80))}`);
    }
    return trimmed;
  } catch (err) {
    // Diagnostic (DEBUG-gated): a miss here is the common "answer.txt not where we looked" failure — log the
    // path we tried + a listing of the checkout dir + any sibling answer.txt under it, so a re-probe pinpoints
    // a cwd/path mismatch (the bee wrote answer.txt to a different dir than checkout.dir) vs a genuine no-answer.
    if (process.env.PAPERCUSP_GAIA_DEBUG && !deps.readFile) {
      try {
        const { readdirSync, existsSync } = await import('node:fs');
        const listing = existsSync(checkout.dir) ? readdirSync(checkout.dir).join(', ') : '(dir gone)';
        console.log(`[gaia-extract] MISS ${answerPath} (${err instanceof Error ? err.message : String(err)}); dir contents: [${listing}]`);
      } catch {
        /* diagnostic only */
      }
    }
    return '';
  }
}
