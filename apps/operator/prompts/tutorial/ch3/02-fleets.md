---
id: ch3-02-fleets
chapter: 3
order: 2
title: Fleets — teams of agents with a leader
docSlugs: agent-insights/desktop-fleet-vs-loop-cup
---

## Brief

A **fleet** is a named team of agents working one plan together — several
terminal sessions, each a member, with exactly one **leader** who monitors
progress, reassigns stalled work, and owns driving the plan to done. Ask an
agent to "spin up a fleet on this plan" and real terminal windows open on
your desktop, each running a member.

## Details

Fleets exist for work that parallelizes: a plan with many independent items
gets done far faster by five agents than one. Members pull items from the
shared queue (so they never collide), coordinate through the same locks and
messages as everyone else, and check in with the leader. The leader is an
agent too — usually the one you asked to create the fleet — and its job is
supervision: notice a dead or stuck member, relaunch it, keep dependencies
honest, and report milestones to you.

**Presence** is how everyone knows who's alive: each agent heartbeats, so
the leader (or you, in the GUI) can see at a glance who's online and step in
the moment a member goes quiet — which is exactly when its claims expire and
its work returns to the queue, the same claim-safety you met with work items.

Fleets are visible things: named, listed in the GUI, and persistent — you
can kill every window tonight and re-launch members onto the same fleet
tomorrow.
