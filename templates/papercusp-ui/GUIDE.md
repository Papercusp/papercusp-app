# papercusp-ui — composition GUIDE

**Papercusp Official: UI Kit.** This aspect template wires the UI
generic-library family into a composed app's deterministic plane: headless
React primitives, the data-grid stack, the dockview workbench shell, and
brand-lexicon terminology. Everything here is **Tier A** (plain libraries) —
compose and modify freely; the MUSTs are about wiring shape, not code
ownership.

## MUST — consult the live papercusp docs when this GUIDE is not enough

You are building ON a live papercusp install (we dogfood papercusp in
papercusp). If anything in this GUIDE is insufficient — a component's API, a
seam convention, a release step — do NOT guess:

- read the papercusp documentation served on your install at **`/internal/docs`**
  (start with the `agent-insights` section; this template's `template.yaml`
  `docs:` list names its canonical pages), and
- inspect the **operator app** itself — it is a running reference instance of
  every pattern these templates encode.

## The construction (orientation)

Four legs; take only what the app's surfaces need:

1. **Primitives** — `@papercusp/ui-primitives`: headless ANSI/terminal
   output, markdown (GFM), a JSON tree viewer, and virtualized lists. Brand-
   value-free — styling is injected by the consumer, so they render under
   any design system. (Peer deps: react, react-markdown, react-virtuoso,
   anser, etc. — declare them in the app.)
2. **Grids** — the papergrid stack: `@papercusp/grid-core`
   (sort/selection/virtualization logic), `@papercusp/bloom-grid` (row store
   + server-rendered rows), `@papercusp/grid`. `@papercusp/papergrid` itself
   is a META-package — apps import the sub-packages directly.
3. **Workbench** — `@papercusp/dock-workbench`: a host-agnostic dockview
   shell — panel registry, logical layout schema + adapters, pluggable
   persistence, and the React `DockWorkspace`. The multi-panel chrome of an
   operator-style app.
4. **Lexicon** — `@papercusp/lexicon`: canonical term keys → display labels
   via the active brand pack (pure singular/plural/lowercase resolution + a
   `configure*()` seam for non-React callers).

## MUST

- Keep the primitives HEADLESS: style them from the app's design system —
  never fork a primitive to hardcode brand values into it.
- Depend on the grid SUB-PACKAGES directly (decision point `grid-usage`) —
  `@papercusp/papergrid` is the catalog handle, not the import.
- Know what the lexicon is FOR (decision point `branding-lexicon`):
  `@papercusp/lexicon`'s `TermKey` is a CLOSED papercusp-internal vocabulary
  (fleet, harness, operator, …) — route those terms through it wherever your
  chrome surfaces them, and assert routed keys in tests. Your app's OWN
  domain nouns ("clipping", "invoice", …) are NOT lexicon terms (WI-2873):
  keep them in one app-local terms module (a small constants file) so a
  rebrand is still one edit — do not hack app nouns into papercusp term
  keys, and never hardcode a display label a rebrand would have to grep
  for.
- Declare every component you keep (and the primitives' peer deps) as real
  dependencies — the `components-integrated` check fails a composition wired
  "on paper".

## SHOULD

- Feed live grids from the `papercusp-data-sync` template's plane (grid over
  a synced projection beats grid over a polled endpoint).
- Persist workbench layout in the app's own data layer (the
  `papercusp-data-layer` template) rather than browser storage when the app
  has one — layouts survive reinstalls with the app home.
- Serve the SPA from the sidecar host (`hono-host` in
  `papercusp-tauri-desktop-shell`) — this kit is the SPA's inside, not a second host.

## FREE

- Which panels/grids/views exist, layout defaults, which brand pack is
  active, and whether any leg is dropped entirely (an app with no tabular
  data needs no grid stack). Styling/composition is free — but every COLOR
  routes through the shared theme tokens below (that part is a MUST).

## Theme tokens (D-011 — the shared light/dark palette)

The app family shares ONE semantic color system, shipped in `tokens/`:

- `tokens/tokens.base.json` — the DTCG source of truth (light `$value`, dark
  under `$extensions["com.papercusp.modes"].dark`).
- `tokens/generate-tokens.mjs` — dependency-free generator; emits
  `tokens.css` implementing the 3-state light/dark/system model (`:root`
  light; `:root[data-theme="dark"]` explicit dark; system dark via
  `@media (prefers-color-scheme: dark)` guarded by
  `:not([data-theme="light"])` so an explicit light choice wins).
- `tokens/tokens.css` — the GENERATED artifact apps consume.

Wiring a composed app:

1. Copy `tokens/tokens.css` to `app/tokens.css` and import it BEFORE the
   app's own stylesheet (e.g. in `app/layout.tsx`).
2. Draw every color from the semantic vars (`--paper`, `--ink`, `--ink-soft`,
   `--muted`, `--line`, `--line-soft`, `--line-strong`, `--panel`,
   `--panel-dim`, `--panel-raised`, `--rail`, `--chip`, `--accent`,
   `--accent-soft`, `--danger`, `--danger-soft`, `--shadow-soft`,
   `--shadow-strong`) — NO raw hex in app CSS. Raw hex is the dark-mode
   blocker: a hardcoded color simply never flips.
3. Per-app accents/extras (a calendar's `--today`, a distinct `--accent`) are
   a thin override layer AFTER the tokens import — redefine the var for BOTH
   modes there; never edit tokens.css in place.
4. Theme switching is `data-theme="dark" | "light"` on `<html>` (absent =
   follow the system); the portal shell owns the persisted switch and
   propagates it into embedded surfaces.

Need a color no semantic var covers? Add a TOKEN (both modes) to
`tokens.base.json`, regenerate, and re-copy — do not inline the hex.

## Checks

`checks/components-integrated.test.ts` — configure the `components` section of
your `TEMPLATE_CHECKS_CONFIG` with the package names you kept. Unconfigured it
skips; see `checks/README.md`.

`checks/theme-tokens.test.ts` — configure the `themeTokens` section
(`tokensCss` path + `appCss` file list); asserts the generated tokens.css
carries the 3-state model and app CSS is raw-hex-free. Unconfigured it skips.
