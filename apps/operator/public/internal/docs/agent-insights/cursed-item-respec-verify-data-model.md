# Re-speccing a cursed item — verify the data model against the code first
URL: /internal/docs/agent-insights/cursed-item-respec-verify-data-model

A cursed item's re-spec must cite the ACTUAL store/table from the code, not an assumed shape — a confidently-wrong mechanism re-curses just as hard as the original under-specified description.

## What

A work-item that fails placement `breakerThreshold` times (default 3) trips
the P-021 circuit breaker and flips `cursed` (`pot/placement-watchdog.ts`).
The Mug's mandate for a cursed item is "change strategy or escalate" —
concretely, that often means **re-speccing**: rewriting the item's
description with a corrected mechanism before it is placed again.

The failure mode (EI-2045): a re-spec that fixes the *symptom* (an
under-specified description) by inventing a mechanism from **assumption**
instead of the actual code re-curses just as hard, because the new
description is now confidently wrong rather than merely vague — a bee
following it literally fails again, in a way that's harder to spot because
it now *looks* well-specified.

## The concrete case

`F-FIX-037` ("coord invariant: handoffs stuck pending past 12h") was cursed
after 3 bee failures. Diagnosis: the ORIGINAL description was empty — no
mechanism at all. The re-spec added one:

> "`coord_handoffs` rows stuck in `pending` should transition to `expired`."

This is wrong on the data model. There is **no `coord_handoffs` table**.
Handoffs are immutable `coord_event_log` records (surfaced as `handoffs`);
acceptance is a **sibling** record (`kind:'handoff_accepted'`), never an
in-place status flip — see `agent-tools/coordination/handoffs.ts`. A bee
handed the re-spec literally would try to `UPDATE` a table that doesn't
exist, fail, and re-curse the item a fourth time.

The actual fix (already implemented, `reconcile-handoffs.ts`): write a
**sibling** `handoff_expired` record for every stale open handoff (mirroring
`reconcile-escalations.ts`), and let the fold (`foldHandoffs`) treat it as
terminal. Same append-only pattern as acceptance — never a mutation.

## The guard

Before dispatching a re-spec of a coord/DB/infra item, `grep` the actual
store/table the item's mechanism depends on and cite the **real** file +
shape in the new description — never assume a shape from the item's prose or
title. Cheap check: does the re-spec name a real file/table you can point to,
or only a noun that sounds plausible? If you can't point to it in the code,
you don't have a re-spec yet, you have another guess — and another guess is
exactly what re-curses.

This is called out directly in the Mug personas
(`mug.base.md`'s cursed bullet, `blueprints/coding/prompts/mug.md`'s
completion-mandate section) — read those for the in-context version agents
actually see at wake time. This doc is the discoverable long-form for anyone
chasing "why did my re-spec cursed again" via `docs:search`.
