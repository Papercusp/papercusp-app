# A "resolved" staleness/watchdog alarm that keeps re-firing is deploy-lag, not rot
URL: /internal/docs/agent-insights/staleness-alarm-deploy-lag-refire

An insight-staleness (or any watchdog) alarm you just resolved re-files under a new id because the watchdog scans the release/green checkout, which lags staging — the fix is already on staging. Diagnose by replaying against the staging tree; the EI-441 cooldown now suppresses it.

## The symptom

An insight-staleness improvement (`insight-staleness:<slug>`) — or any watchdog
signal — that you JUST resolved re-appears within minutes under a NEW EI id, often
escalated to major. You open it, check the cited file… and it exists. The alarm
reads like a live "this file is missing" signal, but the file is right there.

## What's actually happening

The watchdog runs inside the live operator, which on the dev box runs from the
**release checkout** (`papercup-release`, pinned to green `main`) — not the
canonical **staging** tree where fixes land.
`packages/operator-core/lib/harness/improvements/insight-staleness.ts` reads the
insight MDX from its checkout's `DOCS_CONTENT_ROOT` and checks cited paths against
that same checkout's `REPO_ROOT`. When `main` lags `staging` by a deploy window
(or far longer if green-checkpoint is stuck), a citation already repointed on
staging still reads as missing on release, so the signal fires.

It RE-fires (not just fires once) because the pre-filter
`partitionSignalsByKnownKeys` in
`packages/operator-core/lib/harness/improvements/watchdog.ts` only suppresses a
resolved key when the signal's evidence PRE-dates the resolution — and
insight-staleness stamps `latestAt` to the scan time, so its evidence is always
"fresh." A resolved-but-still-stale-on-release signal therefore always re-files as
new. That was the EI-413 to EI-430 loop (5 insights, \~75h).

## Diagnose in 30 seconds

Replay the collector's own extraction against BOTH trees: does the cited path
exist under the staging checkout vs the `papercup-release` checkout? If staging is
clean and only release is missing it, it is **deploy-lag, not rot** — resolve the
item and let the deploy carry the fix. Do NOT re-edit: the fix is already on
staging, and editing the release checkout is clobbered on the next deploy.

## The fix in place (EI-441 / EI-427)

`insight-staleness` now stamps a `resolutionCooldownMs` (default
`DEFAULT_INSIGHT_RESOLUTION_COOLDOWN_MS` = 7 days) on every signal it emits, and
`partitionSignalsByKnownKeys` in `watchdog.ts` suppresses a re-file when the
matching resolution landed within that window before the scan. A
genuinely-undeployed fix re-surfaces after the cooldown. Insights whose every
citation is gone are classified apoptotic and get a single "supersede, don't
repoint" signal. The provenance-aware successor — replace the blind cooldown
with a change-event check, plus auto-rewrite to the new canonical path — is
tracked as EI-448; the content-hash schema redesign is EI-440.

**Since hardened (EI-510):** the collector also got a set of false-positive
guards that reduce needless re-fires further — a citation whose surrounding
prose acknowledges it was moved/removed (`used to`, `moved off`, `retired`, …)
is never flagged as a live dependency; a cited path resolves against the repo's
tracked files with a `/`-anchored SUFFIX match (so a dropped-prefix shorthand
like `` `bin/hono-host.ts` `` for the real `apps/operator/bin/hono-host.ts`
doesn't false-fire), falling back to an on-disk check for gitignored-but-present
files; a freshly-discovered insight is skipped for a recency window (mirroring
the resolution cooldown) so its citations aren't flagged before they've even
deployed; and an apoptotic ("supersede") verdict is downgraded to a "repoint"
review when every missing path's BASENAME still exists elsewhere in the repo
(path-prefix drift, not a vanished evidence base) — see
`extractCitedPaths` / `makeRepoPathResolver` / `makeRepoBasenameResolver` in
`packages/operator-core/lib/harness/improvements/insight-staleness.ts`.
