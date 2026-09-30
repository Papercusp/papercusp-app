# A hot read belongs behind a tool, not a SQL snippet in guidance
URL: /internal/docs/agent-insights/a-hot-read-belongs-behind-a-tool-not-a-sql-snippet

The claimability drift that gave three different answers to 'what is claimable' (8 vs 2 vs 0) was re-armed by GUIDANCE, not by code: docs and tool guidance told the next agent to hand-write the query, and the hand-written version disagreed with what the queue actually served. The governing principle: a read with a stable shape gets a TOOL that wraps the canonical SQL so it cannot drift; dev:pg_query is the escape hatch for a genuinely one-off analytic read. Enforced by lint:sql-guidance-justified — an agent-facing surface may not tell an agent to SELECT from a tool-covered table (work_items, harness_plans, engineer_issues, work_items_claimable) without stating why the tool doesn't fit.

## The shape of the bug

Three surfaces answered "how much work is claimable?" with 8, 2, and 0. None was
lying: each ran a *different* hand-written query, because the real claim floors
lived only in a SQL view plus the scheduler's inline fragments — so every
guidance surface pointed agents at raw `dev:pg_query` and each agent
reconstructed the floors slightly differently.

The fix everyone reaches for is to correct the docs. That is only half of it.
**The docs were not wrong about the SQL — they were wrong to be SQL.** A snippet
is a copy of the semantics, and a copy drifts the moment the original changes.
Nobody edits the runbook when a thirteenth claim floor lands.

## The principle

> A read with a **stable shape** gets a **tool** that wraps the canonical SQL, so
> it cannot diverge from what the system actually does. `dev:pg_query` is the
> escape hatch for a genuinely **one-off analytic** read — not the default way to
> read canonical state.

The test is repetition, not complexity: **if you are writing the same query a
second time, it should be a tool** (or one more arg on an existing tool — extend
before you fork). A one-off join across `tool_invocations` to answer a question
you will never ask again is exactly what the escape hatch is for; that is not
what this is about.

Concretely, the reads that already have tools:

| you want                                | use                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| what issue-family work is claimable now | `work_items:claimable { harness }` — the SSOT floors, same oracle `scheduler:get_next` runs |
| a filtered work-item / issue slice      | `work_items:list` (server-side filters)                                                     |
| the plan directory, or recent plans     | `plans:list { updatedSince, createdSince, order, limit }`                                   |
| plan COUNTS by status / harness / day   | `plans:list { groupBy, aggregateOnly }`                                                     |
| pickable plan items across plans        | `plans:items { actionable: true }`                                                          |

## The guard

`lint:sql-guidance-justified` (`scripts/check-sql-guidance-justified.mjs`, gating
in CI) scans **agent-facing surfaces only** — a tool's own `description:` /
`guidance:` text, docs MDX, the prompt sources, `CLAUDE.md` — for a
`SELECT … FROM` a tool-covered table (`work_items`, `work_items_claimable`,
`harness_plans`, `engineer_issues`).

Implementation SQL inside a tool is never flagged: that IS the encapsulation
working. What is flagged is *telling an agent to run it*.

A snippet that genuinely belongs — the counter-example a page is written to
correct, a repair script no tool exposes — says so at the site, on the same line
or within 3 lines above:

```sql
-- sql-snippet-justified: the WRONG query, quoted as the counter-example this page corrects.
SELECT count(*) FROM harness_shared.work_items WHERE status = 'open';
```

A bare marker with no reason after the colon is rejected — justifying it is the
entire rule, so an empty marker would just be a mute button.

## Why the guard is worth its weight

Every incident is also a detector failure. The claimability fix landed a tool and
repointed the guidance; without a guard, the *next* runbook re-introduces the
snippet and the drift starts over — which is precisely how this class recurred
the first time. The lint makes "should this be a tool?" a question the author has
to answer once, at the moment they are writing the snippet, instead of a question
the next agent discovers by getting a wrong number.

See also:
[judging claimable work — `status='open'` is not claimability](/internal/docs/agent-insights/judging-claimable-work-not-status-open),
[raw SQL plan reads need workspace+harness scope](/internal/docs/agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope).
