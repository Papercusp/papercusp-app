/**
 * `runChangeLedgerScan` — the SHARED change-ledger repo-scan orchestration
 * (flag → git-log scan), the single source of truth both the
 * `system:change-ledger-scan` routine action AND the `change-ledger:scan`
 * deterministic blueprint step (deterministic-blueprints-migration-2026-06-13
 * P-004 / bucket A) run. Extracting it is what makes the migration provably
 * behavior-neutral (D-004): the blueprint path and the routine path call the
 * SAME flag and the SAME git-log scan.
 *
 * Gate (unchanged from change-ledger-scan-action.ts):
 *   - the `papercusp-change-ledger` flag (default ON — the kill-switch). This
 *     is a pure-bookkeeping recorder, NOT a dark frontier loop, so there is NO
 *     learning-governor gate (no LLM, no queue filing, idempotent via the
 *     ledger dedupe index). OFF ⇒ `{ ran: false, skipReason: 'flag-off' }`.
 * Past the flag the scan runs (and MAY throw — the caller owns the durable
 * never-throw wrapper; a crash-replay is free because re-offered (sha, file)
 * pairs dedupe, so no watermark state exists).
 *
 * Deps are injectable PARAMETERS (not module-level setters) so the two callers
 * each pass their own seams — the op keeps its own setter, and there is still
 * ONE orchestration. Mirrors `lib/negative-space/mine.ts`.
 */
import { execFile as execFileCb } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleRepoRoot } from '../module-repo-root';
import { promisify } from 'node:util';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { recordBehaviorChange, type RecordBehaviorChangeInput } from './change-ledger';
import { PROMPT_SCAN_GIT_ARGS, scanRepoPromptEdits } from './prompt-file-scan';

// packages/operator-core/lib/change-ledger → repo root. ESM-safe: bare
// `__dirname` is UNDEFINED under tsx file-mode in this type:module package — a
// top-level reference here threw at import, poisoned the register-system-actions
// chain, and killed DBOS routines fleet-wide on the 2026-06-12 05:30 deploy.
// Never use __dirname in operator-core.
const REPO_ROOT = moduleRepoRoot(import.meta.url); // bundle-safe, unlike a fixed climb (P-016)

/** The live git-log scan against THIS process's repo tree (the serving tree). */
async function defaultRunGitLog(paths: readonly string[], sinceDays: number): Promise<string> {
  // Promisify LAZILY (not at module top level): a partial `node:child_process`
  // mock — several tests mock only `spawn` (e.g. release-actions.test.ts) — leaves
  // `execFile` undefined, and a top-level `promisify(undefined)` would THROW at
  // import, poisoning every test whose graph includes this module (the same
  // import-poisoning class as the __dirname note above). Doing it here keeps the
  // import inert under any mock; it only runs on the real default-deps path.
  const execFile = promisify(execFileCb);
  const { stdout } = await execFile('git', PROMPT_SCAN_GIT_ARGS(paths, sinceDays), {
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export interface ChangeLedgerScanDeps {
  /** Flag check (default: the live `papercusp-change-ledger` getFlag — default ON). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** git-log runner (default: execFile against the serving repo tree). */
  runGitLog?: (paths: readonly string[], sinceDays: number) => Promise<string>;
  /** recordBehaviorChange (default: the live PG-backed writer). */
  record?: (input: RecordBehaviorChangeInput) => Promise<string | null>;
}

export interface ChangeLedgerScanOutcome {
  /** True iff the scan actually ran (the flag passed). */
  ran: boolean;
  /** Why it did NOT run, when `ran` is false. */
  skipReason?: 'flag-off';
  /** (commit, file) pairs the window yielded (present iff `ran`). */
  edits?: number;
  /** New ledger rows inserted, rest deduped (present iff `ran`). */
  recorded?: number;
}

/**
 * Run one change-ledger repo-scan behind the flag gate. Does NOT swallow a scan
 * error (the caller's durable-step wrapper does); the flag check is non-throwing.
 */
export async function runChangeLedgerScan(
  input: { workspaceId: string; installSlug: string; payload?: Record<string, unknown> | null },
  deps: ChangeLedgerScanDeps = {},
): Promise<ChangeLedgerScanOutcome> {
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.CHANGE_LEDGER, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const sinceDays = Number(input.payload?.sinceDays) || 14;
  const result = await scanRepoPromptEdits(
    {
      workspaceId: input.workspaceId,
      record: deps.record ?? recordBehaviorChange,
      runGitLog: deps.runGitLog ?? defaultRunGitLog,
    },
    { sinceDays },
  );
  return { ran: true, edits: result.edits, recorded: result.recorded };
}
