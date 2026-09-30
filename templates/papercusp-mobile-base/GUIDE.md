# papercusp-mobile-base — composition GUIDE

**Papercusp Official: Mobile Base.** This aspect is the one shared foundation
for official Android and iPhone apps. It gives the consumer a portable Rust
core, one UniFFI boundary, deterministic cross-language design tokens,
explicit configuration semantics, and checks that keep identities and secrets
out of template source. It does not supply a product domain or native UI.

## MUST — consult the live Papercusp docs when this GUIDE is not enough

Use the live `/internal/docs` pages declared in `template.yaml` for template
composition, manifest, and component-catalog rules. The
`rust-uniffi-mobile-base` catalog entry describes the reusable pattern; the
consumer repositories remain independent conformance evidence, not code to
copy wholesale.

## Decide first

Record all six decision-point answers before editing the scaffold:

1. Draw the product-domain boundary: deterministic outcomes, validation,
   serialization, state transitions, and error taxonomy belong in Rust;
   presentation, lifecycle, permissions, and platform APIs stay native.
2. Select a supported Rust MSRV and make every selected dependency prove it.
3. Select the SPDX license, authorship, repository, and complete identity set.
4. Replace the neutral token values while retaining one source and
   deterministic Kotlin/Swift generation.
5. Select optional capabilities explicitly. An unselected capability adds no
   dependency, permission, entitlement, service file, or credential input.
6. Classify runtime configuration: non-secret endpoints/identifiers may be
   build/runtime inputs; device credentials use platform secure storage;
   provider credentials remain server-side.

## MUST

- Keep exactly three Rust crates: portable core, UniFFI bindings, and an
  off-device CLI diagnostic consumer. Product modules belong in the consumer,
  never in this template.
- Keep one UDL as the native contract source. Generate Kotlin/Swift and verify
  checksum symbols; do not hand-maintain a second FFI declaration.
- Make the core own portable outcomes. Android and iPhone may use different
  native types and UI lifecycles but must preserve the same result, state, and
  typed-error contract.
- Keep one neutral token JSON source and regenerate both language outputs.
  Drift is a failing result, not a warning.
- Record every substitution and portable command in a validated
  `mobileBase` checks-config section. Start from
  `reference/mobile-base.checks-config.example.json` and update every path,
  identity token, allowlist, and command for the consumer.
- Run both portable suites: `checks/mobile-base-contract.test.ts` validates
  scaffold/source hygiene; `checks/mobile-base-commands.test.ts` executes the
  configured format, clippy, test, boundary-smoke, and token-drift commands.
- Keep secret values outside the repository. Signing/service/provider inputs
  have names and preflight behavior only. A missing optional input disables
  its capability; a missing release signing identity fails release preflight.
- Report unsupported platform execution as `host-constrained`. Missing tools
  or an incapable host never become a passing check.

## SHOULD

- Keep the Rust core independent of Android/iOS framework crates and make the
  CLI exercise the same public core operations used through UniFFI.
- Keep generated bindings and native binaries out of source control; regenerate
  before platform builds and verify symbols/slices after packaging.
- Prefer typed configuration errors and redacted diagnostics over platform
  exceptions or fallback defaults.
- Keep the source scan roots narrow and explicit so the hygiene check is fast,
  deterministic, and free of build-cache noise.

## FREE

Product models, API implementation, persistence, networking library, native UI
framework details, navigation, copy, branding, asset pipeline, and the selected
optional-capability set are consumer choices so long as the MUST outcomes and
assertions remain green.

## Acceptance meaning

The stable assertion IDs and the Android/iPhone ownership boundary live in the
plan's parity decision. In short, parity is equivalent portable outcomes plus
platform-native fitness—not identical screens. The template checks prove the
portable half; each platform shell supplies its host-capable build, package,
privacy, and release assertions.
