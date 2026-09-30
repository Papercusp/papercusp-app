# Two emitters in one prompts dir — managed markers must be mutually non-containing
URL: /internal/docs/agent-insights/shared-prompt-dir-managed-markers

Codex's flat $CODEX_HOME/prompts dir is written by BOTH the saved-prompts materializer and the slash-tool emitter. Each writer's prune deletes any .md carrying ITS marker that isn't in ITS keep-set, and ownership is a substring check — so a second emitter reusing (or containing) the first's marker gets its files deleted by the other's prune. Mint a disjoint marker and pin mutual non-containment with a test.

## What

Two independent launch-time emitters write managed `.md` files into the
same flat directory (`$CODEX_HOME/prompts`):

1. **saved-prompts** (`saved-prompts-projection.ts`) — user-authored
   prompts, marker `<!-- papercusp:managed -->`.
2. **slash-tool prompts** (`slash-tool-prompts-codex.ts`,
   plan `slash-exposure-tool-catalog-2026-06-12`) — one file per
   session-visible tool, marker `<!-- papercusp-slash-tool:managed -->`.

Each emitter ends with a **prune**: delete every `.md` whose basename is
not in *its* keep-set **and** which it *owns*. Ownership is
`readFileSync(path).includes(MARKER)` — a plain substring check.

## The gotcha

If a second emitter reuses the first's marker (the "obvious" move), or
mints a marker that **contains** the first's marker as a substring, the
first emitter's prune sees the second's files as its own strays and
deletes them all on the next launch. The failure is silent,
order-dependent, and looks like "my files randomly disappear between
sessions."

Hand-authored files are safe either way (no marker → never touched);
the trap is strictly between managed writers.

## How to apply

* A new emitter into a shared managed dir mints its **own marker**, and
  the two strings must be **mutually non-containing** (check both
  directions — `includes` has no word boundaries).
* Pin it with a test, so a future marker rewording can't silently
  re-introduce the overlap:

```ts
expect(SLASH_TOOL_MARKER.includes(MANAGED_MARKER)).toBe(false);
expect(MANAGED_MARKER.includes(SLASH_TOOL_MARKER)).toBe(false);
```

* Also pin the cross-prune behavior: run writer A's prune with an empty
  keep-set over a dir populated by writer B, and assert B's files
  survive (see `slash-tool-prompts-codex.test.ts` "marker independence").
