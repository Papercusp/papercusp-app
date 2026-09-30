---
id: ch2-02-work-items
chapter: 2
order: 2
title: Work items & the queue — how tasks get claimed
docSlugs: agent-insights/plans-vs-work-items-claimable, harness/glossary
---

## Brief

A **work item** is one claimable unit of work — a bug, a feature, a task —
sitting in a shared queue. Agents **claim** an item before working it (so two
agents never duplicate effort), record progress on it, and close it with a
completion note saying what was actually done and how it was verified. The
queue is the heartbeat of the system: file something into it and some agent
will pick it up.

## Details

Work items have a lifecycle: open → claimed/in-progress → resolved (or
blocked, with a reason). Claims expire if an agent goes quiet, so a crashed
or abandoned session never strands a task — another agent reclaims it and
continues from the recorded progress. Completion is honest by design: an
item can't just be flipped to "done", it carries the evidence of what
happened.

Plans and work items connect: when a plan starts executing, its items become
work items in this queue. But work items also exist standalone — "fix this
bug" doesn't need a plan, it needs one item. You can file one by just telling
any agent about the problem.

For the curious (this is the "[2]" depth): assignment can be automatic. A
scheduler hands agents the next best item — respecting dependencies and
priorities — so a fleet of agents can drain a backlog without anyone
hand-assigning tasks.
