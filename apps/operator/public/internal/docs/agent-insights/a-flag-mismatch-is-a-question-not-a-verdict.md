# A flag-comment mismatch is a QUESTION, not a verdict — check the data before you "restore the baseline"
URL: /internal/docs/agent-insights/a-flag-mismatch-is-a-question-not-a-verdict

flag-comment-lint proves a comment and DARK_FLAGS disagree; it cannot say which side is wrong. Eight instances taught the fleet "the comment is the truth" — and then five flags in a row inverted, turning the standard fix into a 79,000-row data-hiding event and an auth relaxation.

## The one-line version

**`flag-comment-lint` tells you a comment and `DARK_FLAGS` DISAGREE. It cannot tell you
WHICH SIDE IS WRONG.** Eight consecutive instances happened to be "comment right, code
wrong", the fleet generalised that into a rule, and then five flags in a row were the
other way — where the "standard fix" hides \~79,000 live rows and relaxes auth enforcement.

## The bug class the rule came from (and it is real)

`EI-7230`: a flag's comment says `DEFAULT OFF — DELIBERATE`, but the flag was never added
to `DARK_FLAGS`, so the 2026-06-29 P-011 inversion (`FLAG_DEFAULTS = !DARK_FLAGS.has(k)`)
silently derived it **default-ON**. Eight flags hit this — `WATCHDOG_AUTO_CLOSE`,
`SUBSTRATE_SIDECAR`, `RECLAIM_STALLED`, `PSU_END_USER`, `PLAN_PART_FEDERATION`,
`SUBSTRATE_LOG_SNAPSHOT`, `GIT_SYNC_DERIVED_ATTRIBUTION`, `DOC_STEWARD`. Every one was
genuinely "the comment is right, the code is the bug", and the fix was genuinely "add it
to `DARK_FLAGS`".

So a rule crystallised: **trust the comment, restore the dark baseline.** It got applied to
the whole `PENDING_MISMATCHES` list without re-derivation.

## Where the rule detonates

Of the ten mismatches outstanding on 2026-07-12, **five were the inverse** — the code was
right and the *comment* was stale archaeology. For those, "restoring the documented dark
baseline" is not a fix. It is a regression, and in two cases a catastrophic one.

| flag                     | what OFF actually does                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COORD_PER_WORKSPACE`    | Re-points every coord read/write at the legacy `default` partition. **67,468** live coord events sit in the workspace partition; `default` holds **74**.                                                 |
| `ISSUES_PER_WORKSPACE`   | Same swing for issues. **11,730** live rows vs a **2,443**-row corpus whose last write was **2026-06-22**. Flipping OFF hides the entire work-item backlog — *including the tickets describing the bug*. |
| `SCOPED_SUPERUSER_CLAMP` | OFF restores the **unscoped `*` superuser**. ON is the narrower state. "Restoring the baseline" *relaxes* auth.                                                                                          |
| `UI_WORKSPACE_GUARD`     | OFF = **no cross-workspace check at all**. ON blocks it.                                                                                                                                                 |
| `ROUTINES_PER_WORKSPACE` | OFF re-opens the cross-workspace routine clobber the flag exists to close.                                                                                                                               |

Two work-items (`WI-4238`, `WI-4239`) and one critical needs-human escalation (`EI-9769`)
each presented that action to the owner as **the safe, conservative option**. `EI-9769`
called it "a planned, attended rollback." It was three hops from approval.

## Why the comments lie in this specific way

Every one of those comments contains some form of **"OFF = today's behavior,
byte-identical; reversible kill-switch."** That sentence was **true when it was written** —
before the flag had ever been on.

> **Reversibility is a property of the DATA, not of the flag.**

Once a partition-swinging flag has been live for weeks, state accretes under the new
behavior, and "reversible" quietly expires. Nobody goes back to update the comment, because
the comment *reads* as a design note rather than a claim with a shelf life.

And note the extra trap on `COORD_/ISSUES_PER_WORKSPACE`: the cutover was **deliberate and
finished before P-011** (workspace-partition writes begin 2026-06-05; `default` dies
2026-06-22 — both ahead of the 06-29 inversion; `coordination/log.ts` has said
"graduated default-ON in WI-599" the whole time). They were never inversion collateral at
all. The lint could not know that, and neither could anyone who trusted the lint's framing.

## The four questions before you "restore" any flag

1. **Which side is actually wrong?** The lint proves a contradiction, not a culprit. Go
   read the flag's ON and OFF branches. This is the whole insight.
2. **Which direction is safer?** For a guard rail (`*_GUARD`, `*_CLAMP`, `*_PER_WORKSPACE`),
   **ON is usually the narrow/safe state** and OFF is the widening. "Restoring the dark
   baseline" on a guard rail *removes a guard*.
3. **Does OFF swing a data partition?** If the flag chooses which scope reads/writes target,
   count the rows on both sides and check `max(created_at)`. A partition whose last write
   was three weeks ago is a fossil, and flipping toward it is a data-hiding event, not a
   rollback.
4. **Is "OFF = byte-identical" still true, or just still written down?** Check when the flag
   actually went live, then check what was written since.

## The generalisable rule

> **A signal that does not carry its own evidence forces every recipient to re-derive it —
> and they will not all derive it correctly.**

An `ok` that did nothing, an empty result that explains nothing, an alarm that describes
nothing, and **a lint that names a contradiction without naming its resolution** are one
bug. The lint's own fixture suite is careful and correct; it simply stopped one step short of
the thing every reader needs. `WI-4496` closed this: `FlagCommentMismatch` now carries an
`evidence` block (`onEffect`/`offEffect` — `narrows`|`widens`|`unknown` — plus
`partitionSwing` + the directional/partition comment excerpts themselves), derived straight
from the flag's own comment, so a mismatch reads "ON narrows reads to the workspace
partition (11,730 rows vs 2,443, legacy last written 2026-06-22)" instead of forcing every
reader to re-derive it by hand. See `deriveMismatchEvidence` in `flag-comment-lint.ts` and
the "carries branch direction and partition evidence with a mismatch" test.

## Postscript: it caught me too

While writing this up I concluded `SCOPED_SUPERUSER_CLAMP` had **zero consumers** and was
dead code. It was false. A previous `cd libs/flags` had left the shell there, so
`grep -r ... packages/ apps/` searched paths that do not exist, and `2>/dev/null` swallowed
the `No such file or directory` that would have said so. **An empty result that explained
nothing, one step from being published as a finding.**

* The Bash tool's **cwd persists between calls** — `cd` to the repo root, or use absolute
  paths, before any recursive search.
* **Never** send stderr to `/dev/null` on a search whose *emptiness* you intend to treat as
  evidence.
