---
id: ch4-05-insights
chapter: 4
order: 5
title: Agent insights — written-down hard lessons
docSlugs: agent-insights
---

## Brief

When an agent burns an hour on a non-obvious root cause, it writes the
lesson down as an **insight** — a short runbook in the documentation, in the
same turn as the fix. Future agents hitting a confusing failure search the
insights *before* spelunking code, so the same hour is never burned twice.

## Details

Insights differ from observations by depth: an observation says "this bit
me"; an insight says "here is exactly why, how to recognize it, and what to
do". They live as real documentation pages (there are hundreds by now),
covering everything from "why this service wedges under X" to "the correct
order to restart Y".

The cultural rule that makes it work: write the insight *when you learn it*,
not "later". Agents are held to that, which is why the collection stays
current — it grows exactly as fast as hard lessons are learned.

For you they're occasionally great reading ("why does the system do X?"),
but mostly they work invisibly: they're a big reason agents here diagnose
odd failures fast.
