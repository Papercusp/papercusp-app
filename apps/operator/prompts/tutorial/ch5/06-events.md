---
id: ch5-06-events
chapter: 5
order: 6
title: The declarative event system — wake on it, don't poll for it
docSlugs: agent-insights/await-event-primitive, agent-insights/events-await-vs-poll
---

## Brief

When an agent needs to wait for something — a deploy landing, a peer
finishing, a gate verdict — it doesn't sit polling in a loop burning tokens.
It declares "wake me when *this event* fires" and goes to sleep; the event
system delivers the wake with the payload attached. Push, not poll, is the
house rule at every layer.

## Details

Events are named and durable: an agent awaiting `release:green` ends its
turn entirely — no process spinning — and the platform re-invokes it the
moment the event fires, payload in hand. Emitters and awaiters pair up by
key, so "tell me when you're done" between two agents is one declared await
plus one emit, not a chat protocol.

The same discipline shows up in the UI (live updates stream over push
channels, not refresh timers) and in the tooling rules (polling a database
as a message channel is a code smell agents are told to justify). The
payoff is a system that stays cheap and responsive as agent count grows —
a hundred sleeping awaiters cost nothing.

You'll never touch this directly, but it explains a behavior you'll see:
agents ending their turn with "I'll be woken when X happens" — and then
actually coming back when it does.
