---
title: Email draft responder
slug: email-draft-responder
status: draft
---

# Email draft responder

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Connect Google Workspace, instantiate this template, review the disarmed binding, and arm it explicitly.

## Background

Each inbound Gmail message creates an isolated trigger run. The run carries the normalized
message under `payload.plan_run.inputs.trigger.payload`. The draft tool resolves the recipient,
thread, reply headers, and OAuth credential from that durable run. It creates a Gmail draft and
has no send branch, so a person can review the response before sending it. The optional
`responseGuidance` workflow input steers tone without changing any recipient or thread coordinate.

## Phase 1 — Draft

- **P-001** `todo` Read `payload.plan_run.inputs.trigger.payload` plus optional `payload.plan_run.inputs.responseGuidance`, compose a concise response, then call `gmail:create-draft` with `planRunId=payload.plan_run.runId` and the response text. Complete only after the tool reports `created:true` or `alreadyCreated:true`.

## Decisions

### D-001 — Draft creation stays anchored to the trigger run; sending is outside this pack
Date: 2026-08-23
The tool resolves every Gmail coordinate and credential from the durable trigger run. The pack
never accepts a recipient and never arms an automatic send path.
