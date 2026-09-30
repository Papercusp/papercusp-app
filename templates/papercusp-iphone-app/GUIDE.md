# papercusp-iphone-app — composition GUIDE

**Papercusp Official: iPhone App.** This is the app-scope entry point for a
whole iPhone app. It is intentionally thin: the root adds one product-purpose
answer and pulls the complete mobile chassis through two exact requirements:

- `papercusp-mobile-base@0.1.0` owns the portable Rust/UniFFI, design-token,
  configuration, source-hygiene, and cross-platform verification contract.
- `papercusp-iphone-shell@0.1.0` owns the SwiftUI/XcodeGen/XCFramework chassis,
  generated Swift module, device/simulator slices, privacy, entitlement, test,
  archive/export, provenance, and external-signing preflight contract.

The root owns no components and no product implementation. Product domain
flows, endpoints, routes, copy, brand, assets, and selected optional capability
implementations remain in the app that consumes this template.

## MUST — resolve the exact closure before writing product code

1. Keep this template as the only app-scope root.
2. Resolve its exact `requires` closure and retain the three resolved manifests
   as build provenance: this root, `papercusp-mobile-base@0.1.0`, and
   `papercusp-iphone-shell@0.1.0`. Copy the two resolved dependency manifests
   into `template-manifests/` in the materialized app; do not rewrite their
   pins or checks.
3. Work the aspect GUIDEs in dependency order: shared base, iPhone shell, then
   product code.
4. Run the full additive union of checks. The root check proves closure and
   answer completeness; it does not replace any shared-base or iPhone-shell
   assertion.

## Decision record

Answer `iphone-app-purpose` once: what product is this iPhone app, and which
answers are supplied to every decision point in its exact dependency closure?
The purpose answer is disclosure, not a second copy of identity or capability
parameters owned by the aspects.

Record every answer under `composition.decisionPointAnswers` in the checks
config. Keys are tagged as `<template-id>:<decision-point-id>` so two templates
can never silently overwrite each other. The exact required keys are:

- `papercusp-iphone-app:iphone-app-purpose`
- `papercusp-mobile-base:product-domain`
- `papercusp-mobile-base:rust-msrv`
- `papercusp-mobile-base:license-and-repository`
- `papercusp-mobile-base:design-token-source`
- `papercusp-mobile-base:optional-capabilities`
- `papercusp-mobile-base:runtime-configuration`
- `papercusp-iphone-shell:iphone-identity`
- `papercusp-iphone-shell:iphone-os-floor`
- `papercusp-iphone-shell:iphone-capabilities`
- `papercusp-iphone-shell:iphone-test-host`
- `papercusp-iphone-shell:iphone-release`

Start from `reference/iphone-app.checks-config.example.json`. Replace every
neutral answer and point `composition.templateYamls` at the three retained
manifests. Do not put signing values, service credentials, provisioning
profiles, remote-host credentials, or provider payloads in the answer record.

## MUST

- Keep the root thin. A reusable implementation belongs in one of the two
  aspect templates; product behavior belongs in the consumer.
- Preserve both exact `0.1.0` requirement pins. A contract-breaking change is
  a coordinated version bump, not a local override.
- Record all twelve tagged decision answers before claiming the composition is
  build-ready.
- Treat the union as additive: root composition integrity, mobile-base
  contract/commands, and iPhone-shell contract/assertions all remain required.
- A non-capable host reports `host-constrained` through the shell evidence
  contract; the root may never reinterpret that verdict as green.

## SHOULD

- Commit the final checks config and decision record beside the materialized
  app so later release evidence resolves to the same inputs.
- Specialize product behavior only after the portable core, generated binding
  module, bundle identity, privacy/capability declarations, and external
  signing-input names are coherent.
- Exercise at least one real iPhone-capable macOS host before publishing even
  when every portable check is green.

## FREE

- Product domain, native navigation, screen architecture, copy, branding,
  assets, and which optional capability seams are selected.
- Additional product-owned tests and release channels, provided they do not
  weaken the closure's required assertions.

## Checks

`checks/composition-integrity.test.ts` validates the exact root/requirement
closure, catalog pins, one root app scope, additive check union, and—when
`TEMPLATE_CHECKS_CONFIG` is set—the complete tagged answer record. Its pure
fixture suite also proves the neutral reference record is complete and that a
missing or unknown answer fails.

The check imports `@papercusp/template-kit`. This template carries a vendored,
byte-identical `template-kit/` package because `templates:new-app` overlays only
this root directory into the new app. Declare it from the materialized root:

```jsonc
"devDependencies": {
  "@papercusp/template-kit": "file:./template-kit",
  "vitest": "^4.1.4",
  "yaml": "^2.6.0"
}
```

Do not install `@papercusp/template-kit` from npm and do not point at a
developer checkout. The vendored copy is the portable supply-chain surface.
