# Acceptance grading runbook — green-checkpoint stops judging a moving target
URL: /internal/docs/agent-insights/gate-stop-chasing-the-tip-acceptance-grading-runbook

Grading procedure for the acceptance rubric of plan gate-stop-chasing-the-tip-2026-08-19: how to produce evidence for each of the seven criteria, what the plan deliberately did not promise, and the traps that make a wrong grade look right.

# Acceptance grading runbook: green-checkpoint stops judging a moving target

This is the method for rubric `acceptance-gate-stop-chasing-the-tip-2026-08-19`
(plan `gate-stop-chasing-the-tip-2026-08-19`). Read the rubric from the store before
grading; this page supplies only what the store cannot hold — how to produce the
evidence, and the traps that make a wrong grade look right.

## Before you grade anything

**You must not be an implementer of what you grade.** The rubric author implemented
P-011 and Decisions D-009/D-010. If that is also you, stop and route the grade elsewhere.

**Spot-check the audit first.** The completion audit is seq 2 at tree sha
`1880c066b79e65767b59527983a8d3fb5cd3919f`: 23 citations checked, 11/11 items covered,
7 verified by code/test, 4 recorded `not-code`. Pick at least three verifying citations
and confirm they resolve and still say what the audit claims. A criterion graded PASS on
an audit you never opened is not an independent grade.

## What is NOT being graded

Three things are outside this plan's promise. Grading them is a false FAIL:

1. **A permanently green gate.** Future code regressions may legitimately redden a
   candidate. The promise is that one red stops becoming an opaque freeze.
2. **Reuse across DIFFERENT agent sessions.** Undemonstrated on purpose; tracked on WI-595883.
3. **The unstable-closure-hash hypothesis.** Still UNOBSERVED. It has only ever been
   produced by a deliberately planted control. Do not record it as confirmed, and do not
   fail a criterion for its absence.

## Per-criterion method

### 1. frozen-candidate-fixed-forward

Source: `packages/operator-core/lib/release/frozen-candidate-repair-queue.ts`,
`apps/operator/lib/release/green-checkpoint.ts`.
The question is not "is there a queue" but "can the judged SHA move underneath a repair".
Trace the candidate from queue creation to promotion and look for any path that re-resolves
HEAD instead of reusing the persisted SHA. Promotion carrying a SHA other than the one
tested is an outright FAIL.

### 2. verdict-names-one-tree

Source: `packages/operator-core/lib/git-pipeline-stats.ts`, verdict-detail construction in
`green-checkpoint.ts`. Grade the payload a reader receives. The original defect
(EI-20804540039165334) was one output asserting "real break" and "stale-candidate, N files
PASS at tip" simultaneously. Ask whether that combination is still *constructible*, not
whether a distinct constant exists.

### 3. shared-machine-readable-triage

Source: `packages/operator-core/lib/testing-run-store.ts` (persistRunSnapshot),
`packages/operator-core/test/reporters/admin-test-runs-reporter.ts`,
`packages/operator-core/lib/release/checkpoint-log-tags.ts`.
The outcome is that a SECOND agent can get per-file outcomes without parsing stdout.
Test it directly: query `testing:runs` for a recent gate run and see whether per-file rows
come back. Also confirm fixture narration lines are distinguishable from real ones — the
log-trust problem is why triage was not shareable.

### 4. proof-identity-preserved-across-repair

Source: the `affectedTestProofGroup` threading in the repair queue.
Grade the **fail-closed direction**. A missing, blank, or legacy-schema proof group must
force the full-run miss path. Read the v1/v2 record parse path specifically: that is where
a legacy record could fall through to reuse.

### 5. cross-run-reuse-is-conservative-and-loud

This criterion is deliberately not satisfiable by reading the diff.

* **(a) Effectiveness** needs an observed two-run measurement on the shared DEFAULT cache
  path — no pins, no `AFFECTED_TASK_VERDICT_CACHE_PATH` override. The second pass must
  report a cross-run identity match and spawn ZERO tasks. Absence of this evidence is a
  FAIL, not an unknown: a cache that can never hit looks exactly like a healthy cache with
  nothing to reuse. That indistinguishability is the whole reason this clause exists.
* **(b) Conservatism**, **(c) derived exclusions** and **(d) loudness** are source reads of
  `scripts/lib/passing-task-verdict-cache.mjs` and `scripts/affected-tests.mjs`.
  For (c), the pc-heavy exclusion set must be DERIVED from `scripts/pc-heavy.sh`, not
  hand-listed — a hand-list is the regression Decision D-009 exists to prevent.

### 6. every-miss-names-what-moved

The failure mode is an instrument that passes its unit tests while being inert end to end.
Require evidence of the emission observed against **planted** drift, naming the planted path
or environment key. Unit tests alone are a FAIL for this criterion. Confirm three cases stay
distinct: membership changed, contents changed, and nothing changed but the hash did.

### 7. recurrence-guards-are-falsifiable

Coverage breadth is the easy half. The graded half is falsifiability: find a permanently
present wrong-implementation control, or a documented mutation-probe run, showing the guards
can fail. Broad coverage with no falsifiability evidence is a FAIL.

⚠ If you run a mutation probe yourself, use `scripts/mutation-probe.sh` — never a
hand-rolled copy/mutate/restore, which this repo's git-sync sweep can commit.

## Recording the grade

`scorecards:emit { rubricRef:'acceptance-gate-stop-chasing-the-tip-2026-08-19', ratings:{ <every criterion key>: { rating, evidence } } }`

Every criterion needs concrete evidence — a path, a command output, a queried row. Evidence
that restates the criterion is not evidence. `unknown` is a legitimate rating and is far
better than a guessed PASS; say what you could not determine and why.
