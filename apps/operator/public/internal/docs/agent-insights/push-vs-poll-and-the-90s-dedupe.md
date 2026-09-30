# Push vs poll: the 90s dedupe means push is for EVENT-driven data, not continuous gauges/probes
URL: /internal/docs/agent-insights/push-vs-poll-and-the-90s-dedupe

Before migrating a UI poll to useSyncQuery push, classify the data — write-driven events push cleanly; continuous live gauges and system probes should stay polled. The invalidation bus's 90s source-side dedupe is why.

## TL;DR

Before you migrate a `setInterval` poll to `useSyncQuery` + push, **classify the
data source**. Push (a bridged trigger or `notifySyncInvalidate`) is the right
mechanism for **event-driven data that changes on a discrete write**. It is the
WRONG mechanism for **continuous live gauges** and **system/external probes** —
those should stay polled.

The reason is the invalidation bus's **90 s source-side dedupe**.

## Why — the 90s dedupe

`createInvalidationBus` (`libs/generic/sync/src/server/invalidation-bus.ts`)
suppresses a repeated identical `(name, args)` notify within
`DEFAULT_DEDUPE_WINDOW_MS = 90_000`, and `sync-sse.ts` does **not** override it.
A bridged table entry (`table-to-query-names.ts`) emits the query **name-only**,
so:

* The **first** invalidation in a 90 s window delivers immediately; every
  identical one for the next 90 s is **dropped**.
* For a query whose data changes faster than once per 90 s, the client therefore
  refetches **at most once per 90 s** — regardless of how fast the source moves.
* Name-only also means two concurrent contexts (e.g. two bench runs) **share the
  dedupe key** → one's writes suppress the other's invalidations.

A *data-bearing* notify (`notifySyncInvalidate(name, args, data)`) hashes the
data into the dedupe key, so changing data isn't suppressed — but then a
high-frequency source fires a `pg_notify` **per change** = the notify-storm
anti-pattern (see `/internal/docs/performance`).

So neither form streams a fast-changing value well.

## The classification

| Data shape                                                                   | Example                                                                                          | Mechanism                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event-driven** (changes on a discrete write, events typically >90 s apart) | schedule edit, plan edit, a pot announce/withdraw, a Mug wake, a spawn outcome flip              | **PUSH** — bridge the table or `notifySyncInvalidate` on the write. The dedupe rarely bites; the first event delivers promptly.                                                                       |
| **Continuous live gauge** (changes every request / sub-second)               | fleet rate usage% / in-flight, a live bench-run progress counter                                 | **POLL** (bounded). The 90 s dedupe would make it feel dead; a per-change notify is a storm. A dedicated non-deduped SSE channel is the only push that beats polling here — usually disproportionate. |
| **System / external probe** (no backing PG-table write at all)               | OS process list, `pg_stat_activity`, git worktree state, kopia/drizzle-studio external processes | **POLL**. There is nothing to trigger on — the state changes without a PG write.                                                                                                                      |
| **Editor draft**                                                             | a Vditor/markdown editor's source                                                                | **GUARDED one-shot** — a live re-fire mid-edit clobbers the draft.                                                                                                                                    |

## How this bit `data-sync-push-completion-2026-06-23`

The audit listed \~40 polls to "migrate to push." On inspection \~⅓ were
continuous gauges (`FleetRateControl`, `AdvEvalsTab` bench-live), system probes
(ProcessesTab, PgTab, AdvGitGraphPanel, BackupsTab, StudioTab), or retired
components — none of which should be pushed. The genuinely-pushable set was the
event-driven reads (schedule/design/plans/discovery/mug-wake/run-pills), which
migrated cleanly. See plan decisions D-005 (bench-live), D-006 (the apps/operator
poll set), D-007 (fleet-rate gauge).

**Rule of thumb:** if you'd describe the data as "a live meter / how-busy-is-it
right now," it wants polling. If you'd describe it as "the set of X, which
changes when someone does Y," it wants push.
