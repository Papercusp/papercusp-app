# The Swarm Asset Pack

Flag-gated visual identity assets for `papercusp-the-hive`. The internal pack id remains `the-hive` so the skin is reversible; the product-facing name is **The Swarm**.

## Core Marks

- `primary-mark.svg`: full-color The Swarm mark for app, hero, brand, and OS icon surfaces.
- `primary-mark.mono.svg`: monochrome `currentColor` variant.
- `queen-mark.svg`: full-color Queen brain focal mark.
- `queen-mark.mono.svg`: monochrome `currentColor` variant.
- `wordmark.svg`: The Swarm wordmark with primary swarm mark.
- `wordmark-lockup.svg`: The Swarm plus Hive Console lockup.
- `favicon.svg` and `favicon.png`: flag-gated browser/app favicon.
- `comb-motif.svg`: reusable geometric background and empty-state texture.
- `icons/*.svg`: lexicon iconography for Hive, Swarm, Queen, Sentinel Bee, Bee, Keeper, Cell, Comb, and Frame.

## Usage

Use the primary mark for app-level The Swarm surfaces and small app-icon contexts. Use the Queen mark only for the brain/orchestration avatar and high-judgment moments. Use the Sentinel Bee name for the always-on operator role. Humans are Keepers.

Use comb geometry as a structural grid, divider, empty-state, or loading motif; keep it low-contrast and aligned to layout rhythm.

Do not use cartoon bees, yellow-on-white treatments, or decorative random honeycomb. The system should read as engineered swarm intelligence on charcoal.

## Exports

Desktop icon exports live in `papercusp-desktop/src-tauri/icons/the-hive/`. The same parallel pack is mirrored to `libs/papercusp/apps/desktop/src-tauri/icons/the-hive/` for the secondary in-repo desktop app.

- `_source.svg`
- `_master.png` and `icon.png` at 512px
- `16x16.png`
- `32x32.png`
- `64x64.png`
- `128x128.png`
- `128x128@2x.png`
- `256x256.png`
- `icon.ico`
- `icon.icns`

The OS icon pack is intentionally parallel. `tauri.conf.json` still points at the classic icon set until packaging/runtime selection work explicitly opts into this pack.
