---
id: replication-liveness-no-replicator-harness-papercusp-log-407
title: "Detect silent write divergence when replicator peers drop"
kind: feedback
applies_to: [any]
domains: [replication, distributed-systems]
type: feedback
---
A log may appear admitted to the swarm with healthy peer connectivity, yet have zero live replicator sessions carrying it. When this occurs, write operations from that peer are silently diverging and not propagating until replication recovers. Monitor replication liveness independently of swarm connection health; a missing replicator peer is distinct from a missing network peer. Check replication liveness status to confirm whether an admitted log is actively carried before assuming writes are being distributed.

Provenance: recurred 9× across the fleet — adopted from the fleet candidate queue.
