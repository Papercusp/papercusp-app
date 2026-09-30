# checks/ — shared mobile-base acceptance

Both checks are portable and app-parameterized through the `mobileBase`
section of the JSON file named by `TEMPLATE_CHECKS_CONFIG`. Without that
section they skip.

## `mobile-base-contract`

Validates the three-crate Rust scaffold, one UDL/UniFFI configuration,
bindgen entry point, token source and generated-language outputs, required
paths, placeholder/foreign-identity absence, secret-path absence, and common
credential signatures. Every scan root and allowlist is explicit.

## `mobile-base-commands`

Executes direct argv from `portableCommands` without a shell. The config must
include `rust-fmt`, `rust-clippy`, `rust-test`, `binding-smoke`, and
`token-drift`; every command must exit zero. Platform-only build/package legs
belong to the Android/iPhone shell suites, where an incapable host reports
`host-constrained` rather than passing.

Start from `../reference/mobile-base.checks-config.example.json`.
