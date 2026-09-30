---
id: verify-queue-lock-directory-exists-before-tool-invocation
title: "Verify queue lock directory exists before tool invocation"
kind: feedback
type: feedback
applies_to: [any]
---
When a queue-locking tool returns ENOENT errors on scandir operations, the lock directory itself or a required parent has been deleted or never created. Before invoking queue operations, verify the lock directory path exists and is readable; if missing, create it with appropriate permissions. This deterministic error (not transient) indicates misconfiguration or cleanup race rather than load, and recurs identically across invocations until the directory is restored.

Provenance: recurred 3× across the fleet — adopted from the fleet candidate queue.
