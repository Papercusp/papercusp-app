# checks/ — Android shell acceptance

Both entry points are portable and app-parameterized through the
`androidShell` section of the JSON file named by `TEMPLATE_CHECKS_CONFIG`.
Without that section they skip. Compose the shared `mobileBase` section and
its checks beside them.

## `android-shell-contract`

Validates the source-level chassis: complete identity and pinned toolchain,
one Compose app module, exact ABI declaration, incremental UniFFI Kotlin task,
SDK/NDK/cargo-ndk resolver, stale-JNI cleanup, test roots, lint, permission
allowlist, cleartext policy, external-only signing names, release artifact
paths, provenance, checksum verification, and 16 KB tooling. It rejects
developer-home SDK fallbacks and literal signing values.

## `android-shell-assertions`

Executes the ten required host legs covering `MOB-AND-001` through
`MOB-AND-006`. Direct argv is used—no shell interpolation. The signing-absence
leg intentionally expects a diagnostic non-zero exit with every signing input
removed. Each leg atomically writes a generated JSON evidence record. Missing
tools/SDK/device conditions become a failing `host-constrained` verdict, never
a skip or pass.

Start from `../reference/android-shell.checks-config.example.json`. The config
contains paths, command argv, non-secret flags, and signing input **names**
only. Generated evidence belongs under a build directory and must not be
committed.
