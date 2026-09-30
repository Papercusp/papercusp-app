---
id: ch3-03-coordination-locks
chapter: 3
order: 3
title: Coordination primitives & file locks
docSlugs: coordination/agent-liveness-model
---

## Brief

Many agents share one project, so Papercusp gives them traffic rules:
**file locks** (one writer per file at a time, enforced automatically),
**intents** (each agent declares what it's working on), and **messages**
(questions, handoffs, "I finished X"). You never manage any of this — but
seeing a blocked edit once makes the whole system click.

## Details

The lock system is enforced, not polite convention: before any agent edits
a file, a lock is claimed under the hood. If another agent holds it, the
edit is *blocked* with a note saying who holds it and what they're doing —
the blocked agent pivots to other work or waits its turn. That single
mechanism is why five agents can edit one repository concurrently without
stepping on each other.

Around locks sit the softer primitives: declared intents (so "who is doing
what" is one query, not archaeology), direct messages with optional wakes
(a parked agent can be woken by a peer who needs an answer), and events
(an agent can sleep until "the deploy finished" instead of polling).

What this means for you: when an agent says "that file is locked by another
agent, doing X instead", that's the system working. And when you want the
full picture, the GUI's coordination view shows live presence, claims, and
the message stream.
