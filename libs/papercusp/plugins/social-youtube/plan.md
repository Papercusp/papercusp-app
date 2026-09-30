---
title: Record an inbound YouTube event
slug: social-youtube
status: draft
---

# Record an inbound YouTube event

## Now

**State:** Starter template. Installing this pack makes it available; it does NOT arm it.

**Next:** Connect a YouTube source, instantiate this template, review the 3 disarmed
bindings (`upload`, `comment`, `reply`), and arm the ones you want explicitly.

## Goal

An inbound YouTube event arrived through the `youtube` trigger source. Record what
it was, in one short summary, so the connection's activity is visible — then stop.

**This plan never drafts a reply and never publishes anything.** It is the
least-privilege plan a platform pack can ship: it proves the wiring works
end to end without taking any action on the platform. Compose it with
`@papercupai/social-mention-triage` or `@papercupai/social-comment-digest`
when you want drafting or digesting.

## Input

`trigger` is delivered by the binding that fired:

- `trigger.event` — which event fired: `upload`, `comment`, `reply`.
- `trigger.payload` — the canonical `social-post` document the YouTube adapter
  normalized. `id` and `text` are always present; `author`, `url`,
  `replyToId` and `occurredAt` are present when YouTube supplies them.
- `trigger.dedupeKey` — stable across identical passes, so a redelivery of the
  same event carries the same key.

## Steps

1. Read `trigger.payload`. Use ONLY fields that are actually present on it —
   an absent field means YouTube did not supply one, not that you should go
   looking for it elsewhere.
2. Summarize the event in your completion, in one or two lines: the platform,
   `trigger.event`, the author if present, the permalink if present, and the
   first line of `text`.
3. If — and only if — the event plainly needs a person (it is hostile, legal,
   financial, or commits the owner to something they have not said), raise it
   with `coord:ask-owner`. Otherwise complete quietly.

## Not in scope

- **Do not reply, post, or delete.** This pack requests no write path, and the
  registry gates writes independently of what a plan asks for.
- **Do not read the delivery ledger.** `harness_shared.trigger_deliveries` is
  written by ingestion and exposed by NO agent verb, so "read the events
  coalesced into this run" names a capability that does not exist. Work from the
  `trigger` you were handed.
- **Do not construct a postId** as `youtube:<id>`. A postId is opaque: `social:read`
  and `social:reply` accept one only as `social:search` returned it, verbatim.
  If a later step needs one, get it from `social:search`.
