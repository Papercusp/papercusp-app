# When the veto lives in a LATER command, the write path reports a success the pipeline will not honour
URL: /internal/docs/agent-insights/the-veto-in-a-later-command-reports-false-success

set-doc-part committed a doc-part row and printed ✓ written for a body that project-doc-parts then globally refused, leaving canonical Postgres ahead of CLAUDE.md/AGENTS.md with no test able to see it — because both stages were individually correct. The tell is a success message that ends by handing you the next command: that handoff is an admission a later stage can still say no. The repair is to IMPORT the later stage's rule and predict it as a BEFORE/AFTER DELTA, never an absolute check.

## The shape

Two commands. The first writes canonical state and reports success. The second turns that
state into the thing anyone actually reads, and holds a **veto the first never consults**.

```
$ npm run set-doc-part -- --part-key … --body-file new.md --write
  ✓ written (author=su-…).
  Project it now:   node scripts/project-doc-parts.mjs --write

$ node scripts/project-doc-parts.mjs --write
  ✗ DOC-PART IDENTITY REFUSAL: 1 canonical row(s) do not agree with their key/body identity.
  ✗ NOT writing CLAUDE.md   ✗ NOT writing AGENTS.md   ✗ NOT writing …corpus.generated.md
```

What makes this hard to see is that **neither stage is buggy**. The write really did commit.
The refusal really is correct — a key that no longer describes its body makes every later
`--part-key` lookup a guess. Each stage, reviewed alone, passes review.

The damage lives in the gap: **canonical state advances past its own projection.** Postgres
says the rule changed; CLAUDE.md, AGENTS.md, the generated corpus, and every guard whose
subject is one of those files still say it did not. And no test detects it, because the
projection is not corrupt — it is *self-consistent and merely old*.

## Three properties that compound

1. **The refusal is GLOBAL, the write was LOCAL.** One bad row blocks every client file for
   every part in the batch. Three unrelated, perfectly legal edits committed and then sat
   unprojected behind somebody else's fourth — with nothing telling their authors.
2. **The success message is the misleading half.** An agent that reads `✓ written`, runs the
   handed-over command, sees `✗`, and skims past `NOT writing CLAUDE.md` walks away believing
   the rule changed.
3. **The dry run predicted clean.** `set-doc-part`'s `projection impact` report printed
   `no change to the cut set — headroom 71,889 -> 71,902 chars (+13)` for the exact body the
   projector rejects. A report that models one property of the next stage reads as modelling
   *the* next stage.

## The tell, worth generalising

> **A success message that ends by handing you the next command is admitting a later stage
> can still refuse — and nothing checked whether it will.**

`✓ written. Project it now: <command>` is that admission in one line. Whenever you see a
write path close with "now run X", ask what X can say no to, and whether the write path
consulted it.

This has now been found **twice in this same script, by separate investigations**: first for
budget evictions (EI-21433690724936606, whose title names the repair outright — *"report the
absolute cut list but never the DELTA, so a CLAUDE.md edit silently evicts other rules from
every agent's context"*), then for key/body identity (EI-21968678099053129). The first produced
`eviction-delta.ts`; the second is a second tenant of it. Two independent reporters reaching the
same module by the same route is the signal that this is a shape, not an incident.

## The repair

**Import the later stage's rule; never re-spell it.** A second copy predicts something other
than what actually refuses, which is worse than no prediction at all. `set-doc-part` already
dynamically imports the projector for its impact report, so the identity rule cost one more
imported symbol. `eviction-delta.ts` takes the detector by **injection**, exactly as it already
takes `projectClient`.

**Predict it as a BEFORE/AFTER DELTA, not an absolute check.** This is the part that is easy to
get wrong, and it fails in two independent directions:

* *Absolute* would blame the author for a peer's pre-existing broken row.
* *Filtering findings by the edited key* would miss the case where editing part `X` introduces
  a problem reported under `X#evidence` — the rule's evidence half is defined over **sibling**
  rows, so an edit can break a row that is not the one you touched.

Only a set-level before/after diff gets both right:

```ts
const prior = new Set(detect(before).map(identify));
for (const p of detect(after)) (prior.has(identify(p)) ? preexisting : introduced).push(p);
```

`introduced` is the author's, and is worth refusing over. `preexisting` is **not** their doing
but is still silently blocking their projection — so surface it as a warning. That warning is
what property (1) above actually needs.

**Refuse in the DRY RUN too.** Put the check before the `if (!write) return` branch. A dry run
whose whole job is to predict the next stage must predict the next stage's refusals, or it is
the report that lies.

## Where the rule should NOT go

The obvious suggestion is to move it into the shared single-row validator (`validateDocPart`).
Resist it when the rule is set-relative: that function judges **one row in isolation** and
mirrors a migration's column CHECKs. The identity rule compares a row against its siblings, and
no column CHECK can express that either — moving it would break the mirror property the
validator exists to hold. The rule belongs with the stage that **enforces** it; the earlier
stage imports it.

## Testing it

Drive the tests with the **real** detector, not a restatement of it. The stand-in tests pin the
partition logic; the real-detector tests pin the **injection contract**, so a shape change in
the rule fails in a test rather than in a `✓ written` the next command rejects. Keep a negative
control — a guard that refuses everything looks identical to a guard that works, from the pass
column alone.
