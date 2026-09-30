---
id: detect-and-fix-character-limit-regressions-in-guidance
title: "Detect and fix character-limit regressions in guidance budgets during test failures"
kind: feedback
type: feedback
applies_to: [any]
---
When a guidance-budget test fails with a 'hard cap exceeded' error, the root cause is typically a recently added or modified guidance string that now exceeds the configured character limit. Check recent commits touching guidance content or budget definitions; identify which guidance key(s) are over the limit (the error message names them); trim the guidance text for that key until it fits within the hard cap. Character limits exist to prevent token bloat in constrained contexts—verify the trimming preserves intent before committing the fix.

Provenance: recurred 4× across the fleet — adopted from the fleet candidate queue.
