---
id: ch6-04-agent-delegation-cross-machine
chapter: 6
order: 4
title: Cross-machine delegation — agents handing work between peers
docSlugs: spec/cross-harness-coordination
---

## Brief

**Still being built — treat everything here as a preview.** The goal: the
coordination you saw in chapter 3 (claims, handoffs, wakes, fleets) works
identically when the two agents live on different machines — an agent on
your laptop delegates a task to an agent on the tower as easily as to one in
the next terminal.

## Details

Being explicit again: **cross-machine delegation is actively under
construction.** Pieces work in test rigs — peers already replicate
coordination state (presence, claims, messages) over the encrypted network —
but end-to-end "delegate a task to another machine and get the result back"
is not yet something to depend on.

The design leans on a choice made long ago: all coordination is durable
messages and shared state, never in-process calls. That's why this is
buildable at all — a claim, a handoff, or a wake is a record that
replicates, so the same verbs work whether the recipient is local or
remote. An agent claiming an item off the queue doesn't need to care which
machine filed it; a fleet leader's monitoring loop reads the same assignment
tables either way.

What that unlocks when finished: overnight work migrating to the always-on
machine, a beefy desktop absorbing a laptop's heavy builds, and one
project's Fleet spanning every computer you own.

Until then, delegation stays within one machine, and multi-machine setups
coordinate through the synced state that already replicates — which the next
section (p2p git) is a key part of.
