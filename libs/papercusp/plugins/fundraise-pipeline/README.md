# Fundraise pipeline trigger pack

A five-target trigger pack that runs an investor pipeline on the canonical `pipeline-deal` datatype.
It packages the reusable half of a fundraise: research, reply classification, a bounded follow-up
ladder, meeting prep, and post-meeting follow-through.

Built for `fundraise-automation-2026-08-23`.

## Why this pack exists

The outreach system is the demo. A fundraise visibly run by the product on its own trigger substrate
is a stronger claim than a deck — but only if the automation is good, because investors are the most
spam-calibrated audience there is. Everything below is shaped by that constraint: agents do the
research, correlation, classification, and drafting; a human fingerprint stays on every send.

## The graph

| Binding | Source | Target | Fires on |
|---|---|---|---|
| `investor-reply-to-pipeline` | external `gmail` | `classify-and-draft-reply` | `ext:gmail:message.received` |
| `meeting-to-investor-prep` | external `gcal` | `investor-meeting-prep` | `ext:gcal:event-upcoming` |
| `meeting-to-post-followup` | internal `plan-completed` | `post-meeting-followup` | edge from `meeting-to-investor-prep` |
| `follow-up-ladder` | `manual` | `no-reply-follow-up` | cadence armed per deal |
| `research-enrichment` | `manual` | `fund-research-brief` | kicked off per batch |

One edge stitches prep → follow-through with `correlation: inherit`, so Runs reconstructs the
meeting workflow as a single chain rather than two unrelated triggers.

## Three properties worth knowing

**It cannot send mail.** The manifest requests `gmail.readonly` and `gmail.compose` and deliberately
no `gmail.send`. Every outbound path in every plan ends at `gmail:create-draft`. The no-auto-send
guarantee is therefore structural — a property of the granted scopes — rather than a matter of the
agent following instructions. That is the difference between a safeguard and a request.

**A broad binding is made safe by correlation, not by its filter.** "Is this an investor reply"
cannot be written as a static payload matcher, so `investor-reply-to-pipeline` matches all inbound
mail and the plan's first step decides. An unmatched message stops the run cold: no draft, no
notification, no pipeline write.

**The follow-up ladder is finite.** `maxFollowUps` caps at 4 and defaults to 2; exhaustion moves the
deal to `dormant` and disarms the cadence. A drafted follow-up never advances `lastOutboundAt` —
only a human send does — so an unsent draft cannot silently consume a rung.

## Scheduling

Trigger packs have no schedule consumer: `PluginTriggerPackSource`'s `kind:'schedule'` is deprecated
and the validator says so. Recurrence therefore lives on the instantiated plan via
`plans:set-schedule` + `plans:arm-schedule`. Both time-based behaviours in this pack — the follow-up
ladder and the post-meeting wait — use that path rather than introducing a second scheduler.

## The datatype

`pipeline-deal` is a `generic-kind` registry datatype: a work-item kind plus a validated payload, so
it needed no migration. It is domain-neutral on purpose — a sales, BD, or hiring pipeline uses the
same type with a different stage vocabulary — because D-004 is the standing convention that shapes
belong in the reflexive registry rather than being reinvented per app. People are referenced as
canonical `contact` instances and conversations as `email-message` / `calendar-event` refs; this
pack invents no investor-flavoured copy of any of them.

Its `outreachApproval` field is the send-approval gate. Drafting is always permitted; sending
requires a recorded approval bound to a specific `draftRef`, so an approval cannot silently transfer
to different content. See `packages/operator-core/lib/fundraise/outreach-approval.ts`.

## Installation

Installation makes the declaration available and nothing more. It never arms a binding — connect,
instantiate, and arm remain separate, explicitly autonomy-governed steps.
