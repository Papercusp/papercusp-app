---
title: Record an inbound TikTok event
slug: social-tiktok
status: draft
---

# Record an inbound TikTok event

## Now

**State:** Starter template. Installing this pack makes it available; it does NOT arm it.

**Next:** Connect a TikTok source, instantiate this template, review the 1 disarmed
binding (`post`), and arm it explicitly if you want it.

## Goal

A new video appeared on the connected TikTok creator's public profile, through the
`tiktok` trigger source. Record what it was, in one short summary, so the
connection's activity is visible — then stop.

**This plan never drafts a reply and never publishes anything.** On TikTok that is
not merely a least-privilege choice, it is the only thing available: TikTok exposes
NO comment surface to read or answer at this grant tier, and the registry declares
no write verbs for the platform at all. See "Not in scope".

## Input

`trigger` is delivered by the binding that fired:

- `trigger.event` — always `post`. TikTok has exactly one inbound event, because a
  new upload is the only thing the Display API lets us observe.
- `trigger.payload` — the canonical `social-post` document the TikTok adapter
  normalized. `id` and `text` are always present; `url`, `occurredAt` and `media`
  are present when TikTok supplies them.
- `trigger.dedupeKey` — stable across identical passes, so a redelivery of the same
  event carries the same key.

**`text` is very often EMPTY, and that is normal, not an error.** TikTok is
media-primary: a video with no caption is ordinary. The payload carries
`textAbsent: true` when that is the case, so you can say "no caption" rather than
reporting an empty summary as a fault.

## Steps

1. Read `trigger.payload`. Use ONLY fields that are actually present on it — an
   absent field means TikTok did not supply one, not that you should go looking for
   it elsewhere.
2. Summarize the event in your completion, in one or two lines: the platform, the
   permalink if present, when it was posted, and the first line of `text` — or "no
   caption" when `textAbsent` is set.
3. If — and only if — the event plainly needs a person (it is hostile, legal,
   financial, or commits the owner to something they have not said), raise it with
   `coord:ask-owner`. Otherwise complete quietly.

## Not in scope

- **Do not reply, post, or delete.** TikTok's registry row declares NO write verbs,
  verified 2026-08-23. There is no comment endpoint and no comment scope in TikTok's
  scopes reference, so replying is not gated — it does not exist. Posting is
  separately unavailable: an unaudited client can only publish in `SELF_ONLY`
  viewership from an account that must be private, which no caller's requested
  visibility can honestly represent.
- **Do not treat `commentCount` as something you can act on.** The payload may carry
  a comment COUNT, because the Display API returns one. The comments themselves are
  unreadable and unanswerable. Reporting the number is fine; implying you could read
  or reply to them is not.
- **Do not read the delivery ledger.** `harness_shared.trigger_deliveries` is written
  by ingestion and exposed by NO agent verb, so "read the events coalesced into this
  run" names a capability that does not exist. Work from the `trigger` you were
  handed.
- **Do not construct a postId** as `tiktok:<id>`. A postId is opaque: `social:read`
  accepts one only as `social:search` returned it, verbatim. If a later step needs
  one, get it from `social:search`.
- **Do not persist `media[].coverImageUrl`.** TikTok documents a 6-hour TTL on that
  CDN link; the payload flags it with `coverImageUrlExpires`. It is for immediate
  display only.
