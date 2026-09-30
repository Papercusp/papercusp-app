# @papercusp/plugin-loader-core

A generic, **domain-free** plugin-loader kernel. It owns the reusable
*mechanics* of loading plugins from a filesystem; every host-specific
decision (manifest shape, validation rules, runtime kinds, where to look)
injects through a ports object, so the library names no consuming app.

Three composable pieces:

## `createPluginLoader(ports)`

The filesystem → typed-plugin pipeline, per candidate directory:

1. **read + validate** the manifest — `ports.readManifest(dir)`
2. **not-a-plugin detection** — a dir with no manifest *and* no entry is
   skipped silently; with an entry but no manifest it's a hard error
3. **alternate-runtime dispatch** — `ports.runtimeDispatch(manifest, …)`
   lets manifests that opt into a non-JS runtime (wasm, subprocess
   daemon, …) short-circuit the import path
4. **locate + import** the entry module — `ports.locateEntry` +
   `ports.importEntry` (defaults to a bundler-opaque `createRequire`)
5. **validate** the plugin vs its manifest — `ports.validatePlugin`

Plus **discovery**: `loadAll(roots)` walks a set of search roots (with
optional npm-style `@scope/` recursion) and dedupes by plugin name with
first-seen-wins precedence — order the roots by precedence.

```ts
const loader = createPluginLoader<MyPlugin, MyManifest>({
  readManifest, locateEntry, runtimeDispatch, validatePlugin,
  pluginName: (p) => p.name,
});
const { loaded, errors } = await loader.loadAll([
  { pluginsDir: '/proj/plugins', source: 'project' },
  { pluginsDir: '/global', source: 'global', scopeRecurse: true },
]);
```

## `createManifestValidator(schema, options?)`

A pluggable JSON-Schema manifest validator (ajv). Returns `{ validate,
assertValid }`; `validate` maps ajv errors into `{ path, message }` issues
with stable field paths. It rewrites `additionalProperties:false`
violations into a typo-friendly message out of the box; host-specific
phrasing (id-regex hints, etc.) injects via `options.customizeMessage`.

## `satisfies(version, range)`

A minimal semver-range matcher (`^`, `~`, `>=`, exact, `*`, `X` / `X.Y`
shorthands) for runtime-compatibility checks. Fails closed on malformed
input. Pure — no dependencies.

---

Depends only on `ajv`. Extracted from the Papercusp plugin system
(`@papercusp/plugin-loader`), which now consumes this kernel and supplies
the Papercusp manifest schema, capability/role/UI validation rules,
wasm/daemon runtimes, and `~/.papercusp` search-path resolution as the
ports above.
