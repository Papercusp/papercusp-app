# Workspace design tokens

Canonical source of truth for cross-platform brand-palette tokens. Consumed by desktop (CSS) directly and by mobile (Kotlin/Swift) via mirror.

## Files

| File | Purpose | Editable? |
|---|---|---|
| `primitives.tokens.json` | Workspace brand palette — sky/emerald/amber/gold/rose/slate. **Canonical for all platforms.** | Yes (treat as the source of truth) |
| `desktop.semantic.tokens.json` | Desktop `--bg`/`--accent`/`--warn` etc. with primitive aliases | Yes |
| `desktop.component.tokens.json` | **Not present yet.** Component-tier tokens will land here when extracted from `globals.css` (~217 component-scoped CSS vars). SD v4 errors on source files with zero tokens, so we don't ship an empty placeholder — add the file with real entries when migration starts. | — |
| `style-dictionary.config.mjs` | SD v4 build config emitting two CSS files | Rarely |
| `IMPLEMENTATION_PLAN.md` | The shipped plan with phase breakdown | Frozen — historical record |
| `PHASE5_HARNESS_HANDOFF.md` | Handoff doc for the deferred harness adapter unification | Update when Phase 5 starts |

## Generated outputs (DO NOT EDIT)

- `apps/operator/app/_brand-primitives.css` — workspace brand palette as CSS vars
- `apps/operator/app/_semantic.css` — desktop semantic + ink layer

Both are imported at the top of `apps/operator/app/globals.css`.

## Build

```bash
pnpm tokens                     # regenerate the two CSS files
```

`pnpm dev:operator` does NOT auto-run this — re-run `pnpm tokens` after editing any token JSON.

## Tooling

Style Dictionary transforms (`restart/srgb`, `restart/name`) and the
preflight guards come from **[`@papercusp/token-kit`](../libs/token-kit/)** —
a generic, brand-value-free shared library co-owned with Restart's
`@papercusp/design-tokens`. Only the papercup-specific token JSON values + the
SD platform wiring (in `style-dictionary.config.mjs`) live here.

To pick up upstream kit changes:

```bash
git submodule update --remote libs/token-kit
npm install
pnpm tokens         # re-emit and visually verify the diff
```

## Editing brand colors

The same brand palette is used by mobile via mirror. To retune:

1. Edit `primitives.tokens.json` (or `desktop.semantic.tokens.json` to remap a desktop semantic)
2. Run `pnpm tokens` in this repo
3. Run `make tokens` in the sibling `papercup-rust-mobile/` repo (the `mirror.mjs` step will pull your changes and regen Kotlin/Swift)
4. Commit both repos

If you ONLY edit desktop semantics (not primitives), mobile doesn't need to be touched.

## DTCG quick reference

```json
{
  "color": {
    "accent":       { "$value": "{color.sky.400}", "$type": "color" },
    "accent-soft":  { "$value": "#38BDF824",       "$type": "color", "$description": "{color.sky.400} @ 0.14" }
  }
}
```

- `$value` — the value or `{path.to.token}` alias
- `$type` — DTCG type (color/dimension/duration/etc.)
- `$description` — free-form; we use it to document the source semantics for pre-baked alpha values (8-digit hex form)

## Why two yellows

`amber.400` (#FBBF24, Tailwind) is used by desktop's `--warn`. `gold.400` (#F6C453, Papercusp custom) is used by mobile's warning. They serve the same role but are visually different. Both live in primitives — the divergence is intentional and flagged in `$description` lines. To unify in the future, decide which value is canonical and migrate the other surface.

## Known gotchas (from migration)

- **No semantic token can share a path with a primitive group at the same depth.** SD v4's tree merge sets `$value` alongside children and color transforms skip parents-with-children. Hit twice during Phase 1 (`color.ink`/`color.shade.*`, `color.gold`/`color.gold.400`). If you add a semantic named `X`, make sure there's no primitive group `color.X.*`.
- `transitive: true` on transforms double-transforms aliased values. Keep transitive off.
- `$schema` and `_meta` keys collide if duplicated across source files. Keep them in `primitives.tokens.json` only.
