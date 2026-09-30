# coord:inbox cursor custody: use VIEW reads and inbox wake
URL: /internal/docs/agent-insights/coord-inbox-since-ts-seed-gap

`coord:inbox` is a repeatable VIEW without an agent-facing timestamp cursor; use `coord:await-inbox` for one specific handoff and `coord:feed` for query matching.

## TL;DR

`coord:inbox` is a repeatable **VIEW** of the caller's coordination inbox. It supports narrowing filters such as `kinds`, `from`, `limit`, `include_ambient`/`includeAmbient`, `include_intents`, `max_body_chars`, and `unanswered_only`. It does not accept an agent-facing timestamp cursor, free-text `q`, projection, or cursor argument, and re-reading the same window does not consume or empty it.

The old `since_ts`-style caller cursor was deliberately removed from `coord:inbox`. Cursor custody belongs to the delivery path, where the server and client hook coordinate the private watermark. Agents should interpret a direct read as a current window, not as a delta.

## The supported patterns

For “wait until a specific peer sends me something,” use `coord:await-inbox`. It is an idle-state annotation over the always-armed inbox wake, so a peer's `coord:send { wake: 'required' }` can re-invoke the waiting session without a caller-managed cursor or a seed-timing race.

For free-text or time-window query matching across coordination history, use `coord:feed`; its query and pagination surface is separate from the direct inbox VIEW. For a normal direct read, bound the result with `limit` (the wrapper-level `coord:orient.inboxLimit` maps to that argument) and use the supported narrowing filters.

## Why this distinction matters

A direct inbox read is intentionally repeatable. Treating it as a caller-owned tail poll makes a previously delivered message disappear from the caller's view when the caller chooses a cutoff that is too recent. Keeping the cursor in the delivery path preserves at-least-once coordination delivery while leaving the direct read safe to repeat.

## Historical context

The original handoff drill that motivated this insight exposed a consumer-side cursor-seeding race: a handoff had already landed while the receiving agent was still claiming work, and a later caller-owned tail poll excluded it forever. The durable fix is the public contract above—no caller cursor on `coord:inbox`, server-owned delivery cursoring, and `coord:await-inbox` for a specific handoff—not a recommendation to recreate the old poll shape.

The same rule applies to any coordination consumer: keep delivery cursors with the delivery mechanism, use a repeatable VIEW for inspection, and choose the purpose-built feed or wake surface when you need history or waiting.
