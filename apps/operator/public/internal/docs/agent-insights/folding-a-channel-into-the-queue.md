# Folding a disposition channel into the Queue — surface the awaiting-human slice, never the backlog
URL: /internal/docs/agent-insights/folding-a-channel-into-the-queue

When you add a source to the attention/Queue feed (plans:attention), the naive "surface every open row" floods the human. Filter to the genuinely-awaiting-human slice (a needsHuman flag, a bounded candidate set, or one rollup) and keep execution backlog (work_items) separate.

## What

The operator's **Queue** (the `plans:attention` feed → `packages/operator-core/lib/attention/`) is the unified, categorized list of things **awaiting a human decision/action**. When you fold a new "disposition channel" into it (B-14 / mug-autonomy-policy D-011 added improvements, standing-approvals, conversations, Scout grading), the mechanical part is easy — a new `AttentionKind` + `ATTENTION_KIND_CATEGORY` entry + `AttentionRef` variant + a pure adapter in `adapters.ts` + a best-effort source fetch in `agent-tools/plans/attention.ts` + tests.

The **non-obvious trap** is *what to surface*. The naive move — "list every open row from the channel's store" — **floods the human Queue** (the improvements/issues backlog alone is 100+ open rows). That is exactly what the Queue must NOT be.

## The rule

Surface **only the genuinely-awaiting-human slice**, and pick the right per-channel predicate:

* **A `needsHuman`-style flag** when the channel's loop sets one. Improvements carry `payload.needsHuman` (set by the auto-implement loop when it *explicitly routes to the owner*). Surface those, NOT the backlog — the backlog stays **pull** on the Learning tab (operator-learning-tab D-001), it is not pushed to the Queue.
* **A naturally-bounded candidate set.** Standing-approval candidates (`readCandidates()`) are already gated to ≥3 dispatches + not-yet-approved. Open `coord:ask` conversations (`state='open'`, no accepted answer) are bounded.
* **One rollup item** when the set is large and the action is optional. Scout grading is optional feedback over up-to-thousands of routed ideas → a single `scout-grade:pending` rollup ("N ideas awaiting your grade"), never one item per idea.

**Execution backlog stays separate.** `work_items` (the pool + the Working tab) is execution, not the Queue (D-013). A generic open issue is execution backlog, not a Queue decision — it only becomes a Queue item if something flags it needs-human.

If a channel has **no pending-decision store** (e.g. `gym:judge` is a pure scoring fn; deploy/budget/credential approvals arrive as coord escalations, already folded), **say so in the plan** — do not invent a store and do not flood.

## Two companion patterns from the same fold

* **Disposition coherence (P-102).** Three coord→human channels, three dispositions: an **escalation** is a blocked DECISION (resolve-with-choice, Decision tier); a **conversation** (`coord:ask`) is a non-blocking question (Alert); a **message** (`coord:send`) is a COMMUNICATION (ack) and is **never** a Decision. A directly-addressed message is an Alert, not a Decision — acking is not deciding. Don't let a message compete with escalations for the Decision tier.
* **Decision↔execution dedup (P-104).** A plan-item that has been `plan_items:convert`-ed carries an `implements` edge in `coord_links` and executes in Working — so it must NOT also show as a Queue row. `listConvertedPlanItemRefs()` (one indexed query) + the pure `dropConvertedPlanItems()` filter handle it. Invariant: a needs-human **DECISION** is always kept (you resolve a decision, you don't convert it; never silently hide a decision).

## Where

* Model + categories: `packages/operator-core/lib/attention/types.ts` (`AttentionKind`, `ATTENTION_KIND_CATEGORY`, `AttentionRef`); `lib/autonomy/categories.ts` (the 14 ids).
* Adapters (pure): `lib/attention/adapters.ts`. Source fetches (best-effort, one try/catch each): `lib/agent-tools/plans/attention.ts`.
* The dedup guard: `dropConvertedPlanItems` in `lib/attention/sources.ts` + `listConvertedPlanItemRefs` in `lib/plan-items/convert.ts`.
* Tests: `lib/attention/{adapters,sources,triage}.test.ts`.

**Source fetches run concurrently, not sequentially** (infra-perf-robustness-audit-2026-06-18
P-005, `attention.ts`): source 1 (plan items) still runs first to populate the `planHarness` map,
then sources **2–16** — including every folded disposition channel above — fire together via
`Promise.all`, each still in its own best-effort `try/catch`. This is a latency fix only (the
handler was p50 \~2s sequential); output order is irrelevant because `buildAttentionGroups`
re-groups and deterministically re-sorts by importance, so it changes nothing about *what* to
surface — a new channel's adapter/predicate still slots into that `Promise.all` array the same
way, just wrapped in its own `(async () => { try { … } catch { /* best-effort */ } })()`.

Numbering note: the sequence skips **5** on purpose — the plan-review source was retired by
B-14/P-101 (needs-human plan items, a plan-governance Decision, are the review gate now;
`harness_plan_review` had no live writer once the bash orchestrator was archived). The numbers
are stable labels, not a dense index; don't renumber to close the gap.

## Still current (verified 2026-08-04)

This page is `normative`, so the useful check is whether the code still *obeys* it — it does,
and the growth is the evidence. The fan-out went from 10 sources to 16 by exactly the slot-in
this page prescribes, and every added channel surfaces an awaiting-human slice rather than a
backlog dump: needs-human work-items (11), registered owner-walls (12), pending dark-flag
ratifications (13), watcher blocked-session/mirrored-ask (14), blocked work-items (15), and
possibly-unrecorded owner decisions (16).

One addition worth folding back into "pick the right per-channel predicate" above: alongside a
`needsHuman` flag, a bounded candidate set, and a rollup, the code now also uses **a bounded
lifecycle STATE** — `blocked` (source 15, curated-signal-cards P-001) — as the awaiting-human
predicate. That is consistent with the rule, not an exception to it: `blocked` is bounded and
genuinely awaits a human unblock, whereas plain `open` would be the backlog flood D-013 forbids.

The `lib/autonomy/categories.ts` count cited above is also still exact: **14** ids
(`CATEGORIES` → `AUTONOMY_CATEGORY_IDS`).
