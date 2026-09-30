import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export const REQUIRED_ANDROID_ABIS = [
  "arm64-v8a",
  "armeabi-v7a",
  "x86",
  "x86_64",
] as const;

export const SUPPORTED_ANDROID_CAPABILITIES = [
  "credentials",
  "deep-links",
  "push",
  "crash-reporting",
  "analytics",
  "camera",
  "microphone",
  "media-playback",
  "local-networking",
] as const;

export const REQUIRED_ANDROID_ASSERTION_LEGS = [
  ["MOB-AND-001", "toolchain-build"],
  ["MOB-AND-002", "binding-generation"],
  ["MOB-AND-003", "package-abis"],
  ["MOB-AND-004", "uniffi-alignment"],
  ["MOB-AND-005", "lint"],
  ["MOB-AND-005", "unit"],
  ["MOB-AND-005", "instrumentation"],
  ["MOB-AND-005", "manifest-privacy"],
  ["MOB-AND-006", "release-provenance"],
  ["MOB-AND-006", "signing-absence"],
] as const;

export interface AndroidShellPaths {
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

export interface AndroidAssertionCommand {
  assertionId: string;
  leg: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  unsetEnv?: string[];
  timeoutMs?: number;
  expectedExit?: "zero" | "nonzero";
  expectedOutputPattern?: string;
  hostConstraintPatterns?: string[];
  selectedCapability?: string;
}

export interface AndroidShellSection {
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
  signingInputNames: string[];
  debugCleartext: boolean;
  selectedCapabilities: string[];
  allowedPermissions: string[];
  paths: AndroidShellPaths;
  evidenceDir: string;
  assertions: AndroidAssertionCommand[];
}

export interface AndroidAssertionEvidence {
  schemaVersion: "papercusp-android-assertion-v1";
  assertionId: string;
  leg: string;
  identity: string;
  verdict: "pass" | "fail" | "host-constrained";
  host: string;
  selectedCapability: string | null;
  command: string[];
  cwd: string;
  expectedExit: "zero" | "nonzero";
  exitStatus: number | null;
  signal: string | null;
  outputBytes: number;
  outputSha256: string;
  recordedAt: string;
}

const REQUIRED_PATH_FIELDS = [
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
] as const;

const SECTION_FIELDS = new Set([
  "namespace",
  "applicationId",
  "minSdk",
  "compileSdk",
  "targetSdk",
  "gradleVersion",
  "agpVersion",
  "kotlinVersion",
  "javaVersion",
  "ndkVersion",
  "abis",
  "nativeLibrary",
  "releaseVersionInput",
  "signingPrefix",
  "signingInputNames",
  "debugCleartext",
  "selectedCapabilities",
  "allowedPermissions",
  "paths",
  "evidenceDir",
  "assertions",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);
const slash = (path: string): string => path.split(sep).join("/");
const escaped = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inRoot = (root: string, path: string): string =>
  isAbsolute(path) ? path : join(root, path);

function isSafeRelativePath(path: string): boolean {
  if (!isNonEmptyString(path) || isAbsolute(path)) return false;
  const normalized = slash(path);
  return normalized !== ".." && !normalized.startsWith("../");
}

function exactSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    [...actual]
      .sort()
      .every((value, index) => value === [...expected].sort()[index])
  );
}

function requireStringArray(
  errors: string[],
  field: string,
  value: unknown,
  nonEmpty = true,
): void {
  if (!isStringArray(value))
    errors.push(`${field}: must be a list of non-empty strings`);
  else if (nonEmpty && value.length === 0)
    errors.push(`${field}: must be non-empty`);
}

export function validateAndroidShellConfig(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["androidShell: must be an object"];

  for (const field of Object.keys(value)) {
    if (!SECTION_FIELDS.has(field))
      errors.push(`androidShell.${field}: unknown field`);
  }
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
    if (!isNonEmptyString(value[field]))
      errors.push(`androidShell.${field}: required non-empty string`);
  }
  for (const field of [
    "minSdk",
    "compileSdk",
    "targetSdk",
    "javaVersion",
  ] as const) {
    if (!Number.isInteger(value[field]) || Number(value[field]) <= 0)
      errors.push(`androidShell.${field}: required positive integer`);
  }
  if (typeof value.debugCleartext !== "boolean")
    errors.push("androidShell.debugCleartext: required boolean");
  requireStringArray(errors, "androidShell.abis", value.abis);
  if (isStringArray(value.abis) && !exactSet(value.abis, REQUIRED_ANDROID_ABIS))
    errors.push(
      `androidShell.abis: must be exactly ${REQUIRED_ANDROID_ABIS.join(",")}`,
    );
  requireStringArray(
    errors,
    "androidShell.signingInputNames",
    value.signingInputNames,
  );
  requireStringArray(
    errors,
    "androidShell.selectedCapabilities",
    value.selectedCapabilities,
    false,
  );
  requireStringArray(
    errors,
    "androidShell.allowedPermissions",
    value.allowedPermissions,
    false,
  );

  if (
    isNonEmptyString(value.namespace) &&
    !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value.namespace)
  )
    errors.push("androidShell.namespace: required reverse-DNS identifier");
  if (
    isNonEmptyString(value.applicationId) &&
    !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value.applicationId)
  )
    errors.push("androidShell.applicationId: required reverse-DNS identifier");
  if (
    isNonEmptyString(value.nativeLibrary) &&
    !/^lib[a-z0-9_]+\.so$/.test(value.nativeLibrary)
  )
    errors.push("androidShell.nativeLibrary: required lib<snake_case>.so");
  if (
    isNonEmptyString(value.releaseVersionInput) &&
    !/^[A-Z][A-Z0-9_]+$/.test(value.releaseVersionInput)
  )
    errors.push(
      "androidShell.releaseVersionInput: required upper-snake input name",
    );
  if (
    isNonEmptyString(value.signingPrefix) &&
    !/^[A-Z][A-Z0-9_]+_$/.test(value.signingPrefix)
  )
    errors.push(
      "androidShell.signingPrefix: required upper-snake prefix ending in _",
    );

  if (
    isStringArray(value.signingInputNames) &&
    isNonEmptyString(value.signingPrefix)
  ) {
    if (
      new Set(value.signingInputNames).size !== value.signingInputNames.length
    )
      errors.push("androidShell.signingInputNames: duplicate input name");
    for (const name of value.signingInputNames) {
      if (!name.startsWith(value.signingPrefix))
        errors.push(
          `androidShell.signingInputNames: '${name}' must start with ${value.signingPrefix}`,
        );
    }
    for (const suffix of [
      "KEYSTORE",
      "KEYSTORE_PASSWORD",
      "KEY_ALIAS",
      "KEY_PASSWORD",
    ]) {
      if (!value.signingInputNames.includes(`${value.signingPrefix}${suffix}`))
        errors.push(
          `androidShell.signingInputNames: missing ${value.signingPrefix}${suffix}`,
        );
    }
  }

  if (isStringArray(value.selectedCapabilities)) {
    const supported = new Set<string>(SUPPORTED_ANDROID_CAPABILITIES);
    for (const capability of value.selectedCapabilities) {
      if (!supported.has(capability))
        errors.push(
          `androidShell.selectedCapabilities: unsupported '${capability}'`,
        );
    }
  }
  if (isStringArray(value.allowedPermissions)) {
    if (
      new Set(value.allowedPermissions).size !== value.allowedPermissions.length
    )
      errors.push("androidShell.allowedPermissions: duplicate permission");
    for (const permission of value.allowedPermissions) {
      if (!/^[A-Za-z][A-Za-z0-9_.]+$/.test(permission))
        errors.push(`androidShell.allowedPermissions: invalid '${permission}'`);
    }
  }

  if (!isSafeRelativePath(String(value.evidenceDir ?? "")))
    errors.push("androidShell.evidenceDir: required safe app-relative path");

  if (!isRecord(value.paths))
    errors.push("androidShell.paths: required object");
  else {
    for (const field of REQUIRED_PATH_FIELDS) {
      if (!isSafeRelativePath(String(value.paths[field] ?? "")))
        errors.push(
          `androidShell.paths.${field}: required safe app-relative path`,
        );
    }
    for (const field of [
      "unitTestRoots",
      "instrumentationTestRoots",
    ] as const) {
      requireStringArray(
        errors,
        `androidShell.paths.${field}`,
        value.paths[field],
      );
      if (isStringArray(value.paths[field])) {
        for (const path of value.paths[field]) {
          if (!isSafeRelativePath(path))
            errors.push(
              `androidShell.paths.${field}: '${path}' must be app-relative`,
            );
        }
      }
    }
  }

  if (!Array.isArray(value.assertions) || value.assertions.length === 0)
    errors.push("androidShell.assertions: required non-empty list");
  return errors;
}

function readRequired(root: string, path: string, errors: string[]): string {
  const absolute = inRoot(root, path);
  if (!existsSync(absolute)) {
    errors.push(`missing declared Android shell path: ${path}`);
    return "";
  }
  if (lstatSync(absolute).isDirectory()) {
    errors.push(`declared Android shell file is a directory: ${path}`);
    return "";
  }
  return readFileSync(absolute, "utf8");
}

function treeHasKotlin(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return false;
  if (!stat.isDirectory()) return path.endsWith(".kt");
  return readdirSync(path, { withFileTypes: true }).some((entry) => {
    if (entry.isSymbolicLink()) return false;
    const child = join(path, entry.name);
    return entry.isDirectory()
      ? treeHasKotlin(child)
      : entry.name.endsWith(".kt");
  });
}

function extractAbiFilters(appGradle: string): string[] {
  const match = appGradle.match(/abiFilters\s*\+=\s*listOf\(([^)]*)\)/s);
  return match
    ? [...match[1]!.matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]!)
    : [];
}

function extractManifestPermissions(manifest: string): string[] {
  return [
    ...manifest.matchAll(
      /<uses-permission\b[^>]*android:name\s*=\s*["']([^"']+)["'][^>]*>/g,
    ),
  ]
    .map((entry) => entry[1]!)
    .sort();
}

export function validateAndroidShellScaffold(
  root: string,
  section: AndroidShellSection,
): string[] {
  const errors = validateAndroidShellConfig(section);
  if (errors.length > 0) return errors;

  const paths = section.paths;
  const settings = readRequired(root, paths.settingsGradle, errors);
  const project = readRequired(root, paths.projectGradle, errors);
  const app = readRequired(root, paths.appGradle, errors);
  const wrapper = readRequired(root, paths.wrapperProperties, errors);
  const manifest = readRequired(root, paths.manifest, errors);
  readRequired(root, paths.lintConfig, errors);
  const proguard = readRequired(root, paths.proguardRules, errors);
  const build = readRequired(root, paths.buildScript, errors);
  const abiVerifier = readRequired(root, paths.abiVerifier, errors);
  const provenance = readRequired(root, paths.provenanceScript, errors);
  for (const path of [paths.udl, paths.uniffiConfig, paths.cargoLock])
    readRequired(root, path, errors);

  const packageRoot = inRoot(root, paths.packageSourceRoot);
  if (!existsSync(packageRoot) || !lstatSync(packageRoot).isDirectory())
    errors.push(
      `missing declared Android package source root: ${paths.packageSourceRoot}`,
    );
  const expectedPackageSuffix = section.namespace.replaceAll(".", "/");
  if (!slash(paths.packageSourceRoot).endsWith(expectedPackageSuffix))
    errors.push(
      `androidShell.paths.packageSourceRoot must end with ${expectedPackageSuffix}`,
    );

  for (const [kind, roots] of [
    ["unit", paths.unitTestRoots],
    ["instrumentation", paths.instrumentationTestRoots],
  ] as const) {
    if (!roots.some((path) => treeHasKotlin(inRoot(root, path))))
      errors.push(
        `androidShell.paths.${kind}TestRoots: no Kotlin test source found`,
      );
  }

  if (!settings.includes('include(":app")'))
    errors.push(`${paths.settingsGradle}: missing single :app module`);
  if (
    !new RegExp(`namespace\\s*=\\s*["']${escaped(section.namespace)}["']`).test(
      app,
    )
  )
    errors.push(`${paths.appGradle}: missing namespace ${section.namespace}`);
  if (
    !new RegExp(
      `applicationId\\s*=\\s*["']${escaped(section.applicationId)}["']`,
    ).test(app)
  )
    errors.push(
      `${paths.appGradle}: missing applicationId ${section.applicationId}`,
    );
  for (const [field, value] of [
    ["compileSdk", section.compileSdk],
    ["minSdk", section.minSdk],
    ["targetSdk", section.targetSdk],
  ] as const) {
    if (!new RegExp(`${field}\\s*=\\s*${value}\\b`).test(app))
      errors.push(`${paths.appGradle}: missing ${field} ${value}`);
  }
  if (
    !new RegExp(
      `gradle-${escaped(section.gradleVersion)}-(bin|all)\\.zip`,
    ).test(wrapper)
  )
    errors.push(
      `${paths.wrapperProperties}: missing Gradle ${section.gradleVersion}`,
    );
  if (
    !new RegExp(
      `com\\.android\\.application["']\\)\\s+version\\s+["']${escaped(section.agpVersion)}["']`,
    ).test(project)
  )
    errors.push(`${paths.projectGradle}: missing AGP ${section.agpVersion}`);
  for (const plugin of [
    "org.jetbrains.kotlin.android",
    "org.jetbrains.kotlin.plugin.compose",
  ]) {
    if (
      !new RegExp(
        `${escaped(plugin)}["']\\)\\s+version\\s+["']${escaped(section.kotlinVersion)}["']`,
      ).test(project)
    )
      errors.push(
        `${paths.projectGradle}: missing ${plugin} ${section.kotlinVersion}`,
      );
  }
  if (
    !app.includes(`JavaVersion.VERSION_${section.javaVersion}`) ||
    !new RegExp(`jvmTarget\\s*=\\s*["']${section.javaVersion}["']`).test(app)
  )
    errors.push(
      `${paths.appGradle}: missing Java/Kotlin ${section.javaVersion} target`,
    );
  if (!exactSet(extractAbiFilters(app), REQUIRED_ANDROID_ABIS))
    errors.push(
      `${paths.appGradle}: abiFilters must declare the exact four-ABI set`,
    );
  const acceptedProguardReferences = new Set([
    paths.proguardRules,
    posix.relative(posix.dirname(paths.appGradle), paths.proguardRules),
  ]);
  if (![...acceptedProguardReferences].some((path) => app.includes(path)))
    errors.push(
      `${paths.appGradle}: release build must load ${paths.proguardRules}`,
    );
  for (const rule of [
    "-keep class com.sun.jna.**",
    "-keep class * implements com.sun.jna.**",
    "-dontwarn java.awt.Component",
    "-dontwarn java.awt.GraphicsEnvironment",
    "-dontwarn java.awt.HeadlessException",
    "-dontwarn java.awt.Window",
  ]) {
    if (!proguard.includes(rule))
      errors.push(`${paths.proguardRules}: missing JNA/R8 rule '${rule}'`);
  }

  for (const token of [
    paths.udl,
    paths.uniffiConfig,
    paths.cargoLock,
    paths.generatedKotlin,
  ]) {
    if (!app.includes(token))
      errors.push(`${paths.appGradle}: binding task missing '${token}'`);
  }
  for (const token of [
    "Exec::class",
    "inputs.file",
    "outputs.file",
    "preBuild",
    "dependsOn",
  ]) {
    if (!app.includes(token))
      errors.push(
        `${paths.appGradle}: incremental binding contract missing '${token}'`,
      );
  }

  for (const token of [
    "ANDROID_SDK_ROOT",
    "ANDROID_HOME",
    section.ndkVersion,
    "jniLibs",
    "rm",
    section.nativeLibrary,
  ]) {
    if (!build.includes(token))
      errors.push(
        `${paths.buildScript}: Android build contract missing '${token}'`,
      );
  }
  if (!/(cargo-ndk|cargo\s+ndk)/.test(build))
    errors.push(`${paths.buildScript}: missing cargo-ndk invocation/preflight`);
  if (/\$\{?HOME\}?\/Android\/Sdk|\$HOME\/Android\/Sdk/.test(build))
    errors.push(
      `${paths.buildScript}: developer-home Android SDK fallback is forbidden`,
    );
  for (const abi of REQUIRED_ANDROID_ABIS) {
    if (!build.includes(abi))
      errors.push(`${paths.buildScript}: missing ABI ${abi}`);
  }
  for (const token of [
    paths.releaseApk,
    paths.releaseAab,
    paths.provenanceFile,
    section.releaseVersionInput,
  ]) {
    if (!build.includes(token) && !provenance.includes(token))
      errors.push(`Android release scripts missing '${token}'`);
  }
  for (const token of ["zipalign", "-P 16", "llvm-objdump"]) {
    if (!build.includes(token))
      errors.push(`${paths.buildScript}: 16 KB contract missing '${token}'`);
  }
  for (const token of ["checksum", "readelf"]) {
    if (!abiVerifier.toLowerCase().includes(token))
      errors.push(
        `${paths.abiVerifier}: UniFFI ABI verifier missing '${token}'`,
      );
  }
  for (const token of [
    "sha256",
    "git",
    "status",
    "version",
    "apk",
    "aab",
    "mv",
  ]) {
    if (!provenance.toLowerCase().includes(token))
      errors.push(
        `${paths.provenanceScript}: release provenance missing '${token}'`,
      );
  }

  const actualPermissions = extractManifestPermissions(manifest);
  if (!exactSet(actualPermissions, [...section.allowedPermissions].sort()))
    errors.push(
      `${paths.manifest}: permissions do not equal androidShell.allowedPermissions`,
    );
  const cleartext = manifest.match(
    /android:usesCleartextTraffic\s*=\s*["']([^"']+)["']/,
  )?.[1];
  if (!cleartext)
    errors.push(
      `${paths.manifest}: missing android:usesCleartextTraffic policy`,
    );
  if (cleartext === "true")
    errors.push(
      `${paths.manifest}: main/release cleartext may not be literal true`,
    );
  if (!section.debugCleartext && cleartext !== "false")
    errors.push(
      `${paths.manifest}: debugCleartext=false requires literal release-safe false`,
    );
  if (section.debugCleartext) {
    if (!cleartext?.startsWith("${"))
      errors.push(
        `${paths.manifest}: debug cleartext exception must use a build-type placeholder`,
      );
    if (
      !app.includes("usesCleartextTraffic") ||
      !app.includes('"false"') ||
      !app.includes('"true"')
    )
      errors.push(
        `${paths.appGradle}: debug cleartext requires false default plus explicit debug-only true`,
      );
  }

  for (const input of section.signingInputNames) {
    if (!app.includes(input))
      errors.push(
        `${paths.appGradle}: missing external signing input name ${input}`,
      );
  }
  if (/(storePassword|keyPassword|keyAlias)\s*=\s*["'][^"']+["']/.test(app))
    errors.push(
      `${paths.appGradle}: literal signing credential/alias value is forbidden`,
    );
  if (/storeFile\s*=\s*file\(\s*["'][^"']+["']\s*\)/.test(app))
    errors.push(`${paths.appGradle}: literal signing file path is forbidden`);

  return errors;
}

const assertionKey = (
  entry: Pick<AndroidAssertionCommand, "assertionId" | "leg">,
): string => `${entry.assertionId}/${entry.leg}`;

export function validateAndroidCommandPlan(
  section: AndroidShellSection,
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(section.assertions))
    return ["androidShell.assertions: required list"];
  const seen = new Set<string>();
  for (const [index, entry] of section.assertions.entries()) {
    const prefix = `androidShell.assertions[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }
    if (
      !isNonEmptyString(entry.assertionId) ||
      !/^MOB-(AND|PAR|OPT)-\d{3}$/.test(entry.assertionId)
    )
      errors.push(`${prefix}.assertionId: required stable MOB-AND/PAR/OPT id`);
    if (
      !isNonEmptyString(entry.leg) ||
      !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.leg)
    )
      errors.push(`${prefix}.leg: required kebab-case identity`);
    requireStringArray(errors, `${prefix}.command`, entry.command);
    const key = assertionKey(entry as unknown as AndroidAssertionCommand);
    if (seen.has(key))
      errors.push(`${prefix}: duplicate assertion leg '${key}'`);
    seen.add(key);
    if (entry.cwd !== undefined && !isSafeRelativePath(String(entry.cwd)))
      errors.push(`${prefix}.cwd: must be a safe app-relative path`);
    if (
      entry.timeoutMs !== undefined &&
      (typeof entry.timeoutMs !== "number" ||
        !Number.isFinite(entry.timeoutMs) ||
        entry.timeoutMs <= 0)
    )
      errors.push(`${prefix}.timeoutMs: must be a positive number`);
    if (
      entry.expectedExit !== undefined &&
      entry.expectedExit !== "zero" &&
      entry.expectedExit !== "nonzero"
    )
      errors.push(`${prefix}.expectedExit: required zero|nonzero`);
    if (
      entry.expectedExit === "nonzero" &&
      !isNonEmptyString(entry.expectedOutputPattern)
    )
      errors.push(
        `${prefix}.expectedOutputPattern: required for nonzero expectation`,
      );
    if (isNonEmptyString(entry.expectedOutputPattern)) {
      try {
        new RegExp(entry.expectedOutputPattern, "i");
      } catch {
        errors.push(
          `${prefix}.expectedOutputPattern: invalid regular expression`,
        );
      }
    }
    if (entry.hostConstraintPatterns !== undefined) {
      requireStringArray(
        errors,
        `${prefix}.hostConstraintPatterns`,
        entry.hostConstraintPatterns,
        false,
      );
      if (isStringArray(entry.hostConstraintPatterns)) {
        for (const pattern of entry.hostConstraintPatterns) {
          try {
            new RegExp(pattern, "i");
          } catch {
            errors.push(
              `${prefix}.hostConstraintPatterns: invalid '${pattern}'`,
            );
          }
        }
      }
    }
    if (entry.unsetEnv !== undefined)
      requireStringArray(errors, `${prefix}.unsetEnv`, entry.unsetEnv, false);
    if (entry.env !== undefined) {
      if (
        !isRecord(entry.env) ||
        Object.values(entry.env).some((value) => typeof value !== "string")
      )
        errors.push(`${prefix}.env: must be a string map`);
      else {
        for (const name of Object.keys(entry.env)) {
          if (
            section.signingInputNames.includes(name) ||
            /(PASSWORD|SECRET|TOKEN|ACCESS_KEY|API_KEY|CREDENTIAL)$/i.test(name)
          )
            errors.push(
              `${prefix}.env: secret/signing input '${name}' may not carry a value`,
            );
        }
      }
    }
    if (
      entry.assertionId?.startsWith("MOB-OPT-") &&
      (!isNonEmptyString(entry.selectedCapability) ||
        !section.selectedCapabilities.includes(entry.selectedCapability))
    )
      errors.push(
        `${prefix}.selectedCapability: MOB-OPT leg must name a selected capability`,
      );
  }
  for (const [assertionId, leg] of REQUIRED_ANDROID_ASSERTION_LEGS) {
    const key = `${assertionId}/${leg}`;
    if (!seen.has(key))
      errors.push(`androidShell.assertions: missing required '${key}'`);
  }
  const signingAbsence = section.assertions.find(
    (entry) => assertionKey(entry) === "MOB-AND-006/signing-absence",
  );
  if (signingAbsence) {
    if (signingAbsence.expectedExit !== "nonzero")
      errors.push(
        "androidShell.assertions: signing-absence must expect nonzero",
      );
    for (const input of section.signingInputNames) {
      if (!signingAbsence.unsetEnv?.includes(input))
        errors.push(
          `androidShell.assertions: signing-absence must unset ${input}`,
        );
    }
  }
  return errors;
}

function redactOutput(output: string): string {
  return output
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/g,
      "[REDACTED CREDENTIAL]",
    )
    .slice(-8_000);
}

function evidenceTarget(
  root: string,
  evidenceDir: string,
  entry: AndroidAssertionCommand,
): string {
  const safe = `${entry.assertionId.toLowerCase()}-${entry.leg}.json`;
  const target = resolve(root, evidenceDir, safe);
  const rel = relative(resolve(root), target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`evidence path escapes app root: ${target}`);
  return target;
}

export function runAndroidAssertionCommand(
  root: string,
  evidenceDir: string,
  entry: AndroidAssertionCommand,
): {
  evidence: AndroidAssertionEvidence;
  evidencePath: string;
  output: string;
} {
  const [command, ...args] = entry.command;
  if (!command) throw new Error(`${assertionKey(entry)}: empty command`);
  const env = { ...process.env, ...(entry.env ?? {}) };
  for (const name of entry.unsetEnv ?? []) delete env[name];
  const cwd = entry.cwd ? inRoot(root, entry.cwd) : root;
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: entry.timeoutMs ?? 600_000,
  });
  const output = redactOutput(
    [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join("\n"),
  );
  const constrained =
    (result.error &&
      (result.error as NodeJS.ErrnoException).code === "ENOENT") ||
    (entry.hostConstraintPatterns ?? []).some((pattern) =>
      new RegExp(pattern, "i").test(output),
    );
  const expected = entry.expectedExit ?? "zero";
  const expectedOutput = entry.expectedOutputPattern
    ? new RegExp(entry.expectedOutputPattern, "i").test(output)
    : true;
  const passed =
    expected === "zero"
      ? result.status === 0
      : result.status !== null && result.status !== 0 && expectedOutput;
  const verdict: AndroidAssertionEvidence["verdict"] = constrained
    ? "host-constrained"
    : passed
      ? "pass"
      : "fail";
  const evidence: AndroidAssertionEvidence = {
    schemaVersion: "papercusp-android-assertion-v1",
    assertionId: entry.assertionId,
    leg: entry.leg,
    identity: assertionKey(entry),
    verdict,
    host: `${platform()}-${arch()}`,
    selectedCapability: entry.selectedCapability ?? null,
    command: entry.command,
    cwd: slash(relative(root, cwd) || "."),
    expectedExit: expected,
    exitStatus: result.status,
    signal: result.signal,
    outputBytes: Buffer.byteLength(output),
    outputSha256: createHash("sha256").update(output).digest("hex"),
    recordedAt: new Date().toISOString(),
  };
  const target = evidenceTarget(root, evidenceDir, entry);
  mkdirSync(resolve(target, ".."), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, target);
  return { evidence, evidencePath: target, output };
}
