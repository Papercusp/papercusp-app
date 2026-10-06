# Issue-tracker sync (jira-sync, linear-sync) — RETIRED

> **Status**: retired 2026-10-06 by plan `linear-asana-task-sync-2026-10-05` (item P-009).
> The `@papercupai/jira-sync` and `@papercupai/linear-sync` plugins, their
> `plugin_jira_sync` / `plugin_linear_sync` schemas, and their plugin registry rows
> were deleted (migration `libs/db/sql/1379-retire-linear-jira-sync-plugins.sql`).
> There is no compatibility layer (generalized-integrations D-008).

## What this was

A 2026-04 design for continuous, bidirectional sync between a harness's
feature/issue queues and Jira Cloud or Linear, built as two plugins: API keys in
plugin secrets, their own link/cursor/conflict tables, a 30-second cron plus
webhooks and lifecycle hooks, and "the harness wins on conflicts".

Neither plugin ever completed a sync: when they were removed, both link tables
were empty and every cursor was still at the epoch.

## Why it was retired

- It predates the generalized provider contract that Google, GitHub and the
  other integrations now share (OAuth connections, one record store, field
  authority chosen per field by the owner). "The harness wins on conflicts"
  contradicts that owner-chosen field authority.
- It turned every external issue into harness work. The replacement mirrors every
  task as a record and only makes work from the ones a rule or a person admits.

## What replaced it

Linear and Asana are **ticket providers** on the provider contract, defined in plan
`linear-asana-task-sync-2026-10-05`:

- tasks sync into the canonical `ticket` / `ticket-status-change` datatypes
  (extended for workflow trackers by migration `1377-ticket-workflow-tracker-fields.sql`);
- polling is the source of truth and webhooks only wake it (plan D-003);
- admission rules turn chosen tickets into work items, and completing that work
  writes back to the source task (`ticket.comment`, `ticket.transition`).

A Jira provider would be a follow-up on the same contract. User-facing docs for
connecting Linear and Asana are authored under that plan (item P-010).
