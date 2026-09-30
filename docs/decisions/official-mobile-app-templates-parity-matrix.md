# Official mobile app templates — parity and acceptance matrix

**Date:** 2026-08-20  
**Plan:** `official-mobile-app-templates-2026-08-20` · P-005  
**Inputs:** [two-source extraction matrix](official-mobile-app-templates-extraction-matrix.md),
[frozen v0.1 contract](official-mobile-app-templates-contract.md), and plan
decision D-005.

## Parity definition

Android and iPhone are conformant when the same portable operation produces
the same domain result and state transition, the generated UniFFI boundaries
agree with that Rust contract, and each native shell proves the equivalent
platform outcome through its own APIs. Parity does **not** require identical
screens, navigation stacks, framework types, lifecycle timing, accessibility
APIs, or release packaging.

The official templates therefore use four ownership classes:

- **Portable Rust** owns deterministic domain behavior, validation, state
  transitions, serialization, network-independent configuration semantics,
  error taxonomy, and the UDL-facing contract.
- **Generated boundary** owns the mechanically generated Kotlin/Swift
  representation of the UDL and its checksum symbols. It is an artifact, not
  a second abstraction source.
- **Native seam** owns platform lifecycle, presentation, storage primitives,
  permissions, links, notifications, media/camera/microphone APIs, and release
  packaging while preserving portable outcomes.
- **Product consumer** owns domain modules, endpoints, models, copy, routes,
  brand, assets, and capability selection.

An optional capability is absent from the default dependency closure. Once a
consumer enables it, the capability's platform acceptance assertions become
mandatory for that consumer on every selected platform.

## Normative assertion levels

| Level | Meaning |
|---|---|
| **MUST** | A portable/template check fails if the assertion can execute and does not pass. |
| **HOST** | The assertion must execute on a capable host. An incapable host reports `host-constrained` with the missing host/tool, never green or silently skipped. |
| **OPT-IN** | Not required in the default root; becomes MUST/HOST when its decision-point answer enables the capability. |
| **CONSUMER** | Proven by each reference consumer without moving its product behavior into the template. |

## Shared behavioral parity matrix

| ID | Surface | Owner | Android acceptance | iPhone acceptance | Level |
|---|---|---|---|---|---|
| `MOB-PAR-001` | Core determinism | Portable Rust | The same fixture/input produces the same success value or typed error through Kotlin as the Rust test. | The same fixture/input produces the same success value or typed error through Swift as the Rust test. | MUST |
| `MOB-PAR-002` | State transitions | Portable Rust | Kotlin observes the ordered state sequence declared by the Rust state-machine test, with no Android-only domain state. | Swift observes the same ordered state sequence, with no iPhone-only domain state. | MUST |
| `MOB-PAR-003` | Validation and normalization | Portable Rust | Invalid, boundary, and normalized inputs map to the canonical Rust outcomes; Compose may change presentation only. | The same input table maps to the canonical Rust outcomes; SwiftUI may change presentation only. | MUST |
| `MOB-PAR-004` | Serialization contract | Portable Rust | Kotlin round-trips every versioned boundary fixture without field loss and rejects incompatible input with the declared error. | Swift round-trips the same fixtures and rejects the same incompatible input class. | MUST |
| `MOB-PAR-005` | Error taxonomy | Portable Rust | Generated/native wrappers preserve stable error code, retryability, and redacted message class. | Generated/native wrappers preserve the same error code, retryability, and redacted message class. | MUST |
| `MOB-PAR-006` | Cancellation and retry policy | Portable Rust plus native adapter | Cancellation reaches Rust and leaves the declared terminal state; retries use the Rust policy, not a second Kotlin policy. | Cancellation reaches Rust and leaves the same terminal state; retries use the Rust policy, not a second Swift policy. | MUST when the core exposes asynchronous work |
| `MOB-PAR-007` | Runtime configuration | Portable Rust plus native loader | Missing, malformed, and valid non-secret inputs yield the same typed Rust result after Android config loading. | The same configuration table yields the same result after iPhone config loading. | MUST |
| `MOB-PAR-008` | Boundary call direction | Generated boundary | One host smoke calls generated Kotlin into Rust and proves the expected return/error; no hand-written duplicate FFI declaration exists. | One host smoke calls generated Swift into Rust and proves the same return/error; no hand-written duplicate FFI declaration exists. | HOST |
| `MOB-PAR-009` | UniFFI freshness | Generated boundary | Generated Kotlin checksum symbols match every packaged `.so` export for all required ABIs. | Generated Swift/header/module symbols match the XCFramework device and simulator slices. | HOST |
| `MOB-PAR-010` | Design-token source | Shared generator plus native presentation | Kotlin tokens regenerate deterministically from the neutral source and the drift check is clean. | Swift tokens regenerate from the same source and the drift check is clean. | MUST |
| `MOB-PAR-011` | Accessibility meaning | Native seam | The launch/root smoke exposes a named actionable root through Android accessibility semantics. | The launch/root smoke exposes the equivalent named action through iOS accessibility APIs. | HOST; wording/layout may differ |
| `MOB-PAR-012` | Offline/error presentation | Product consumer plus native seam | A portable offline/error state is reachable and rendered without converting it to success or leaking secret detail. | The same portable state is reachable and preserves the same outcome/redaction. | CONSUMER |

## Platform-native acceptance matrix

These assertions intentionally differ by platform. They prove equivalent
fitness and security, not byte-identical artifacts.

| ID | Platform | Acceptance assertion | Level |
|---|---|---|---|
| `MOB-AND-001` | Android | SDK/NDK/Java/cargo-ndk preflight resolves the pinned toolchain without a developer-home path, then builds the four declared Rust ABIs after deleting stale JNI outputs. | HOST |
| `MOB-AND-002` | Android | Gradle generates the Kotlin binding incrementally before compilation from the UDL/config/lock inputs and declares the generated output directory. | HOST |
| `MOB-AND-003` | Android | Debug APK and release APK/AAB contain exactly `arm64-v8a`, `armeabi-v7a`, `x86`, and `x86_64`; source `abiFilters` alone is insufficient evidence. | HOST |
| `MOB-AND-004` | Android | Every packaged native library passes the generalized UniFFI checksum/export verifier; every 64-bit release ELF and release APK passes the 16 KB alignment checks. | HOST |
| `MOB-AND-005` | Android | JVM unit smoke, instrumentation launch/navigation smoke, lint, merged-manifest permission allowlist, and release cleartext prohibition pass with non-zero expected test execution. | HOST |
| `MOB-AND-006` | Android | A publishable APK/AAB pair has one requested version, one clean source commit, verified package metadata, and atomically written SHA-256 provenance; missing signing identity fails publish preflight. | HOST |
| `MOB-IOS-001` | iPhone | XcodeGen deterministically produces the project from `ios/project.yml`; the generated `.xcodeproj` is not template source. | HOST |
| `MOB-IOS-002` | iPhone | Rust builds device `aarch64-apple-ios` plus simulator `aarch64-apple-ios-sim` and `x86_64-apple-ios`, lipos the simulator library, and produces one XCFramework with headers/modulemap. | HOST |
| `MOB-IOS-003` | iPhone | The generated Swift boundary compiles behind its own module target and the app/tests import that module rather than compiling generated bindings ad hoc. | HOST |
| `MOB-IOS-004` | iPhone | Host-health, SDK, simulator, XcodeGen, and SwiftFormat preflights pass before build; a Linux invocation either delegates to the declared Mac host or reports `host-constrained`. | HOST |
| `MOB-IOS-005` | iPhone | XCTest and XCUITest bundles return Xcode success **and** execute a non-zero expected test count; wrapper exit status alone cannot satisfy the assertion. | HOST |
| `MOB-IOS-006` | iPhone | Privacy manifest and selected entitlements agree with XcodeGen/project settings; archive/export/signing preflight verifies the selected release mode without uploading. | HOST |

## Optional capability parity matrix

| ID | Capability | Shared contract | Android assertion when enabled | iPhone assertion when enabled |
|---|---|---|---|---|
| `MOB-OPT-001` | Device credential storage | Portable code sees only a small store interface and redacted typed failures; provider secrets remain server-side. | Keystore-backed round-trip, overwrite, delete, unavailable/locked failure, and no plaintext source/config residue. | Keychain-backed equivalents with the same portable result classes and no plaintext residue. |
| `MOB-OPT-002` | Deep links | Product maps an external route into one portable route intent; unknown input is rejected safely. | Cold and warm intent delivery tests for the selected scheme/app link. | Cold and warm URL/universal-link tests for the selected scheme/domain. |
| `MOB-OPT-003` | Push notifications | Product owns payload/domain behavior; service credentials stay external and privacy declarations are explicit. | Permission-denied and cold/warm tap routing tests; service file absent from template source. | Permission-denied and cold/warm tap routing tests; APNs credential absent from template source. |
| `MOB-OPT-004` | Camera/microphone | Portable behavior never assumes permission; denial yields the same typed unavailable outcome. | Merged-manifest allowlist plus grant/deny/revoke lifecycle test. | Privacy usage declaration plus grant/deny/revoke lifecycle test. |
| `MOB-OPT-005` | Local networking | Endpoint remains product-owned; release transport policy remains secure. | Any cleartext exception is debug-only and host-scoped; release manifest/config proves cleartext disabled. | Local-network entitlement/privacy declaration is present only when selected; release transport policy passes. |
| `MOB-OPT-006` | Analytics/crash reporting | No default dependency, identifier, upload, or credential; events contain no secrets. | Plugin/service file, permissions, and consent behavior exist only when selected and pass source-hygiene checks. | Package/config/privacy declarations exist only when selected and pass source-hygiene checks. |
| `MOB-OPT-007` | Media playback | URLs/tokens derived by the server remain product-owned; the portable boundary exposes only neutral playback state if needed. | Selected Android media dependency and lifecycle tests do not introduce product provider keys into source. | Selected iPhone media dependency and lifecycle tests prove the equivalent state/redaction contract. |

## Source, identity, and secret acceptance assertions

| ID | Assertion | Level |
|---|---|---|
| `MOB-SRC-001` | A materialized app contains the selected crate, package, module, bundle, display, artifact, repository, author, and license identities in every derived representation. | MUST |
| `MOB-SRC-002` | Tracked source and generated project metadata contain no unallowlisted `Papercusp`, `Papercup`, `SideStage`, `com.example`, `example.invalid`, `mobile_app`, `MobileApp`, or unresolved template token. | MUST after materialization |
| `MOB-SRC-003` | Substitution is identifier-aware and leaves dependency names, third-party URLs, licenses, binary assets, fixtures, and unrelated prose unchanged. | MUST |
| `MOB-SRC-004` | The source set contains no usable key/token/credential/private key/keystore/provisioning profile/service payload/private-host key or generated native/build artifact; ignore rules alone do not satisfy this scan. | MUST |
| `MOB-SRC-005` | Signing and provider inputs have names and preflight behavior but no values. Missing optional inputs disable their capability cleanly; missing required release signing fails release preflight. | MUST |
| `MOB-SRC-006` | Every platform leg returns one of `passed`, `failed`, or `host-constrained` with evidence; a missing tool or unsupported host can never be summarized as passed. | MUST |

## Reference-consumer conformance

Papercusp and SideStage remain independent product repositories and are
conformance consumers, not copied fixtures. Each consumer must record one
checks configuration containing its decision-point answers, selected
capabilities, identity allowlist, host strategy, and assertion applicability.

| ID | Consumer proof |
|---|---|
| `MOB-REF-001` | Papercusp Android passes all applicable shared/Android/source assertions while retaining operator, pairing, voice, push, and diagnostic domain code outside the template. |
| `MOB-REF-002` | SideStage Android passes all applicable shared/Android/source assertions while retaining marketplace, checkout, order, realtime, and media behavior outside the template. |
| `MOB-REF-003` | Papercusp iPhone passes all applicable shared/iPhone/source assertions with the same product-domain exclusion. |
| `MOB-REF-004` | SideStage iPhone passes all applicable shared/iPhone/source assertions with the same commerce/media exclusion. |
| `MOB-REF-005` | The two consumers exercise at least one different optional-capability set, proving that optional seams are genuinely optional rather than hidden base dependencies. |
| `MOB-REF-006` | A clean greenfield Android root and a clean greenfield iPhone root materialize from the bundled-store closure and pass every applicable portable assertion without reading either reference consumer. |

## Acceptance execution contract

1. `papercusp-mobile-base` owns `MOB-PAR-*` portable fixtures,
   `MOB-SRC-*`, neutral token generation, and the common result schema.
2. `papercusp-android-shell` owns `MOB-AND-*` plus Android realizations of
   applicable `MOB-PAR-*` and `MOB-OPT-*` assertions.
3. `papercusp-iphone-shell` owns `MOB-IOS-*` plus iPhone realizations of
   applicable `MOB-PAR-*` and `MOB-OPT-*` assertions.
4. Thin app roots check only exact dependency closure, answer completeness,
   and composition integrity; they do not duplicate shell/base assertions.
5. Consumer configs select assertions by stable ID. An assertion may be marked
   `not-applicable` only with the decision-point answer that makes it so.
6. Checks emit machine-readable assertion ID, verdict, host, selected
   capability, evidence path, and command/test identity. Counts are derived
   from those records, never inferred from wrapper exit status.
7. Adding a new optional capability adds assertions without weakening the
   default closure. Changing an existing assertion's ownership or success
   meaning is a contract change under the v0.1 versioning rule.

## Explicit non-parity surfaces

The following are deliberately excluded from template parity: visual layout,
screen count, navigation implementation, copy, branding, assets, animation,
product endpoint/model/fixture shape, telemetry event names, app-store listing,
release-channel policy, and product-specific domain flows. They may be tested
inside each consumer but cannot be used to make the common base depend on one
product.
