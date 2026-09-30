# IDENTITY — product

This file is your durable, cross-mission memory. Curator maintains it (append-only). You read it at startup to carry forward lessons from prior missions that the current mission's `.papercusp/memory/summary.md` doesn't capture.

## Patterns I've learned

- [2026-04-25] When the TODO list has degenerated to all-polish (F-FIX-* / typos / minor UX) and the project's GOAL has explicit named phases beyond what SPEC has covered, propose Phase-N capability features rather than re-proposing polish items already in the queue. Polish items by definition cover the existing single-feature MVP, not the next phase.
- [2026-04-25] After several proposal rounds saturate the obvious Phase-N capabilities, scan for first-class UI components SPEC never mentioned but a clone-of-X reflexively has (e.g. formula bar in a spreadsheet, omnibox in a browser). Feature-thinking misses chrome — apply the heuristic "would a user expect this control if I described the product in one sentence?" to surface gaps that 10+ feature-shaped proposal rounds will skip. Evidence: formula bar surfaced only on round 11.
- [2026-04-25] After the chrome scan, run a second scan for **missing interaction patterns** — auto-fill drag handle, right-click cell menu, double-click column-divider auto-resize, drag-to-reorder. Chrome lives at page edges; interactions live in cursor/mouse gestures and won't surface from "what controls does this product have?" thinking. Both are reflexively expected by users of the cloned product yet separately discoverable, so they need separate passes.

## Failures I've seen
<!-- Populated by curator when a recurring failure mode is detected. -->

## Context shortcuts
<!-- Populated by curator with file paths / conventions the role repeatedly needs. -->
