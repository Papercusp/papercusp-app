---
title: Social mention triage
slug: social-mention-triage
status: draft
---

# Social mention triage

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Connect a Bluesky or Mastodon social source, instantiate this template, review the disarmed bindings, and arm them explicitly.

## Background

Each inbound mention creates one isolated trigger run. The run carries the canonical `social-post`
payload under `payload.plan_run.inputs.trigger.payload`, already normalized by the platform adapter
and validated against the registered datatype schema, so the plan reads one shape whichever platform
the mention arrived from.

**This pack has no write path, and that is a structural property rather than an instruction.** It
declares no publishing verb, no write scope, and no OAuth field. The plan's terminal output is
DRAFT TEXT; publishing is a separate, deliberate act the owner takes with `social:reply` after
reading it. An automated reply to a mention answers a stranger in the owner's voice on the owner's
public identity, which is not correctable by a follow-up — so the reviewable step is the product,
not a safety rail bolted onto one.

The `social:reply` seam would refuse to be redirected even if this plan did call it: the caller
supplies text only, and the server resolves the account, thread, credential and audience from the
stored post. That is defence in depth under the decision below, never a substitute for it.

## Phase 1 — Triage

- **P-001** `todo` Read the mention from `payload.plan_run.inputs.trigger.payload` — `text` is the mention body, `author` the handle that sent it, and `url` (when present) the public permalink. Read the platform from `payload.plan_run.inputs.trigger.source`, and treat it as the audience the draft is written for: a Bluesky mention is public, a Mastodon one inherits the parent status's visibility.
- **P-002** `todo` Classify the mention against `payload.plan_run.inputs.escalationGuidance`. Record one of `needs-human`, `reply-suggested`, or `no-action`, with the sentence from the mention that decided it. A mention classified `needs-human` stops here with the reason stated; do not also draft a reply for it, because a draft sitting beside an escalation invites someone to send it.
- **P-003** `todo` For a `reply-suggested` mention only, draft the reply following `payload.plan_run.inputs.replyGuidance`. To give the owner an id they can act on, locate the mention with `social:search` (narrow with `platforms` and a `{ from, to }` window around the mention's `occurredAt`) and take the hit's `postId` VERBATIM — a `postId` is an opaque token and both `social:read` and `social:reply` refuse one the caller assembled from a platform and an id. Record the draft, that postId, and the classification as this plan's output. Do not call `social:reply`, `social:post`, or any other publishing verb — the owner sends it, or does not.

## Decisions

### D-001 — The pack declares no write capability at all, rather than declaring one and choosing not to use it
Date: 2026-08-23
A "never auto-publishes" property enforced only by plan prose is one careless edit away from being
untrue, and the edit would look like an improvement. So the guarantee is moved into the manifest,
where it is checkable: no `oauth` block, no write scope, no publishing target. The pack cannot
publish because it holds nothing that could.

### D-002 — No `oauthField` is declared, because neither mention-emitting platform has a platform-wide OAuth provider to name
Date: 2026-08-23
The P-021 packs each bind an `oauthField` to a provider (`google`, `slack`). Neither Wave A platform
that emits a `mention` event can do that honestly: Bluesky authenticates with an app password and
the registry records its scope list as empty, and Mastodon registers a client PER INSTANCE, so
there is no single provider id that means "Mastodon". Declaring one would name a referent the OAuth
registry cannot resolve. The social source's credential is acquired through the trigger-source
connection flow instead, and the README states which registry scopes that connection must carry.
