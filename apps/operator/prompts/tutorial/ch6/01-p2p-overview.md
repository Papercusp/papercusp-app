---
id: ch6-01-p2p-overview
chapter: 6
order: 1
title: The peer-to-peer vision — many machines, one Pot
docSlugs: spec/multi-topology, spec/distribution
---

## Brief

**Everything in this chapter is under construction — it describes where
Papercusp is going, not what it reliably does today.** The vision: several
machines — your laptop, a desktop, a tower in the closet, a teammate's box —
form one **peer-to-peer Pot**. Work, agents, accounts, and even GPU time
flow to wherever they're best served, with no central server anywhere.

## Details

To be explicit up front: **this is the aspirational chapter.** The p2p
substrate exists and parts of it work in test rigs (machines already sync
coordination state over an encrypted peer network), but the features described
in the next four sections are being actively built and should not be relied
on yet. They're in the tutorial because they explain the design decisions
you've already seen — why state lives in durable, syncable stores, why
coordination is message-based, why nothing assumes a single machine.

The shape of the goal: you install Papercusp on a second machine, pair it
with your first, and they become one system. Plans, work items, and memory
replicate both ways; an agent on either machine can see and coordinate with
agents on the other. No cloud relay, no account with a vendor — machines
find each other and talk directly, encrypted end to end.

The sections that follow cover the individual capabilities being built on
that substrate: GPU allocation, account allocation, cross-machine agent
delegation, and peer-to-peer git. Each one repeats this disclaimer, because
it's the honest state: designed, partially built, not yet dependable.

## Public v1 claims

The release contract keeps **support**, **trust**, and **readiness** separate. A
capability can be implemented in source while still requiring an explicit trust
choice or a signed, current artifact before it is a public claim.

| Capability | Supported claim | Trust boundary | Readiness claim |
| --- | --- | --- | --- |
| Data collaboration | Supported for paired Pot members | Encrypted peer membership and owner admission | Claim only with current artifact evidence for the expected peer set |
| Peer Git | Supported behind the per-Pot `hiveGit.mode` setting | Members choose legacy, bridged, or p2p-only egress | Physical acceptance and the signed release profile must be current |
| Trusted delegated seats | Supported for explicitly opted-in trusted hosts | Host allowlists, bounded seats, accounts, duration, and spend | Claim only after a real first-turn receipt and revoke path are evidenced |
| Opt-in memory | Available as an explicit capability when enabled | Memory scope follows the Pot and its owner policy | Do not imply universal federation; publish only measured scope |
| Optional media | Optional capability input | Media remains opt-in and host-scoped | Default-on media is not a v1 readiness claim |

The v1 contract explicitly excludes retired generic work offers, a public
untrusted compute marketplace, universal memory federation, default-on media,
billing or metering, and 256-peer validation until each has an independent
implementation and acceptance record. Do not summarize this table as “all P2P
features shipped”; the current release manifest and signed profile are the
authority for readiness.
