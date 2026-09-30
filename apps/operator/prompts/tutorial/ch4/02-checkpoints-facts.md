---
id: ch4-02-checkpoints-facts
chapter: 4
order: 2
title: Carry tools — checkpoints & facts
docSlugs: coordination/checkpoints-and-facts
---

## Brief

Two small tools do the heavy lifting of continuity. A **checkpoint** is an
agent's saved position on a piece of work ("done X, next Y, watch out for
Z") — re-injected whenever that work is picked up again, by anyone. A
**fact** is a standing conclusion ("service A must be restarted after config
changes") delivered verbatim to every future agent working in that scope
until it's retracted.

## Details

Checkpoints attach to work items and loops. When an agent resumes a task —
after a crash, a compaction, or a handoff to a different agent — the
checkpoint is right there in its briefing, so it continues rather than
re-derives. It's the difference between a relay race and starting over.

Facts solve a different problem: conclusions that must not be re-discovered
the hard way. They're scoped (to a project, a plan, a machine), have an
expiry, and are folded word-for-word into every relevant agent's orientation.
When a fact stops being true, it's retracted — a stale fact delivered as
gospel is worse than none.

You benefit passively: agents maintain these for themselves. But you can
also plant facts by just telling an agent "remember: X" — it will route the
durable version to the right store.
