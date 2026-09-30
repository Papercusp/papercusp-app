# \"no built-in blueprint\" almost always means a stale dist-host bundle
URL: /internal/docs/agent-insights/no-builtin-blueprint-stale-dist-host-bundle

A routine/loader throwing `no built-in blueprint \"<id>\" at .../dist-host/blueprints/<id>/blueprint.yaml` is a stale-bundle drift, not a missing blueprint — and the loader now falls back to the source package.

## The symptom

A background routine (e.g. `bp-singleton-scout-0`) or any `loadBuiltinBlueprint(<id>)`
caller throws:

```
no built-in blueprint "scout" at /…/apps/operator/dist-host/blueprints/scout/blueprint.yaml
```

The blueprint *does* exist in source (`libs/papercusp/packages/harness/blueprints/<id>/blueprint.yaml`).
This has recurred (EI-1562 = `no built-in blueprint "pot"`, EI-8628 = `scout`).

## Why it happens

`apps/operator/bin/bundle-host.sh` copies the harness `blueprints/` into
`apps/operator/dist-host/blueprints` (`rm -rf` + `cp -R`) — a **point-in-time snapshot**.
The bundled host's `import.meta.url` points at `dist-host`, so `packageRoot()`
(`libs/papercusp/packages/harness/paths.ts`) anchors `harnessRoot()` on `dist-host`.
Its anchor check (`hasHarnessAssets`) only verifies `base/blueprint.yaml` exists — so a
`dist-host/blueprints` that is **stale or partial** relative to the fresh source still
anchors, and any blueprint the snapshot is missing throws `no built-in blueprint`.
It's a build-freshness drift, **not** a missing/broken blueprint.

## The fix (already in place)

`builtinBlueprintPath` now resolves the blueprint file across
`harnessRootCandidates()` — the primary `harnessRoot()` **first** (unchanged for
already-resolvable ids), then any derived **source** package
(`<ancestor>/libs/papercusp/packages/harness`) recovered by walking up from the primary
root and cwd. So a source-present blueprint resolves even when the bundled `dist-host`
copy is stale. A packaged deploy (no `libs/` source on disk) yields only the primary
root — byte-identical to before.

## If you still hit it

The fallback covers dev/self-host boxes where source is present. If a **packaged**
deploy (no source tree) throws this, the shipped `dist-host/blueprints` bundle is
genuinely incomplete — rebuild it with `apps/operator/bin/bundle-host.sh` (which
`rm -rf`s + re-`cp -R`s the whole blueprints dir and asserts `base/blueprint.yaml`).
Don't "add the one blueprint" by hand into `dist-host` — it's a generated artifact.
