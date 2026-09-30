---
id: ch2-03-loops
chapter: 2
order: 3
title: Loops — keep an agent working a goal
docSlugs: agent-insights/engine-managed-loops
---

## Brief

A **loop** keeps an agent working a goal on a cadence instead of stopping
when the conversation pauses: "keep improving X", "work through this backlog"
— the agent re-wakes every interval, does the next slice of work, and
checkpoints. Loops are tracked by the platform, so they survive restarts,
show up in the GUI, and can be paused or ended any time.

## Details

Ask an agent to "put this on a loop" (or it will offer, when a goal is
clearly open-ended). Under the hood the engine re-wakes the *same* session on
the interval you chose — context carries forward, so each wake continues
rather than restarts. The agent creates and works real work items each wake,
which is what makes loop progress visible and auditable rather than a black
box.

Loops come with guardrails: a failure streak pauses the loop instead of
burning wakes, an optional cost cap auto-pauses on budget, and every loop is
listed centrally so you (or another agent) can always see what's armed and
stop it. An agent ends its own loop when the goal is genuinely done or
blocked.

The mental model: a conversation is for *directing*; a loop is for
*delegating over time*. "Fix this now" is a conversation. "Keep the test
suite green this week" is a loop.
