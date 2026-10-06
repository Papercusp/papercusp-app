---
title: Post-meeting follow-through
slug: fundraise-post-meeting
status: draft
personalScopes: personal:gmail, personal:calendar
---

# Post-meeting follow-through

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** This target is reached by an internal `plan-completed` edge from the meeting-prep binding,
so it is instantiated when the prep brief completes — which is BEFORE the meeting happens. P-001 is
therefore a wait, not a formality.

## Background

The follow-through after an investor meeting is where most fundraises leak: the thank-you goes out
late, the promised materials go out later, and the next step is never written down. This plan makes
all three automatic-to-draft and immediate-to-schedule.

The plan is instantiated early, by the prep plan's completion, inheriting the same correlation so
Runs reconstructs prep → meeting → follow-through as one workflow. It must therefore defer its own
work until the meeting has actually ended.

## Phase 1 — Wait for the meeting to end

- **P-001** `todo` Read the meeting end time from `payload.end` from `triggers:read-payload { planRunId: payload.plan_run.runId }` (fall back to `start` plus one hour when `end` is absent). If that instant is still in the future, arm a single-shot cadence with `plans:set-schedule` + `plans:arm-schedule` for shortly after it and COMPLETE this run — the next run resumes at Phase 2. Do not busy-wait, and do not draft a thank-you for a meeting that has not happened yet.
- **P-002** `todo` On the resumed run, re-read the calendar event and the matched `pipeline-deal`. If the event was cancelled or declined, set `stageDetail: meeting-cancelled`, leave `stage` unchanged, disarm the cadence, and COMPLETE without drafting. blocked-by: P-001

## Phase 2 — Capture what was promised

- **P-003** `todo` Reconstruct what was committed in the meeting from the owner's own notes on the deal, any notes attached to the calendar event, and the thread. Do NOT infer commitments from the prep brief's objections list: a question we anticipated is not a promise we made, and inventing a promised artifact is worse than omitting a real one. Where nothing is recorded, say so and ask the owner rather than guessing. blocked-by: P-002
- **P-004** `todo` Advance the deal: `stage: evaluation` when materials or diligence were requested, otherwise keep `stage: meeting` with `stageDetail: met-awaiting-next-step`. Set `nextAction` to the single most important owed item and `nextActionDueAt` within two business days. blocked-by: P-003

## Phase 3 — Draft and hand off

- **P-005** `todo` Draft the thank-you in the existing thread: find the latest message in the deal's `threadRefs` thread with `personal:search { scopes:["personal:gmail"] }`, then call `mail:reply` with its `externalId` as `messageId`, its `sourceId`, and the thank-you as `text` (draft mode, never `mode:"send"`). The draft carries one line of genuine specificity from the conversation, the owed items with dates, and the proposed next step. Honour `payload.plan_run.inputs.toneGuidance`. No recap of the whole meeting — they were there. blocked-by: P-004
- **P-006** `todo` List every owed artifact as a checklist on the deal's `notes` with an owner and a date, so an unshipped promise is visible in the pipeline board rather than only in a draft nobody re-reads. blocked-by: P-004
- **P-007** `todo` Notify the owner with `notifications:send_owner` on a stable `dedupeKey`: counterparty, what was promised, the new stage, and that a thank-you draft is waiting. blocked-by: P-005

## Decisions

### D-001 — Instantiated early by the edge, executed late by its own schedule
Date: 2026-08-23
The pack grammar offers `plan-completed` as the correlation-preserving way to chain targets, and
gcal emits no meeting-ended event, so the chain fires at prep-completion and P-001 defers execution
until after the real end time. This keeps prep, meeting, and follow-through in one correlated
workflow instead of splitting them across two unrelated triggers.

### D-002 — Anticipated objections are not promises
Date: 2026-08-23
The prep brief's objection list is upstream of the meeting and says nothing about what was actually
committed. Drafting "as promised, here is X" for an X nobody promised damages credibility precisely
where this pack is trying to build it.

### D-003 — Owed artifacts live on the deal, not only in the draft
Date: 2026-08-23
A promise recorded only inside an unsent draft is invisible to the pipeline board. Recording it on
the deal is what makes an unshipped promise surface during weekly review.
