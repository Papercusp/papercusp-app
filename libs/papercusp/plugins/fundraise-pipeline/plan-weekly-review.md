---
title: Weekly pipeline review
slug: fundraise-weekly-review
status: draft
---

# Weekly pipeline review

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Instantiate once for the pipeline, then arm a weekly cadence with `plans:set-schedule` +
`plans:arm-schedule`.

## Background

This is the human gate that keeps the rest of the pack honest. Everything else drafts, classifies,
and schedules autonomously; once a week the owner sees the whole board and decides what actually
goes out. Without it, "a human fingerprint on every first touch" degrades into a stack of pending
approvals nobody looks at.

The review produces a decision list, not a status report. Every line ends in something the owner
approves, rejects, or reschedules.

## Phase 1 — Assemble the board

- **P-001** `todo` Load every `pipeline-deal` scoped to `payload.plan_run.inputs.pipelineTag`, grouped by `stage`. Report the counts per stage and the week-over-week movement between them. Movement is the signal; a total is not.
- **P-002** `todo` List every deal whose `outreachApproval.state` is `pending`, with its counterparty, the opening line of the draft, and how long it has been waiting. This is the section the review exists for, so it goes first and it is never summarized away. blocked-by: P-001
- **P-003** `todo` List deals whose approval has EXPIRED while waiting (older than the gate's permitted window). These need re-approval rather than a nudge, and silently re-approving them is not an option the gate allows. blocked-by: P-002

## Phase 2 — Surface what is drifting

- **P-004** `todo` List overdue `nextActionDueAt` items, oldest first, with the owed action. blocked-by: P-001
- **P-005** `todo` List deals that went `dormant` this week with their follow-up counts, and deals sitting in `engaged` with no scheduled next step — the quiet leak, where an interested investor goes cold because nobody moved. blocked-by: P-001
- **P-006** `todo` List every unshipped promise recorded by the post-meeting plan: the artifact, who owes it, and how late it is. blocked-by: P-001
- **P-007** `todo` Report tier-1 deals with no mapped warm path and tier-2 deals whose thesis match was never verified. Both are list-hygiene failures that quietly turn a considered list into a spray list. blocked-by: P-001

## Phase 3 — Deliver a decision list

- **P-008** `todo` Assemble the review as decisions, not prose: approve/reject/reschedule for each pending draft, and one concrete next action for each drifting deal. State the honest read of the raise — where it actually stands — including when the answer is that momentum has stalled. A review that always reads encouraging is a review the owner learns to skip. blocked-by: P-003
- **P-009** `todo` Deliver with `notifications:send_owner` on a stable weekly `dedupeKey`. Do not mutate any deal from this plan: the review reports and the owner decides. Approvals are recorded by the owner's action, never by this run. blocked-by: P-008

## Decisions

### D-001 — The review reports; it never approves
Date: 2026-08-23
No step here writes `outreachApproval`. A review plan that could approve its own pending queue would
close the loop the human gate exists to keep open.

### D-002 — Pending approvals lead, and are never summarized away
Date: 2026-08-23
The standing gate is only real if the owner sees the queue every week. Compressing it to a count is
how an approval queue becomes a rubber stamp.

### D-003 — An honest read includes bad news
Date: 2026-08-23
Stalled momentum reported plainly is the review's most valuable output. A consistently encouraging
report trains the owner to ignore it, which removes the gate by attrition rather than by decision.
