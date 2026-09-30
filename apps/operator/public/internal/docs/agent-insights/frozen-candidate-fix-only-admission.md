# Frozen candidates advance by fix-only admission — never re-cut at tip or sweep
URL: /internal/docs/agent-insights/frozen-candidate-fix-only-admission

Convention for converging one red release candidate through staging-authored, path-exact repairs and exact judging; prevents tip re-cuts and mixed sweep work from replacing the object under verification.

## The rule

A red candidate becomes a **frozen candidate** once the gate records its exact commit and opens the repair queue. That candidate is the only candidate that may advance until it is green or an explicitly bounded escape retires it.

The queue's identity is two-part:

* `candidate` is the commit that first failed the gate and is immutable for the queue entry.
* `repairHead` is the exact head that fixes move forward from. It starts at `candidate`, and every accepted repair must be a descendant of the previous `repairHead`.

Do not cut a new candidate from the moving tip, cherry-pick a mixed sweep commit, or start a broad sweep while this queue is active. A new tip cut re-admits work that the frozen candidate has not proved and turns one convergence problem back into an unbounded candidate stream.

This is the convergence invariant recorded by `converge-frozen-candidate-by-fix-only-admission-2026-08-27#P-010` (D-001, D-002, D-003, D-004, and D-007), with the staging-only authoring route ratified by D-010 in `frozen-candidate-stays-frozen-through-all-fixes-2026-09-03`.

## Why freezing matters

Selection-based recovery cannot make progress when each red result is replaced by another tip cut: the next candidate includes new, unrelated changes before the repair for the previous candidate can be judged. The gate then compares different objects on every run, and a passing repair may never be the object that gets verified.

Freezing gives the gate one stable object and a monotone sequence of repair heads:

```text
candidate C  --> repairHead C --> repairHead R1 --> repairHead R2 --> green
                  (same queue; forward descendants only)
```

The green-checkpoint suite must judge the exact head named by the queue. Never move `repairHead` while a verification is running (D-004), and stop the loop if a round adds failures instead of shrinking them (D-005).

## The only admission path

1. **Select and persist once.** The gate records `candidate`, `base`, `repairHead`, and the failing tests before dispatching a fixer. A later checkpoint reads that durable queue instead of selecting a fresh tip. The retired repair-worktree lifecycle and `worktreePath` field are not part of the queue or dispatch contract.
2. **Author on staging.** The dispatched release fixer is an ordinary agent in the canonical shared `staging` checkout, exactly like every other agent. It receives the frozen candidate, current `repairHead`, failing-test evidence, and the declared repair manifest. It reproduces the failure, makes the smallest source edit on `staging`, records changed paths and hunks in the edit ledger, and runs focused tests. The shared checkout is the authoring tree; isolated checkouts are never authoring tenants.
3. **Admit by path through plumbing.** Use `release:repair-queue` with `op:'admit'` and the declared paths (`converge` remains an alias). The admission bridge takes hunk-exact content from the edit ledger by default; whole-blob replacement requires an explicit, ledgered reason. It builds a descendant of `repairHead` with only the named source paths, proves the `diff-tree` is within the allowlist, and advances the frozen lineage only after that proof. A staging commit or `git add -A` is not itself an admission.
4. **Verify the exact repair head.** Run the named focused/full verification against that `repairHead` in the gate's `papercusp-checkpoint` judging checkout. Checkouts exist for judging only, never for authoring. The candidate SHA in the run record, logs, and verdict must agree with the queue. If the head changes, the result is inconclusive and must not promote anything.
5. **Promote the proven tree.** After verification passes, the green-checkpoint promotion advances `main` to the proven frozen lineage. Staging absorbs the tested lineage with the ancestry-only `merge -s ours` step owned by the gate/git-sync machinery. If the exact patch is absent or staging diverged, retain the queue and diagnose; do not re-cut at tip to make the mismatch disappear.

The fixer does not move `main` or push. Git-sync owns staging commits and pushes; the green-checkpoint owns judged-lineage promotion. This separation keeps authoring, exact admission, and verification observable as distinct steps.

## What a repair agent should do

A cold or resumed fixer receiving `frozenCandidate`, `repairHead`, the failing-test evidence, and a repair manifest should:

* treat the frozen candidate, current `repairHead`, and manifest as the authoritative scope;
* work in canonical staging, not a retired repair worktree or isolated authoring checkout;
* read the newest gate log, reproduce every named failure, and classify regression versus flake before changing code;
* keep edits narrow, record the exact changed paths and hunks in the edit ledger, and run focused tests;
* leave commits and pushes to git-sync and the gate machinery; and
* exit after focused verification so the serialized checkpoint can admit the declared edits and run the one authoritative full verdict.

If the dispatch context is missing its repair manifest, the staging checkout cannot reproduce the named candidate, or the requested edit would require an undeclared path, stop with an explicit diagnosis. Do not silently fall back to a tip cut, an isolated authoring tree, or an unrelated candidate.

## Exhaustion and the bounded exception

The default queue limits are fail-closed: attempts or wall-clock exhaustion holds the same candidate, with no automatic tip cut. This preserves the invariant even when automation is unhealthy.

The code has an explicit, owner-ratified escape hatch, `maxCandidateEscapes`. It is **zero by default**. A nonzero value permits only that many recorded `recut-at-tip` escapes after exhaustion; each escape must be observable, bounded, and treated as retirement of the exhausted queue, not as ordinary convergence. Raising the bound is a Phase-2 policy change, not a fixer shortcut.

## Checklist before declaring progress

* [ ] The queue's `candidate` and current `repairHead` are read from durable metadata.
* [ ] The fixer authored on canonical staging and recorded an exact repair manifest/edit ledger.
* [ ] Admission is hunk/path-exact, has no undeclared paths, and produces a descendant of the prior `repairHead`.
* [ ] The gate's isolated `papercusp-checkpoint` judging checkout verified that exact `repairHead`.
* [ ] Staging contains the verified repair and the green-checkpoint promotion is the only path to `main`.
* [ ] A non-shrinking round, staging mismatch, moving head, undeclared path, or exhausted budget is held and diagnosed rather than hidden by a new candidate.

The sources of truth are `frozen-candidate-repair-queue.ts` for queue policy, `repair-head-admission.ts` for path-exact lineage admission, `green-checkpoint.ts` for serialization and judging, `release-actions.ts` for fixer dispatch, and `run-git-sync.ts` for the staging commit and contained-ancestry bridge.
