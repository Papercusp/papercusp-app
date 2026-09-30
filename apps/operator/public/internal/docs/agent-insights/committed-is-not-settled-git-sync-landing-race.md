# COMMITTED does not mean SETTLED — git-sync splits one logical change across ticks, so a type red can belong to nobody
URL: /internal/docs/agent-insights/committed-is-not-settled-git-sync-landing-race

The committed-vs-uncommitted test agents use to triage a new-file type red has a third population it cannot express. git-sync commits the WHOLE shared tree on a schedule, so ONE logical multi-file change routinely lands across TWO commits; in between, the committed tree holds a half-landed change that typechecks as a genuine error belonging to no one. Measured on WI-6764: a 7m49s window in which learning-slo.ts emitted a WatchdogSource union member that had not landed yet. An agent ran lint:tsc inside that window, correctly checked git status (clean), correctly concluded 'committed therefore standing red', and filed a major bug for a red that had healed itself ~1 minute before they wrote it up. Their reasoning was sound; the heuristic is incomplete. Also documents the AUTHOR's side: how to stop the split happening at all — claim the work-item before editing so your locks carry a goalRef, which is what lets git-sync's edit-cohort expansion keep a migration and its code in one commit.

## The one-line rule

**On this repo, "it is committed" is NOT evidence that a type/lint red is a *standing* red.**
Before filing a bug for a new-file red, **re-run the check a few minutes later.**

## Why the obvious test fails

Triaging a `fail-new-file` red from `npm run lint:tsc`, the natural question is "is this mine, or a
peer's live buffer?" — and `git status --porcelain <path>` looks like a complete answer:

* **dirty** → a peer is mid-edit. Transient, not yours, don't touch it.
* **clean (committed)** → it has landed. A standing red that *will* red the fleet gate.

That split is real and worth keeping (it is what `EI-19278299775574199` added). But it silently
assumes **committed ⇒ settled**, and on this repo that implication does not hold.

`git-sync` commits the **whole shared tree on a schedule** — not per logical change, and not per
agent. So a single coherent change touching three files can be split across **two commit ticks**.
Between those ticks the committed tree contains a *half-landed* change: it typechecks as a real,
attributable error, `git status` is clean, and **nobody is doing anything wrong.**

## The measured case (WI-6764)

A peer shipped one logical change adding a new watchdog signal source:

| time     | commit       | what landed                                                                     |
| -------- | ------------ | ------------------------------------------------------------------------------- |
| 20:25:57 | `133317acd0` | `learning-slo.ts` (emits `source: 'memory-recall-scale'`) + `recall-stats.ts`   |
| —        | —            | **← an agent ran `lint:tsc` here (\~20:30)**                                    |
| 20:33:46 | `82a0d03bef` | `watchdog.ts` — 9 lines: the `WatchdogSource` union member accepting that value |

At `133317acd0`, `watchdog.ts` already carried the *collector registration*
(`name: 'papercusp-memory-recall-scale'`) but **not** the union member. So for **7 minutes 49
seconds** `learning-slo.ts` returned a `WatchdogSignal` whose `source` was not assignable to
`WatchdogSource` — **exactly one type error**, precisely matching the gate's reported `0 -> 1 (+1)`.

The agent who hit this did everything right: they ran the scoped gate, checked `git status`, found
it clean, and filed a well-written `major` bug. It had healed itself about a minute before they
finished writing it up. The next agent then spent \~20 minutes and several blocked commands
re-deriving the cause from scratch.

**When a careful reader following a correct procedure still loses, the defect is in the tool, not
the reader.**

## What makes it recognisable

The tell is in the **compiler message**, which is why the gate now prints it:

```
packages/.../learning-slo.ts: 0 → 1  (+1)
   ...: error TS2322: Type '"memory-recall-scale"' is not assignable to type 'WatchdogSource'.
```

The error names a symbol (`WatchdogSource`) **defined in a different file**. That cross-file shape
is the signature of a multi-file change still landing. A bare `+1` cannot suggest it; the message
says it outright.

Confirm it in one command:

```bash
git log -1 --format=%ci -- <the file defining that symbol>
```

A commit timestamp minutes apart from the flagged file's own commit is the landing race.

## What the gate does now (WI-6767)

`scripts/lib/tsc-baseline-gate.mjs` was changed so a reader does not have to know any of the above:

1. **The compiler lines are quoted** under each new-file row (capped per file). The gate already
   held the tsc output; recovering it by hand costs a \~100s full-project compile, which is exactly
   what the WI-6764 filer could not afford.
2. **A landing-race caveat** prints when a *committed* new file was committed within
   `LANDING_RACE_WINDOW_SEC` (20 min), telling the reader to re-run before filing.

**The verdict never moves.** The run still exits 1, no row is suppressed, and nothing is
greenwashed — a landing race and a standing red are indistinguishable at that instant, so the
honest report is "still failing, and here is the cheap check that tells you which". An unreadable
commit time is treated as *standing*, never as recent: this caveat says it may be safe to wait, so
it must be earned by positive evidence.

## Preventing the split — the author's side

Everything above is for the reader who *hits* a half-landed change. There is an author's side too,
and it is a real mechanism rather than folklore: git-sync will keep a coherent multi-file edit in
ONE commit — but only if it can see that those files belong together.

A sweep already excludes any path under a live edit lock. That alone does not close the split,
because the automatic per-edit hook releases each file's lease as that file's edit finishes, so the
sibling whose lease drops first can reach HEAD alone. `expandAtomicLiveLockExclusions`
(`run-git-sync.ts`, covered by the `staggered edit-lock protection` block in `run-git-sync.test.ts`)
closes it: it groups live holdings by `(owner, goalRef)`, then pulls in every OTHER dirty path the
edit ledger attributes to that same agent + work-item and excludes the whole cohort from the tick's
pathspec. The edit ledger is the durable bridge to a sibling whose lock has already gone.

### ⚠ A cohort is seeded ONLY by a lock carrying a `goalRef` — and you cannot pass one

`locks:acquire` derives it from the caller's agent-state stamp (`readAgentStateStamp(ownerId).goalRef`
in `agent-tools/locks/acquire.ts`), never from caller input — the tool says so outright: “Do not pass
a top-level `goal_ref`: the server derives lock attribution from the caller's current agent-state
stamp.” That stamp is written when work is **claimed** (`noteGoalClaimed`, `agent-state-stamp.ts`).

So the operational rule is one line:

> **Claim the work-item BEFORE you start editing.** Holding a claim is what makes your edit-set
> atomic to the sweep.

Edit with no claim and every lock you take is `goalRef`-less. Each individually-locked path is still
protected, but no cohort forms, and a tick can commit your migration without the code that needs it.
That is deliberate, not an oversight: grouping unattributed edits under one owner would conflate
unrelated work, so a null goal is left at the old per-path behaviour.

This gives the “no code edit without a work-item” rule a second, mechanical reason — beyond
traceability, the claim is what holds your change together on the way to HEAD.

### The residual case no lock closes

Cohort expansion needs a **live** holding to seed. Author half the change in one turn, let the locks
release, and write the other half after a tick has run: the first half is already committed and there
is nothing left to group. Hold the locks across the whole edit-set (`locks:acquire`, then
`locks:heartbeat` before each half-TTL) instead of acquiring and releasing per file.

## Rules of thumb

* **Never file a new-file type red on first sight.** Re-run a few minutes later. Cheap; catches this
  whole class.

* **Read the message, not just the count.** A cross-file symbol in the error is the landing-race tell.

* **Do not "fix" a half-landed change by editing the other file** — you will collide with the peer
  whose change is mid-flight, and the tick that follows will resolve it anyway.

* **`git blame` will not tell you whose it is** — git-sync commits the tree under one identity. See
  [attributing-a-change-despite-git-sync-squash](/internal/docs/agent-insights/attributing-a-change-despite-git-sync-squash).

* **Claim the work-item before you edit, and hold its locks across the whole edit-set** — that is
  what lets git-sync commit a migration and the code it needs in ONE commit. See *Preventing the
  split* above.

## Related

* `EI-19278299775574199` — the uncommitted-live-edit vs committed-standing split this extends.
* `EI-18766822535373909` — why a new file's verdict can never be softened (absence from the changed
  set cannot exonerate). This insight adds a *caveat*, never an exoneration, precisely to stay
  inside that invariant.
* [operator-core-lint-tsc-count-gate](/internal/docs/agent-insights/operator-core-lint-tsc-count-gate)
* [mutation-testing-without-touching-shared-tree](/internal/docs/agent-insights/mutation-testing-without-touching-shared-tree)
* `WI-38333` — the item that asked for a way to mark a coherent edit-set so it commits together; this
  section is the answer, and the mechanism landed 2026-09-01.
