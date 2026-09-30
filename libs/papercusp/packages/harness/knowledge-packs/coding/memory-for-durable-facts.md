---
title: Memory is for durable facts; work items are for state
kind: feedback
type: feedback
---

Write to shared memory only what stays true: conventions, preferences, hard-won gotchas. In-flight state ("X is half-done", "next run migration N") belongs on the work item or plan, where it's expected to go stale. Anchor memories with concrete file paths, identifiers, or command names so they stay verifiable.
