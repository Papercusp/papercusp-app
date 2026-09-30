# Social scheduled crosspost trigger pack

A first-party starter that takes one composed post, adapts it per platform, and publishes it to
several connected accounts. One plan target, one `manual` binding, and the cadence armed on the
instantiated plan.

## The cadence is armed outside the pack — deliberately

The trigger-pack schema offers a `schedule` binding source with a `scheduleRef`. **Nothing consumes
it.** It is declared in the SDK type and the published JSON schema, and the validator skips every
check for a non-external source, so a schedule-sourced binding validates cleanly and then never
fires. Building the template's defining feature on that would ship a pack that looks scheduled and
silently does nothing.

So the binding is `manual`, and the cadence is armed on the instantiated plan:

1. `plans:set-schedule` — author the recurrence
2. `plans:arm-schedule` — arm it (a separate, autonomy-gated step; an unarmed schedule never fires)

## Destinations

`destinations` takes canonical `"<platform>:<destination>"` refs — one opaque token, split on the
FIRST colon, because a destination can itself contain colons. The platform half selects the
credential, which is why a ref lifted from inbound post content is refused by the seam: it would
let a payload choose which of the owner's identities speaks.

The accepted platform prefixes are the registry rows that declare the `post` write verb AND carry a
verified write path — currently Bluesky, Mastodon, Reddit, Facebook Pages, Instagram and Threads.
YouTube is excluded: its row declares `reply` only. The set is not hand-maintained; a test
recomputes it from the registry and fails if the manifest pattern disagrees.

## Publishing is owner-ratified

`social:post` sits behind an owner-authority flag. Until the owner enables it the verb resolves the
account, destination and audience and returns them **without sending**, marking the result
`withheld`. That is the answer to show the owner. A run that reports success while every post was
withheld is the failure the plan's Phase 2 is written to prevent.

## Storm policy

`maxRuns: 1` per `windowSeconds: 1728` — the tightest derived `post` policy across the six
destination platforms, which is Instagram's ~50-posts-per-24h publishing bucket. The cap bounds
crosspost RUNS, and one run fans out to every destination, so it is the rate at which the whole
fan-out may repeat rather than a per-platform throttle. Derived, not chosen: a test recomputes it.

Cupboard installation only discovers the pack. Connection, instantiation, scheduling and arming all
remain explicit.
