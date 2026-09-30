/**
 * The checks-config seam (plan app-templates-2026-07-04 P-007): the JSON
 * document an app provides to parameterize the PORTABLE template checks
 * (templates/<id>/checks/*.test.ts — copied verbatim into a composed app and
 * driven via the TEMPLATE_CHECKS_CONFIG env var naming a config file).
 *
 * Every path is resolved relative to `app.root`, which itself resolves
 * relative to the CONFIG FILE's directory (or absolutely); "~/" expands to the
 * user home. A section left out ⇒ that check SKIPS — the config declares
 * which checks the app has wired, and the union-of-checks rule (composition.ts)
 * says which it must eventually wire to be done.
 *
 * This module is the canonical TYPE + structural validator only — the checks
 * themselves stay dependency-free of the kit (they re-declare the tiny slice
 * they read), so the validator here is for tooling: the materializer (P-011)
 * and the template gym (P-009) validate an app's config before running suites.
 */

/** `confinement-guard` — no hive role holds a dangerous capability/tool. */
export interface ChecksConfinementSection {
  /** Blueprint.yaml paths (app-root-relative) whose roles are audited. */
  blueprints: string[];
  /** Patterns: exact ("approvals:write") or resource-wide ("cart:*"). */
  dangerousCapabilities: string[];
  /** Optional — same pattern language, matched against role tools. */
  dangerousTools?: string[];
}

/** `seam-round-trip` — the contract parse gates + join-key echo + reject path. */
export interface ChecksSeamSection {
  /** The ONE seam work-item kind (e.g. "purchase-research"). */
  workItemKind: string;
  /** The contract package entry module, app-root-relative. */
  contractModule: string;
  /** Export name of the payload.in gate (e.g. "parsePurchaseResearchInput"). */
  parseInputExport: string;
  /** Export name of the payload.out gate (e.g. "parseCandidateSet"). */
  parseOutputExport: string;
  /** The id that must round-trip in→out unchanged (e.g. "itemId"). */
  joinKey?: string;
  /** A payload.in fixture the gate must ACCEPT. */
  validInput: Record<string, unknown>;
  /** A payload.out fixture the gate must ACCEPT. */
  validOutput: Record<string, unknown>;
  /** A payload.out fixture the gate must REJECT (throw). */
  invalidOutput: Record<string, unknown>;
  /** Stable app-agent blueprint.yaml — cross-checked against work kind and operation declaration. */
  agentBlueprint: string;
  /** The standard reusable task declaration that targets the app-owned plan template. */
  operation: {
    id: string;
    version: string;
    planTemplate: {
      ref: string;
      revision: string;
      contentHash: string;
    };
  };
  /** The app's own full enqueue→ingest integration leg (must exit 0). */
  roundTripCommand?: string[];
  roundTripCwd?: string;
  roundTripTimeoutMs?: number;
}

/** `boot-e2e` — the composed app boots, writes discovery, health 200. */
export interface ChecksBootSection {
  /**
   * `spawn` boots a fresh sidecar and asserts the full lifecycle including
   * SIGTERM cleanup (CI / gym / fresh checkout). `attach` asserts against an
   * ALREADY-RUNNING instance — the discovery file is a per-user singleton, so
   * never spawn a second instance on a machine where the app is live.
   */
  mode: "spawn" | "attach";
  /** The operator.json analog ("~/…" ok). */
  discoveryFile: string;
  /** Optional env var whose configured value supplies the base home for "~/" boot paths. */
  discoveryHomeEnv?: string;
  /** Default "/api/health". */
  healthPath?: string;
  /** Optional "app builds" leg, spawn mode only. */
  buildCommand?: string[];
  /** Required in spawn mode: the command that boots the sidecar. */
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Wall-clock budget for `buildCommand`; default 1800000 (30min). A real
   * production build is minutes long and its tail is load-dependent, so this
   * has to be sized from the app's MEASURED build time with margin, not from a
   * round number. The `boot-e2e` vitest timeout is derived from this rather
   * than hand-maintained beside it — see that check's budget preamble.
   */
  buildTimeoutMs?: number;
  readyTimeoutMs?: number;
  shutdownGraceMs?: number;
  /**
   * Spawn mode only, optional. App-root-relative (or "~/") path to the
   * embedded PG data directory the spawned sidecar boots against. When
   * present, checked BEFORE spawning for a live `postmaster.pid` lock —
   * i.e. a DIFFERENT already-running deployment (a portal, a prior instance)
   * holding the same data dir. A collision here means the spawn is doomed
   * (Postgres refuses a second postmaster against a locked data dir), so the
   * check fails fast naming the collision and pointing at attach mode
   * instead of spawning and burning the full `readyTimeoutMs` waiting on a
   * health check that can never succeed (EI-22125738148136740). Omit when
   * the app's data dir is guaranteed isolated (e.g. a fresh per-run temp
   * dir) — the discovery-file staleness check above already covers a
   * relaunch of the SAME app.
   */
  pgDataDir?: string;
}

/** Fast static inputs required before a Tauri desktop build can compile. */
export interface ChecksNativeDesktopSection {
  /** App-root-relative Rust package manifest. */
  cargoManifest: string;
  /** App-root-relative committed lockfile for reproducible application builds. */
  cargoLock: string;
  /** App-root-relative Tauri v2 config. */
  tauriConfig: string;
  /** App-root-relative icon files; must exactly match `bundle.icon`. */
  icons: string[];
}

/** `gym-signals` — the stable app agent's guardrail signals are declared and wired. */
export interface ChecksGymSection {
  /** The stable app-agent blueprint.yaml, app-root-relative. */
  blueprint: string;
  /** The app's ids for the four signal classes. */
  requiredSignals: string[];
}

/** `composition-integrity` — the app's CHOSEN template set (else sibling dirs). */
export interface ChecksCompositionSection {
  templateYamls: string[];
  /** Tagged `<template-id>:<decision-point-id>` build disclosures. */
  decisionPointAnswers?: Record<string, string>;
}

/**
 * `components-integrated` (P-017) — the generic check every lib-integration
 * aspect template (data-sync, search, data-layer, ui, papercusp-release-pipeline)
 * ships: the composed app actually DEPENDS on the template's pinned component
 * packages. `packages` lists the npm package names the app must declare
 * (dependencies or devDependencies, any workspace package.json under root).
 */
export interface ChecksComponentsSection {
  packages: string[];
  /** Package.json paths to search, app-root-relative. Default: ["package.json"]. */
  manifests?: string[];
}

/**
 * `theme-tokens` (D-011) — the app consumes the papercusp-ui shared theme
 * token package: a generated tokens.css carrying the 3-state
 * light/dark/system model, and NO raw hex colors in app CSS outside it.
 */
export interface ChecksThemeTokensSection {
  /** App-root-relative path to the GENERATED tokens.css (e.g. "app/tokens.css"). */
  tokensCss: string;
  /** App CSS files that must be raw-hex-free (tokens.css itself is exempt). */
  appCss: string[];
}

/** One portable command in the shared mobile-base acceptance contract. */
export interface ChecksMobileCommand {
  /** Stable command id (rust-fmt, rust-test, binding-smoke, token-drift, ...). */
  id: string;
  /** Direct argv; no shell interpolation. */
  command: string[];
  /** App-root-relative working directory. Default: app root. */
  cwd?: string;
  /** Non-secret environment overrides. Secret values never belong here. */
  env?: Record<string, string>;
  /** Optional per-command timeout. */
  timeoutMs?: number;
}

/**
 * `mobile-base-contract` + `mobile-base-commands` — the portable
 * Rust/UniFFI/token/source-hygiene contract shared by Android and iPhone.
 */
export interface ChecksMobileBaseSection {
  rustMsrv: string;
  rootCargo: string;
  cargoLock: string;
  /** Exactly core, bindings, and CLI manifests. */
  crateManifests: string[];
  udl: string;
  uniffiConfig: string;
  bindgen: string;
  tokenSource: string;
  /** At least Kotlin and Swift generated token outputs. */
  generatedTokenFiles: string[];
  /** Any additional scaffold paths the consumer requires. */
  requiredPaths: string[];
  /** Source roots scanned recursively for placeholders/secrets. */
  scanRoots: string[];
  /** Consumer-specific placeholders and foreign-product identities. */
  forbiddenTokens: string[];
  /** Files intentionally carrying provenance/negative-test tokens. */
  allowlistedFiles?: string[];
  /** Additional JavaScript regexes matched against app-relative paths. */
  secretPathPatterns?: string[];
  /** Required portable verification commands. */
  portableCommands: ChecksMobileCommand[];
}

/** Source/build paths consumed by the official Android shell checks. */
export interface ChecksAndroidShellPaths {
  settingsGradle: string;
  projectGradle: string;
  appGradle: string;
  wrapperProperties: string;
  manifest: string;
  packageSourceRoot: string;
  unitTestRoots: string[];
  instrumentationTestRoots: string[];
  lintConfig: string;
  proguardRules: string;
  buildScript: string;
  abiVerifier: string;
  provenanceScript: string;
  udl: string;
  uniffiConfig: string;
  cargoLock: string;
  generatedKotlin: string;
  releaseApk: string;
  releaseAab: string;
  provenanceFile: string;
}

/** One machine-evidenced Android host assertion leg. */
export interface ChecksAndroidAssertionCommand extends ChecksMobileCommand {
  assertionId: string;
  leg: string;
  unsetEnv?: string[];
  expectedExit?: "zero" | "nonzero";
  expectedOutputPattern?: string;
  hostConstraintPatterns?: string[];
  selectedCapability?: string;
}

/**
 * `android-shell-contract` + `android-shell-assertions` — the pinned
 * Compose/Gradle/cargo-ndk/package/privacy/release contract.
 */
export interface ChecksAndroidShellSection {
  namespace: string;
  applicationId: string;
  minSdk: number;
  compileSdk: number;
  targetSdk: number;
  gradleVersion: string;
  agpVersion: string;
  kotlinVersion: string;
  javaVersion: number;
  ndkVersion: string;
  abis: string[];
  nativeLibrary: string;
  releaseVersionInput: string;
  signingPrefix: string;
  /** External input names only; values never belong in checks config. */
  signingInputNames: string[];
  debugCleartext: boolean;
  selectedCapabilities: string[];
  allowedPermissions: string[];
  paths: ChecksAndroidShellPaths;
  /** App-relative generated evidence directory. */
  evidenceDir: string;
  assertions: ChecksAndroidAssertionCommand[];
}

/** Source/build paths consumed by the official iPhone shell checks. */
export interface ChecksIphoneShellPaths {
  projectSpec: string;
  generatedProject: string;
  gitignore: string;
  infoPlist: string;
  privacyManifest: string;
  entitlements: string;
  appSourceRoot: string;
  coreSourceRoot: string;
  unitTestRoots: string[];
  uiTestRoots: string[];
  buildScript: string;
  hostPreflightScript: string;
  testScript: string;
  releaseScript: string;
  udl: string;
  uniffiConfig: string;
  cargoLock: string;
  generatedSwift: string;
  ffiHeader: string;
  moduleMap: string;
  deviceLibrary: string;
  simulatorLibrary: string;
  xcframework: string;
  archive: string;
  exportDir: string;
  provenanceFile: string;
}

/** One machine-evidenced iPhone host assertion leg. */
export interface ChecksIphoneAssertionCommand extends ChecksMobileCommand {
  assertionId: string;
  leg: string;
  unsetEnv?: string[];
  expectedExit?: "zero" | "nonzero";
  expectedOutputPattern?: string;
  hostConstraintPatterns?: string[];
  selectedCapability?: string;
}

/**
 * `iphone-shell-contract` + `iphone-shell-assertions` — the pinned
 * SwiftUI/XcodeGen/XCFramework/privacy/archive-preflight contract.
 */
export interface ChecksIphoneShellSection {
  bundleId: string;
  productName: string;
  coreModule: string;
  scheme: string;
  projectName: string;
  deploymentTarget: string;
  swiftVersion: string;
  deviceTarget: string;
  simulatorTargets: string[];
  rustLibrary: string;
  ffiModule: string;
  hostStrategy: "local-mac" | "remote-host";
  remoteHost?: string;
  releaseVersionInput: string;
  buildNumberInput: string;
  signingPrefix: string;
  /** External input names only; values never belong in checks config. */
  signingInputNames: string[];
  exportMethod: string;
  selectedCapabilities: string[];
  entitlementKeys: string[];
  privacyUsageDescriptionKeys: string[];
  backgroundModes: string[];
  paths: ChecksIphoneShellPaths;
  /** App-relative generated evidence directory. */
  evidenceDir: string;
  assertions: ChecksIphoneAssertionCommand[];
}

export interface TemplateChecksConfig {
  app: {
    /** The app's name (diagnostics only). */
    name: string;
    /** App repo root, config-file-relative or absolute. Default ".". */
    root?: string;
  };
  confinement?: ChecksConfinementSection;
  seam?: ChecksSeamSection;
  boot?: ChecksBootSection;
  nativeDesktop?: ChecksNativeDesktopSection;
  gym?: ChecksGymSection;
  composition?: ChecksCompositionSection;
  components?: ChecksComponentsSection;
  themeTokens?: ChecksThemeTokensSection;
  mobileBase?: ChecksMobileBaseSection;
  androidShell?: ChecksAndroidShellSection;
  iphoneShell?: ChecksIphoneShellSection;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isNonEmptyString);

function requireStringArray(
  errors: string[],
  section: string,
  field: string,
  v: unknown,
  nonEmpty: boolean,
): void {
  if (!isStringArray(v))
    errors.push(`${section}.${field}: must be a list of non-empty strings`);
  else if (nonEmpty && v.length === 0)
    errors.push(`${section}.${field}: must be non-empty`);
}

/**
 * Structural validation of a checks-config document. Collects EVERY problem;
 * `[]` means valid. Absent optional sections are valid — they mean "that
 * check skips here".
 */
export function validateChecksConfig(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["config: must be an object"];

  if (!isRecord(value.app) || !isNonEmptyString(value.app.name)) {
    errors.push("app.name: required non-empty string");
  } else if (
    value.app.root !== undefined &&
    !isNonEmptyString(value.app.root)
  ) {
    errors.push("app.root: must be a non-empty string when present");
  }

  if (value.confinement !== undefined) {
    if (!isRecord(value.confinement))
      errors.push("confinement: must be an object");
    else {
      requireStringArray(
        errors,
        "confinement",
        "blueprints",
        value.confinement.blueprints,
        true,
      );
      requireStringArray(
        errors,
        "confinement",
        "dangerousCapabilities",
        value.confinement.dangerousCapabilities,
        true,
      );
      if (value.confinement.dangerousTools !== undefined)
        requireStringArray(
          errors,
          "confinement",
          "dangerousTools",
          value.confinement.dangerousTools,
          false,
        );
    }
  }

  if (value.seam !== undefined) {
    if (!isRecord(value.seam)) errors.push("seam: must be an object");
    else {
      for (const f of [
        "workItemKind",
        "contractModule",
        "parseInputExport",
        "parseOutputExport",
        "agentBlueprint",
      ] as const) {
        if (!isNonEmptyString(value.seam[f]))
          errors.push(`seam.${f}: required non-empty string`);
      }
      for (const f of ["validInput", "validOutput", "invalidOutput"] as const) {
        if (!isRecord(value.seam[f]))
          errors.push(`seam.${f}: required object fixture`);
      }
      if (!isRecord(value.seam.operation))
        errors.push("seam.operation: required object");
      else {
        for (const f of ["id", "version"] as const) {
          if (!isNonEmptyString(value.seam.operation[f]))
            errors.push(`seam.operation.${f}: required non-empty string`);
        }
        if (!isRecord(value.seam.operation.planTemplate))
          errors.push("seam.operation.planTemplate: required object");
        else {
          for (const f of ["ref", "revision", "contentHash"] as const) {
            if (!isNonEmptyString(value.seam.operation.planTemplate[f]))
              errors.push(`seam.operation.planTemplate.${f}: required non-empty string`);
          }
          if (
            isNonEmptyString(value.seam.operation.planTemplate.contentHash) &&
            !/^[0-9a-f]{64}$/.test(value.seam.operation.planTemplate.contentHash)
          ) {
            errors.push("seam.operation.planTemplate.contentHash: must be sha256 hex");
          }
        }
      }
      if (value.seam.roundTripCommand !== undefined)
        requireStringArray(
          errors,
          "seam",
          "roundTripCommand",
          value.seam.roundTripCommand,
          true,
        );
    }
  }

  if (value.boot !== undefined) {
    if (!isRecord(value.boot)) errors.push("boot: must be an object");
    else {
      if (value.boot.mode !== "spawn" && value.boot.mode !== "attach")
        errors.push("boot.mode: must be 'spawn' or 'attach'");
      if (!isNonEmptyString(value.boot.discoveryFile))
        errors.push("boot.discoveryFile: required non-empty string");
      if (
        value.boot.discoveryHomeEnv !== undefined &&
        !isNonEmptyString(value.boot.discoveryHomeEnv)
      )
        errors.push(
          "boot.discoveryHomeEnv: must be a non-empty string when present",
        );
      if (value.boot.mode === "spawn" && !isStringArray(value.boot.command))
        errors.push("boot.command: required (list of strings) in spawn mode");
      if (
        value.boot.pgDataDir !== undefined &&
        !isNonEmptyString(value.boot.pgDataDir)
      )
        errors.push("boot.pgDataDir: must be a non-empty string when present");
    }
  }

  if (value.nativeDesktop !== undefined) {
    if (!isRecord(value.nativeDesktop))
      errors.push("nativeDesktop: must be an object");
    else {
      for (const field of ["cargoManifest", "cargoLock", "tauriConfig"] as const) {
        if (!isNonEmptyString(value.nativeDesktop[field]))
          errors.push(`nativeDesktop.${field}: required non-empty string`);
      }
      requireStringArray(
        errors,
        "nativeDesktop",
        "icons",
        value.nativeDesktop.icons,
        true,
      );
    }
  }

  if (value.gym !== undefined) {
    if (!isRecord(value.gym)) errors.push("gym: must be an object");
    else {
      if (!isNonEmptyString(value.gym.blueprint))
        errors.push("gym.blueprint: required non-empty string");
      requireStringArray(
        errors,
        "gym",
        "requiredSignals",
        value.gym.requiredSignals,
        true,
      );
    }
  }

  if (value.composition !== undefined) {
    if (!isRecord(value.composition))
      errors.push("composition: must be an object");
    else {
      requireStringArray(
        errors,
        "composition",
        "templateYamls",
        value.composition.templateYamls,
        true,
      );
      if (value.composition.decisionPointAnswers !== undefined) {
        if (!isRecord(value.composition.decisionPointAnswers)) {
          errors.push("composition.decisionPointAnswers: must be an object");
        } else {
          for (const [key, answer] of Object.entries(
            value.composition.decisionPointAnswers,
          )) {
            if (!isNonEmptyString(key) || !isNonEmptyString(answer)) {
              errors.push(
                `composition.decisionPointAnswers.${key}: must be a non-empty string`,
              );
            }
          }
        }
      }
    }
  }

  if (value.components !== undefined) {
    if (!isRecord(value.components))
      errors.push("components: must be an object");
    else {
      requireStringArray(
        errors,
        "components",
        "packages",
        value.components.packages,
        true,
      );
      if (value.components.manifests !== undefined)
        requireStringArray(
          errors,
          "components",
          "manifests",
          value.components.manifests,
          true,
        );
    }
  }

  if (value.themeTokens !== undefined) {
    if (!isRecord(value.themeTokens))
      errors.push("themeTokens: must be an object");
    else {
      if (!isNonEmptyString(value.themeTokens.tokensCss))
        errors.push("themeTokens.tokensCss: required non-empty string");
      requireStringArray(
        errors,
        "themeTokens",
        "appCss",
        value.themeTokens.appCss,
        true,
      );
    }
  }

  if (value.mobileBase !== undefined) {
    if (!isRecord(value.mobileBase))
      errors.push("mobileBase: must be an object");
    else {
      for (const field of [
        "rustMsrv",
        "rootCargo",
        "cargoLock",
        "udl",
        "uniffiConfig",
        "bindgen",
        "tokenSource",
      ] as const) {
        if (!isNonEmptyString(value.mobileBase[field])) {
          errors.push(`mobileBase.${field}: required non-empty string`);
        }
      }
      requireStringArray(
        errors,
        "mobileBase",
        "crateManifests",
        value.mobileBase.crateManifests,
        true,
      );
      if (
        Array.isArray(value.mobileBase.crateManifests) &&
        value.mobileBase.crateManifests.length !== 3
      ) {
        errors.push(
          "mobileBase.crateManifests: must contain exactly core, bindings, and CLI manifests",
        );
      }
      requireStringArray(
        errors,
        "mobileBase",
        "generatedTokenFiles",
        value.mobileBase.generatedTokenFiles,
        true,
      );
      if (
        Array.isArray(value.mobileBase.generatedTokenFiles) &&
        value.mobileBase.generatedTokenFiles.length < 2
      ) {
        errors.push(
          "mobileBase.generatedTokenFiles: must contain at least Kotlin and Swift outputs",
        );
      }
      requireStringArray(
        errors,
        "mobileBase",
        "requiredPaths",
        value.mobileBase.requiredPaths,
        true,
      );
      requireStringArray(
        errors,
        "mobileBase",
        "scanRoots",
        value.mobileBase.scanRoots,
        true,
      );
      requireStringArray(
        errors,
        "mobileBase",
        "forbiddenTokens",
        value.mobileBase.forbiddenTokens,
        true,
      );
      if (value.mobileBase.allowlistedFiles !== undefined) {
        requireStringArray(
          errors,
          "mobileBase",
          "allowlistedFiles",
          value.mobileBase.allowlistedFiles,
          false,
        );
      }
      if (value.mobileBase.secretPathPatterns !== undefined) {
        requireStringArray(
          errors,
          "mobileBase",
          "secretPathPatterns",
          value.mobileBase.secretPathPatterns,
          false,
        );
      }
      if (
        !Array.isArray(value.mobileBase.portableCommands) ||
        value.mobileBase.portableCommands.length === 0
      ) {
        errors.push(
          "mobileBase.portableCommands: required non-empty list of command objects",
        );
      } else {
        const ids = new Set<string>();
        value.mobileBase.portableCommands.forEach((command, index) => {
          if (!isRecord(command)) {
            errors.push(
              `mobileBase.portableCommands[${index}]: must be an object`,
            );
            return;
          }
          if (!isNonEmptyString(command.id)) {
            errors.push(
              `mobileBase.portableCommands[${index}].id: required non-empty string`,
            );
          } else if (ids.has(command.id)) {
            errors.push(
              `mobileBase.portableCommands[${index}].id: duplicate '${command.id}'`,
            );
          } else {
            ids.add(command.id);
          }
          requireStringArray(
            errors,
            `mobileBase.portableCommands[${index}]`,
            "command",
            command.command,
            true,
          );
          if (command.cwd !== undefined && !isNonEmptyString(command.cwd)) {
            errors.push(
              `mobileBase.portableCommands[${index}].cwd: must be a non-empty string when present`,
            );
          }
          if (command.env !== undefined) {
            if (
              !isRecord(command.env) ||
              Object.values(command.env).some(
                (entry) => typeof entry !== "string",
              )
            ) {
              errors.push(
                `mobileBase.portableCommands[${index}].env: must be a string map when present`,
              );
            }
          }
          if (
            command.timeoutMs !== undefined &&
            (typeof command.timeoutMs !== "number" ||
              !Number.isFinite(command.timeoutMs) ||
              command.timeoutMs <= 0)
          ) {
            errors.push(
              `mobileBase.portableCommands[${index}].timeoutMs: must be a positive number when present`,
            );
          }
        });
      }
    }
  }

  if (value.androidShell !== undefined) {
    if (!isRecord(value.androidShell))
      errors.push("androidShell: must be an object");
    else {
      for (const field of [
        "namespace",
        "applicationId",
        "gradleVersion",
        "agpVersion",
        "kotlinVersion",
        "ndkVersion",
        "nativeLibrary",
        "releaseVersionInput",
        "signingPrefix",
        "evidenceDir",
      ] as const) {
        if (!isNonEmptyString(value.androidShell[field])) {
          errors.push(`androidShell.${field}: required non-empty string`);
        }
      }
      for (const field of [
        "minSdk",
        "compileSdk",
        "targetSdk",
        "javaVersion",
      ] as const) {
        if (
          !Number.isInteger(value.androidShell[field]) ||
          Number(value.androidShell[field]) <= 0
        ) {
          errors.push(`androidShell.${field}: required positive integer`);
        }
      }
      if (typeof value.androidShell.debugCleartext !== "boolean") {
        errors.push("androidShell.debugCleartext: required boolean");
      }
      requireStringArray(
        errors,
        "androidShell",
        "abis",
        value.androidShell.abis,
        true,
      );
      requireStringArray(
        errors,
        "androidShell",
        "signingInputNames",
        value.androidShell.signingInputNames,
        true,
      );
      requireStringArray(
        errors,
        "androidShell",
        "selectedCapabilities",
        value.androidShell.selectedCapabilities,
        false,
      );
      requireStringArray(
        errors,
        "androidShell",
        "allowedPermissions",
        value.androidShell.allowedPermissions,
        false,
      );

      if (!isRecord(value.androidShell.paths)) {
        errors.push("androidShell.paths: required object");
      } else {
        for (const field of [
          "settingsGradle",
          "projectGradle",
          "appGradle",
          "wrapperProperties",
          "manifest",
          "packageSourceRoot",
          "lintConfig",
          "proguardRules",
          "buildScript",
          "abiVerifier",
          "provenanceScript",
          "udl",
          "uniffiConfig",
          "cargoLock",
          "generatedKotlin",
          "releaseApk",
          "releaseAab",
          "provenanceFile",
        ] as const) {
          if (!isNonEmptyString(value.androidShell.paths[field])) {
            errors.push(
              `androidShell.paths.${field}: required non-empty string`,
            );
          }
        }
        for (const field of [
          "unitTestRoots",
          "instrumentationTestRoots",
        ] as const) {
          requireStringArray(
            errors,
            "androidShell.paths",
            field,
            value.androidShell.paths[field],
            true,
          );
        }
      }

      if (
        !Array.isArray(value.androidShell.assertions) ||
        value.androidShell.assertions.length === 0
      ) {
        errors.push(
          "androidShell.assertions: required non-empty list of command objects",
        );
      } else {
        const assertionLegs = new Set<string>();
        value.androidShell.assertions.forEach((assertion, index) => {
          const section = `androidShell.assertions[${index}]`;
          if (!isRecord(assertion)) {
            errors.push(`${section}: must be an object`);
            return;
          }
          for (const field of ["assertionId", "leg"] as const) {
            if (!isNonEmptyString(assertion[field])) {
              errors.push(`${section}.${field}: required non-empty string`);
            }
          }
          if (
            isNonEmptyString(assertion.assertionId) &&
            isNonEmptyString(assertion.leg)
          ) {
            const key = `${assertion.assertionId}/${assertion.leg}`;
            if (assertionLegs.has(key)) {
              errors.push(`${section}: duplicate assertion leg '${key}'`);
            } else {
              assertionLegs.add(key);
            }
          }
          requireStringArray(
            errors,
            section,
            "command",
            assertion.command,
            true,
          );
          if (assertion.cwd !== undefined && !isNonEmptyString(assertion.cwd)) {
            errors.push(
              `${section}.cwd: must be a non-empty string when present`,
            );
          }
          if (
            assertion.env !== undefined &&
            (!isRecord(assertion.env) ||
              Object.values(assertion.env).some(
                (entry) => typeof entry !== "string",
              ))
          ) {
            errors.push(`${section}.env: must be a string map when present`);
          }
          if (
            assertion.timeoutMs !== undefined &&
            (typeof assertion.timeoutMs !== "number" ||
              !Number.isFinite(assertion.timeoutMs) ||
              assertion.timeoutMs <= 0)
          ) {
            errors.push(
              `${section}.timeoutMs: must be a positive number when present`,
            );
          }
          if (assertion.unsetEnv !== undefined) {
            requireStringArray(
              errors,
              section,
              "unsetEnv",
              assertion.unsetEnv,
              false,
            );
          }
          if (
            assertion.expectedExit !== undefined &&
            assertion.expectedExit !== "zero" &&
            assertion.expectedExit !== "nonzero"
          ) {
            errors.push(
              `${section}.expectedExit: must be 'zero' or 'nonzero' when present`,
            );
          }
          if (
            assertion.expectedOutputPattern !== undefined &&
            !isNonEmptyString(assertion.expectedOutputPattern)
          ) {
            errors.push(
              `${section}.expectedOutputPattern: must be a non-empty string when present`,
            );
          }
          if (assertion.hostConstraintPatterns !== undefined) {
            requireStringArray(
              errors,
              section,
              "hostConstraintPatterns",
              assertion.hostConstraintPatterns,
              false,
            );
          }
          if (
            assertion.selectedCapability !== undefined &&
            !isNonEmptyString(assertion.selectedCapability)
          ) {
            errors.push(
              `${section}.selectedCapability: must be a non-empty string when present`,
            );
          }
        });
      }
    }
  }

  if (value.iphoneShell !== undefined) {
    if (!isRecord(value.iphoneShell))
      errors.push("iphoneShell: must be an object");
    else {
      for (const field of [
        "bundleId",
        "productName",
        "coreModule",
        "scheme",
        "projectName",
        "deploymentTarget",
        "swiftVersion",
        "deviceTarget",
        "rustLibrary",
        "ffiModule",
        "releaseVersionInput",
        "buildNumberInput",
        "signingPrefix",
        "exportMethod",
        "evidenceDir",
      ] as const) {
        if (!isNonEmptyString(value.iphoneShell[field])) {
          errors.push(`iphoneShell.${field}: required non-empty string`);
        }
      }
      if (
        value.iphoneShell.hostStrategy !== "local-mac" &&
        value.iphoneShell.hostStrategy !== "remote-host"
      ) {
        errors.push(
          "iphoneShell.hostStrategy: must be 'local-mac' or 'remote-host'",
        );
      }
      if (
        value.iphoneShell.hostStrategy === "remote-host" &&
        !isNonEmptyString(value.iphoneShell.remoteHost)
      ) {
        errors.push(
          "iphoneShell.remoteHost: required non-empty string for remote-host strategy",
        );
      }
      if (
        value.iphoneShell.remoteHost !== undefined &&
        !isNonEmptyString(value.iphoneShell.remoteHost)
      ) {
        errors.push(
          "iphoneShell.remoteHost: must be a non-empty string when present",
        );
      }
      for (const field of ["simulatorTargets", "signingInputNames"] as const) {
        requireStringArray(
          errors,
          "iphoneShell",
          field,
          value.iphoneShell[field],
          true,
        );
      }
      for (const field of [
        "selectedCapabilities",
        "entitlementKeys",
        "privacyUsageDescriptionKeys",
        "backgroundModes",
      ] as const) {
        requireStringArray(
          errors,
          "iphoneShell",
          field,
          value.iphoneShell[field],
          false,
        );
      }

      if (!isRecord(value.iphoneShell.paths)) {
        errors.push("iphoneShell.paths: required object");
      } else {
        for (const field of [
          "projectSpec",
          "generatedProject",
          "gitignore",
          "infoPlist",
          "privacyManifest",
          "entitlements",
          "appSourceRoot",
          "coreSourceRoot",
          "buildScript",
          "hostPreflightScript",
          "testScript",
          "releaseScript",
          "udl",
          "uniffiConfig",
          "cargoLock",
          "generatedSwift",
          "ffiHeader",
          "moduleMap",
          "deviceLibrary",
          "simulatorLibrary",
          "xcframework",
          "archive",
          "exportDir",
          "provenanceFile",
        ] as const) {
          if (!isNonEmptyString(value.iphoneShell.paths[field])) {
            errors.push(
              `iphoneShell.paths.${field}: required non-empty string`,
            );
          }
        }
        for (const field of ["unitTestRoots", "uiTestRoots"] as const) {
          requireStringArray(
            errors,
            "iphoneShell.paths",
            field,
            value.iphoneShell.paths[field],
            true,
          );
        }
      }

      if (
        !Array.isArray(value.iphoneShell.assertions) ||
        value.iphoneShell.assertions.length === 0
      ) {
        errors.push(
          "iphoneShell.assertions: required non-empty list of command objects",
        );
      } else {
        const assertionLegs = new Set<string>();
        value.iphoneShell.assertions.forEach((assertion, index) => {
          const section = `iphoneShell.assertions[${index}]`;
          if (!isRecord(assertion)) {
            errors.push(`${section}: must be an object`);
            return;
          }
          for (const field of ["assertionId", "leg"] as const) {
            if (!isNonEmptyString(assertion[field])) {
              errors.push(`${section}.${field}: required non-empty string`);
            }
          }
          if (
            isNonEmptyString(assertion.assertionId) &&
            isNonEmptyString(assertion.leg)
          ) {
            const key = `${assertion.assertionId}/${assertion.leg}`;
            if (assertionLegs.has(key)) {
              errors.push(`${section}: duplicate assertion leg '${key}'`);
            } else {
              assertionLegs.add(key);
            }
          }
          requireStringArray(
            errors,
            section,
            "command",
            assertion.command,
            true,
          );
          if (assertion.cwd !== undefined && !isNonEmptyString(assertion.cwd)) {
            errors.push(
              `${section}.cwd: must be a non-empty string when present`,
            );
          }
          if (
            assertion.env !== undefined &&
            (!isRecord(assertion.env) ||
              Object.values(assertion.env).some(
                (entry) => typeof entry !== "string",
              ))
          ) {
            errors.push(`${section}.env: must be a string map when present`);
          }
          if (
            assertion.timeoutMs !== undefined &&
            (typeof assertion.timeoutMs !== "number" ||
              !Number.isFinite(assertion.timeoutMs) ||
              assertion.timeoutMs <= 0)
          ) {
            errors.push(
              `${section}.timeoutMs: must be a positive number when present`,
            );
          }
          if (assertion.unsetEnv !== undefined) {
            requireStringArray(
              errors,
              section,
              "unsetEnv",
              assertion.unsetEnv,
              false,
            );
          }
          if (
            assertion.expectedExit !== undefined &&
            assertion.expectedExit !== "zero" &&
            assertion.expectedExit !== "nonzero"
          ) {
            errors.push(
              `${section}.expectedExit: must be 'zero' or 'nonzero' when present`,
            );
          }
          for (const field of [
            "expectedOutputPattern",
            "selectedCapability",
          ] as const) {
            if (
              assertion[field] !== undefined &&
              !isNonEmptyString(assertion[field])
            ) {
              errors.push(
                `${section}.${field}: must be a non-empty string when present`,
              );
            }
          }
          if (assertion.hostConstraintPatterns !== undefined) {
            requireStringArray(
              errors,
              section,
              "hostConstraintPatterns",
              assertion.hostConstraintPatterns,
              false,
            );
          }
        });
      }
    }
  }

  return errors;
}

/** Parse-or-throw variant (mirrors parseTemplateManifest's contract). */
export function parseChecksConfig(value: unknown): TemplateChecksConfig {
  const errors = validateChecksConfig(value);
  if (errors.length)
    throw new Error(`invalid checks config: ${errors.join("; ")}`);
  return value as TemplateChecksConfig;
}
