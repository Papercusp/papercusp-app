---
id: ch5-04-dogfooding
chapter: 5
order: 4
title: Dogfooding — Papercusp builds itself
docSlugs: agent-insights/dogfood-bootstrap
---

## Brief

Papercusp is built *by* Papercusp: its own development runs through the same
pots, queues, agents, and gates you just learned. The practical payoff for
you: **don't like something? tell an agent to fix it.** Your complaint
becomes a work item in the same system, and often ships within days.

## Details

This is why the platform has the self-learning machinery of chapter 4 — the
builders live inside the product, so friction gets felt and filed
constantly. It's also why the environment controls exist: the GUI's
dev/staging/production surfaces let the team run candidate versions of
Papercusp against itself before promoting them, and feature flags gate new
behavior so it can be flipped on (and off) at runtime rather than shipped
irreversibly.

Feature flags deserve one sentence more: every meaningful new capability
lands behind a named flag, defaulting ON when finished — flags exist for
fast reversal and staged cutover, not for shipping dark. The GUI lists them
all, and flipping one is instant.

None of this requires your participation — but it explains the occasional
"the app improved overnight" experience, and it's your license to be
demanding: requests are cheap to file and the pipeline that handles them is
the product itself.
