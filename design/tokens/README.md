# Design tokens (DTCG)

Token store for the design phase. Read by:

- The design-phase plugin's `list_tokens` / `read_token` MCP tools
  (designer + implementer agents)
- The Token inventory pane in the design tab
- (future) `papercusp-design-react-tailwind`'s `tokens.emit()` for
  CSS vars + Tailwind preset codegen

## Files

- `base.json` — design-phase token inventory for the live operator
  semantic theme contract. It mirrors the tokens documented in
  `/internal/docs/design/tokens` and generated into
  `apps/operator/app/_semantic.css` (`--bg`, `--fg`, `--accent`,
  `--good`, `--warn`, `--bad`, etc.). Keep IDs semantic
  (`color.bg.page`, `color.accent.default`, `space.md`, …) and name the
  matching CSS custom property in `$description`.
- `seeded-from-harness-css.json` — seed produced by the
  `seed-dtcg-from-css.mjs` script (plan §17.5 step A). NOT a final
  store; its keys mirror the original CSS var names. Use as input to
  the human-driven semantic rename pass (step B).

## Source of truth

The operator's shipped theme is still generated from
`design-tokens/*.tokens.json` through Style Dictionary. `base.json` is
the DTCG view exposed to design-phase tools and agents; do not let it
drift into a separate palette. When the semantic token source changes,
update `base.json` in the same change (or regenerate it once the
design-phase token emitter is wired).

## Workflow (plan §17.5)

```
       ┌────────────────────────┐
       │ harness.css            │
       └──────────┬─────────────┘
                  │  step A
                  ▼
       ┌────────────────────────┐
       │ seeded-from-           │
       │   harness-css.json     │  (technical names: h.topbar.surface)
       └──────────┬─────────────┘
                  │  step B (human / agent semantic rename)
                  ▼
       ┌────────────────────────┐
       │ base.json              │  (semantic: color.bg.page → --bg)
       └──────────┬─────────────┘
                  │  step C
                  ▼
       generated CSS vars + Tailwind preset
                  │  step D
                  ▼
       Lost Pixel verifies no regression
```

Step A is automated. Step B is the design judgment call — no tool
replaces it. The operator's production CSS is currently generated from
`design-tokens/*.tokens.json`; `base.json` is the design-phase DTCG
inventory that must stay aligned with that semantic layer.

## Running the seeder

```sh
node apps/operator/scripts/seed-dtcg-from-css.mjs \
  apps/operator/app/harness/harness.css \
  libs/papercusp/apps/web/app/harness/harness.css \
  --out=design/tokens/seeded-from-harness-css.json --force
```

Stats are printed to stderr. For the operator harness today: ~42
unique custom properties produced from ~391 declarations across the
two harness.css files (most are color values; many are
re-declarations across light/dark/responsive scopes).

## Editing `base.json`

Strict DTCG: every leaf has `$type` and `$value`. Groups have
neither. Mixing is invalid (the seeder pushes leaf-with-children to
`.default` to handle this).

Allowed `$type` values: `color`, `dimension`, `duration`,
`fontFamily`, `fontWeight`, `number`, `shadow`, `cubicBezier`. See
the design-phase plugin's IR schema for the canonical list.

For colors, prefer the same frost values emitted by the live semantic
tokens and make the CSS variable relationship explicit in
`$description`. Designers should choose semantic token IDs from here;
implementers should render through CSS vars (`var(--bg)`,
`var(--accent)`, etc.), not by copying the frost literal into a
component.
