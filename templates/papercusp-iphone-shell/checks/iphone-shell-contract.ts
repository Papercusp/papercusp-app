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
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const REQUIRED_IPHONE_DEVICE_TARGET = "aarch64-apple-ios" as const;
export const REQUIRED_IPHONE_SIMULATOR_TARGETS = [
  "aarch64-apple-ios-sim",
  "x86_64-apple-ios",
] as const;

export const SUPPORTED_IPHONE_CAPABILITIES = [
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

export const REQUIRED_IPHONE_ASSERTION_LEGS = [
  ["MOB-IOS-001", "project-generation"],
  ["MOB-IOS-002", "xcframework"],
  ["MOB-IOS-003", "swift-module"],
  ["MOB-IOS-004", "host-preflight"],
  ["MOB-IOS-005", "unit"],
  ["MOB-IOS-005", "ui"],
  ["MOB-IOS-006", "privacy-capabilities"],
  ["MOB-IOS-006", "archive-preflight"],
  ["MOB-IOS-006", "signing-absence"],
] as const;

export interface IphoneShellPaths {
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

export interface IphoneAssertionCommand {
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

export interface IphoneShellSection {
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
  signingInputNames: string[];
  exportMethod: string;
  selectedCapabilities: string[];
  entitlementKeys: string[];
  privacyUsageDescriptionKeys: string[];
  backgroundModes: string[];
  paths: IphoneShellPaths;
  evidenceDir: string;
  assertions: IphoneAssertionCommand[];
}

export interface IphoneAssertionEvidence {
  schemaVersion: "papercusp-iphone-assertion-v1";
  assertionId: string;
  leg: string;
  identity: string;
  verdict: "pass" | "fail" | "host-constrained";
  host: string;
  hostStrategy: "local-mac" | "remote-host";
  remoteHost: string | null;
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

const REQUIRED_SOURCE_PATH_FIELDS = [
  "projectSpec",
  "gitignore",
  "infoPlist",
  "privacyManifest",
  "entitlements",
  "buildScript",
  "hostPreflightScript",
  "testScript",
  "releaseScript",
  "udl",
  "uniffiConfig",
  "cargoLock",
] as const;

const REQUIRED_PATH_FIELDS = [
  ...REQUIRED_SOURCE_PATH_FIELDS,
  "generatedProject",
  "appSourceRoot",
  "coreSourceRoot",
  "generatedSwift",
  "ffiHeader",
  "moduleMap",
  "deviceLibrary",
  "simulatorLibrary",
  "xcframework",
  "archive",
  "exportDir",
  "provenanceFile",
] as const;

const SECTION_FIELDS = new Set([
  "bundleId",
  "productName",
  "coreModule",
  "scheme",
  "projectName",
  "deploymentTarget",
  "swiftVersion",
  "deviceTarget",
  "simulatorTargets",
  "rustLibrary",
  "ffiModule",
  "hostStrategy",
  "remoteHost",
  "releaseVersionInput",
  "buildNumberInput",
  "signingPrefix",
  "signingInputNames",
  "exportMethod",
  "selectedCapabilities",
  "entitlementKeys",
  "privacyUsageDescriptionKeys",
  "backgroundModes",
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

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

export function validateIphoneShellConfig(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["iphoneShell: must be an object"];

  for (const field of Object.keys(value)) {
    if (!SECTION_FIELDS.has(field))
      errors.push(`iphoneShell.${field}: unknown field`);
  }
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
    if (!isNonEmptyString(value[field]))
      errors.push(`iphoneShell.${field}: required non-empty string`);
  }
  if (
    value.hostStrategy !== "local-mac" &&
    value.hostStrategy !== "remote-host"
  ) {
    errors.push("iphoneShell.hostStrategy: required local-mac|remote-host");
  }
  if (
    value.hostStrategy === "remote-host" &&
    !isNonEmptyString(value.remoteHost)
  ) {
    errors.push("iphoneShell.remoteHost: required for remote-host strategy");
  }
  if (value.hostStrategy === "local-mac" && value.remoteHost !== undefined) {
    errors.push("iphoneShell.remoteHost: forbidden for local-mac strategy");
  }
  if (
    isNonEmptyString(value.remoteHost) &&
    !/^[a-z][a-z0-9-]*$/.test(value.remoteHost)
  ) {
    errors.push(
      "iphoneShell.remoteHost: required named-host slug without user, address, port, or key path",
    );
  }

  if (
    isNonEmptyString(value.bundleId) &&
    !/^[a-z][a-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value.bundleId)
  ) {
    errors.push("iphoneShell.bundleId: required reverse-DNS identifier");
  }
  for (const field of [
    "productName",
    "coreModule",
    "scheme",
    "projectName",
    "ffiModule",
  ] as const) {
    if (
      isNonEmptyString(value[field]) &&
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value[field])
    ) {
      errors.push(`iphoneShell.${field}: required Swift/Xcode identifier`);
    }
  }
  if (
    isNonEmptyString(value.deploymentTarget) &&
    (!/^\d+\.\d+$/.test(value.deploymentTarget) ||
      Number.parseFloat(value.deploymentTarget) < 17)
  ) {
    errors.push(
      "iphoneShell.deploymentTarget: required iOS version at or above 17.0",
    );
  }
  if (
    isNonEmptyString(value.swiftVersion) &&
    !/^\d+\.\d+$/.test(value.swiftVersion)
  ) {
    errors.push("iphoneShell.swiftVersion: required major.minor version");
  }
  if (
    isNonEmptyString(value.deviceTarget) &&
    value.deviceTarget !== REQUIRED_IPHONE_DEVICE_TARGET
  ) {
    errors.push(
      `iphoneShell.deviceTarget: must be ${REQUIRED_IPHONE_DEVICE_TARGET}`,
    );
  }
  requireStringArray(
    errors,
    "iphoneShell.simulatorTargets",
    value.simulatorTargets,
  );
  if (
    isStringArray(value.simulatorTargets) &&
    !exactSet(value.simulatorTargets, REQUIRED_IPHONE_SIMULATOR_TARGETS)
  ) {
    errors.push(
      `iphoneShell.simulatorTargets: must be exactly ${REQUIRED_IPHONE_SIMULATOR_TARGETS.join(",")}`,
    );
  }
  if (
    isNonEmptyString(value.rustLibrary) &&
    !/^lib[a-z0-9_]+\.a$/.test(value.rustLibrary)
  ) {
    errors.push("iphoneShell.rustLibrary: required lib<snake_case>.a");
  }
  for (const field of ["releaseVersionInput", "buildNumberInput"] as const) {
    if (
      isNonEmptyString(value[field]) &&
      !/^[A-Z][A-Z0-9_]+$/.test(value[field])
    ) {
      errors.push(`iphoneShell.${field}: required upper-snake input name`);
    }
  }
  if (
    isNonEmptyString(value.signingPrefix) &&
    !/^[A-Z][A-Z0-9_]+_$/.test(value.signingPrefix)
  ) {
    errors.push(
      "iphoneShell.signingPrefix: required upper-snake prefix ending in _",
    );
  }
  if (
    isNonEmptyString(value.exportMethod) &&
    !["development", "ad-hoc", "app-store-connect"].includes(value.exportMethod)
  ) {
    errors.push(
      "iphoneShell.exportMethod: required development|ad-hoc|app-store-connect",
    );
  }

  for (const field of [
    "signingInputNames",
    "selectedCapabilities",
    "entitlementKeys",
    "privacyUsageDescriptionKeys",
    "backgroundModes",
  ] as const) {
    requireStringArray(
      errors,
      `iphoneShell.${field}`,
      value[field],
      field === "signingInputNames",
    );
    if (isStringArray(value[field]) && duplicates(value[field]).length > 0)
      errors.push(`iphoneShell.${field}: duplicate value`);
  }
  if (
    isStringArray(value.signingInputNames) &&
    isNonEmptyString(value.signingPrefix)
  ) {
    for (const name of value.signingInputNames) {
      if (!name.startsWith(value.signingPrefix))
        errors.push(
          `iphoneShell.signingInputNames: '${name}' must start with ${value.signingPrefix}`,
        );
    }
    for (const suffix of [
      "TEAM_ID",
      "CODE_SIGN_IDENTITY",
      "PROVISIONING_PROFILE",
    ]) {
      if (!value.signingInputNames.includes(`${value.signingPrefix}${suffix}`))
        errors.push(
          `iphoneShell.signingInputNames: missing ${value.signingPrefix}${suffix}`,
        );
    }
  }
  if (isStringArray(value.selectedCapabilities)) {
    const supported = new Set<string>(SUPPORTED_IPHONE_CAPABILITIES);
    for (const capability of value.selectedCapabilities) {
      if (!supported.has(capability))
        errors.push(
          `iphoneShell.selectedCapabilities: unsupported '${capability}'`,
        );
    }
  }
  if (isStringArray(value.privacyUsageDescriptionKeys)) {
    for (const key of value.privacyUsageDescriptionKeys) {
      if (!/^NS[A-Za-z0-9]+UsageDescription$/.test(key))
        errors.push(
          `iphoneShell.privacyUsageDescriptionKeys: invalid '${key}'`,
        );
    }
  }

  if (!isSafeRelativePath(String(value.evidenceDir ?? "")))
    errors.push("iphoneShell.evidenceDir: required safe app-relative path");
  if (!isRecord(value.paths)) {
    errors.push("iphoneShell.paths: required object");
  } else {
    for (const field of REQUIRED_PATH_FIELDS) {
      if (!isSafeRelativePath(String(value.paths[field] ?? "")))
        errors.push(
          `iphoneShell.paths.${field}: required safe app-relative path`,
        );
    }
    for (const field of ["unitTestRoots", "uiTestRoots"] as const) {
      requireStringArray(
        errors,
        `iphoneShell.paths.${field}`,
        value.paths[field],
      );
      if (isStringArray(value.paths[field])) {
        for (const path of value.paths[field]) {
          if (!isSafeRelativePath(path))
            errors.push(
              `iphoneShell.paths.${field}: '${path}' must be app-relative`,
            );
        }
      }
    }
    if (
      isNonEmptyString(value.paths.generatedProject) &&
      !value.paths.generatedProject.endsWith(".xcodeproj")
    ) {
      errors.push("iphoneShell.paths.generatedProject: must end in .xcodeproj");
    }
    if (
      isNonEmptyString(value.paths.xcframework) &&
      !value.paths.xcframework.endsWith(".xcframework")
    ) {
      errors.push("iphoneShell.paths.xcframework: must end in .xcframework");
    }
    if (
      isNonEmptyString(value.paths.archive) &&
      !value.paths.archive.endsWith(".xcarchive")
    ) {
      errors.push("iphoneShell.paths.archive: must end in .xcarchive");
    }
  }

  if (!Array.isArray(value.assertions) || value.assertions.length === 0)
    errors.push("iphoneShell.assertions: required non-empty list");
  return errors;
}

function readRequired(root: string, path: string, errors: string[]): string {
  const absolute = inRoot(root, path);
  if (!existsSync(absolute)) {
    errors.push(`missing declared iPhone shell path: ${path}`);
    return "";
  }
  if (lstatSync(absolute).isDirectory()) {
    errors.push(`declared iPhone shell file is a directory: ${path}`);
    return "";
  }
  return readFileSync(absolute, "utf8");
}

function treeHasSwift(path: string, requireXCTest = false): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return false;
  if (!stat.isDirectory()) {
    if (!path.endsWith(".swift")) return false;
    return (
      !requireXCTest || /\bimport\s+XCTest\b/.test(readFileSync(path, "utf8"))
    );
  }
  return readdirSync(path, { withFileTypes: true }).some((entry) => {
    if (entry.isSymbolicLink()) return false;
    return treeHasSwift(join(path, entry.name), requireXCTest);
  });
}

function targetBlock(project: string, target: string): string {
  const marker = new RegExp(`^  ${escaped(target)}:\\s*$`, "m");
  const match = marker.exec(project);
  if (!match) return "";
  const start = match.index;
  const rest = project.slice(start + match[0].length);
  const next = /^  [A-Za-z_][A-Za-z0-9_]*:\s*$/m.exec(rest);
  return project.slice(
    start,
    next ? start + match[0].length + next.index : undefined,
  );
}

function plistKeys(plist: string): string[] {
  return [...plist.matchAll(/<key>\s*([^<]+?)\s*<\/key>/g)].map(
    (entry) => entry[1]!,
  );
}

function plistArrayStrings(plist: string, key: string): string[] {
  const match = new RegExp(
    `<key>\\s*${escaped(key)}\\s*<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>`,
  ).exec(plist);
  return match
    ? [...match[1]!.matchAll(/<string>\s*([^<]+?)\s*<\/string>/g)].map(
        (entry) => entry[1]!,
      )
    : [];
}

function requireTokens(
  errors: string[],
  path: string,
  content: string,
  tokens: readonly string[],
  contract: string,
): void {
  for (const token of tokens) {
    if (!content.includes(token))
      errors.push(`${path}: ${contract} missing '${token}'`);
  }
}

export function validateIphoneShellScaffold(
  root: string,
  section: IphoneShellSection,
): string[] {
  const errors = validateIphoneShellConfig(section);
  if (errors.length > 0) return errors;

  const paths = section.paths;
  const source = new Map<string, string>();
  for (const field of REQUIRED_SOURCE_PATH_FIELDS) {
    source.set(field, readRequired(root, paths[field], errors));
  }
  const project = source.get("projectSpec")!;
  const gitignore = source.get("gitignore")!;
  const info = source.get("infoPlist")!;
  const privacy = source.get("privacyManifest")!;
  const entitlements = source.get("entitlements")!;
  const build = source.get("buildScript")!;
  const hostPreflight = source.get("hostPreflightScript")!;
  const tests = source.get("testScript")!;
  const release = source.get("releaseScript")!;

  const appRoot = inRoot(root, paths.appSourceRoot);
  if (!treeHasSwift(appRoot))
    errors.push(
      `iphoneShell.paths.appSourceRoot: no Swift app source found under ${paths.appSourceRoot}`,
    );
  const coreRoot = inRoot(root, paths.coreSourceRoot);
  if (!existsSync(coreRoot) || !lstatSync(coreRoot).isDirectory())
    errors.push(
      `missing declared generated Swift module root: ${paths.coreSourceRoot}`,
    );
  for (const [kind, roots] of [
    ["unit", paths.unitTestRoots],
    ["ui", paths.uiTestRoots],
  ] as const) {
    if (!roots.some((path) => treeHasSwift(inRoot(root, path), true)))
      errors.push(`iphoneShell.paths.${kind}TestRoots: no XCTest source found`);
  }

  requireTokens(
    errors,
    paths.projectSpec,
    project,
    [
      `name: ${section.projectName}`,
      `iOS: "${section.deploymentTarget}"`,
      `SWIFT_VERSION: "${section.swiftVersion}"`,
      `IPHONEOS_DEPLOYMENT_TARGET: "${section.deploymentTarget}"`,
      `PRODUCT_BUNDLE_IDENTIFIER: ${section.bundleId}`,
      `INFOPLIST_FILE: ${paths.infoPlist.replace(/^ios\//, "")}`,
      `CODE_SIGN_ENTITLEMENTS: ${paths.entitlements.replace(/^ios\//, "")}`,
      `  ${section.scheme}:`,
      "type: bundle.unit-test",
      "type: bundle.ui-testing",
    ],
    "XcodeGen project contract",
  );
  for (const path of [
    paths.appSourceRoot,
    ...paths.unitTestRoots,
    ...paths.uiTestRoots,
  ]) {
    const projectPath = path.replace(/^ios\//, "");
    if (!project.includes(projectPath))
      errors.push(`${paths.projectSpec}: missing source path ${projectPath}`);
  }

  const app = targetBlock(project, section.productName);
  if (!app) {
    errors.push(
      `${paths.projectSpec}: missing app target ${section.productName}`,
    );
  } else {
    if (!/type:\s*application\b/.test(app))
      errors.push(
        `${paths.projectSpec}: ${section.productName} must be an application target`,
      );
    if (!new RegExp(`target:\\s*${escaped(section.coreModule)}\\b`).test(app))
      errors.push(
        `${paths.projectSpec}: app target must depend on ${section.coreModule}`,
      );
    if (app.includes(paths.generatedSwift.replace(/^ios\//, "")))
      errors.push(
        `${paths.projectSpec}: app target may not compile generated Swift directly`,
      );
  }

  const core = targetBlock(project, section.coreModule);
  if (!core) {
    errors.push(
      `${paths.projectSpec}: missing generated boundary target ${section.coreModule}`,
    );
  } else {
    if (!/type:\s*(static\.)?framework\b/.test(core))
      errors.push(
        `${paths.projectSpec}: ${section.coreModule} must be a framework target`,
      );
    for (const path of [paths.coreSourceRoot, paths.generatedSwift]) {
      if (!core.includes(path.replace(/^ios\//, "")))
        errors.push(
          `${paths.projectSpec}: ${section.coreModule} missing ${path.replace(/^ios\//, "")}`,
        );
    }
    if (!core.includes(paths.xcframework.replace(/^ios\//, "")))
      errors.push(
        `${paths.projectSpec}: ${section.coreModule} missing XCFramework dependency`,
      );
  }

  const generatedProject = slash(paths.generatedProject);
  if (
    !gitignore.split(/\r?\n/).some((line) => {
      const normalized = line.trim().replace(/^\//, "");
      return (
        normalized === generatedProject ||
        normalized === generatedProject.replace(/^ios\//, "")
      );
    })
  ) {
    errors.push(
      `${paths.gitignore}: must ignore generated project ${paths.generatedProject}`,
    );
  }
  if (project.includes(paths.generatedProject))
    errors.push(
      `${paths.projectSpec}: generated .xcodeproj may not be template source`,
    );

  const actualEntitlements = plistKeys(entitlements).filter(
    (key) => key !== "DOCTYPE",
  );
  if (!exactSet(actualEntitlements, section.entitlementKeys))
    errors.push(
      `${paths.entitlements}: keys do not equal iphoneShell.entitlementKeys`,
    );
  const actualUsageKeys = plistKeys(info).filter((key) =>
    /^NS[A-Za-z0-9]+UsageDescription$/.test(key),
  );
  if (!exactSet(actualUsageKeys, section.privacyUsageDescriptionKeys))
    errors.push(
      `${paths.infoPlist}: usage descriptions do not equal iphoneShell.privacyUsageDescriptionKeys`,
    );
  const actualBackgroundModes = plistArrayStrings(info, "UIBackgroundModes");
  if (!exactSet(actualBackgroundModes, section.backgroundModes))
    errors.push(
      `${paths.infoPlist}: UIBackgroundModes do not equal iphoneShell.backgroundModes`,
    );
  requireTokens(
    errors,
    paths.privacyManifest,
    privacy,
    [
      "NSPrivacyTracking",
      "NSPrivacyTrackingDomains",
      "NSPrivacyCollectedDataTypes",
      "NSPrivacyAccessedAPITypes",
    ],
    "privacy manifest",
  );
  const selected = new Set(section.selectedCapabilities);
  const entitlementsSet = new Set(section.entitlementKeys);
  const usage = new Set(section.privacyUsageDescriptionKeys);
  if (selected.has("push") && !entitlementsSet.has("aps-environment"))
    errors.push(
      "iphoneShell.selectedCapabilities: push requires aps-environment entitlement",
    );
  if (
    selected.has("deep-links") &&
    !entitlementsSet.has("com.apple.developer.associated-domains") &&
    !info.includes("CFBundleURLTypes")
  ) {
    errors.push(
      "iphoneShell.selectedCapabilities: deep-links requires URL types or associated domains",
    );
  }
  for (const [capability, key] of [
    ["camera", "NSCameraUsageDescription"],
    ["microphone", "NSMicrophoneUsageDescription"],
    ["local-networking", "NSLocalNetworkUsageDescription"],
  ] as const) {
    if (selected.has(capability) && !usage.has(key))
      errors.push(
        `iphoneShell.selectedCapabilities: ${capability} requires ${key}`,
      );
  }
  if (
    selected.has("media-playback") &&
    !section.backgroundModes.includes("audio")
  )
    errors.push(
      "iphoneShell.selectedCapabilities: media-playback requires UIBackgroundModes audio",
    );

  requireTokens(
    errors,
    paths.buildScript,
    build,
    [
      "cargo build",
      section.deviceTarget,
      ...section.simulatorTargets,
      section.rustLibrary,
      "lipo",
      "-create",
      "xcodebuild",
      "-create-xcframework",
      paths.generatedSwift,
      paths.ffiHeader,
      paths.moduleMap,
      paths.deviceLibrary,
      paths.simulatorLibrary,
      paths.xcframework,
      "headers",
      "module.modulemap",
      "rm",
    ],
    "XCFramework build contract",
  );
  requireTokens(
    errors,
    "iPhone host entrypoints",
    [hostPreflight, build, tests, release].join("\n"),
    ["uname", "Darwin", "xcodebuild", "xcodegen", "swiftformat", "simctl"],
    "iPhone host capability closure",
  );
  if (
    section.hostStrategy === "remote-host" &&
    ![hostPreflight, tests, release].some((content) =>
      content.includes(section.remoteHost!),
    )
  ) {
    errors.push(
      `iPhone host scripts do not reference named remote host ${section.remoteHost}`,
    );
  }
  requireTokens(
    errors,
    paths.testScript,
    tests,
    [
      "xcodebuild",
      section.scheme,
      "build-for-testing",
      "test-without-building",
      "xcresult",
      "xcresulttool",
      "nodeIdentifier",
    ],
    "non-zero XCTest/XCUITest contract",
  );
  if (!/(testsCount|test count|executed)/i.test(tests))
    errors.push(
      `${paths.testScript}: must verify a non-zero executed test count`,
    );
  if (section.hostStrategy === "remote-host") {
    requireTokens(
      errors,
      paths.testScript,
      tests,
      ["simctl boot", "simctl spawn", "launchctl print system"],
      "bounded headless simulator readiness",
    );
    if (/simctl\s+bootstatus\b/.test(tests))
      errors.push(
        `${paths.testScript}: remote-host runners may not use GUI-dependent simctl bootstatus; use a bounded simctl spawn readiness probe`,
      );
  }

  requireTokens(
    errors,
    paths.releaseScript,
    release,
    [
      "xcodebuild",
      "archive",
      "-exportArchive",
      section.releaseVersionInput,
      section.buildNumberInput,
      section.exportMethod,
      paths.archive,
      paths.exportDir,
      paths.provenanceFile,
      "sha256",
      "git",
      "status",
      "mv",
    ],
    "archive/export preflight contract",
  );
  for (const input of section.signingInputNames) {
    if (!release.includes(input))
      errors.push(
        `${paths.releaseScript}: missing external signing input name ${input}`,
      );
  }
  if (/\b(altool|iTMSTransporter|notarytool)\b|--upload\b/.test(release))
    errors.push(
      `${paths.releaseScript}: upload invocation is forbidden in shell preflight`,
    );
  if (/DEVELOPMENT_TEAM\s*[:=]\s*["']?[A-Z0-9]{10}\b/.test(project + release))
    errors.push(
      "iPhone shell source contains a literal Apple development team id",
    );
  if (
    /CODE_SIGN_IDENTITY\s*[:=]\s*["'][^$"'][^"']*["']/.test(project + release)
  )
    errors.push("iPhone shell source contains a literal code-sign identity");

  for (const token of [paths.udl, paths.uniffiConfig, paths.cargoLock]) {
    if (!build.includes(token))
      errors.push(
        `${paths.buildScript}: generated boundary input missing '${token}'`,
      );
  }
  return errors;
}

const assertionKey = (
  entry: Pick<IphoneAssertionCommand, "assertionId" | "leg">,
): string => `${entry.assertionId}/${entry.leg}`;

export function validateIphoneCommandPlan(
  section: IphoneShellSection,
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(section.assertions))
    return ["iphoneShell.assertions: required list"];
  const seen = new Set<string>();
  for (const [index, entry] of section.assertions.entries()) {
    const prefix = `iphoneShell.assertions[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }
    if (
      !isNonEmptyString(entry.assertionId) ||
      !/^MOB-(IOS|PAR|OPT)-\d{3}$/.test(entry.assertionId)
    ) {
      errors.push(`${prefix}.assertionId: required stable MOB-IOS/PAR/OPT id`);
    }
    if (
      !isNonEmptyString(entry.leg) ||
      !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.leg)
    ) {
      errors.push(`${prefix}.leg: required kebab-case identity`);
    }
    requireStringArray(errors, `${prefix}.command`, entry.command);
    const key = assertionKey(entry as unknown as IphoneAssertionCommand);
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
    ) {
      errors.push(`${prefix}.timeoutMs: must be a positive number`);
    }
    if (
      entry.expectedExit !== undefined &&
      entry.expectedExit !== "zero" &&
      entry.expectedExit !== "nonzero"
    ) {
      errors.push(`${prefix}.expectedExit: required zero|nonzero`);
    }
    if (
      entry.expectedExit === "nonzero" &&
      !isNonEmptyString(entry.expectedOutputPattern)
    ) {
      errors.push(
        `${prefix}.expectedOutputPattern: required for nonzero expectation`,
      );
    }
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
      ) {
        errors.push(`${prefix}.env: must be a string map`);
      } else {
        for (const name of Object.keys(entry.env)) {
          if (
            section.signingInputNames.includes(name) ||
            /(PASSWORD|SECRET|TOKEN|ACCESS_KEY|API_KEY|CREDENTIAL)$/i.test(name)
          ) {
            errors.push(
              `${prefix}.env: secret/signing input '${name}' may not carry a value`,
            );
          }
        }
      }
    }
    if (
      entry.assertionId?.startsWith("MOB-OPT-") &&
      (!isNonEmptyString(entry.selectedCapability) ||
        !section.selectedCapabilities.includes(entry.selectedCapability))
    ) {
      errors.push(
        `${prefix}.selectedCapability: MOB-OPT leg must name a selected capability`,
      );
    }
  }
  for (const [assertionId, leg] of REQUIRED_IPHONE_ASSERTION_LEGS) {
    const key = `${assertionId}/${leg}`;
    if (!seen.has(key))
      errors.push(`iphoneShell.assertions: missing required '${key}'`);
  }
  for (const leg of ["unit", "ui"]) {
    const testEntry = section.assertions.find(
      (entry) => assertionKey(entry) === `MOB-IOS-005/${leg}`,
    );
    if (testEntry && !isNonEmptyString(testEntry.expectedOutputPattern))
      errors.push(
        `iphoneShell.assertions: ${leg} must declare a non-zero test-count output pattern`,
      );
  }
  const signingAbsence = section.assertions.find(
    (entry) => assertionKey(entry) === "MOB-IOS-006/signing-absence",
  );
  if (signingAbsence) {
    if (signingAbsence.expectedExit !== "nonzero")
      errors.push(
        "iphoneShell.assertions: signing-absence must expect nonzero",
      );
    for (const input of section.signingInputNames) {
      if (!signingAbsence.unsetEnv?.includes(input))
        errors.push(
          `iphoneShell.assertions: signing-absence must unset ${input}`,
        );
    }
  }
  const archive = section.assertions.find(
    (entry) => assertionKey(entry) === "MOB-IOS-006/archive-preflight",
  );
  if (
    archive?.command.some((part) => /upload|altool|iTMSTransporter/i.test(part))
  )
    errors.push("iphoneShell.assertions: archive-preflight may not upload");
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
  entry: IphoneAssertionCommand,
): string {
  const safe = `${entry.assertionId.toLowerCase()}-${entry.leg}.json`;
  const target = resolve(root, evidenceDir, safe);
  const rel = relative(resolve(root), target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`evidence path escapes app root: ${target}`);
  return target;
}

export function runIphoneAssertionCommand(
  root: string,
  section: Pick<
    IphoneShellSection,
    "hostStrategy" | "remoteHost" | "evidenceDir"
  >,
  entry: IphoneAssertionCommand,
): {
  evidence: IphoneAssertionEvidence;
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
    (section.hostStrategy === "local-mac" && platform() !== "darwin") ||
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
      ? result.status === 0 && expectedOutput
      : result.status !== null && result.status !== 0 && expectedOutput;
  const verdict: IphoneAssertionEvidence["verdict"] = constrained
    ? "host-constrained"
    : passed
      ? "pass"
      : "fail";
  const evidence: IphoneAssertionEvidence = {
    schemaVersion: "papercusp-iphone-assertion-v1",
    assertionId: entry.assertionId,
    leg: entry.leg,
    identity: assertionKey(entry),
    verdict,
    host: `${platform()}-${arch()}`,
    hostStrategy: section.hostStrategy,
    remoteHost: section.remoteHost ?? null,
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
  const target = evidenceTarget(root, section.evidenceDir, entry);
  mkdirSync(resolve(target, ".."), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, target);
  return { evidence, evidencePath: target, output };
}
