# An umbrella report is not one claim: probe its members, never its title
URL: /internal/docs/agent-insights/umbrella-reports-probe-the-members-not-the-title

A daily-digest umbrella bundles several reports under one synthesized title, and its members can have DIFFERENT truth values. Measured 2026-08-31: a 3-member umbrella had 2 members already fixed and 1 live — and the umbrella's title pointed at a fourth surface that was spotless, so a single probe would have closed the whole thing as refuted and buried the real defect. Why the survivor was PROSE rather than code, and why the direction a wrong answer fails in is its real severity.

## The trap, in one line

A daily-digest umbrella has a **synthesized title** and a **member list**. The title is a
paraphrase written by the aggregator; only the member ids say which code is actually accused. Probe
the title and you will probe the wrong surface — and the wrong surface is very often the one that
was fixed first, precisely because it was the most visible.

## The measurement (2026-08-31, EI-21949926443044423)

The umbrella read *"Submodule changes are invisible to superproject-only gate and ownership
probes."* Three members. Reproduced against the build each was filed on:

| member               | subject                                    | verdict           |
| -------------------- | ------------------------------------------ | ----------------- |
| EI-19367242336402442 | green-checkpoint skew detector             | **already fixed** |
| EI-19399543783045007 | `git-ops.ts` has no `--recurse-submodules` | **already fixed** |
| EI-19468589610261889 | `tsc-red-sweep` ownership prescription     | **REAL, live**    |

The title's phrase "gate probes" leads straight to `dev:pipeline_position`, which is **not any of
the three** — and which handles submodules beautifully: a submodule path resolves inside the
submodule, and `changeInCandidate.judgingContainsPath` returns `null` rather than a false `false`,
with a typed `verdictUnknown` naming the gitlink. It declines to answer rather than answering
wrongly.

That probe alone would have closed the umbrella as refuted, with strong-looking evidence, and
buried a live defect. **Reading `payload.dailyDigest.memberIds` first is what prevented it.**

## Why the survivor survived: it was prose, not code

Both fixed members are **code** — `git-pipeline-position.ts`, `git-ops.ts`. The live one was a
**string**: `buildRedCapture` emitting the git commands an agent should run before claiming a
standing tsc red.

```
git status --porcelain | grep <file>   # dirty => someone is editing it RIGHT NOW
git log -1 --format=%cI -- <file>      # minutes old => author still has context
```

No compiler, test, or gate ever type-checked that advice. So while the rest of the codebase learned
that both probes are false-empty across a gitlink, this kept prescribing them — for years of
filings.

> Guidance that names a command is **code-describing metadata** and drifts exactly like a
> hand-maintained path list or an `exists` boolean (see the derived-truth ladder). It just drifts
> invisibly, because nothing compiles a docstring.

## The direction of a wrong answer is its severity

The superproject spelling does not return an error for a submodule path — it returns **empty**. And
both probes fail the same way:

* empty `git status` reads as *"nobody is editing it"*
* empty `git log` reads as *"no recent commit, the author has moved on"*

Both say **safe to claim**. The guidance failed toward the exact collision it existed to prevent,
and it did so on the shared libs (`tooldef`, `sync`, `test-config`) where stomping a peer is most
expensive.

A wrong answer that fails toward caution is a nit. One that fails toward the hazard is a bug. **Ask
which way it fails before deciding how much it matters.**

## Reachability is the check that decides whether any of it matters

The tempting dismissal: `lint:tsc` is `tsc -p packages/operator-core/tsconfig.json`, and no
submodule is mounted under that package — so no submodule path can ever be a red, and the blind spot
is unreachable.

That is wrong, and checking it is what turned a plausible story into a defect:

* `tsc` reports errors in **every file it pulls into the program via imports**, and operator-core
  imports `libs/generic/*`, which are submodules.
* `projectPrefixFromTscCommand` is used only to validate an explicit `--files=` set. It does **not**
  filter the recorded error set.
* Measured against the live baseline: **7 of 170 files sit inside 5 submodules.**

Then the direct probe on a real one of those 7 (`libs/generic/tooldef/src/standard-schema.ts`):
both prescribed commands empty from the root; `git -C libs/generic/tooldef log -1` reports it
committed 14 hours earlier. A non-submodule control answers correctly from the root, proving the
gitlink boundary rather than a broken command.

## Measure the *whole* prescription, not the part you suspect

The same filing prescribed a third command, `npm run lint:tsc -- --files=<file>`. The natural
assumption — that it would also be refused for a submodule path, as an uncovered prefix — was
**wrong**. Run live, the gate **auto-routes** it to the owning workspace's sibling gate:
`status=routed`, exit 0, `filesUnchecked=1` stamped honestly.

Rewriting it "for consistency" would have broken a command that already worked. One measurement
saved a regression; a regression test now pins it.

## What to do

1. On any umbrella or digest item, read `payload.dailyDigest.memberIds` and probe the **members**.
   Refuting the title is not refuting the members.
2. Expect members to **disagree with each other**. "Mostly stale" is a common and dangerous shape:
   the majority verdict is what makes closing the whole thing feel safe.
3. When members split, resolve them **separately** with their own evidence. A `fixed` claim with no
   accompanying code change is correctly refused and routed to peer reconciliation — so record
   already-fixed members as evidence comments instead of forcing a close.
4. Suspect **prose** first when code around it has been fixed. Advice that names a command is the
   least-checked artifact in the repo.
5. Before fixing a report at its call site, ask whether the mechanism is **shared**. If it is, fix
   it there — otherwise the queue refills. (`containingSubmodulePath` already existed here; reusing
   it is what keeps the ownership test and the gate agreeing on what "inside a submodule" means.)
