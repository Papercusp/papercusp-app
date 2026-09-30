# Official mobile app templates — two-source extraction matrix

**Date:** 2026-08-20  
**Plan:** `official-mobile-app-templates-2026-08-20` · P-003  
**Evidence sources:** canonical `papercup-rust-mobile` and `sidestage-mobile`
repositories, plus the P-002 reproducible baseline recorded on WI-39957.

## Decision frame

Papercusp and SideStage are co-equal evidence sources. This matrix extracts
their intersection, then chooses a verified stronger implementation where the
same invariant is realized differently. It is not a request to clone either
product.

The classifications are intentionally exclusive:

- **Shared invariant** — cross-platform architecture or policy owned by
  `papercusp-mobile-base`.
- **Android shell** — Android/Compose/Gradle realization owned by
  `papercusp-android-shell`.
- **iPhone shell** — iOS/SwiftUI/Xcode realization owned by
  `papercusp-iphone-shell`.
- **Optional capability** — a declared seam a product may opt into; never a
  default dependency of the base.
- **Product-specific** — domain behavior, data, copy, or branded experience
  that stays in the reference consumer.
- **Generated output** — reproducible build output that must not become
  template source.
- **Secret/external config** — injected at build/run time and never committed.

“Selected source” names the best currently verified behavior. “Both” means the
implementations already agree on the invariant; it does not mean copying both
files.

## Extraction matrix

| Recurring surface | Evidence in both products | Classification | Selected source and template treatment |
|---|---|---|---|
| Repository chassis | Workspace `Cargo.toml`, `Cargo.lock`, `Makefile`, `crates/`, `android/`, `ios/`, `tools/`, design tokens | Shared invariant | **Both.** Preserve the three-crate Rust shape plus native shells and one top-level command surface. Parameterize names, license, repository, and minimum Rust version. |
| Rust crate split | `<product>-core`, `<product>-bindings`, `<product>-cli` | Shared invariant | **Both.** Core owns portable domain/network behavior, bindings own the single UniFFI boundary, and CLI is an off-device diagnostic consumer. Domain modules remain product-specific. |
| Rust dependency policy | Workspace resolver 2, edition 2021, pinned lockfile, shared workspace dependencies, size-oriented release profile | Shared invariant | **Both.** Keep dependency choice FREE, but require a checked lockfile, explicit MSRV, TLS choice, and no platform UI logic in the core. |
| UniFFI contract source | One UDL, `build.rs`, `uniffi.toml`, bindgen binary, Rust wrapper crate | Shared invariant | **Both.** The UDL is the canonical native boundary. Generated Kotlin/Swift never becomes hand-maintained source. |
| Host boundary smoke | Papercusp Rust tests and Android ABI guard; SideStage Rust bindings smoke, Swift host smoke, status/platform guards | Shared invariant | **SideStage baseline plus Papercusp ABI evidence.** Require a Rust-call-direction smoke, generated-language smoke when the host exists, and checksum-symbol agreement for every packaged native slice. |
| Cross-platform parity boundary | Both products keep portable API/state behavior in Rust and map it into native presentation | Shared invariant | **Both.** Define parity as equivalent domain outcomes and state transitions, not identical screens. P-005 freezes the assertions. |
| Design-token source | Both carry mobile primitive/component/semantic token JSON and generated Kotlin/Swift outputs | Shared invariant | **Papercusp pipeline generalized.** Keep one neutral token source, deterministic Kotlin/Swift generation, and a drift check. Product values, typography, assets, and names remain consumer-owned. |
| Top-level quality gate | Both expose fmt, clippy, tests, binding generation, Android build, and iOS build through `Makefile` | Shared invariant | **Union.** A portable `check` contract runs scaffold/placeholder/secret checks, Rust fmt/clippy/tests, binding smoke, token drift, and platform-specific checks only on capable hosts. |
| Toolchain/host contract | Gradle 8.14.3, Kotlin 2.0.21, Java 17, Android SDK 36, NDK 27.0.12077973; iOS scripts require macOS/Xcode | Shared invariant | **Both, explicit.** Pin the build tools, validate them before work, and report unsupported-host legs as constrained rather than green. Rust MSRV stays a decision point. |
| Source/placeholder hygiene | Both use product-specific crate/package/module/bundle names throughout | Shared invariant | **New neutral check derived from both.** Materialized apps must contain the chosen identity and must not retain Papercusp, Papercup, SideStage, example buyer IDs, or template placeholder tokens outside allowlisted provenance/docs. |
| Secret hygiene | Both ignore `local.properties`, service files, signing inputs, and build products | Shared invariant | **Papercusp documentation plus both ignore rules.** Template only schemas/examples; require an absence scan for key material and local service payloads. |
| Android Gradle chassis | Wrapper, settings, AGP application plugin, Kotlin/Compose plugins, app module | Android shell | **Both.** Keep a single app module and repository-policy settings. Additional repositories/plugins are optional capability decisions. |
| Android SDK discovery | Both use the Android SDK/NDK; SideStage resolves `ANDROID_SDK_ROOT`/`ANDROID_HOME` and tests the fallback | Android shell | **SideStage.** Reuse the tested resolver and cargo-ndk preflight, parameterized for the consumer and with no hardcoded home path. |
| Android identity and versions | Namespace, application ID, app name, version code/name, compile/min/target SDK | Android shell | **Both, parameterized.** Package ID, display name, min SDK, version source, and release version input are decision points; compile/target SDK remains a pinned shell default. |
| Kotlin binding generation | Both invoke UniFFI; SideStage wires an incremental Gradle `Exec` task into `preBuild` | Android shell | **SideStage.** Generate from UDL/config/lock inputs before Android compilation and declare the generated Kotlin output. Retain the explicit Make target for CI/debugging. |
| Rust Android cross-build | Both delete stale JNI outputs, run cargo-ndk for four ABIs, and package the shared library | Android shell | **Union.** Use SideStage SDK/cargo-ndk preflight and both products’ stale-output deletion. Crate, library, and UniFFI symbol prefixes are parameters. |
| Android ABI contract | Both compare generated Kotlin checksum symbols with exports from every `.so` | Android shell | **Both, generalized.** Extract one neutral verifier that accepts the binding file, symbol prefix, and library paths; never infer freshness from mtimes. |
| Packaged ABI coverage | Both assert `arm64-v8a`, `armeabi-v7a`, `x86`, and `x86_64` in debug/release archives | Android shell | **Both.** Verify the exact ABI set in APK and AAB; do not trust source `abiFilters` alone. |
| 16 KB native alignment | Both inspect 64-bit ELF LOAD alignment and run `zipalign -P 16` for release APKs | Android shell | **Both, generalized.** Keep as a release check using discovered NDK/build-tools binaries. |
| Android release provenance | Both bind requested version, source commit, artifact hashes, APK version, APK/AAB pair, and clean source | Android shell | **Papercusp producer/manifest validation plus SideStage resolver test.** Write provenance atomically only after both artifacts verify; require `dirty:false` and re-verify hashes/version/commit before publish. |
| Android signing | Both read keystore path/password/alias from Gradle properties or environment and keep the keystore outside the repo | Android shell | **Both.** Signing input names become parameters. Debug may build unsigned; a publishable release must prove a configured signing identity rather than silently accepting an unsigned artifact. |
| Android cleartext policy | Papercusp defaults release to no cleartext with a debug-only local exception; SideStage currently enables cleartext for its emulator demo API | Android shell | **Papercusp.** Release cleartext is forbidden. A narrowly scoped debug/local-network exception is an explicit decision and check, not a product default. |
| Android permission/privacy surface | Both declare only needed permissions; Papercusp additionally removes inherited ad/attribution permissions and tests privacy permissions | Android shell | **Papercusp guard generalized.** Require an allowlist/diff check over the merged release manifest. Camera, microphone, notifications, foreground service, analytics, and attribution permissions are optional capability inputs. |
| Compose application seam | Both use a thin `MainActivity`, Compose theme/tokens, navigation/root state, and native wrappers over Rust | Android shell | **SideStage’s smaller chassis.** Ship only the activity/root/theme/navigation seams. Product screens, routes, copy, and state machines remain consumer code. |
| Android tests and lint | Both have JVM tests; SideStage has instrumentation smoke and auto-binding; Papercusp has lint configuration and security/privacy tests | Android shell | **Union.** Require JVM unit smoke, instrumentation launch/navigation smoke, lint, generated-binding/ABI checks, and release-preflight checks. |
| iPhone project source | Both keep `ios/project.yml` and generate an Xcode project with XcodeGen | iPhone shell | **Both.** XcodeGen YAML is source; `.xcodeproj` is generated output. Bundle ID, display name, deployment target, capabilities, schemes, and package dependencies are decisions. |
| iPhone Rust slices | Both build `aarch64-apple-ios`, `aarch64-apple-ios-sim`, and `x86_64-apple-ios`, lipo simulator slices, and create an XCFramework | iPhone shell | **Both, generalized.** Parameterize crate/library/module names; require the device and simulator slices and generated headers/modulemap. |
| Swift binding/module target | Both compile generated Swift against the XCFramework; SideStage models the generated boundary as its own XcodeGen framework target | iPhone shell | **SideStage target shape.** Keep generated bindings behind a module target so app/tests import one boundary rather than compiling generated files ad hoc. |
| iPhone formatting/build preflight | Papercusp checks host health and ensures SwiftFormat; SideStage explicitly checks Mac VM, SDK, XcodeGen, and simulator availability | iPhone shell | **Union.** Run local host-health/tool checks, then a deterministic remote-capable preflight when Linux delegates to macOS. |
| iPhone privacy and entitlements | Papercusp has `PrivacyInfo.xcprivacy`, entitlements, release verifier, and tests; SideStage has only the capabilities its buyer app needs | iPhone shell | **Papercusp structure generalized.** Always require a privacy manifest and verify declared capabilities against project settings. Push, associated domains, local network, microphone, and camera are optional capability decisions. |
| Secure credential storage | Papercusp implements Android Keystore-backed storage and iOS Keychain storage; SideStage keeps commerce/provider credentials server-side | Optional capability | **Papercusp native seam, opt-in.** Provide a small credential-store interface and platform guidance; products with no device secret omit it. Provider/server credentials never cross into the app. |
| Deep-link routing | Papercusp has URL/push routing plus tests; SideStage has internal navigation but no external deep-link requirement | Optional capability | **Papercusp seam, opt-in.** Parameterize URL scheme/associated domains and require cold/warm route tests when enabled. |
| Push/crash/analytics services | Papercusp uses FCM/APNs/Crashlytics with explicit privacy constraints; SideStage does not require them | Optional capability | **Papercusp guidance only.** Service plugins/files, permission declarations, privacy disclosures, and credentials appear only when selected; never in the base closure. |
| Voice/wake word/camera | Papercusp owns voice, wake word, QR camera, mic permissions, foreground service, and privacy consent | Product-specific + optional platform seams | Keep operator voice/pairing behavior in Papercusp. The shell exposes only capability declarations and permission-test hooks. No Picovoice/ElevenLabs/ML Kit dependency in an official default. |
| Commerce/media playback | SideStage owns catalog, cart, checkout, orders, realtime, WHEP/WebRTC, and server-computed playback endpoints | Product-specific + optional platform seams | Keep domain code and WebRTC dependency in SideStage. The shell exposes only optional network/media capability slots. No Square, Typesense, buyer ID, or WHEP behavior in an official default. |
| Product API/data model | Papercusp models paired-operator activity; SideStage models a buyer marketplace | Product-specific | Never extract model names, endpoints, fixtures, copy, navigation destinations, or state machines. The base owns only the rule that portable domain behavior lives behind the Rust boundary. |
| Branding and assets | Product token values, app icons, launch art, strings, wordmarks, colors, and typography differ | Product-specific | Materialization creates neutral starter assets and substitution slots. Reference-consumer assets stay untouched and are never evidence for a shared brand. |
| iPhone test execution | Both have XCTest/XCUITest; SideStage’s Mac runner rejects `TEST SUCCEEDED` when zero expected tests execute | iPhone shell | **SideStage verdict logic plus both suites.** Require Xcode’s verdict and non-zero execution for every expected bundle; support local macOS and explicit remote Mac host without relying on wrapper exit alone. |
| iPhone archive/export | Papercusp has preflight, archive, export, validate, upload actions and tests; SideStage has an export plist but no equivalent full release verifier | iPhone shell | **Papercusp.** Generalize archive/export/signing preflight; production upload remains an outward-facing product/release action, not a template check. |
| Generated native bindings | Kotlin/Swift generated sources, headers, modulemaps | Generated output | Regenerate from UDL; allow a checked generated-language source only when the consumer’s build requires it, and verify drift. Never treat it as the abstraction source. |
| Generated native binaries | JNI `.so`, static `.a`, fat simulator library, XCFramework | Generated output | Build per host/target, validate slices/symbols, ignore from source control, and never reuse a stale copy. |
| Generated app/build artifacts | Gradle caches/reports, APK, AAB, mapping files, Xcode project, DerivedData, archives, exported IPA | Generated output | Ignore from source control. Checks identify exact output, variant, version, hash, ABI/slice set, and source provenance. |
| Generated design artifacts | Kotlin/Swift token files | Generated output | Deterministically regenerate from the neutral token source and fail on drift. |
| Signing credentials | Android keystore/passwords/alias; Apple team, identities, provisioning profiles, App Store credentials | Secret/external config | Inject outside the repository. Templates declare variable names and preflight behavior only; examples contain no usable values. |
| Service/provider credentials | FCM service file, APNs, Picovoice, analytics/crash reporting, payment/search/provider keys | Secret/external config | Opt-in capability configuration outside the repository. Server-owned provider keys remain server-side. |
| Runtime endpoints and demo identities | Paired operator URL/JWT; SideStage API base URL/buyer identity; local simulator gateways | Secret/external config or product-specific | URL and non-secret demo identity may be explicit materialization decisions, but no product URL, buyer ID, token, or private network assumption is an official default. Credentials use secure runtime storage. |

## Stronger-than-either combined invariants

The extraction produces four deliberate unions rather than choosing one
repository wholesale:

1. **Android build:** SideStage’s SDK/cargo-ndk preflight and Gradle binding
   task + both products’ stale-output/ABI/alignment guards + Papercusp’s
   privacy, cleartext, and provenance checks.
2. **iPhone build:** the common three-slice XCFramework pipeline + SideStage’s
   explicit generated-module target and non-zero-test Mac runner + Papercusp’s
   host-health, formatting, privacy, archive, export, and signing verifier.
3. **Shared base:** the common Rust/UniFFI three-crate architecture +
   Papercusp’s deterministic cross-language token pipeline + SideStage’s
   focused boundary-smoke philosophy.
4. **Security:** Papercusp’s device-secret and release-network posture +
   SideStage’s rule that provider credentials and derived media/payment
   addresses stay server-owned.

## Extraction exclusions

The following never move into the shared base or a default platform shell:

- Papercusp operator, pairing, pots/plans/inbox, push, voice, wake-word, and
  diagnostic domain flows.
- SideStage catalog, live-event, WHEP, cart, checkout, order, buyer, payment,
  search, and commerce fixtures.
- Either product’s brand, package/bundle identity, app-store identity, copy,
  assets, default endpoint, demo user, license, or repository metadata.
- Generated bindings/binaries/projects/build directories and any credential,
  service file, keystore, provisioning profile, or signing identity.

## Inputs frozen for the next plan items

P-004 can now freeze five templates without changing this classification:
`papercusp-mobile-base`, `papercusp-android-shell`,
`papercusp-android-app`, `papercusp-iphone-shell`, and
`papercusp-iphone-app`. The two app roots remain thin compositions; platform
code lives in the shell aspects and cross-platform policy lives in the base.

P-005 can define parity against the matrix’s behavioral boundaries: shared
Rust results and state transitions, generated-binding contract agreement,
secure configuration behavior, and platform-native acceptance checks. Visual
layout and product domain flows are explicitly outside cross-product parity.
