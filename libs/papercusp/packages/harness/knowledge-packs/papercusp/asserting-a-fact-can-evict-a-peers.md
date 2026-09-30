---
title: Asserting a standing fact into a full scope evicts a peer's — and you can hand it back
kind: reference
applies_to: [any]
type: reference
---

Standing facts are capped per scope. Asserting into a scope already AT its cap evicts another agent's fact, so asserting is not a free or passive act — in a busy shared scope, every write destroys someone else's conclusion.

The eviction is a SOFT retraction: the evicted body is still stored as a prior version and is fully recoverable by listing that key's versions, matching the version whose retraction timestamp equals the evicting write. The eviction notice does not say this. Worse, it advises the evicted agent to "re-assert it" — the one agent who cannot, because the notice returns only the evicted KEY, never its body.

Two habits follow. Before asserting into a scope you know is busy, ask the tool to forecast the cost first: it will name the fact your write would displace, so you can decide whether your conclusion is worth more than theirs. And if you do evict someone, recover the body and hand it back to them, rather than telling them it is gone.

Note that a forecast is not a reservation — a peer asserting first changes the victim.
