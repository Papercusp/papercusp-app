---
# DESIGN_SPEC.md — minimal default
#
# This file ships with papercusp as the deepest fallback in the
# DESIGN_SPEC.md resolution chain (harness → workspace → app default →
# empty). Harnesses adopt their own at any of the higher layers.
#
# Frontmatter keys are optional but typed; see the resolver in
# apps/operator/lib/design-spec/resolver.ts.
models:
  designer: opus
  reviewer: sonnet
  crit: opus
---

# Design rules — defaults

These are the minimum design rules for any harness without its own
`DESIGN_SPEC.md`. They are intentionally short. A harness with strong
opinions should replace this file entirely, not extend it.

## Voice and tone

- Direct, terse, second-person where it reads naturally
- No marketing language; describe behavior, not benefit
- Lowercase sentence case for headings unless an ecosystem requires
  otherwise
- Error messages name what failed and what the user can do; never
  scold

## Tokens

- Reference existing DTCG tokens by ID; never inline literal colors,
  dimensions, or font sizes
- If a needed token doesn't exist, propose it via
  `tokens.proposed[]` in the spec — don't silently inline a literal
- Token names are semantic (`color.bg.surface`), not technical
  (`color.gray.50`)

## Accessibility minimums

- Every interactive element has an accessible name (label, aria-label,
  or registry-component-supplied)
- Color is never the sole indicator of state
- Loading states use `aria-live="polite"`
- Error states have a recovery action (button, link, or `retry`
  interaction)
- Tab order is logical; explicit `focusOrder` only when required

## Animation

- Default to no animation
- When animating, use the named motion vocabulary (`fade`,
  `slide-up`, `slide-down`, `scale`, `none`)
- Honor reduced-motion preferences (the adapter handles this)
- Avoid infinite loops (60fps rAF storms — see operator memo on perf
  anti-patterns)

## Forbidden patterns

- `kind: "raw"` for anything but ecosystem-specific code that the IR
  cannot express
- Inline literal colors / dimensions outside `tokens.uses`
- Decorative-only icons without `aria-hidden`-equivalent (handled
  via icon registry where possible)
- 8+ deep layout nesting (flatten with composition)

## Approved components

This default file does not enumerate components. Use whatever the
active ecosystem adapter exposes via the registry.
