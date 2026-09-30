---
id: ch6-03-account-allocation
chapter: 6
order: 3
title: Account allocation — sharing inference capacity between machines
docSlugs:
---

## Brief

**Under construction — this does not reliably work yet.** The plan: extend
the inference gateway's account pool (chapter 5) across the whole Pot, so
credentialed accounts attached to any machine can serve sessions on every
machine — one shared budget, one governor, Pot-wide.

## Details

To restate the disclaimer plainly: **cross-machine account allocation is
still being designed and built.** Today each machine routes only through the
accounts configured on that machine.

The single-machine version already exists and you've met it: the gateway
pools several accounts, routes each session to the best one, and fails over
around rate limits. The p2p extension makes that pool a Pot resource. Your
laptop, with no accounts of its own, borrows capacity through the tower's
gateway; the rate governor sees aggregate usage across every peer so one
machine can't silently exhaust an account the others depend on; billing
attribution still traces each session to the account that served it.

The hard parts — and the reason this is under construction — are the
distributed ones: credentials must never leave their home machine (peers
proxy requests, they don't copy keys), usage accounting has to stay correct
when peers disconnect and reconnect, and failover across a network hop has
different latency trade-offs than failover in-process.

Until it lands: configure accounts per machine, and use the existing
`default` / `auto` / pin choices when launching agents.
