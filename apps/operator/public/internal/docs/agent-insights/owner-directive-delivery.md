# Owner directives: every turn is one, only open ones are delivered, once per context
URL: /internal/docs/agent-insights/owner-directive-delivery

How owner directives reach agents after owner-directive-delivery-redesign-2026-09-22: every owner-typed turn lands open; only open directives are injected; <=500 chars renders verbatim, longer renders a forced agent summary; delivered once per context epoch with hook-confirmed delivery; a 50k-token reminder for the addressee; a turn-end done-or-open check; ended sessions route to the fleet leader or the owner's unhandled list.

## The model

**Every owner-typed turn is a directive (D-001).** The UserPromptSubmit provenance hook captures each turn the owner types into a session as an `open` row in `harness_shared.owner_directives`, addressed to that session (`recordedBy`). A question is a directive too: its job is "answer this". There is no pending/promote/dismiss triage any more (migration 1198 folded pending rows into open). A directive ends only as `done` or `declined` with a note, via `orders:disposition`.

**Only open directives are delivered, and agents close their own (D-002).** The addressed session carries it as a due obligation until it dispositions it. Every other session sees it as an awareness line only (D-003): no `[DUE]` framing, because it is not theirs.

**No truncation (D-004).** A directive of at most 500 chars renders verbatim, in full, everywhere. A longer one renders the addressed agent's summary (at most 200 chars, written with `orders:summarize`, labelled with its author) or an explicit `summary not written yet [full text: orders:get #N]` placeholder. A cut fragment of the owner's words is never rendered. The single display rule is `directiveDisplayText` in `owner-directive-display.ts`.

## Cadence (D-005)

* **Once per context epoch.** The turn-start orientation is suppressed while the agent provably already saw it. The epoch resets on every context wipe: SessionStart `compact` (via the recovery brief) and `startup`/`resume`/`clear` (via `/api/agent-mcp/context-epoch-bump`), so a new context gets the full set again.
* **Hook-confirmed delivery.** The server stages each delivery with a token; the client hook echoes the token back on its next call only if it actually emitted that block (`delivery-ledger.mjs`). An unconfirmed delivery is re-sent, never assumed.
* **Reminder for the addressee.** After the context grows by 50k tokens (30 minutes when the size is unknown), the addressed agent gets one line: `📌 reminder: directive #N still open and yours`. It escalates after three ignored reminders.
* **Turn-end check (Stop hook).** `stop-owner-directive-check.mjs` asks `/api/agent-mcp/turn-end-directive-check`. It blocks the turn end once per directive the session replied to that is still open (done, declined, or still in progress?), and on every turn end while an over-cap directive addressed to it has no summary. `stop_hook_active` bounds it to one bounce per turn; every failure lets the turn end.

## Ended sessions (R-7)

A directive whose addressee has ended is not stranded (`owner-directive-routing.ts`):

1. A live session holding a non-terminal work-item linked to it keeps it.
2. Otherwise the addressee's fleet leader inherits it, if alive. Membership comes from `fleet_membership_events`, because presence rows are reaped within hours. The leader sees it as an obligation titled `passed to you: its session … ended` and may disposition it.
3. Otherwise it is **unhandled**. It appears in the owner's inbox as an `unhandled-directive` card, and any session may adopt and disposition it.

Liveness comes from the shared oracle (`resolveSessionStates`). An unknown verdict never reroutes.

## What an agent does

* **Addressed to you:** carry it out (or answer it), then `orders:disposition { id, status: 'done' | 'declined', note }`. If it is over 500 chars, write its summary first: `orders:summarize { id, summary }`.
* **Not addressed to you:** it is awareness. To close it you must be the addressee, a holder of linked work, the inheriting fleet leader, or it must be unhandled. `orders:clear` only takes it off your own banner.
