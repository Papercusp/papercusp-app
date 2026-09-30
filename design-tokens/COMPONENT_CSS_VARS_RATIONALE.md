# Why component-scoped CSS vars in globals.css are NOT migrated to DTCG

**TL;DR:** They aren't design tokens. They're CSS scoping mechanisms. Migrating
them would be a category error.

## What the audit flagged

The 2026-05-13 audit listed: *"Component-tier desktop CSS vars (~217 in non-:root selectors) not migrated; out of v1 scope"*.

After analysis: 232 declarations across 68 unique names, all scoped to specific
component selectors (`.operator-entry`, `.operator-life--accepted`,
`.operator-card-action--ghost`, etc.).

## Why they shouldn't be tokenized

A **design token** is a named, semantically-meaningful value reused across many
contexts. Tier 3 (component tokens) is for shared values like `button-primary-bg`
that have a stable name across surfaces.

What's actually in `globals.css` non-`:root` selectors:

```css
.operator-life {
  --operator-life-accent: var(--accent);
}
.operator-life--accepted { --operator-life-accent: var(--good); }
.operator-life--rejected { --operator-life-accent: var(--bad); }
.operator-life--dismissed { --operator-life-accent: var(--fg-mute); }
```

These are **state-overrides**, not tokens. The pattern is:
1. A component declares a CSS custom property scoped to itself
2. Variant classes override that property with different semantic-token references
3. The component's children consume `var(--operator-life-accent)` once

This is the *correct* CSS-only pattern for component state theming. Moving these
to a JSON token store would:

- Add ~68 single-instance names with no cross-platform parallel (mobile doesn't
  have `--operator-life-accent` — it has Compose/SwiftUI conditionals)
- Require a separate runtime mechanism to apply them (CSS scoping is the
  mechanism; DTCG tokens don't have scoping semantics)
- Make state-variants harder to discover (a Compose dev reading
  `mobile.component.tokens.json` would see foreign concepts that don't apply)

## What these vars already do right

They consume tier-1 and tier-2 tokens correctly:

```css
.operator-life--accepted { --operator-life-accent: var(--good); }
                                                   ^^^^^^^^^^^^
                                                   semantic token (DTCG)
```

If you retune `--good` (i.e., edit `desktop.semantic.tokens.json`), every
`.operator-life--accepted` re-themes for free. The component vars are
*correctly* wired to the token graph.

## When would they migrate?

Three triggers would change this analysis:

1. **Cross-platform component parity.** If mobile gets the same
   `.operator-life--accepted` semantics in Compose/SwiftUI, we'd want a
   shared token to drive both. Today mobile has no equivalent.
2. **Component variants exposed in a design tool.** If a designer wants to
   edit `operator-life-accent` per-variant in Figma/Tokens Studio, then DTCG
   tier-3 makes sense. Today designers don't.
3. **More than 5 truly-shared component values.** If the same value were
   reused across `.operator-life`, `.operator-card`, `.operator-stream` etc.,
   that's a shared concept worth naming. Today each name is local.

Until any of those land, the current pattern is correct.

## Concrete evidence

`python3` analysis of `globals.css` (excluding `:root` and `@keyframes`):

| Metric | Count |
|---|---|
| Total `--var: value` declarations | 232 |
| Unique names | 68 |
| Names used in ≥3 selectors | 25 |
| Names used in only one selector | 36 |

Of the 25 "reused" names, all uses are *variant overrides of the same
component* (e.g., the same name appearing in `.operator-life`,
`.operator-life--accepted`, `.operator-life--rejected`, etc.) — they are
component-local, not cross-component.

## Decision

**Leave globals.css component vars as-is.** They are the right tool for the
job. The audit item is hereby reclassified from "not migrated; out of v1
scope" to **"not a migration target."**
