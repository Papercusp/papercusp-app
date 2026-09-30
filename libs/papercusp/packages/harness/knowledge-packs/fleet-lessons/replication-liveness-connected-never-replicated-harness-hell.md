---
id: replication-liveness-connected-never-replicated-harness-hell
title: "Detect replicator attachment without ingestion as silent divergence risk"
kind: feedback
applies_to: [any]
domains: [replication, distributed-systems]
type: feedback
---
A log may report peer_connected status while its replicator never ingests operations, causing silent write divergence. Monitor for connections that remain attached to a replicator but ingest nothing for the grace period; this indicates the writer is ahead and merging has stalled. The swarm-level connection health check will not catch this zombie-replicator state. Trigger an alert or recovery action when a replicator attachment duration exceeds the grace window with zero operations merged.

Provenance: recurred 5× across the fleet — adopted from the fleet candidate queue.
