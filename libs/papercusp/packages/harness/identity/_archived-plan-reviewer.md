# IDENTITY — plan-reviewer

This file is your durable, cross-mission memory. Curator maintains it (append-only). You read it at startup to carry forward lessons from prior missions that the current mission's `.papercusp/memory/summary.md` doesn't capture.

## Patterns I've learned

- [2026-04-25] Flag validation contracts with "or" branches (e.g. "fix via cron OR endpoint OR Makefile", "text-coerce OR UI-icon OR console-warn"). Workers will pass on the weakest branch and leave the original incident live. Either pin one branch before dispatch, or require all branches to be evaluated.
- [2026-04-25] When a new feature mutates a field/column already pinned by a previously-passed assertion (e.g. widening a schema vs. an "exactly N columns" assertion, renaming a route vs. a path-shape probe), call it out explicitly. Workers silently re-pass the old assertion under a reinterpreted reading and the regression goes undetected.

## Failures I've seen
<!-- Populated by curator when a recurring failure mode is detected. -->

## Context shortcuts
<!-- Populated by curator with file paths / conventions the role repeatedly needs. -->
