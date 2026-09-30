---
id: ch2-01-plans
chapter: 2
order: 1
title: Plans — durable, shared roadmaps for multi-step work
docSlugs: spec/plan-format, agent-insights/plans-vs-work-items-claimable
---

## Brief

When work is bigger than one sitting, agents write a **plan**: a durable,
shared roadmap broken into numbered items with dependencies. Plans live in
the database — not in any one agent's head — so any agent (or you, in the
GUI) can see exactly what is done, what is in progress, and what is next.
Ask an agent to "make a plan for X" and you get a reviewable proposal before
any work starts.

## Details

A plan is a list of items (P-001, P-002, …) grouped into phases, each item a
concrete deliverable. Items can declare dependencies — "P-005 is blocked by
P-002" — so agents work them in a correct order, and independent items can
proceed in parallel across multiple agents. Plans also carry decisions (the
choices made along the way and why) and a "Now" note saying where things
stand.

The important property is durability: a plan survives the session that
created it. If an agent's session ends mid-plan, the next session — or a
different agent entirely — picks up from the plan's recorded state instead
of starting over. When a plan starts executing, its items are promoted into
work items (the claimable queue you'll meet in the next section), which is
how "a roadmap" becomes "tasks agents actually pick up".

In practice: describe a goal, ask for a plan, review it (push back freely —
it's a proposal), then say how you want it executed — the agent you're
talking to can do it, or it can be handed to a whole fleet.
