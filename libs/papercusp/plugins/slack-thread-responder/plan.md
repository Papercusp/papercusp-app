---
title: Slack thread responder
slug: slack-thread-responder
status: draft
---

# Slack thread responder

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Connect Slack Socket Mode, instantiate this template, review the disarmed binding, and arm it explicitly.

## Background

Each Slack mention creates one isolated trigger run. The run carries the canonical chat message
under the event `payload` returned by `triggers:read-payload { planRunId: payload.plan_run.runId }`. The reply tool accepts the run id plus text and
resolves the source, channel, thread, and bot credential server-side, so neither the event payload
nor the worker can redirect the response. Optional `responseGuidance` steers tone only.

## Phase 1 — Respond

- **P-001** `todo` Read the event `payload` returned by `triggers:read-payload { planRunId: payload.plan_run.runId }` plus optional `payload.plan_run.inputs.responseGuidance`, draft a concise answer to the triggering mention, then call `slack:respond-in-thread` with `planRunId=payload.plan_run.runId` and the answer text. Complete only after the tool reports `posted:true` or `alreadyPosted:true`.

## Decisions

### D-001 — Replies stay anchored to the trigger run
Date: 2026-08-23
The plan never accepts a channel or thread coordinate. The server resolves both from the durable
trigger run and posts with the connected owner's bot credential.
