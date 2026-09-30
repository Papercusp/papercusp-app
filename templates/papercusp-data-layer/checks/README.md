# papercusp-data-layer — check contracts

Portable, app-parameterized checks (P-007 convention): copied verbatim into a
composed app, driven by the JSON config named by `TEMPLATE_CHECKS_CONFIG`
(schema: `@papercusp/template-kit` `TemplateChecksConfig`). Unconfigured, a
check SKIPS.

## components-integrated

Section: `components`

```jsonc
{
  "components": {
    // npm package names the composed app must declare (dependencies or
    // devDependencies). Two of this template's components are PATTERNS you
    // instantiate as app-local packages — list the package names your app
    // actually uses (your embedded-PG server package, your contracts
    // package) alongside the shared discovery lib.
    "packages": ["@papercusp/embedded-pg-discovery", "@myapp/embedded-postgres-server", "@myapp/contracts"],
    // package.json paths to search, app-root-relative (default: ["package.json"])
    "manifests": ["package.json", "apps/desktop/package.json"]
  }
}
```

Green means: every listed package is a declared dependency of at least one of
the app's manifests — the composition is wired for real, not on paper.
