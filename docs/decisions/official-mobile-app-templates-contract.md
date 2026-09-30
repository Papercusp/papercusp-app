# Official mobile app templates — frozen v0.1 contract

**Date:** 2026-08-20  
**Plan:** `official-mobile-app-templates-2026-08-20` · P-004  
**Input:** [two-source extraction matrix](official-mobile-app-templates-extraction-matrix.md)

## Composition

The proposed five-template composition is retained without deviation. All
initial versions are `0.1.0`; dependency edges are exact pins.

| Template ID | Scope | Category | Hard requirements | Role |
|---|---|---|---|---|
| `papercusp-mobile-base` | aspect | shell | none | Cross-platform Rust/UniFFI, token, configuration, source-hygiene, and verification contract. |
| `papercusp-android-shell` | aspect | shell | none | Compose/Gradle/cargo-ndk chassis and Android package/release checks. |
| `papercusp-android-app` | app | app | `papercusp-mobile-base@0.1.0`, `papercusp-android-shell@0.1.0` | Thin official Android app root and composition-integrity check. |
| `papercusp-iphone-shell` | aspect | shell | none | SwiftUI/XcodeGen/XCFramework chassis and iPhone package/release checks. |
| `papercusp-iphone-app` | app | app | `papercusp-mobile-base@0.1.0`, `papercusp-iphone-shell@0.1.0` | Thin official iPhone app root and composition-integrity check. |

No new template scope, category, manifest schema, materializer, or component
registry is introduced. Mobile reuses the existing `app`/`aspect`,
`app`/`shell`, exact `requires` closure, GUIDE, portable checks,
`TEMPLATE_CHECKS_CONFIG`, template-kit reference manifest, bundled store,
Cupboard, public mirror, and template-gym surfaces.

## Decision points

Decision-point IDs are stable API. GUIDEs may expand the prompts but must not
rename an ID without a template major-version change.

### `papercusp-mobile-base`

| ID | Question answered by the builder |
|---|---|
| `product-domain` | What domain behavior belongs in the portable Rust core, and what remains native presentation? |
| `rust-msrv` | Which supported Rust MSRV does the app require? |
| `license-and-repository` | What SPDX license, authorship, and repository metadata replace the neutral starter values? |
| `design-token-source` | Which product token values and typography replace the neutral token source while preserving deterministic Kotlin/Swift generation? |
| `optional-capabilities` | Which optional native seams—credentials, deep links, push, crash reporting, analytics, camera, microphone, media playback, or local networking—are enabled? |
| `runtime-configuration` | Which non-secret endpoints/identifiers are build-time versus runtime inputs, and which device credentials use secure storage? |

### `papercusp-android-shell`

| ID | Question answered by the builder |
|---|---|
| `android-identity` | What namespace, application ID, package path, display name, version source, and launcher identity are used? |
| `android-sdk-floor` | Does the app keep the default min SDK or raise it for a selected capability? |
| `android-local-network` | Is a debug-only local cleartext endpoint required, and how is it constrained so release remains cleartext-free? |
| `android-capabilities` | Which optional permissions, features, services, Gradle plugins, repositories, and manifest entries are enabled? |
| `android-release` | Which external signing-property names, release channel, version input, and provenance destination are used? |

### `papercusp-iphone-shell`

| ID | Question answered by the builder |
|---|---|
| `iphone-identity` | What bundle ID, module, scheme, product/display name, version/build source, and generated project name are used? |
| `iphone-os-floor` | Does the app keep the default deployment target or raise it for a selected capability? |
| `iphone-capabilities` | Which optional entitlements, privacy declarations, URL schemes, associated domains, background modes, and Swift packages are enabled? |
| `iphone-test-host` | Are Xcode checks executed locally on macOS or delegated to a named Mac host from Linux? |
| `iphone-release` | Which external team/signing inputs, archive/export mode, release channel, and validation actions are used? |

### Thin app roots

Each app root declares one decision point:

| Template | ID | Question answered by the builder |
|---|---|---|
| `papercusp-android-app` | `android-app-purpose` | What product is this Android app, and which answers are supplied to every decision point in its exact dependency closure? |
| `papercusp-iphone-app` | `iphone-app-purpose` | What product is this iPhone app, and which answers are supplied to every decision point in its exact dependency closure? |

The root purpose answer is a disclosure, not a place to duplicate identity or
capability parameters owned by the shell/base aspects.

## Materialization parameters and defaults

These snake-case keys are the canonical builder/checks vocabulary. The
template system remains guidance-plus-verification: builders may use native
framework tools rather than a global text-replacement engine, but every source
identity and portable check must resolve from the same answer set.

### Shared parameters

| Key | Default | Contract |
|---|---|---|
| `app_name` | `Mobile App` | Human display name; must be replaced for a shipped app. |
| `app_slug` | `mobile-app` | Kebab-case repository/app slug. |
| `rust_crate_prefix` | `mobile_app` | Snake-case prefix for core/bindings/CLI crates and Rust symbols. |
| `rust_msrv` | `1.88` | Minimum supported Rust compiler; may be lowered only when all selected dependencies verify. |
| `license_spdx` | `MIT` | Must be an SPDX identifier selected by the builder. |
| `repository_url` | `https://example.invalid/mobile-app` | Non-shippable sentinel; placeholder check requires replacement. |
| `token_namespace` | `mobile` | Neutral source namespace for generated Kotlin/Swift tokens. |
| `optional_capabilities` | `[]` | Closed set named by the base decision point; opt-in only. |
| `runtime_config_keys` | `[]` | Names of non-secret runtime inputs. Values are never stored in the template contract. |

### Android parameters

| Key | Default | Contract |
|---|---|---|
| `android_namespace` | `com.example.mobileapp` | Kotlin namespace and source package path. |
| `android_application_id` | `com.example.mobileapp` | Install identity; may differ from namespace only by an explicit decision. |
| `android_min_sdk` | `24` | Compatibility floor; selected capabilities may raise it. |
| `android_compile_sdk` | `36` | Pinned shell toolchain value. |
| `android_target_sdk` | `36` | Pinned shell policy value. |
| `android_gradle` | `8.14.3` | Wrapper version. |
| `android_agp` | `8.13.2` | Android application plugin version. |
| `android_kotlin` | `2.0.21` | Kotlin and Compose plugin version. |
| `android_java` | `17` | Source, target, and build JVM floor. |
| `android_ndk` | `27.0.12077973` | Default NDK used by the verified cargo-ndk/alignment flow. |
| `android_abis` | `arm64-v8a,armeabi-v7a,x86,x86_64` | Exact development and release package set. |
| `android_native_library` | `libmobile_app.so` | Derived from `rust_crate_prefix`; one library per ABI. |
| `android_release_version_input` | `APP_RELEASE_VERSION` | Neutral environment/property name used to bind release artifacts. |
| `android_debug_cleartext` | `false` | Secure default; any `true` answer is debug-only and host-scoped. |
| `android_signing_prefix` | `APP_ANDROID_RELEASE_` | Prefix for external keystore/password/alias inputs; no values are templated. |

### iPhone parameters

| Key | Default | Contract |
|---|---|---|
| `iphone_bundle_id` | `com.example.mobileapp` | Install/App Store identity. |
| `iphone_product_name` | `MobileApp` | PascalCase Xcode product and scheme name. |
| `iphone_core_module` | `MobileAppCore` | Generated-binding module target. |
| `iphone_deployment_target` | `17.0` | Default iPhone OS floor. |
| `iphone_device_target` | `aarch64-apple-ios` | Required device Rust slice. |
| `iphone_simulator_targets` | `aarch64-apple-ios-sim,x86_64-apple-ios` | Required simulator Rust slices. |
| `iphone_project_source` | `ios/project.yml` | XcodeGen source of truth; `.xcodeproj` is generated. |
| `iphone_url_scheme` | unset | Optional; only present when deep links are selected. |
| `iphone_team_id` | unset | External release input; never committed or defaulted. |
| `iphone_remote_host` | unset | Optional named Mac executor; no host/key/user is embedded in a materialized app. |

## Supported host and toolchain matrix

| Host | Shared Rust/UniFFI | Android | iPhone | v0.1 support statement |
|---|---|---|---|---|
| Linux x86_64 | Full | Full SDK/NDK/Gradle build, test, APK/AAB, and release preflight | Source, placeholder, manifest, and config checks only | Supported. iPhone execution must report `host-constrained`, never pass. |
| macOS arm64/x86_64 | Full | Full when Android SDK/NDK and Java 17 are installed | Full XcodeGen/XCFramework/simulator/XCTest/XCUITest/archive preflight | Supported. This is the authoritative iPhone execution host. |
| Windows via WSL2 | Same as Linux | Same as Linux with SDK/NDK visible inside WSL | Same as Linux | Supported as Linux semantics; native Windows scripts are not claimed. |
| Native Windows | Not verified | Not verified | Impossible | Not supported in v0.1; portable checks must fail with an explicit host verdict rather than partial green. |

Required toolchain contracts are Rust at or above `rust_msrv`, cargo-ndk,
Android SDK/target 36, NDK `27.0.12077973`, Java 17, Gradle `8.14.3`, AGP
`8.13.2`, Kotlin `2.0.21`, Node for portable template/token checks, and—in the
iPhone execution leg—macOS, Xcode with iOS 17+ SDK/simulator support,
XcodeGen, SwiftFormat, `lipo`, and `xcodebuild`.

## Substitution contract

1. The builder records every decision-point answer and the final parameter
   document next to the materialized app’s checks configuration.
2. One answer drives all representations of an identity. Crate names, UniFFI
   prefixes, Kotlin package path, Android namespace/application ID, Swift
   module, Xcode scheme, bundle ID, display strings, and artifact names may
   not be replaced independently without an explicit divergence decision.
3. Placeholder detection is allowlist-based and scans tracked source plus
   generated project metadata. `Papercusp`, `Papercup`, `SideStage`,
   `com.example`, `example.invalid`, `mobile_app`, and `MobileApp` are forbidden
   after materialization except in provenance/attribution fixtures explicitly
   named by the checks config.
4. Substitution must be identifier-aware. It may not perform an unbounded
   global replacement inside dependency names, third-party URLs, licenses,
   binary assets, test fixtures, or user-visible prose.
5. Generated paths and symbol prefixes are verified after substitution by
   building the Rust workspace, regenerating bindings/tokens/projects, and
   matching checksum symbols, package paths, module names, and bundle/package
   metadata.

## No-secret and external-config contract

1. Template source, reference assets, worked configs, tests, and greenfield
   fixtures contain no usable secret, token, credential, private key,
   keystore, provisioning profile, service payload, or private host key.
2. Secret parameters have **names but no values**. Signing, push, crash,
   analytics, voice, payment, search, and provider credentials are injected
   outside the repository. A missing optional credential disables the
   capability cleanly; a publishable release fails its preflight.
3. Non-secret demo endpoints and identities are still product-owned. Official
   defaults use `example.invalid` or unset values, never Papercusp/SideStage
   URLs, local operator addresses, buyer IDs, or developer usernames.
4. Device credentials use the optional secure-storage seam (Android Keystore
   and iOS Keychain). Provider/server credentials stay server-side.
5. The source-hygiene check scans tracked files and the resolved build config;
   `.gitignore` alone is not evidence. Generated artifacts and local config
   files must also be absent from the materialized source set.

## Versioning consequence

Changing an ID, scope, category, decision-point ID, parameter key, default that
changes generated behavior, required target/ABI set, or no-secret rule is a
template contract change. Additive checks or clearer GUIDE prose may remain
within `0.1.x`; breaking contract changes require a coordinated version bump
across the affected root and its exact `requires` pins.
