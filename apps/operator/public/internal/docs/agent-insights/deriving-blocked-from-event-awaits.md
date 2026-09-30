# Deriving \"blocked on a gate\" from event_awaits — two traps that both render as an empty column
URL: /internal/docs/agent-insights/deriving-blocked-from-event-awaits

Building a supervision surface from harness_shared.event_awaits? Two non-obvious traps will silently ruin it: the always-armed coord:inbox-wake row every agent holds (which made 93% of the roster look blocked), and the workspace_id vocabulary mismatch between event_awaits ('default') and coord_presence ('papercusp-workspace') (which made 0% look blocked on any scoped read). Both were found only by checking against live data.

If you are building anything that answers **"which agents are blocked, and on
what?"** from `harness_shared.event_awaits`, read this first. Two traps sit on
that path. They pull in opposite directions, and each one renders as a plausible
result rather than an error — which is why both survived a green typecheck, a
green unit suite, and a clean render, and were caught only by comparing against
live data.

Both were found while building `/adv/HUD`'s Blocked column
(`adv-hud-fleet-board-2026-07-25`).

## Trap 1 — the always-armed inbox wake makes \~93% of the roster look blocked

Every agent carries a **permanently open** await on its own
`coord:inbox-wake:<ownerId>` key. It is armed at SessionStart by
`inbox-wake-arm.ts` (migration 183, one standing row per agent) and re-upserted
for the life of the session. It is the rendezvous a `coord:send` wake fires
against.

It means **"I am reachable by a wake"** — the *opposite* of blocked.

Measured on the dev box, 2026-07-25:

| open awaits (not fired, not cancelled, not superseded)            | rows | distinct agents |
| ----------------------------------------------------------------- | ---- | --------------- |
| `coord:inbox-wake:*`                                              | 126  | 126             |
| `work-item:*`                                                     | 10   | 8               |
| `gate-first-green`, `composed-root`, `critical-bug-wave-complete` | 3    | 3               |

A naive "has an open await ⇒ blocked" put **89 of 96** su sessions in the
Blocked column. That does not merely add noise — it **destroys the column**, because
a signal that fires for nearly everyone distinguishes no one. The Blocked column
looked busy and authoritative and was worthless.

```sql
-- Always exclude the standing inbox-wake row.
AND event_key NOT LIKE 'coord:inbox-wake:%'
```

After the exclusion the same roster reported 12–13 genuinely-gated sessions with
real keys (`work-item:claimable`, `work-item:done:WI-5822`, `gate-first-green`) —
and, usefully, each carried the agent's own `note` explaining the park.

## Trap 2 — `event_awaits` and `coord_presence` do not share a workspace vocabulary

The obvious way to scope the join is by workspace. It silently returns nothing.

```
harness_shared.event_awaits    → workspace_id = 'default'              (all rows)
harness_shared.coord_presence  → workspace_id = 'papercusp-workspace'  (all rows)
```

So `WHERE event_awaits.workspace_id = <the roster's workspace>` matches **zero
rows** on any workspace-scoped read. The symptom is maximally confusing:

* an **unauthenticated `curl`** of the endpoint (unscoped, `workspaceId = null`,
  predicate short-circuits) returns the awaits correctly;
* the **app**, which is workspace-scoped, gets an empty Blocked column;
* both hit the same URL on the same process, so it reads like a stale build or a
  cache — and you will go restart things for a while before suspecting the SQL.

This is the failure mode
[raw SQL plan reads need workspace+harness scope](/internal/docs/agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope)
describes, arriving from the other direction: not a *wrong-tenant* match, but a
*no-tenant* match caused by two tables using different workspace vocabularies.

**Scope by the roster's owner ids instead.** `subscriber_id` is a globally-unique
owner id and the caller's presence roster is already scoped, so joining on the
owner set is both correct and tighter — it bounds the scan, and it mirrors what
`fetchPresenceFleet` already does:

```ts
export async function openAwaitsByOwner(ownerIds: string[]) {
  // …
  AND subscriber_id = ANY(${ownerIds}::text[])
}
```

## What to copy

1. Exclude `coord:inbox-wake:%`. Enforce it at the SQL boundary *and* in whatever
   pure layer classifies the result, so a cached payload or a future endpoint
   cannot resurrect it.
2. Scope by owner ids, never by `workspace_id`, when joining `event_awaits` to a
   presence-derived roster.
3. Filter on all three closure columns — `fired_at IS NULL AND cancelled_at IS
   NULL AND superseded_at IS NULL`. A fired await is history; a superseded one was
   replaced, not honoured. Counting either parks an agent in Blocked forever after
   its gate already opened.
4. Pick the **oldest** open await per agent (`DISTINCT ON (subscriber_id) … ORDER
   BY subscriber_id, created_at ASC`). An agent can hold several; the oldest is
   the one that has been costing time.

## The meta-lesson

Both bugs produced a **plausible-looking UI**, not an exception. Trap 1 filled a
column; trap 2 emptied one. Unit tests passed throughout, because the fixtures
encoded the same assumption the code did. What caught them was reading the live
table and asking *"do these numbers describe a system I recognise?"* — 89 of 96
agents blocked did not, and neither did 0 of 97 on a box where agents park on
gates constantly.

When a derived signal is about to become a column in someone's dashboard, check
its **distribution against production** before you ship it. A signal that fires
for almost everyone, or almost no one, is usually measuring the wrong thing.
