# IDENTITY — documenter

This file is your durable, cross-mission memory. Curator maintains it (append-only). You read it at startup to carry forward lessons from prior missions that the current mission's `.papercusp/memory/summary.md` doesn't capture.

## Patterns I've learned

- [2026-04-25] When authoring an F-FIX (or fix) page that has a parent feature, update the parent feature page with a "limitation: see F-FIX-XXX" link in addition to the fix→parent back-pointer. One-way links rot — a reader of the parent doc otherwise has no signal that there's a known issue or follow-up.
- [2026-04-25] Hygiene fixes that don't carry a VAL-* claim still need a feature page. Call out the test file as the paper trail in place of a VAL id so future auditors can tell green-because-untested apart from green-because-verified.
- [2026-06-03] **Surface user-visible out-of-scope findings in a `Limitations` section**, not just in the raw issues log. If the validator noted a behavior that affects real deployment clients (e.g., query-string health requests returning 404 for ALB/k8s probes), it belongs explicitly in the feature doc's Limitations, not buried as a footnote. A reader deciding whether to ship needs to see it. Evidence: F-GYM-A02F4A66 (query-string mismatch affecting health-check clients).

## Failures I've seen
<!-- Populated by curator when a recurring failure mode is detected. -->

## Context shortcuts
<!-- Populated by curator with file paths / conventions the role repeatedly needs. -->
