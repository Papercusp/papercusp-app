# papercusp-search — check contracts

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
    // devDependencies). List the component packages you KEPT — if you dropped
    // the precision stack at the `relevance-stack` decision point, omit
    // @papercusp/rerank and @papercusp/search-core here.
    "packages": ["@papercusp/search", "@papercusp/rrf", "@papercusp/rerank", "@papercusp/search-core"],
    // package.json paths to search, app-root-relative (default: ["package.json"])
    "manifests": ["package.json", "apps/desktop/package.json"]
  }
}
```

Green means: every listed package is a declared dependency of at least one of
the app's manifests — the composition is wired for real, not on paper.
