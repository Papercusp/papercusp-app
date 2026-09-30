# `@papercupai/starlight` changelog

## 0.1.0 — successor to `@papercupai/fumadocs`

Iframe-driven dashboard tab embedding the docs site at the configured
`docsUrl`. This is the Starlight-era replacement for
`@papercupai/fumadocs`: the docs framework was migrated from Fumadocs to
Astro Starlight (`apps/operator-docs`, `apps/papercusp-docs`), so the
plugin is renamed to reflect the actual underlying framework.

**No mechanism change** — same hookup as `@papercupai/fumadocs`:
- `capabilities: ["ui:dashboard-tab"]`
- a single `dashboardTabs[]` entry, `iframeUrlConfigKey: "docsUrl"`
- `replaces: ["docs", "fumadocs"]` — supersedes both the legacy
  hard-coded `docs` tab and the outgoing `fumadocs` plugin tab, so a
  side-by-side install never shows two "Docs" tabs.
- activation gated by the `PAPERCUSP_TABS_FROM_PLUGINS` feature flag.

The `docsUrl` default is **unchanged** from `@papercupai/fumadocs`:
`http://localhost:3055/project-docs` — the per-harness docs viewer that
reads `?harness=<slug>` and renders that harness's `docs/` folder. The
plugin rename does not change which URL the tab embeds, so per-harness
behaviour is identical. Override `docsUrl` only to point the tab
elsewhere (e.g. the operator-served Starlight site at `/internal/docs`).

### Replacing an existing `@papercupai/fumadocs` install

```sh
papercusp install @papercupai/starlight
papercusp plugin enable starlight --harness <slug>   # per harness
papercusp uninstall fumadocs
```

Per-harness plugin config lives at
`<workspace>/.papercusp/harnesses/<slug>/plugin-configs/@papercupai/starlight.json`
(keyed by the manifest `name`). The shape is unchanged from the
fumadocs plugin (`{ "docsUrl": "..." }`), so any `docsUrl` you had set
under `@papercupai/fumadocs.json` can be copied across verbatim.
