---
id: ch5-08-inference-gateway
chapter: 5
order: 8
title: The inference gateway — accounts, routing, and cost
docSlugs: agent-insights/gateway-pin-and-tier-semantics
---

## Brief

Every agent's LLM calls bill to a credentialed account, and Papercusp can
pool several behind an **inference gateway** that routes each session to the
best available account and fails over when one hits a rate limit. When you
launch agents you choose: the **default** system account (simplest), **auto**
gateway routing (best for fleets), or a **pin** to one named account
(predictable billing).

## Details

The gateway exists because one account's rate limit is the practical ceiling
on how many agents can run at once. Pooling raises that ceiling: sessions
spread across accounts, a rate-limited account rotates out automatically,
and a governor keeps aggregate usage inside each account's budget. The
gateway prefers keeping a session on the same account across turns (that
keeps prompt caching effective, which is real money).

The three routing choices trade off simply. `default` skips the gateway
entirely — fine for one or two interactive sessions. `auto` is the right
answer for fleets and heavy autonomous work. Pinning is for when you need
one workload's usage cleanly attributable to one account.

Agents announce which account and model they're spawning fleets with — if
you have a preference, say it in one line ("use auto", "pin to the API
account") and it's applied.
