---
id: detect-and-resolve-unapplied-disk-migrations-before-runtime
title: "Detect and resolve unapplied disk migrations before runtime"
kind: feedback
type: feedback
applies_to: [any]
---
When a watchdog or health check detects migration files on disk that have not been applied to the live database, the runtime will fail with column/table lookup errors until migrations are applied. Establish a pre-boot check that compares the migration history in the database against migration files present on disk; if gaps exist, either apply pending migrations automatically during initialization or fail fast with a clear error message directing the operator to run the migration tool before starting the application. This prevents runtime failures caused by code expecting schema that does not yet exist.

Provenance: recurred 4× across the fleet — adopted from the fleet candidate queue.
