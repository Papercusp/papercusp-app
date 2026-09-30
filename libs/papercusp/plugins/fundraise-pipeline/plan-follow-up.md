---
title: No-reply follow-up
slug: fundraise-follow-up
status: draft
personalScopes: personal:gmail
---

# No-reply follow-up

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Instantiate this template against a pipeline deal, then arm its cadence with
`plans:set-schedule` followed by `plans:arm-schedule`. The binding itself is `manual`: trigger packs
have no schedule consumer, so the cadence belongs on the instantiated plan.

## Background

Silence is the common case in venture, and the follow-up ladder is where good outreach turns into
spam if it is unbounded. This plan is deliberately finite: `maxFollowUps` attempts, then the deal
goes `dormant` and stops consuming attention.

Every run re-reads the deal rather than trusting what the schedule captured when it was armed. A
reply that landed since the last tick must cancel the follow-up, and re-reading is the only way to
know.

## Phase 1 — Decide whether a follow-up is owed

- **P-001** `todo` Re-read the `pipeline-deal` named in `payload.plan_run.inputs.deal` from the ledger. Do not act on the copy embedded in the plan inputs: it is a snapshot from arming time and the whole question here is whether the world changed since.
- **P-002** `todo` STOP with `followUpOwed:false` if any of these hold: `lastInboundAt` is newer than `lastOutboundAt` (they replied — the ladder is over); `stage` is `lost`, `dormant`, `committed`, `meeting`, or `evaluation`; fewer than `payload.plan_run.inputs.followUpDays` days have passed since `lastOutboundAt`; or the deal has no `lastOutboundAt` at all (nothing was ever sent, so nothing is owed). blocked-by: P-001
- **P-003** `todo` Count prior follow-ups on this deal. If that count is already at or above `payload.plan_run.inputs.maxFollowUps`, set `stage: dormant`, `stageDetail: no-reply-ladder-exhausted`, clear `nextActionDueAt`, end the cadence with `plans:end-schedule` (or the equivalent disarm), and COMPLETE. The ladder ending quietly is a success, not a failure. blocked-by: P-002

## Phase 2 — Draft

- **P-004** `todo` Draft the follow-up with `gmail:create-draft` using `planRunId=payload.plan_run.runId`, replying in the existing thread rather than opening a new one. Each successive follow-up must be SHORTER than the last and must add one genuinely new piece of information — a shipped capability, a live artifact, a relevant milestone. A follow-up that only says "bumping this" or "circling back" is worse than silence; if you have nothing new to say, go to P-003's dormant path instead. blocked-by: P-003
- **P-005** `todo` Never imply a deadline, competitive pressure, or scarcity that is not literally true, and never reference a previous email's emotional register ("I know you're busy", "sorry to bother"). Honour `payload.plan_run.inputs.toneGuidance`. blocked-by: P-004
- **P-006** `todo` Record the attempt on the deal: increment the follow-up count, set `nextActionDueAt` to now + `followUpDays`, and leave `lastOutboundAt` UNCHANGED until a human actually sends the draft. A drafted follow-up is not an outbound touch, and treating it as one would silently advance the ladder against mail that was never sent. blocked-by: P-005
- **P-007** `todo` Notify the owner with `notifications:send_owner` on a stable `dedupeKey`: counterparty, days of silence, attempt number out of `maxFollowUps`, and that a draft awaits review. blocked-by: P-006

## Decisions

### D-001 — The cadence lives on the instantiated plan, not in the pack
Date: 2026-08-23
`PluginTriggerPackSource` marks `kind:'schedule'` deprecated with no runtime consumer, so this
binding is `manual` and the recurrence is armed per-deal with `plans:set-schedule` +
`plans:arm-schedule`. This follows the substrate's own stated direction rather than inventing a
second scheduler.

### D-002 — The ladder is finite and ends quietly
Date: 2026-08-23
`maxFollowUps` is capped at 4 by the pack's input schema and defaults to 2. Exhaustion moves the
deal to `dormant` and disarms the cadence. An unbounded ladder is the mechanism by which
well-intentioned outreach becomes spam.

### D-003 — A draft is not a send, and must not advance the ladder
Date: 2026-08-23
`lastOutboundAt` only moves when a human sends. Otherwise an unsent draft would silently consume a
follow-up slot and the next tick would compound the error.
