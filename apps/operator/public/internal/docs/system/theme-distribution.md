# Theme distribution — author, publish, install, select, update
URL: /internal/docs/system/theme-distribution

How inert semantic-token theme packages travel through the Cupboard, remain separate from local themes, refresh every picker, and survive cold start.

A Cupboard theme is an inert, versioned package of semantic color-token overrides. It uses the same public listing, release, review, search, and install infrastructure as other Cupboard kinds, while selection remains an explicit local preference.

See [Design tokens, themes & the theming standard](/internal/docs/design/tokens) for the semantic token vocabulary and built-in palettes. This page covers distribution and lifecycle.

## Package layout

A public mirror stores each theme under its listing ref:

```text
<listing-ref>/
  theme.json
  listing.json
```

`theme.json` schema version 1 contains:

* `id`: publisher-local lowercase slug.
* `label` and `description`: display metadata.
* `version`: a non-empty package version.
* `baseTheme`: one generated built-in layer such as `frost`, `black`, `honeycomb`, `portal-light`, or `portal-dark`.
* `colorScheme`: `light` or `dark`.
* `tokens`: a non-empty partial map from the canonical semantic token vocabulary to CSS-safe values.

`listing.json` identifies the directory as `kind: "theme"`, names the same listing ref/version, and records the public source repository. The runtime rejects unknown token keys, references to non-semantic primitives, unsafe CSS values, unsupported schema versions, wrong-kind directories, and invalid base/color-scheme values before any package is installed.

Theme packages contain data only. They do not carry scripts, capabilities, or executable hooks.

## Authoring and publishing

Create or edit the source theme in Personalization first. Local themes live in the workspace custom-theme file and remain independent of installed packages.

The agent path is:

```text
cupboard:publish-theme {
  themeId,
  githubUrl,
  listingRef?,
  version?,
  baseTheme?,
  colorScheme?,
  title?,
  description?,
  exportOnly?
}
```

Use `exportOnly: true` to materialize the validated `theme.json` and `listing.json` directory before pushing it to the public mirror. Once the mirror contains that directory, call without `exportOnly` to publish the ordinary `kind=theme` listing. Publication uses the established Cupboard authorization, public-repository, immutable-release, visibility, and review policy.

The UI exposes themes through the Themes category. A detail page can install only after the package parser accepts the same bytes the local store will later enumerate.

## Install, select, update, remove

Installation and selection are separate operations:

1. **Install** clones and validates the listing ref, then atomically places it in the workspace installed-theme layer. It does not change the active theme.
2. **Use theme** calls the canonical `writeActiveTheme` preference writer. This applies immediately, persists through the profile store, and becomes the pre-paint selection on reload.
3. **Update** is explicit. A normal reinstall refuses to overwrite an existing package; the update path validates incoming bytes first and swaps directories atomically. A served release already at the installed version is a no-op.
4. **Remove** deletes only the installed package. A local edit-as-copy remains independent. Removing the active package restores Blue frost through the canonical preference writer.

The agent install path is:

```text
cupboard:install-theme { listingId }
cupboard:install-theme { listingId, update: true }
```

The result includes the installed metadata and `activeThemeId`; callers must still select it explicitly.

## Identity and provenance

Installed ids are opaque and source-qualified. They derive from the actual local package ref plus listing ref, so two repositories may publish the same display label or author-local id without collision. Catalog entries retain package ref, listing ref, source, version, base theme, and color scheme. Personalization shows this provenance and exposes **Edit as copy**, which seeds a new local id instead of mutating package bytes.

Local themes, installed themes, and generated built-ins are separate layers. The merged catalog never seeds installed entries into the custom-theme file.

## Live catalog and cold start

Every picker reads the `themes.catalog` sync query. Successful install/update/remove and local save/delete operations emit committed-write invalidation for that query, so mounted controls refresh without polling.

The client caches three workspace-scoped values:

* resolved custom-theme CSS for pre-paint injection;
* base-theme/color-scheme metadata;
* the last known-good catalog for labels and provenance during a transient or offline read.

A missing or failed sync result never overwrites those caches with an empty catalog. A legitimate live catalog that no longer contains the active custom id falls back through `writeActiveTheme`. Workspace-prefixed storage keys prevent one workspace's catalog from appearing in another.

## Verification

Focused coverage lives in:

* `packages/operator-core/lib/cupboard/theme-store.test.ts`
* `packages/operator-core/lib/cupboard/install-theme-io.test.ts`
* `packages/operator-core/lib/cupboard/publish-theme-core.test.ts`
* `packages/operator-core/lib/agent-tools/cupboard/theme-registration.test.ts`
* `apps/operator/lib/theme-catalog.test.tsx`
* `apps/operator/app/cupboard/[id]/ThemeInstall.test.tsx`
* `apps/operator/app/_components/ThemeSelector.test.tsx`
* `apps/operator/app/settings/personalization/ThemeEditor.test.tsx`

The isolated desktop journey is:

```bash
VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready \
  scripts/verify-tauri-headless.sh -- \
  bash scripts/verify-cupboard-theme-journey.sh
```

It writes only to the verifier's throwaway workspace and proves the Themes browse category, validated fixture selection, both existing controls, switch-away/back, committed update invalidation, reload persistence, active removal fallback, computed semantic colors, and invalid-theme rejection.
