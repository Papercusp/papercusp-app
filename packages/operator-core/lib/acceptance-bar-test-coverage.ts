/**
 * R-7 of generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 (P-007).
 *
 * R-7, verbatim: "Every acceptance-routing behavior pinned by this plan's bar set is
 * covered by at least one committed test in the repository's own test framework that
 * fails when that behavior is reverted."
 *
 * Note what that sentence does NOT say. It does not say a test EXISTS per bar; a test
 * that passes whether or not the behavior is present is not coverage, it is decoration.
 * The load-bearing clause is "fails when that behavior is reverted" — a claim about a
 * counterfactual, which no amount of reading the test can settle. So this module keeps
 * the MEASURED falsifiability verdict beside each mapping, and `validateBarTestCoverage`
 * treats a bar whose probe did not CATCH its mutant as uncovered, exactly as if no test
 * existed at all. An unprobed mapping is a claim; a caught mutant is evidence.
 *
 * Why a map rather than a naming convention: the bars and their tests do not correspond
 * one-to-one (R-5 is pinned by two tests across two subjects; one test file pins both
 * R-5 and R-6), so any convention that recovers the relation from filenames would have
 * to encode that fan-out in the names. The relation is data; it is stored as data.
 *
 * Reuse note: this is deliberately NOT a second acceptance-bar registry. The sibling
 * `acceptance-bar-*` modules answer "what bars does this plan HAVE and are they met";
 * this one answers the strictly different "is each bar's pinned behavior guarded by a
 * test that can actually fail". No existing surface carried the test↔bar relation or a
 * falsifiability verdict, which is why this adds one field-set rather than a mechanism.
 */

/** Verdict from `scripts/mutation-probe.sh` for a bar's named test. */
export type BarProbeVerdict = 'caught' | 'survived' | 'not-probed';

/** Which falsifiability tier produced the verdict (CLAUDE.md § "Proving a guard is falsifiable"). */
export type BarProbeTier = 'copy-out' | 'in-tree' | 'historical' | 'paired-control';

export interface BarTestCoverageEntry {
  /** Bar key as it appears in the plan's rubric, e.g. `R-4`. */
  readonly barKey: string;
  /** The plan spec id this entry covers, e.g. `AUTO-BAR-R-4-P-004`. */
  readonly specId: string;
  /** The plan item the spec hangs off, e.g. `P-004`. */
  readonly planItemId: string;
  /** Repo-relative path of the committed test that pins the behavior. */
  readonly testPath: string;
  /** Repo-relative path of the production subject whose reversion the test must catch. */
  readonly subjectPath: string;
  /** The exact reversion applied to `subjectPath` when the verdict was measured. */
  readonly mutation: string;
  readonly probeTier: BarProbeTier;
  readonly probeVerdict: BarProbeVerdict;
}

export interface BarTestCoverageInput {
  /** Every bar key the plan's bar set requires coverage for. */
  readonly requiredBarKeys: readonly string[];
  readonly entries: readonly BarTestCoverageEntry[];
  /** Does the test file exist on disk? */
  readonly fileExists: (path: string) => boolean;
  /** Is the test file tracked by git — i.e. COMMITTED, not merely present? */
  readonly isTracked: (path: string) => boolean;
}

export interface BarTestCoverageReport {
  readonly ok: boolean;
  /** Required bars with no mapping at all. */
  readonly barsWithoutEntry: string[];
  /** Bars that have a mapping, but no mapping whose mutant was CAUGHT. */
  readonly unfalsifiedBars: string[];
  /** Mapped test paths absent from disk. */
  readonly missingTestFiles: string[];
  /** Mapped test paths present but untracked — present for me, absent for everyone else. */
  readonly untrackedTestFiles: string[];
  /** Bars with at least one existing, tracked, mutant-catching test. */
  readonly coveredBars: string[];
}

/**
 * Pure, dependency-injected so the guard test can drive it with deliberately-wrong
 * maps (its permanent controls) as well as the real one. Keeping the fs/git reads
 * behind `fileExists`/`isTracked` is what makes those controls possible at all.
 */
export function validateBarTestCoverage(input: BarTestCoverageInput): BarTestCoverageReport {
  const byBar = new Map<string, BarTestCoverageEntry[]>();
  for (const entry of input.entries) {
    const list = byBar.get(entry.barKey);
    if (list) list.push(entry);
    else byBar.set(entry.barKey, [entry]);
  }

  const barsWithoutEntry: string[] = [];
  const unfalsifiedBars: string[] = [];
  const coveredBars: string[] = [];

  for (const barKey of input.requiredBarKeys) {
    const entries = byBar.get(barKey) ?? [];
    if (entries.length === 0) {
      barsWithoutEntry.push(barKey);
      continue;
    }
    // A bar is covered by an entry only if that entry is simultaneously: present on
    // disk, tracked, and measured to FAIL on reversion. Splitting these into separate
    // top-level lists would let a bar count as covered on the strength of one entry's
    // existence and a DIFFERENT entry's probe verdict.
    const covering = entries.filter(
      (entry) =>
        entry.probeVerdict === 'caught' &&
        input.fileExists(entry.testPath) &&
        input.isTracked(entry.testPath),
    );
    if (covering.length === 0) {
      unfalsifiedBars.push(barKey);
      continue;
    }
    coveredBars.push(barKey);
  }

  const missingTestFiles: string[] = [];
  const untrackedTestFiles: string[] = [];
  for (const entry of input.entries) {
    if (!input.fileExists(entry.testPath)) {
      missingTestFiles.push(entry.testPath);
      continue;
    }
    if (!input.isTracked(entry.testPath)) untrackedTestFiles.push(entry.testPath);
  }

  return {
    ok:
      barsWithoutEntry.length === 0 &&
      unfalsifiedBars.length === 0 &&
      missingTestFiles.length === 0 &&
      untrackedTestFiles.length === 0,
    barsWithoutEntry,
    unfalsifiedBars,
    missingTestFiles,
    untrackedTestFiles,
    coveredBars,
  };
}

/**
 * The bar-set revision `REQUIRED_BAR_KEYS` and the mapping below were derived from
 * (`sourceBar.barSetHash` on this plan's specs). Recorded so the copy is PINNED rather
 * than hand-maintained: if the rubric is re-cut, this hash stops matching and the guard
 * fails loudly instead of quietly certifying a bar set that no longer exists.
 */
export const ACCEPTANCE_BAR_SET_HASH =
  '9428e795bc141211363f822e86c6f621c8ec4fdb844c4f1eac46ca37213b123b';

/** Every bar in the plan's set. R-7's falsifier is BAR-scoped ("a bar ... has no committed test"). */
export const REQUIRED_BAR_KEYS: readonly string[] = ['R-1', 'R-2', 'R-3', 'R-4', 'R-5', 'R-6', 'R-7'];

/**
 * MEASURED, not asserted. Every `probeVerdict: 'caught'` below was produced by an actual
 * `scripts/mutation-probe.sh` run on 2026-09-22 against the committed tree: the recorded
 * `mutation` was applied to `subjectPath`, the named test was run, and it FAILED. Each
 * probe also printed `tree integrity: VERIFIED — byte-identical to its pre-probe state`,
 * and the six subjects were confirmed clean via `git status --porcelain` afterwards.
 *
 * TIER — every entry is `in-tree`, which is this repo's LAST-RESORT tier, chosen because
 * copy-out is inapplicable rather than inconvenient: copy-out proves falsifiability by
 * pointing the test at `{}`, a mutated COPY, and every subject here is a TypeScript module
 * its test resolves by STATIC import, so `{}` can never reach it. The sweep race was
 * mitigated the documented way — a `locks:acquire` file lock was held on all six subjects
 * for the whole run, and git-sync excludes actively file-locked paths from its pathspecs.
 *
 * SCOPE, stated honestly: bars R-1 and R-2 each also carry a P-001 spec whose subject is
 * the AUDIT ARTIFACT (that the audit cites a resolvable seam), not runtime behavior. There
 * is nothing in code to revert for those, so they are verified by `plans:audit` citation
 * resolution rather than by a mutation-probed test. The entries below therefore map each
 * bar via the spec whose behavior IS executable — which is exactly the granularity R-7's
 * own falsifier uses.
 */
export const ACCEPTANCE_BAR_TEST_COVERAGE: readonly BarTestCoverageEntry[] = [
  {
    barKey: 'R-1',
    specId: 'AUTO-BAR-R-1-P-002',
    planItemId: 'P-002',
    testPath: 'packages/operator-core/lib/agent-obligation-providers.test.ts',
    subjectPath: 'packages/operator-core/lib/agent-obligation-providers.ts',
    mutation: "s/acceptance_ungraded: 'grader',/acceptance_ungraded: 'not-here',/",
    probeTier: 'in-tree',
    probeVerdict: 'caught',
  },
  {
    barKey: 'R-2',
    specId: 'AUTO-BAR-R-2-P-003',
    planItemId: 'P-003',
    testPath: 'packages/operator-core/lib/acceptance-grading-authority.rubric-authority.test.ts',
    subjectPath: 'packages/operator-core/lib/acceptance-grading-authority.ts',
    mutation: "s/return input\\.authority === 'owner-authorized' && input\\.isOwnerFiled;/return true;/",
    probeTier: 'in-tree',
    probeVerdict: 'caught',
  },
  {
    barKey: 'R-3',
    specId: 'AUTO-BAR-R-3-P-003',
    planItemId: 'P-003',
    testPath: 'packages/operator-core/lib/acceptance-grader-pickup.test.ts',
    subjectPath: 'packages/operator-core/lib/acceptance-grader-pickup.ts',
    mutation: 's/if \\(sinceWakeMs > 0\\) \\{/if (true) {/',
    probeTier: 'in-tree',
    probeVerdict: 'caught',
  },
  {
    barKey: 'R-4',
    specId: 'AUTO-BAR-R-4-P-004',
    planItemId: 'P-004',
    testPath: 'packages/operator-core/lib/plan-acceptance-state-machine-r4-guard.test.ts',
    subjectPath: 'packages/operator-core/lib/agent-tools/plans/set-plan-status.ts',
    mutation:
      "s/return status === 'shipped' && expectedCurrent !== 'shipped';/return status === 'shipped';/",
    probeTier: 'in-tree',
    probeVerdict: 'caught',
  },
  {
    barKey: 'R-5',
    specId: 'AUTO-BAR-R-5-P-005',
    planItemId: 'P-005',
    testPath: 'packages/operator-core/lib/delegation-counts.test.ts',
    subjectPath: 'packages/operator-core/lib/delegation-counts.ts',
    mutation: 's/deps\\.plansAwaitingDelegation\\(ctx\\)/deps.planExecutionAgents(ctx)/',
    probeTier: 'in-tree',
    probeVerdict: 'caught',
  },
  {
    barKey: 'R-5',
    specId: 'AUTO-BAR-R-5-P-006',
    planItemId: 'P-006',
    testPath: 'packages/operator-core/lib/agent-tools/plans/__tests__/delegation-posture-brief.test.ts',
    subjectPath: 'packages/operator-core/lib/agent-tools/plans/context-bundle.ts',
    // Bakes every rendered count to a literal — precisely the "constant baked into the
    // prompt source" that R-5 forbids.
    mutation: 's/\\$\\{renderDelegationCount\\(counts\\[key\\]\\)\\}/0/',
    probeTier: 'in-tree',
    probeVerdict: 'caught',
  },
  {
    barKey: 'R-6',
    specId: 'AUTO-BAR-R-6-P-006',
    planItemId: 'P-006',
    testPath: 'packages/operator-core/lib/agent-tools/plans/__tests__/delegation-posture-brief.test.ts',
    subjectPath: 'packages/operator-core/lib/agent-tools/plans/context-bundle.ts',
    mutation: 's/REPORT IDLE/LAUNCH AGENT/g',
    probeTier: 'in-tree',
    probeVerdict: 'caught',
  },
  {
    barKey: 'R-7',
    specId: 'AUTO-BAR-R-7-P-007',
    planItemId: 'P-007',
    testPath: 'packages/operator-core/lib/acceptance-bar-test-coverage.test.ts',
    subjectPath: 'packages/operator-core/lib/acceptance-bar-test-coverage.ts',
    // Reverting R-7 means dropping a bar's coverage from the map; the guard must notice.
    // ⚠ SELF-MATCH, recorded because it is surprising rather than because it harmed the
    // verdict: R-7's subject is this very file, so the literal below appears BOTH in the
    // R-6 entry and in this `mutation` string. The probe therefore rewrote two lines, not
    // one. The verdict is unaffected — the guard failed with `barsWithoutEntry: ['R-6']`,
    // i.e. for exactly the intended reason — but this is the static-fixture form of the
    // `pgrep -f` self-match trap, and anyone re-running or re-ordering this probe should
    // expect it. A subject that IS the fixture cannot be pattern-matched naively.
    mutation: "s/barKey: 'R-6',/barKey: 'R-6-DROPPED',/",
    probeTier: 'in-tree',
    probeVerdict: 'caught',
  },
];
