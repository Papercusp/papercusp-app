# checks/ — iPhone shell acceptance

Both entry points are portable and app-parameterized through the `iphoneShell`
section of the JSON file named by `TEMPLATE_CHECKS_CONFIG`. Without that
section they skip. Compose the shared `mobileBase` section and its checks beside
them.

## `iphone-shell-contract`

Validates the source-level chassis: complete identity and pinned deployment
inputs, XcodeGen as the only project source, an ignored generated project,
exact device/simulator Rust targets, one XCFramework with headers/modulemap, a
dedicated generated Swift module target, source/test roots, local or named
remote Mac strategy, privacy/entitlement/capability agreement, external-only
signing names, and archive/export preflight with no upload.

## `iphone-shell-assertions`

Executes the nine required host legs covering `MOB-IOS-001` through
`MOB-IOS-006`. Direct argv is used—no shell interpolation. Unit and UI legs
must match a non-zero test-count diagnostic; wrapper exit status alone cannot
pass. The signing-absence leg intentionally expects a diagnostic non-zero exit
with every signing input removed. Each leg atomically writes a generated JSON
evidence record. A local-Mac strategy invoked on Linux, or a missing named
remote host/tool/SDK/simulator, becomes a failing `host-constrained` verdict,
never a skip or pass.

Start from `../reference/iphone-shell.checks-config.example.json`. The config
contains paths, command argv, non-secret flags, and signing input **names**
only. Generated projects, bindings, libraries, XCFrameworks, result bundles,
archives, exports, and evidence belong under ignored build paths.
