# Branding
URL: /internal/docs/branding

Visual identity assets, token packs, icon exports, the classic/Pot public lexicon (the default), and the flag-gated The Swarm skin.

import { Aside } from '@astrojs/starlight/components';

Papercusp currently has two visual identity layers:

* **Classic / Pot** is the DEFAULT public skin — the original product identity, and
  the one every fresh install ships. `FLAGS.THE_HIVE` (`papercusp-the-hive`) is
  **parked (default-OFF)** in `libs/flags/src/types.ts` per
  `restore-pot-lexicon-public-release-2026-07-04`, so with the flag off the lexicon
  resolves to the **classic / Pot** pack out of the box. This is the public-release
  lexicon: **Pot** project, **Papercup** operator, **Mug** brain, **Kettle**
  overwatch, **Blender** scout, **Cup** contributor.
* **The Swarm (`the-hive`)** is a fully-built, still-maintained skin kept for
  **internal / testing** use, reachable by flipping `papercusp-the-hive` **on** (via
  the testing-gated BrandSwitcher, or `/admin/features`). It changes presentation
  assets, theme tokens, favicon, and labeled nouns only; it does not rename code
  identifiers, database rows, or tools.

The public-release default is the **classic / Pot** lexicon (the cup theme). The **The Swarm** (`the-hive`) pack — Hive / Sentinel / Queen / Overwatch / Scout / Bee — is preserved but flag-gated for internal and testing use (`restore-pot-lexicon-public-release-2026-07-04`). The implementation pack id remains `the-hive` for reversibility; when the flag is on, the user creates or joins a **Hive**, and inside a Hive many **Swarms** can run.

## Classic Identity

Classic assets stay in their existing locations and must not be overwritten by the-hive-skin work:

| Surface                     | Path                                                       |
| --------------------------- | ---------------------------------------------------------- |
| Operator logo component     | `apps/operator/app/_components/OperatorLogoMark.tsx`       |
| Operator wordmark component | `apps/operator/app/_components/OperatorWordmarkLockup.tsx` |
| Operator favicon/icon       | `apps/operator/app/icon.svg`                               |
| Public wordmark             | `apps/operator/public/wordmark.svg`                        |
| Desktop icon set            | `papercusp-desktop/src-tauri/icons/`                       |

## The Swarm Identity

The Swarm direction is engineered swarm intelligence: honey-amber signal color on charcoal, precise hex geometry, a primary bee-swarm mark for the app, and a distinct Queen mark for the brain.

| Asset                   | Path                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Primary mark            | `apps/operator/public/brand/the-hive/primary-mark.svg`                                                    |
| Primary monochrome mark | `apps/operator/public/brand/the-hive/primary-mark.mono.svg`                                               |
| Queen mark              | `apps/operator/public/brand/the-hive/queen-mark.svg`                                                      |
| Queen monochrome mark   | `apps/operator/public/brand/the-hive/queen-mark.mono.svg`                                                 |
| Wordmark                | `apps/operator/public/brand/the-hive/wordmark.svg`                                                        |
| Wordmark lockup         | `apps/operator/public/brand/the-hive/wordmark-lockup.svg`                                                 |
| Favicon                 | `apps/operator/public/brand/the-hive/favicon.svg` and `favicon.png`                                       |
| Comb motif              | `apps/operator/public/brand/the-hive/comb-motif.svg`                                                      |
| Lexicon icons           | `apps/operator/public/brand/the-hive/icons/*.svg`                                                         |
| Desktop icon pack       | `papercusp-desktop/src-tauri/icons/the-hive/` and `libs/papercusp/apps/desktop/src-tauri/icons/the-hive/` |
| React mark components   | `apps/operator/app/_components/HiveVisualIdentity.tsx`                                                    |

## Runtime Behavior

The Swarm skin is selected by `FLAGS.THE_HIVE` / `papercusp-the-hive`.

* Logo components switch from the classic cup marks to The Swarm primary mark via `useLexiconPackId()`.
* `HiveThemeBridge` forces `data-theme="honeycomb"`, sets `document.title` to the literal `HIVE_TITLE = 'The Swarm'`, and injects the Hive favicon while the flag is on.
* When the flag turns off, `HiveThemeBridge` restores the user’s saved active theme and the classic title `CLASSIC_TITLE = 'Papercusp Operator'`.
* The selectable Honeycomb theme is generated from the repo-root `design-tokens/honeycomb.semantic.tokens.json` into `apps/operator/app/_semantic.honeycomb.css` by the repo-root `npm run tokens` script (style-dictionary), which emits the CSS under the `[data-theme="honeycomb"]` selector.
* The legacy `hive` selector remains as an implementation-pack alias; new runtime usage should prefer `honeycomb`.
* The Swarm desktop icons are parallel exports only. `tauri.conf.json` still points to the classic icon set until packaging explicitly opts into the Swarm pack.

The flag-on `document.title`/wordmark renders `The Swarm`. EI-230 weighed this against D-005 (classic runtime titles) and D-007 (`Swarm` = deployment unit); the owner **resolved** it on 2026-06-10 (D-008 in `the-hive-lexicon-2026-06-06`, status: shipped): `The Swarm` is ratified as the product sub-brand, so `HIVE_TITLE` / `OperatorWordmarkLockup` stay pointed at `The Swarm` (deliberately **not** repointed to `The Hive`).

## Lexicon

Both packs are presentation-only — they relabel nouns, not code identifiers, tables, or
tools. The **classic / Pot** column is the public-release default (flag OFF); the
**the-hive / Swarm** column is the flag-on internal/testing skin. Source of truth:
`libs/generic/lexicon/src/packs.ts`.

| Concept (term key)                           | Classic / Pot (default, flag OFF) | the-hive / Swarm (flag ON) |
| -------------------------------------------- | --------------------------------- | -------------------------- |
| Project / deployable group (`pot`)           | Pot                               | Hive                       |
| Live set of working agents (`fleet`)         | Fleet                             | Colony                     |
| Brain / high-judgment orchestrator (`brain`) | Mug                               | Queen                      |
| Always-on operator (`operator`)              | Papercup                          | Sentinel                   |
| Health / overwatch monitor (`overwatch`)     | Kettle                            | Overwatch                  |
| Idea-radar scout (`scout`)                   | Blender                           | Scout                      |
| AI agent / worker (`contributor`)            | Cup                               | Bee                        |
| Human member (`human`)                       | Human                             | Keeper                     |
| Unit of work (`chunk`)                       | Chunk                             | Cell                       |
| Shared store (`cupboard`)                    | Cupboard                          | Comb                       |
| Machine / deployment instance (`node`)       | Node                              | Swarm                      |
| Collaboration substrate (`substrate`)        | Coordination                      | Hive Mind                  |
| Agent signal / handoff (`signal`)            | Signal                            | Waggle                     |

The agent-role marks map to cup glyphs in the classic pack (matching `apps/tui`
`agent_pane_kind.rs`, fixed regardless of pack): **Mug** ☕ (brain/queen), **Kettle** 🫖
(overwatch), **Papercup** 🥤 (operator/sentinel), **Cup** 🍵 (contributor/bee). Nav icons in
the GUI use lucide `Coffee` / `Thermometer` / `CupSoda` respectively.

:::note\[Owner correction 2026-07-12 — the Mug/Cup glyphs were swapped]
D-006 originally gave the **Mug** a teacup (🍵) and the worker **Cup** the actual
coffee-mug (☕) — backwards, and it read wrong wherever the cast is listed together
(the agents-running legend, the zellij roster). The Mug now takes ☕ and the Cup 🍵.
Display only — **wire strings are unchanged**, and `AgentPaneKind::from_glyph_prefix`
derives from `glyph()`, so the zellij pane-name parser follows automatically. The three
glyph tables (`apps/tui/src/agent_pane_kind.rs`, `apps/operator/app/harness/primitives.tsx`
`AGENT_KIND_GLYPH`, `apps/operator-vite/.../AgentsRunningPill.tsx` `KIND_GLYPH`) must stay
in sync — change them together or the desktop and zellij stop reading identically.
:::

Under the flag-on **the-hive** pack: the live agent collective is the **Colony** (term key
`fleet`); **Swarm** (term key `node`) is the deployment-to-instance unit — a deployment of a
Hive to a single machine. Owner revision D-007 (plan P-009) reassigned `Swarm` from the
live-agent row to the deployment row and folded the earlier `Frame` machine/region term into
`Swarm`. `Sentinel` was renamed from `Sentinel Bee` by owner directive 2026-06-09
(hive-agent-tabs P-003); the shaping icon file is still named `icons/sentinel-bee.svg`, but
the flag-on lexicon term is `Sentinel`.

## Color Tokens

There are three distinct The Swarm color sources — do not conflate them:

* **Shipped Honeycomb theme tokens** — the values the selectable `honeycomb` theme actually emits at runtime, from `design-tokens/honeycomb.semantic.tokens.json` (muted honey, accent `#C68E24`). Documented in the table below.
* **SVG mark palette** — `HIVE_BRAND_COLORS` in `apps/operator/app/_components/HiveVisualIdentity.tsx` (honey `#F6B72F`, deep honey `#B97812`, cream `#FFF2C2`). These are the colors the brand SVGs (`primary-mark.svg`, `queen-mark.svg`, `favicon.svg`) actually render with.
* **Prototype demo palette** — the brighter `#EAB308`/`#FDE68A` honey used only in the `/dev/swarm-logos` exploration page (`swarm-logos.module.css`). Not a runtime theme.

The shipped Honeycomb token pack is dark-first and WCAG-oriented (values are the runtime CSS variables emitted under `[data-theme="honeycomb"]`):

| Token              |     Value | Use                       |
| ------------------ | --------: | ------------------------- |
| Background         | `#070704` | app shell base            |
| Deepest background | `#030303` | maximum depth             |
| Popover surface    | `#11100B` | cards and elevated panels |
| Raised surface     | `#15130B` | elevated chrome           |
| Text               | `#F4EBD4` | primary foreground        |
| Muted text         | `#9F9378` | secondary foreground      |
| Primary accent     | `#C68E24` | muted honey action color  |
| Strong accent      | `#D6A64A` | hover/focus accent        |
| Accent ink         | `#130D03` | text on honey             |

Semantic colors remain distinct from the primary honey accent: success green (`#68D391`), danger rose (`#E06F69`), and warning honey (`#D6A64A`).

## Motif Rules

Use hexagons as layout structure, not wallpaper. The comb motif works for background texture, dividers, empty states, and swarm/loading states when it is low-contrast and aligned to the UI grid.

Do not use cartoon bees, playful yellow-on-white compositions, or random honeycomb decoration. The Swarm should feel like an engineered distributed system.

## Preview And Exports

* Preview the system at `/dev/operator-logo` in the operator app.
* Editable SVG and raster export notes live in `apps/operator/public/brand/the-hive/README.md`.
* Regenerate theme CSS with `npm run tokens` after editing token JSON.
* Rebuild docs with `cd apps/operator-docs && npm run build` after changing this page so `apps/operator/public/internal/docs/` is refreshed.
