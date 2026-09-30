# papercusp-release-pipeline — check contracts

## `components-integrated` (`components-integrated.test.ts`) — the kit is really wired in

PORTABLE + APP-PARAMETERIZED (verbatim copy of the shared portable check —
never fork it): asserts every pinned component package appears in
`dependencies`/`devDependencies` of at least one of the app's manifests.
Driven by the `TEMPLATE_CHECKS_CONFIG` JSON (schema: `@papercusp/template-kit`
`TemplateChecksConfig`, section `components`); skips without the env var.
Needs only a `vitest` devDep.

For THIS template the packages list is one entry:

```jsonc
"components": {
  "packages": ["@papercusp/tauri-release-kit"],
  "manifests": ["package.json"]   // or wherever the app declares it
}
```

A composition "on paper" whose release kit was never actually added as a
dependency fails HERE, before any release is attempted. The deeper proof is
operational: the app's release entry point (its `bin/release.ts` +
`TauriReleaseConfig`) driving a real channel build — see the decision points
in `../template.yaml` and the kit's own suite in its source lib.
