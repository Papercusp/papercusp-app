---
id: create-lightweight-subpath-exports-to-avoid-side-effect
title: "Create lightweight subpath exports to avoid side-effect imports in test helpers"
kind: feedback
type: feedback
applies_to: [any]
---
When a shared test-helper barrel export pulls in unrelated dependencies with module-scope side effects (such as mocking libraries that touch globals), create a lightweight subpath export that re-exports only the needed utilities without those dependencies. Apply this pattern repo-wide wherever the full barrel is imported solely for a subset of helpers, to eliminate spurious warnings and avoid polluting test globals.

Provenance: recurred 17× across the fleet — adopted from the fleet candidate queue.
