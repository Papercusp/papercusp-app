# A refusal that hides its own bound and its own bypass reads as permanent — the admission-pending claim floor
URL: /internal/docs/agent-insights/a-refusal-that-hides-its-own-bound-and-bypass

A gate refusal must publish two things it usually knows and usually withholds: HOW LONG, when the condition clears on a schedule, and WHICH BYPASS, when the honouring path already has one. work_items:claim's `admission-pending` floor said only \"wait for admitted/unreviewed\" while the promoter was a 30-minute cron, and never mentioned `bypass:explicit-assignment` (235 uses in 3 days) — so a launched reviewer was refused twice on an item unclaimable for its entire 9-minute lifetime, and read a temporary floor as a dead end. Render the bypass list from the same record the honouring path mints from, and derive the bound from the schedule's own constant.

## What happened

A launched independent reviewer was briefed to claim a review work-item as its first act. That
item existed solely as its critique channel and had been created seconds earlier by the launching
agent. `work_items:claim` refused twice, several minutes apart, with `not_claimable /
admission-pending`, whose entire explanation was:

> duplicate screening is pending — the durable promoter owns admission; wait for admitted/unreviewed

The reviewer did the right thing by judgement — posted its critique unclaimed and said so in a
closing note — but an unclaimed item is invisible as owned work, and the obvious alternative
(retry until admission clears) would have stalled it indefinitely.

**The refusal was accurate and useless.** Two facts the system already knew were withheld:

1. **How long.** The admission promoter is a **30-minute durable cron**
   (`seed-work-item-admission-promoter-routine.ts`, `'0 */30 * * * *'`), with an independent
   fail-open runner admitting anything still pending after two ticks. Measured over 289 items
   admitted in 48h: **p50 978s, p95 2003s, max 4531s**. That specific item sat pending **22.5
   minutes** — created 12:37:57Z, admitted 13:00:27Z — while the reviewer launched at 12:38:51Z
   and finished at 12:47:40Z. It was unclaimable for its agent's *entire lifetime*. "Wait" was
   never a strategy that could have worked, and nothing said so.
2. **Which bypass.** The report proposed, as new design, "an item whose creator names a specific
   intended owner could bypass screening". That mechanism already existed:
   `bypass:explicit-assignment` — pass `assign_to` on `work_items:create` and the item is born
   `admission:'auto'` and claimable immediately. It had **235 uses in the three days before the
   report**, the second most-used admission path in the workspace. The launching agent, which
   knew the intended owner and was still alive, simply did not pass it.

## Why it is worth a rule

The claim-floor list mixes two populations that render identically to a caller. Some floors are
**temporal** — they clear with nobody acting (`admission-pending`, `cooldown`,
`watchdog-recovery-window`). Some are **permanent properties of the row** (`observation-lane`,
`federation-detector`, `already-completed`, `origin`). A refusal that does not say which leaves
the caller to guess, and both guesses are expensive: abandon work that was minutes from claimable,
or block forever on work that never will be.

The second half is sharper and generalises further:

> **A gate with an escape hatch that its own refusal never mentions is, to everyone who hits it,
> a gate with no escape hatch.**

The bypass and the refusal lived in different files and neither named the other. Every agent that
hits the refusal is, by construction, an agent that did not find the bypass — so the refusal is
the one place naming it changes an outcome, and it was the one place that did not.

Note also that the two *other* pre-existing exceptions to this floor (`leaderDispatchAdmission`,
`selfFiledFalloutAdmission` in `claimIssue`) both resolve through `resolveFleetScopeContext`,
which returns `null` unless the claimant is a fleet **member**. A launched reviewer never is —
which is precisely why the acceptance flow routes its review through a work-item rather than
`consult`. Neither doc comment said so. **When an exception is derived through a fleet/scope
resolver, check what that resolver does to a non-member before believing the exception applies to
your caller.**

## The rule

When you write or review a refusal:

* **If the condition clears on a schedule, publish the schedule.** Not "wait" — the expected
  interval and the guaranteed ceiling, so the caller can decide between waiting and proceeding.
  A short-lived agent needs to be told that waiting is the wrong move for it specifically.
* **If the honouring path has bypasses, the refusal renders them** — from the *same* record that
  path mints from, never a second hand-written list.
* **Absent must not imply permanent.** A floor that advertises no bound is one whose bound the
  code does not know; that is different from a floor that never clears, and the field's own docs
  have to say so or the ambiguity comes straight back.

## The shape that keeps it true

Both halves are **derivations**, because a hand-written "30 minutes" or a second copy of the
bypass list is exactly the drift this is meant to prevent (see `derived-truth-ladder`):

* `DEFAULT_PROMOTER_TICK_MINUTES` and `ADMISSION_FAIL_OPEN_TICKS` live in
  `work-items-admission.ts` beside the admission predicate; the promoter re-exports the tick so
  its own consumers are unchanged, and the claim path reads the number without importing a
  batched-LLM runner.
* `ADMISSION_CREATE_BYPASSES` is one record. The create path's `admissionBypass` is typed
  `AdmissionBypassReason`, so deleting an entry is a compile error at the mint site; the refusal's
  remedy string is *rendered* from the same record, so adding one cannot leave the refusal behind.
* `ClaimFloorAttribution` gained **optional** `retry { clearsOnItsOwn, expectedWithinSec,
  guaranteedWithinSec, basis }` and `remedy`. Optional is load-bearing: that interface has
  fixtures hand-built across the tree (`set_claim_spec` builds `unknownRows`), and a required
  field would strand files the change never touches.

Pin it with a **parametrised** test, not a text assertion: `admissionPendingExplanation(7)` must
say `7-minute`, which a hardcoded `30` cannot satisfy. Pin the ceiling against the runner's own
cutoff expression, so a fail-open that starts admitting after a different number of ticks fails
the test rather than silently making the published bound a lie. And give the "renders the remedy"
loop a negative control — over an empty record every `for` assertion passes vacuously.

## Related

* `new-gate-marker-must-be-wired-into-every-reader-not-just-one` — the sibling failure: when you
  widen or add an authoritative signal, grep for every other site answering the same question.
  This doc is its refusal-side counterpart.
* `derived-truth-ladder` — why the bound and the bypass list are derived rather than restated.
