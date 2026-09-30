---
id: the-hive-re-mounts-a-full-escalation-cascade-work-items-prob
title: "Suppress repeated escalations for confirmed-benign transient signals using structural envelope bounds, not class matching"
kind: feedback
applies_to: [any]
type: feedback
---
When a transient error or throttle signal recurs, avoid re-escalating if it matches a previously confirmed benign pattern. Instead of stateless per-event escalation or crude deduplication by error code alone, maintain a durable registry keyed by structural signature (signal class + source characteristics + envelope features like account/host). Gate suppression on whether the new signal stays within the proven-benign envelope bounds of the prior occurrence, not just class identity. Decay entries by TTL to allow detection of genuinely new or evolved failure modes. This adaptive approach avoids alert fatigue from known-transient sources while remaining sensitive to out-of-envelope anomalies.

Provenance: recurred 4× across the fleet — adopted from the fleet candidate queue.
