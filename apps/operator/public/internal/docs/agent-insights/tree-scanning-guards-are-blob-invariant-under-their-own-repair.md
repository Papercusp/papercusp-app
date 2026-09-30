# A tree-scanning guard is blob-invariant under its own repair — why blob containment cannot settle its gate red
URL: /internal/docs/agent-insights/tree-scanning-guards-are-blob-invariant-under-their-own-repair

Blob containment against a frozen candidate is the standard way to tell a current gate red from a stale one — but it is informative only when the failing test's SUBJECT is reachable through that file's import graph. When the subject is the TREE (a scanner) or an ARTIFACT THE TEST SPAWNS (a shell script, a CLI), the repair lands somewhere containment never looks, so blob identity is the EXPECTED state and reads as 'unfixed'. This is what the gate cell renders as `fixInRepairHead: false` / `stillBrokenCount`. Two settlement methods, one per subject shape: feed COMMITTED blobs to a scanner's exported detector (with a mandatory positive control), or pin an external-artifact test's outcome-determining input set and run it once. Also records the staleness caveat that runs BACKWARDS for a scanner walking untracked files.

# A tree-scanning guard is blob-invariant under its own repair

> **The containment RECIPES live in [git-evidence-and-containment-recipes](/internal/docs/agent-insights/git-evidence-and-containment-recipes). This page is about the case where running them correctly still cannot answer the question.**

> **Arriving from the gate cell?** `state:read { cell: 'gate.greenCheckpoint.candidateFailures' }` renders this class as a row with **`fixInRepairHead: false`**, counted into **`stillBrokenCount`** / `stillBrokenNeedsRunCount` under the assessment code `repairs-outstanding`. That field is a blob compare, so for every subject shape described below it is **structurally uninformative — not evidence of unfixed work**. The cell says as much in its own `reading` and `safeAction` (*"needs `testing:run` on that ONE file at repairHead FIRST"*); this page is *why*, and what to run instead. Measured on frozen candidate `247e3140e590`: **every** `false` row on it resolved as already-fixed.

## The mistake this prevents

When the gate is red on a frozen candidate, the standard triage is blob containment: compare the failing file's blob in the judged candidate against the repaired tree. **Different blobs ⇒ the fix landed, the file awaits re-verification. Equal blobs ⇒ the red is current, go repair it.**

That inference is sound for an ordinary test, whose subject is the code it imports. It is **invalid for a guard whose subject is the TREE** — lint guards, ratchets, census/count guards, identity and enrolment scanners. For those, equal blobs is the *expected* state whether or not the defect is fixed, so the check returns a confident reading that carries **zero information**.

The failure it produces is specific and expensive: the file is reported `UNDETERMINED` — *"blob identical to the candidate; I cannot explain the candidate red from content"* — and the repair is either redone or left in doubt through a full \~55-minute suite cycle.

## Why it happens

A tree-scanning guard detects a defect **in the files it walks**, so the repair necessarily lands in a *scanned* file, never in the guard. The guard's blob is therefore invariant under its own repair — by construction, not by accident.

```
ordinary test:   subject ⊂ the file's own import graph  → repair changes what containment measures
tree scanner:    subject = the tree                     → repair changes a file containment never looks at
```

That is the whole mechanism. Once you see it, the `UNDETERMINED` verdict stops looking like a mystery and starts looking like the instrument answering a question you did not ask.

## The tell

Suspect this class whenever **all** of these hold:

* the failing file's blob is identical in the candidate and the repaired tree, **and**
* the test walks the filesystem (`readdirSync`, a glob, `git ls-files`, a `scan(ROOT)` helper) rather than importing a subject, **and**
* the failure message names a path *other than the test's own*.

That third point is the cheapest tell and the most often missed: **the guard is telling you where the repair belongs, and it is not in the guard.**

⚠ The second point is the one that misfires. The walk is frequently **not in the file you are reading** — it lives in a script the test drives, behind a helper. Absence of a `readdir` in the named test file is not evidence; see [the audit that returns a false clean bill](#which-guards-are-untracked-sensitive--the-audit-that-returns-a-false-clean-bill).

## The method — settle it from committed blobs, without touching the tree

Do **not** mutate the tree to prove the point, and do not re-run the suite hoping for a different answer. A tree-scanning guard almost always exports its detector; feed that detector the **committed blobs** on both sides.

```bash
# Extract the SCANNED file (not the guard) at each ref. Check the exit status:
# a failed `git show > file` still leaves a ZERO-BYTE file, and every later count returns 0.
git show "<candidate-sha>:<scanned-path>" > /tmp/before.ts || { echo EXTRACT-FAILED; exit 1; }
git show "HEAD:<scanned-path>"            > /tmp/after.ts  || { echo EXTRACT-FAILED; exit 1; }
[ -s /tmp/before.ts ] && [ -s /tmp/after.ts ] || { echo ZERO-BYTE; exit 1; }
```

Then run the guard's own exported detector over each, and **require a positive control** — a synthetic input you know must trip it. Without the control, a detector that silently matches nothing is indistinguishable from a clean repo, which is the same false-zero family as a `| head` SIGPIPE truncation or a wrong-relation SQL zero-row.

A settled result looks like this:

| input                              | offenders             | what it proves                               |
| ---------------------------------- | --------------------- | -------------------------------------------- |
| candidate blob of the scanned file | 1 (at the named line) | the candidate red **explained from content** |
| `HEAD` blob of the scanned file    | 0                     | the repair is real and committed             |
| synthetic offending input          | ≥1                    | the detector is **not vacuous**              |

Three cheap reads, no mutation, no suite, no lock — and they answer the question blob containment structurally could not.

## The wider class — "tree-scanning" is one shape of a subject outside the import graph

The mechanism above is not really about walking the filesystem. It is about **where the subject sits relative to the file containment measures**. Containment measures the failing test file, and is informative only when the subject is reachable through *that file's* import graph. Any arrangement that puts the subject elsewhere produces the same blob-invariance:

| subject shape                                                                   | the repair lands in      | containment measures    | settle it by                                                |
| ------------------------------------------------------------------------------- | ------------------------ | ----------------------- | ----------------------------------------------------------- |
| ordinary test — subject ⊂ its import graph                                      | an imported module       | a file that changed     | blob containment (still the correct primary method)         |
| tree scanner — subject = the tree                                               | a *scanned* file         | the guard, unchanged    | feed committed blobs to the exported detector (above)       |
| **external-artifact test — subject = something it `spawn`s / `execFileSync`es** | **the spawned artifact** | **the test, unchanged** | **pin the outcome-determining input set, then run it once** |

The third row catches people who have already learned the second, because such a test **looks perfectly ordinary**: no `scan(ROOT)`, no glob, nothing walked. Its subject is a shell script, a generated binary, or a CLI it shells out to, and reading the `import` list will never reveal it. **Grep for the spawn, not for the import.**

### Settling an external-artifact test

There is no exported detector to feed, so the method differs: **enumerate the test's outcome-determining inputs, prove each is blob-identical between `repairHead` and your worktree, then run the test once.** A tip pass then transfers to `repairHead` by construction — every object the outcome can depend on is the same object.

```bash
# 1. Which REPO paths does the test actually touch? A join(tmpRoot, 'packages/a')
#    fixture path is NOT an input; only paths resolving into the checkout are.
grep -nE "bin/|scripts/|apps/|packages/|libs/" <test-file>

# 2. Pin the test AND every repo path from step 1 across all three refs.
for f in <test-file> <each repo path from step 1>; do
  printf '%s\n  repairHead=%s\n  head=%s\n  worktree=%s\n' "$f" \
    "$(git rev-parse "<repairHead>:$f")" "$(git rev-parse "HEAD:$f")" \
    "$(git hash-object "$f")"
done
git status --porcelain -- <the same paths>   # must be EMPTY
```

Step 1 does the real work, and it is where the honesty lives: **if the grep returns paths you cannot account for, the input set is not pinned and the tip run does not transfer.** Say that, rather than rounding up to "green". This does not waive the standard *a pass at tip is not proof the verdict was stale* caveat — it **discharges** it, by pinning rather than by asserting.

## The staleness caveat runs BACKWARDS here

CLAUDE.md warns that a **pass at tip is not proof the verdict was stale**, because `test:file` runs the working tree and a peer's uncommitted fix rides in silently. For an ordinary test that is exactly right.

**For a scanner that walks untracked files by design, it inverts.** A dirty tree can only *add* offenders — extra files are extra opportunities to fail, never fewer. So a clean checkout is **strictly greener** than the dirty tree you measured, and a pass on a dirty tree is *stronger* evidence than a pass on a clean one, not weaker.

Applying the usual caveat here rejects a sound result. Check which direction the contamination actually runs before reaching for it.

⚠ The inversion is licensed by the scanner **actually** walking untracked files — a property that is easy to get wrong in both directions, and whose obvious test is unsound. Establish it with the audit under [The dual](#which-guards-are-untracked-sensitive--the-audit-that-returns-a-false-clean-bill), not by reading the named test file for a `readdir`.

### Bounding a scanner's whole-tree pass to a specific ref

The inversion above licenses the pass but does not by itself transfer it to `repairHead`, because a scanner's verdict is a function of the **whole tree**, not of one file. An offender could exist at `repairHead` and have been removed by `HEAD`. Bound it directly — the only files whose offender status can differ between two refs are the files that **differ** between them:

```bash
# Every candidate-for-difference, checked AT repairHead. Expect zero hits.
while IFS=$'\t' read -r st f; do
  case "$f" in *.ts|*.tsx) ;; *) continue;; esac
  blob=$(git rev-parse "<repairHead>:$f" 2>/dev/null) || continue
  git cat-file blob "$blob" | grep -q '<the detector pattern>' && echo "HIT $st $f"
done < <(git diff --name-status <repairHead> HEAD)
```

Run the identical grep against a blob you **know** offends (the candidate's own named offender) as a positive control — without it, a broken pattern reports zero and is indistinguishable from a clean delta. Files identical between the refs have identical status by definition, so zero hits plus a live control closes it.

## The dual — this property is also a real defect

Be honest about the other edge. The same property that makes the guard blob-invariant also means **its verdict is not a pure function of the judged commit**: a scanner that walks untracked files can red-pin the gate on debris that exists in one checkout and not another. That is a genuine bug in such a guard, not merely an inconvenience for triage.

So the two readings compose rather than compete:

* for **triage**, blob containment is the wrong instrument — use the detector method above;
* for **the guard itself**, a verdict that depends on untracked debris should be repaired so it is a function of the commit.

Do not use the first as a reason to skip the second.

### Which guards are untracked-sensitive — the audit that returns a false clean bill

Repairing that defect presupposes you can tell which guards *have* it. The obvious classification is wrong, and it fails toward a **clean bill** — the direction that closes the investigation:

> `readdirSync` / a glob ⇒ walks untracked files  ·  `git ls-files` ⇒ commit-pure

Both halves leak. **`git ls-files --others` lists exactly the untracked files.** It is fully git-native, matches none of the filesystem tells above, and is maximally untracked-sensitive; "it uses git, not `readdir`" licenses nothing.

Worse, the tell is usually **not in the file you are auditing**. Measured at `HEAD` on this page's own tree-scanner example, `check-unenrolled-mjs-imports`:

| where you look                                                          | what you find                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| the failing test file the gate names                                    | no `readdir`, no glob, **no `ls-files` at all** → clean bill   |
| `scripts/check-no-unenrolled-detached-import.mjs` — the guard it drives | `listFilesIncludingUntracked(ROOT)` at line 238                |
| `scripts/lib/tracked-files.mjs:285` — the helper                        | `['ls-files','-z','--cached','--others','--exclude-standard']` |

Three hops from the file containment measures to the `--others` that creates the sensitivity. This is the **same shape as the external-artifact row above**: the subject sits one hop outside the file you are reading, so *grep for the spawn, not for the import* generalizes to **follow the helper, not the test**.

**Audit by the thing that creates the sensitivity — the `--others` flag and the helper name `listFilesIncludingUntracked` — across the guard's whole call graph, not by `readdir`-vs-git in the named file.** Strip comments before matching (`stripCommentsAndStrings` from `scripts/lib/strip-comments-and-strings.mjs`): that same script carries an explanatory comment naming the helper on line 233, five lines above the real call on 238, so a raw text match classifies on lines that execute nothing — and it does so in **either** direction.

**What caught the misclassification was a positive control that failed.** A guard already known to be untracked-sensitive came back clean from the same pass, which is the only reason the rule was re-examined at all. This page already demands a mandatory control of a *detector*; the lesson here is that the demand applies one level up, to the **audit** — an audit that silently classifies nothing is indistinguishable from a corpus with no offenders.

⚠ Do not carry a remembered caller count for this helper. Counts drift, and the denominators differ by what you include: a naive file-level match at `HEAD` returns 16 (10 non-test, 6 test), most of which are not gate guards. Re-measure, and say which denominator you used.

*(Trap surfaced by su-f27cf391 while auditing this class; the call-graph hops and counts above independently re-measured at `HEAD` before being recorded here.)*

## Worked examples (both measured, same candidate, same day)

### 1 — tree scanner

Frozen candidate `247e3140e590`, file `packages/operator-core/lib/__tests__/check-unenrolled-mjs-imports.test.ts`.

The guard's blob was byte-identical in the candidate and the repaired tree, so containment reported the red as current and the file was flagged `UNDETERMINED`. The repair was never in the guard: it was a `TS7016` suppression in the **scanned** file, `apps/operator/lib/psu-launcher.test.ts:347`.

Feeding committed blobs to the guard's own exported detector: the candidate blob produced **1 offender at line 347** — the candidate red explained from content — and the `HEAD` blob produced **0**. A synthetic bare import still tripped the detector, so it was not vacuous. `scan(ROOT)` returned a raw 1 against an empty BASELINE.

Independently, the whole-tree bound above returned **0 hits** across the `repairHead..HEAD` delta with the positive control returning **4** on the candidate's own offender blob, and the file ran **14 passed / 0 failed**. The evidence cost roughly twenty seconds against a suite measured in tens of minutes.

### 2 — external artifact

Same candidate, file `apps/operator/lib/release/dependency-generation.test.ts`. The cell reported `fixInRepairHead: false` and counted it into `stillBrokenCount`; it walks nothing and imports only `node:*` builtins and `vitest`, so it reads as a perfectly ordinary test whose red must be current.

Its subject is line 29: `join(REPO_ROOT, 'apps/operator/bin/release/dependency-generation.sh')`, which it runs via `execFileSync`. That `.sh` **was** one of the paths admitted onto `repairHead` — so the repair landed exactly where containment does not look. The step-1 grep returned that single repo path; every other path in the file is a `join(tmpRoot, …)` fixture. With the test and the `.sh` both blob-identical at `repairHead == HEAD == worktree` and `git status` empty for both, one run settled it: **48 passed, exit 0**.

Two different subject shapes, two different settlement methods, one shared root cause — and in both cases the "still broken" count was a false positive.

## What this does not cover

This settles whether the red of a test whose **subject sits outside its own import graph** is current. It says nothing about an ordinary test, where blob containment remains the correct primary method. Neither method is a substitute for running the thing — they are what you do when running it on a moving tree cannot produce an *attributable* answer, and the external-artifact method ends in a real run by design.

It also does not tell you the gate is green. Every technique here produces a **per-file** verdict from individually-pinned inputs; the gate's own run on the frozen lineage remains the only thing that turns those into a candidate verdict.
