# papercusp-iphone-shell — composition GUIDE

**Papercusp Official: iPhone Shell.** This aspect supplies the iPhone-native
chassis around `papercusp-mobile-base`: one thin SwiftUI app, XcodeGen project
source, a dedicated generated-binding module over one XCFramework, Mac host
execution, platform-native tests, privacy checks, and archive/export signing
preflight. It is not a product app and does not own domain behavior, screens,
routes, brand, assets, endpoints, or provider integrations.

## MUST — consult the live Papercusp docs when this GUIDE is not enough

Use the live `/internal/docs` pages declared in `template.yaml` for template
composition and manifest rules. Treat Papercusp and SideStage as independent,
co-equal conformance consumers. Extract the verified invariant; never clone a
product project file, bundle ID, capability set, endpoint, or dependency graph
wholesale.

## Decide first

Record all five decision-point answers before building the shell:

1. `iphone-identity` — choose bundle ID, product/display name, scheme,
   generated project name, dedicated core-module name, and external
   version/build inputs. One answer drives every representation unless an
   explicit divergence is recorded.
2. `iphone-os-floor` — keep iOS 17.0 unless a selected capability proves a
   higher floor.
3. `iphone-capabilities` — select every entitlement, privacy usage key, URL
   scheme/domain, background mode, Swift package, and optional service
   explicitly. An unselected capability contributes nothing to the default
   closure.
4. `iphone-test-host` — choose `local-mac` or `remote-host`. A remote choice
   records only a named executor alias; no username, address, port, private-key
   path, or credential enters the app.
5. `iphone-release` — name external team/signing inputs, version/build inputs,
   export method, release channel, archive/export paths, and validation steps.
   This aspect performs preflight only and never uploads.

Start from `reference/iphone-shell.checks-config.example.json`, then replace
every identity, path, command, privacy declaration, and capability selection.
Compose and run the `papercusp-mobile-base` checks alongside this suite.

## MUST

- Keep `ios/project.yml` as the XcodeGen source of truth and ignore the
  generated `.xcodeproj`. Pin Swift 5.9 and an explicit iOS deployment target
  of 17.0 or higher.
- Build Rust fresh for `aarch64-apple-ios`, `aarch64-apple-ios-sim`, and
  `x86_64-apple-ios`; lipo the two simulator libraries, then create one
  XCFramework with generated headers and a canonical `module.modulemap`.
- Generate Swift from the one UniFFI UDL/config/lock input set. Compile that
  output behind its own XcodeGen framework target together with the
  XCFramework. The app and tests depend on the module target; they do not add
  generated Swift as ad-hoc app sources.
- Run host-health, Xcode/SDK/simulator, XcodeGen, and SwiftFormat preflights
  before build. Local macOS executes directly. Linux either delegates through
  the recorded named Mac executor or emits `host-constrained`; it never claims
  an iPhone host pass.
- Run XCTest and XCUITest with a result bundle, inspect the result, and require
  a non-zero executed test count in addition to Xcode success.
- Any SwiftUI view whose `.accessibilityIdentifier` a XCUITest queries as a
  container must ALSO be promoted to an accessibility container with
  `.accessibilityElement(children: .contain)`. Setting the identifier alone on
  a layout view (a `VStack` card, a row) does not publish that view to the
  accessibility hierarchy, so `app.otherElements["<id>"]` never resolves. The
  failure signature is deliberately unhelpful — `waitForExistence` burns its
  full timeout and reports a bare `XCTAssertTrue failed` with no hint that the
  identifier was set but unreachable — so treat a leaf assertion that passes
  (`staticTexts[...]`) beside a container assertion that fails as this bug,
  not as a rendering fault.
- Always ship a privacy manifest. Keep entitlement keys, usage descriptions,
  background modes, URL/domain declarations, selected capabilities, and
  XcodeGen settings consistent. No optional declaration appears by default.
- Archive and export only as a preflight. Team ID, signing identity, and
  provisioning profile are external input names with no templated values.
  Missing signing identity must fail the publishable path. The shell never
  invokes an uploader.
- Run `checks/iphone-shell-contract.test.ts` and
  `checks/iphone-shell-commands.test.ts`. Every host leg writes an atomic JSON
  record containing its stable assertion ID, verdict, host strategy,
  capability, command identity, and evidence digest.

## SHOULD

- Keep the SwiftUI app, navigation/root state, token hookup, and native
  wrappers thin. Portable outcomes and state stay in Rust.
- Make the Mac host preflight independently runnable so SDK, simulator, and
  remote-executor failures are diagnosed before a long cross-build.
- Keep build, test, privacy, and release checks as separate direct commands so
  every stable assertion leg has one machine identity.
- Put generated bindings, static libraries, simulator fat libraries,
  XCFrameworks, Xcode projects, derived data, archives, exports, and evidence
  outside tracked source.

## FREE

SwiftUI navigation and screen structure, product Swift packages, asset
pipeline, brand, copy, runtime endpoint loading, and selected capability
implementations are consumer choices. They remain outside this aspect unless a
cross-product invariant is proven and versioned.

## Acceptance meaning

The command plan covers `MOB-IOS-001` through `MOB-IOS-006` from the frozen
parity matrix. A command failure is `fail`; a missing capable host, SDK,
simulator, or remote executor is `host-constrained`; neither is green. Thin app
roots later verify only exact dependency closure and answer completeness—they
do not duplicate these shell assertions.
