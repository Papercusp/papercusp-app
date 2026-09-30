---
title: Investor reply — classify and draft
slug: fundraise-classify-reply
status: draft
personalScopes: personal:gmail, personal:contacts
---

# Investor reply — classify and draft

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Connect Google Workspace, instantiate this template, review the disarmed binding, and arm it explicitly.

## Background

An inbound Gmail message arrives under `payload.plan_run.inputs.trigger.payload` as a canonical
`email-message`. This plan decides whether the message belongs to the fundraise pipeline at all,
records what the reply means, and leaves a draft a human reviews.

The binding deliberately matches EVERY inbound message rather than trying to express "is an
investor" as a static payload filter, because that judgement needs the pipeline, not the envelope.
The correlation step below is therefore the real filter, and P-001's stop condition is the most
important line in this template: an unmatched message must leave no trace.

This plan never sends. The pack holds no `gmail.send` scope, so drafting is the only outbound
capability that exists here.

## Phase 1 — Correlate

- **P-001** `todo` Read `payload.plan_run.inputs.trigger.payload` and find the `pipeline-deal` work-item whose `threadRefs` contains the message `threadId`, or whose `contacts` include the sender address, scoped to `payload.plan_run.inputs.pipelineTag`. If no deal matches, COMPLETE THIS PLAN IMMEDIATELY with `matched:false` and take no further action — no draft, no notification, no pipeline write. A non-investor email must be untouched, and "when in doubt, stop" is the correct bias: a missed reply costs one manual read, a wrong draft costs the relationship.
- **P-002** `todo` Confirm the message is genuinely inbound from the counterparty and not our own message reflected back into the thread, nor an autoreply/bounce/out-of-office. Treat an autoreply as no reply at all: leave the stage untouched so the follow-up ladder still runs. blocked-by: P-001

## Phase 2 — Classify and record

- **P-003** `todo` Classify the reply as exactly one of `interested`, `later`, or `pass`, using the counterparty's own words as the evidence. Quote the sentence you classified on. Where the message is genuinely ambiguous, classify `later` and say so — do not resolve ambiguity toward the flattering reading, which is the standing failure mode of an agent scoring its own outreach. blocked-by: P-002
- **P-004** `todo` Update the matched deal: `interested` → `stage: engaged`, `stageDetail: replied-interested`; `later` → `stage: engaged`, `stageDetail: replied-later`; `pass` → `stage: lost`, `stageDetail: replied-pass`. Always set `lastInboundAt` to the message timestamp and append the `threadId` to `threadRefs` if absent. Never move a deal backwards out of `meeting`, `evaluation`, or `committed` on the strength of one message. blocked-by: P-003
- **P-005** `todo` Set `nextAction` and `nextActionDueAt` on the deal from the classification: `interested` → propose times / send materials, due within 1 business day; `later` → re-approach, due at the date the counterparty named (or +90 days if they named none); `pass` → no next action, clear `nextActionDueAt`. blocked-by: P-004

## Phase 3 — Draft

- **P-006** `todo` For `pass`, draft a short, gracious, genuinely no-ask acknowledgement — no rebuttal, no "just to clarify", no attempt to reopen. A clean pass preserves the relationship for the next raise and is worth more than a salvage attempt. blocked-by: P-005
- **P-007** `todo` For `interested` or `later`, draft the reply with `gmail:create-draft` using `planRunId=payload.plan_run.runId`: answer what they actually asked, propose a concrete next step, and honour `payload.plan_run.inputs.toneGuidance`. Never invent traction numbers, committed investors, round size, or timeline pressure — if a fact is not in the deal record or the thread, omit it rather than estimate it. Complete only after the tool reports `created:true` or `alreadyCreated:true`. blocked-by: P-005
- **P-008** `todo` Notify the owner with `notifications:send_owner` using a `dedupeKey` derived from `trigger.dedupeKey` plus this plan-run ref: name the counterparty, the classification with its quoted evidence, and that a draft is waiting for review. The draft is never sent by this plan or any downstream plan. blocked-by: P-006

## Decisions

### D-001 — Correlation is the filter, and an unmatched message stops the run
Date: 2026-08-23
"Is this an investor reply" cannot be expressed as a static payload matcher, so the binding matches
all inbound mail and P-001 decides. The stop path is unconditional: no draft, no notification, no
write. This keeps a broad binding safe.

### D-002 — Classification records evidence, never a bare label
Date: 2026-08-23
Every classification carries the counterparty sentence it rests on, and ambiguity resolves to
`later` rather than to the more flattering `interested`. A pipeline that grades its own outreach
optimistically produces a forecast the owner cannot use.

### D-003 — This pack drafts and stops
Date: 2026-08-23
No plan in this pack sends mail, and the manifest requests no `gmail.send` scope, so the
no-auto-send property is structural rather than a matter of instruction-following.
