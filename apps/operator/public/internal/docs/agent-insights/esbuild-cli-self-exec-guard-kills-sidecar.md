# A bundled library's CLI self-exec guard kills the desktop sidecar at boot (EI-650)
URL: /internal/docs/agent-insights/esbuild-cli-self-exec-guard-kills-sidecar

Why the packaged operator logged a phase then silently process.exit(0)'d — and the bundle-safe isCliEntry() fix for the whole class of ESM main-module guards.

## Symptom

The **packaged** desktop app (the `.deb`, not `tauri dev`) boots normally —
embedded PG starts, migrations apply, the operator logs
`[seed-learning-singletons] 13/13 loop(s) would materialize` and even
`operator ready` — then the **sidecar process silently exits** \~3s in. No JS
stack, no error, exit code 0. Embedded PG goes down with it
(`CONNECTION_ENDED`), the Tauri shell stays up as an empty window, and every
page shows `upstream error`. 100% deterministic, host **and** VM, fresh-initdb
**and** reused data dir. Older builds were fine.

## Root cause

A **library file that is also a CLI** — `seed-learning-singletons.ts` — ended its
module with the ESM main-module guard:

```ts
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0))…   // dry-run, then exit
}
```

That guard is correct for `tsx seed-learning-singletons.ts`. But the desktop
sidecar **esbuild-bundles the whole operator into one file** (`serve.mjs`,
entry `apps/operator/bin/serve.ts`). In that single bundle **every inlined
module shares ONE `import.meta.url`** — the bundle's own — which **equals
`process.argv[1]`** (both are `…/sidecar/serve.mjs`). So the guard fires the
moment the module is first imported at boot (here: `learning-loops.ts`, an
agent-tool registered during boot, imports `LEARNING_SINGLETONS`). It runs the
CLI's `main()` and then `process.exit(0)` — **killing the operator before it
serves**. The dry-run log line is the smoking gun: it's `main()`'s output, not
a boot phase.

This is a whole CLASS of bug. Every spelling collapses to true in the bundle:

* ``import.meta.url === `file://${process.argv[1]}` ``
* `import.meta.url === pathToFileURL(process.argv[1]).href`
* `fileURLToPath(import.meta.url) === process.argv[1]`

The CJS sibling (`require.main === module`) was already neutralised — the build
banner defines a dummy `module` so it's always false. The **ESM idiom had no
such neutraliser**, so a new ESM-CLI file (the Jun-13/14 deterministic-blueprints
migration added `seed-learning-singletons.ts`) silently became a boot landmine.
`tauri dev` never reproduces it: dev loads modules separately, so each file's
`import.meta.url` is its own and the guard stays false.

## Fix

Bundle-aware guard helper + an esbuild define (symmetric with the CJS banner
fix):

* `packages/operator-core/lib/util/cli-entry.ts` exports `isCliEntry(import.meta.url)`.
  It returns `false` when `__PAPERCUSP_BUNDLED_SIDECAR__` is defined (the bundle),
  else does the real `import.meta.url === pathToFileURL(process.argv[1]).href` check.
* `papercusp-desktop/bin/build-desktop-sidecar.sh` passes
  `--define:__PAPERCUSP_BUNDLED_SIDECAR__=true` to the serve esbuild step. esbuild
  folds the helper to `if (true) return false`, so **no inlined library CLI can
  self-execute** — only the real entry (`serve.ts`, which boots unconditionally
  and does NOT use the helper) runs.
* Library CLIs guard with `if (isCliEntry(import.meta.url)) { main()… }`. Outside
  the bundle (tsx/dev/test) the define is absent, so `tsx <file>.ts` still
  self-executes exactly as before.

A regression guard (`lib/util/cli-entry.test.ts`) fails CI if any
`operator-core/lib` file reintroduces a naive ESM self-exec guard. **New library
CLI? Use `isCliEntry`, never a raw `import.meta.url`/`process.argv[1]`
comparison.**

**Symlink robustness follow-up (WI-1443).** Node realpaths the entry module's
`import.meta.url` by default while `process.argv[1]` preserves the path it was
*invoked* through — so through a symlinked checkout (e.g. `papercup ->
papercusp`) the naive `importMetaUrl === pathToFileURL(argv1).href` comparison
is false and the CLI silently never runs (exit 0, no output — the same
symptom class as the bundling bug, different cause). Both `isCliEntry()`
(`cli-entry.ts`) AND `serve.ts`'s own `invokedDirectly` check (the real entry,
which does NOT use `isCliEntry` — see above) now fall back to comparing the
`realpathSync`'d forms of both sides when the direct comparison misses, under
a try/catch (a non-file URL or a vanished path just means "not a direct CLI
invocation", never a throw).

## How to verify a sidecar boot fix fast

The bug is bundle-only, so `tauri dev` (unbundled tsx) won't exercise it. Rebuild
the sidecar (`bin/build-desktop-sidecar.sh`) and either run the packaged `.deb`
or grep the rebuilt `serve.mjs`: `isCliEntry` should compile to
`if (true) { return false; }` and the guard sites should read
`if (isCliEntry(import.meta.url))`. The two-instance boot+isolation assert in
`bin/two-instance-federation-smoke.sh` is the packaged runtime proof.
