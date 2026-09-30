# papercusp-ui — check contracts

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
    // devDependencies). List what you KEPT — note papergrid is a
    // meta-package: list the grid SUB-packages you actually import
    // (@papercusp/grid-core / @papercusp/bloom-grid / @papercusp/grid).
    "packages": ["@papercusp/ui-primitives", "@papercusp/grid-core", "@papercusp/dock-workbench", "@papercusp/lexicon"],
    // package.json paths to search, app-root-relative (default: ["package.json"])
    "manifests": ["package.json", "apps/desktop/package.json"]
  }
}
```

Green means: every listed package is a declared dependency of at least one of
the app's manifests — the composition is wired for real, not on paper.

## theme-tokens

Section: `themeTokens`

```jsonc
{
  "themeTokens": {
    // App-root-relative path to the GENERATED tokens.css copied from this
    // template's tokens/ dir (see GUIDE.md § Theme tokens).
    "tokensCss": "app/tokens.css",
    // App CSS files that must contain NO raw hex — every color routes
    // through the semantic vars. tokens.css itself is exempt (it defines them).
    "appCss": ["app/globals.css"]
  }
}
```

Green means: the app carries the 3-state light/dark/system token sheet
(explicit `data-theme` beats the system preference) and no app CSS hardcodes
a color a dark flip would miss — raw hex is the dark-mode blocker (D-011).
