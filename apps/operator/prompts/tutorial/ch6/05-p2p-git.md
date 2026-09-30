---
id: ch6-05-p2p-git
chapter: 6
order: 5
title: Peer-to-peer git — replicating code without a central remote
docSlugs: system/pot-git-sync
---

## Brief

**Wired behind an explicit per-Pot mode, but not yet public-release-ready.**
The shared working tree that git-sync commits (chapter 5) can replicate
directly between a Pot's machines over the encrypted p2p channel. The current
signed release verdict remains **NO-GO** until the physical-rig acceptance
sequence and its 72-hour soak are green.

## Details

Honest labeling first: the production replication legs are wired, but the
feature is still release-gated. Today a Pot with no explicit setting runs in
`legacy` mode, where each member's git-sync pushes the configured remote.
Operators can instead choose `bridged` (p2p replication plus a GitHub mirror)
or `p2p-only` (p2p replication with no GitHub egress). Do not read a successful
single-box drill or one clean peer transfer as a public-release sign-off.

The design extends git-sync's existing rhythm. You've seen that agents never
commit — a background routine sweeps the tree on a schedule. In the p2p
version, each sweep also announces new commits to peers over the encrypted
network, and peers fetch objects directly from each other. Git's content-
addressed model is a natural fit: commits are immutable, verifiable blobs,
so replication is just "who has which objects," and any peer can serve any
other.

Why bother, when GitHub exists? Resilience and privacy: a Pot that fully
replicates its own history keeps working — including merges, deploys, and
the green gate — with no internet, and code never has to leave machines you
own. A conventional remote becomes an optional mirror rather than a
dependency.

Until the signed gate turns green, new Pots remain on the conventional remote
path unless an operator deliberately changes `hiveGit.mode`. The day-2 mode,
rollback, and evidence checks live in the hive-git P2P ops runbook; the signed
GO/NO-GO map remains the authority for release claims.
