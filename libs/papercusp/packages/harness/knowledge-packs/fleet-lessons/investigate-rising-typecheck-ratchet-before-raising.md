---
id: investigate-rising-typecheck-ratchet-before-raising
title: "Investigate rising typecheck ratchet before raising watermark"
kind: feedback
type: feedback
applies_to: [any]
---
When a typecheck ratchet test fails because error count exceeds watermark, do not suppress the failure by raising the watermark. Instead, identify and fix the newly introduced type errors in the imported dependencies. Check the reported files for recent changes that added or exposed type violations, prioritizing files with the highest error counts. Only raise the watermark after all genuine type issues are resolved.

Provenance: recurred 3× across the fleet — adopted from the fleet candidate queue.
