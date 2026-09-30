/**
 * P-002 (plan `design-to-code-coverage-seam-2026-09-02`), governed by D-017.
 *
 * Decide whether a completion's declared test evidence is CONTRADICTED by the test-run
 * ledger — i.e. the closing agent's own most recent `testing:run` actually went red.
 *
 * ## The defect this closes
 *
 * `insufficientEvidenceReason` accepts ANY non-empty `testsRun`/`testResult` string. The
 * literal string `"3 failed"` therefore earns `committed` today: the gate reads that a
 * test field is PRESENT, never that it says anything true. `testResult` is prose, and
 * prose cannot be falsified — which is exactly what makes the resulting authority grade
 * uninformative at scale.
 *
 * `test_runs` already carries the falsifier. Every `testing:run` stamps
 * `PAPERCUSP_TEST_RUN_GROUP=<runId>` into the child environment, and the vitest reporter
 * writes one row per test file carrying that `run_group_id` plus a real `status`
 * (`pass`/`fail`/`skip`/`cancelled`/`error`/`running`). So a ledgered verdict for the
 * agent's own run already exists; nothing here adds plumbing to carry it.
 *
 * ## Why attribution is the hard part, and how it is solved
 *
 * Neither `test_runs` nor `testing_run_snapshots` records WHICH AGENT ran the suite —
 * there is no owner column on either. On a shared tree where ~100 agents commit and test
 * concurrently, "the most recent row for this file path" is therefore NOT this agent's
 * result, and grading on it would manufacture confident false accusations against agents
 * whose own run was green. That is the D-016 failure mode one table over.
 *
 * The join that does hold: `tool_invocations` records `coord_owner_id`, `tool_name`,
 * `invoked_at`, `duration_ms` and `args_json.files` for every `testing:run` call. A run by
 * agent X at time T lasting D produces ledger rows for exactly those files, sharing ONE
 * `run_group_id`, finishing inside `[T, T+D]`. Selecting on (declared files) × (that
 * window) recovers the group — and the group id, being shared, is its own consistency
 * check.
 *
 * ## Biased toward generosity, deliberately — every ambiguity is silence
 *
 * A false contradiction lowers an honest agent's grade and teaches the fleet the signal is
 * noise; a false clean verdict merely leaves today's behaviour in place. The two errors are
 * not symmetric, so:
 *
 *   - only the agent's MOST RECENT run is judged. Running red, fixing, and re-running green
 *     is the normal shape of good work and must never be punished by an earlier red.
 *   - if the window resolves to MORE THAN ONE distinct run group, nothing is judged. That
 *     is the concurrent-peer case, and refusing it is what makes misattribution structurally
 *     impossible rather than merely unlikely.
 *   - only `fail` and `error` count. `skip`, `cancelled` and `running` are not verdicts
 *     against the work, so they are silent.
 *   - no invocation, no rows, a null group, a stale run, or ANY throw is `undefined` —
 *     "not judged", never "judged clean".
 *
 * PURE via injected probes, so every branch above is unit-testable with no database.
 */
import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

/**
 * How far back a `testing:run` may sit and still be treated as the run this close is
 * describing. A run older than this is not evidence about the work being closed now, so it
 * is not judged — silence, not a downgrade.
 */
export const MAX_TEST_BINDING_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * Slack added to the end of the invocation window before matching ledger rows.
 *
 * `duration_ms` is measured around the tool call, while the reporter's row is written by
 * the child process as it exits; the row can therefore land fractionally after the call
 * returns. Too small a slack silently loses the last file's row (reading as "no rows" —
 * silence, so it fails safe but blind); too large starts admitting a peer's later run into
 * the window, which the single-group rule below then refuses outright.
 */
export const TEST_BINDING_WINDOW_SLACK_MS = 30_000;

/** One `harness_shared.test_runs` row, reduced to the three columns this decision reads. */
export interface TestRunLedgerRow {
  filePath: string;
  /** `pass` | `fail` | `skip` | `cancelled` | `error` | `running` (table CHECK constraint). */
  status: string;
  runGroupId: string | null;
}

/** One `testing:run` call by the closing agent, from `harness_shared.tool_invocations`. */
export interface TestingRunInvocation {
  invokedAt: Date;
  /** Null when the invocation never recorded a duration; the window then uses slack alone. */
  durationMs: number | null;
  /** `args_json.files` — the exact paths that run executed. */
  files: readonly string[];
}

export interface TestResultBindingProbe {
  /**
   * The closing agent's most recent `testing:run` invocation, or `undefined` when it
   * cannot be determined. `null` means "looked, found none" — both are silence here, but
   * the distinction is kept so a caller can log them apart.
   */
  latestTestingRun: () => Promise<TestingRunInvocation | null | undefined>;
  /** Ledger rows for `paths` whose `finished_at` falls inside `[from, to]`. */
  ledgerRowsInWindow: (
    paths: readonly string[],
    from: Date,
    to: Date,
  ) => Promise<readonly TestRunLedgerRow[] | undefined>;
  /** Injectable clock, so staleness is testable without waiting six hours. */
  now?: () => Date;
}

export interface TestResultContradiction {
  /** The ledgered run this verdict is bound to — cite it, never a bare assertion. */
  runGroupId: string;
  /** Test files that came back `fail`/`error` in that run. */
  failingFiles: readonly string[];
  /** How many files the run reported at all, so the failing count reads in proportion. */
  filesInRun: number;
}

/** Statuses that are a verdict AGAINST the work. Everything else is deliberately silent. */
const FAILING_STATUSES: ReadonlySet<string> = new Set(['fail', 'error']);

/**
 * Resolve the closing agent's most recent `testing:run` to a ledgered verdict, returning a
 * contradiction ONLY when that run demonstrably went red.
 *
 * Returning `undefined` always means "not judged" and must be handed to
 * {@link import('../../work-item-completion-authority').insufficientEvidenceReason} as an
 * absent field, which preserves today's grade exactly.
 */
export async function testResultContradictedByRun(
  evidence: CompletionVerificationEvidence | null | undefined,
  probe: TestResultBindingProbe,
): Promise<TestResultContradiction | undefined> {
  // Nothing was claimed about tests, so there is nothing to contradict. The missing-field
  // gate (`no-test-run-or-result`) already owns that case and reports a better remedy.
  if (!evidence?.testsRun?.trim() && !evidence?.testResult?.trim()) return undefined;

  try {
    const run = await probe.latestTestingRun();
    if (!run) return undefined;

    const files = (run.files ?? []).map((f) => f?.trim()).filter((f): f is string => !!f);
    if (files.length === 0) return undefined;

    const invokedAt = run.invokedAt;
    if (!(invokedAt instanceof Date) || Number.isNaN(invokedAt.getTime())) return undefined;

    // A run older than the lookback is not evidence about work being closed now.
    const now = probe.now?.() ?? new Date();
    if (now.getTime() - invokedAt.getTime() > MAX_TEST_BINDING_LOOKBACK_MS) return undefined;

    const durationMs = typeof run.durationMs === 'number' && run.durationMs >= 0 ? run.durationMs : 0;
    const windowEnd = new Date(invokedAt.getTime() + durationMs + TEST_BINDING_WINDOW_SLACK_MS);

    const rows = await probe.ledgerRowsInWindow(files, invokedAt, windowEnd);
    if (!rows || rows.length === 0) return undefined;

    // The single-group rule. Two distinct groups in the window means a peer ran one of
    // these files concurrently, and there is no column that says which group is ours — so
    // refuse to judge rather than guess. A null group id is a legacy/unstamped row and is
    // equally unattributable, so its presence also stops the judgement.
    const groups = new Set(rows.map((r) => r.runGroupId));
    if (groups.size !== 1) return undefined;
    const runGroupId = [...groups][0];
    if (!runGroupId) return undefined;

    const failingFiles = rows
      .filter((r) => FAILING_STATUSES.has(String(r.status ?? '').toLowerCase()))
      .map((r) => r.filePath)
      .filter((p): p is string => !!p);
    if (failingFiles.length === 0) return undefined;

    return {
      runGroupId,
      failingFiles: [...new Set(failingFiles)].sort(),
      filesInRun: rows.length,
    };
  } catch {
    // Any probe failure is "cannot judge". Never a downgrade.
    return undefined;
  }
}
