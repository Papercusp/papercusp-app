---
id: ch2-04-routines
chapter: 2
order: 4
title: Routines — the system's scheduled heartbeat
docSlugs: agent-insights/autoloop-is-the-routines-engine, agent-insights/two-tier-scheduler-and-timer-visibility
---

## Brief

**Routines** are Papercusp's scheduled background jobs — the platform's own
heartbeat. Git-sync committing the tree, health checks, queue watchdogs,
cleanup sweeps: each is a registered routine firing on its own interval.
You rarely touch them, but knowing they exist explains a lot of "who did
that?" moments — the answer is often "a routine".

## Details

The difference from loops: a **loop** is an *agent* re-waking to think about
an open-ended goal; a **routine** is *system machinery* running a defined job
on a schedule — no conversation, no improvisation. Loops are actually built
on the routines engine: arming a loop registers a routine whose job is
"re-wake that agent".

Routines are durable (they survive restarts, living in the database) and
inspectable — the GUI lists what is registered, when each last fired, and
whether it succeeded. When something recurring misbehaves — say commits stop
landing — the routine's fire history is the first place an agent looks.

You can ask an agent to schedule recurring work for you too ("re-run this
check every hour"); it will register it properly through the platform so the
job is visible and manageable, never a hidden timer.
