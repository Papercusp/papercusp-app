---
id: ch1-01-server-gui-tutorial
chapter: 1
order: 1
title: Server, GUI & Tutorial — the three icons
docSlugs: system/repo-conventions
---

## Brief

Papercusp installed three icons: the **Server** (the engine — it runs the
database, the agents, and everything else; leave it running), the **GUI**
(a desktop window for settings and for browsing what your agents have been
doing), and this **Tutorial**. The thing to internalize on day one: you
*direct* Papercusp from a terminal, by talking to an agent — the GUI is your
inspection surface, not your steering wheel.

## Details

The Server is a desktop app with an embedded Postgres database and an
operator process. Everything durable — your projects, work queues, agent
memory, coordination state — lives there, locally on this machine. Agents,
the GUI, and this tutorial all talk to that one server, so as long as it is
running, every surface sees the same live state.

The GUI is deliberately the *secondary* surface. It is excellent for two
things: adjusting settings (accounts, API keys, feature flags, backups) and
browsing state and history (what agents did, what work is queued, how plans
are progressing). Day-to-day direction of work — "build this", "fix that",
"investigate this" — happens in a terminal chat with an agent, exactly like
this conversation.

The Tutorial icon re-opens this guided tour any time, and it resumes where
you left off — so feel free to finish early today and come back later.
