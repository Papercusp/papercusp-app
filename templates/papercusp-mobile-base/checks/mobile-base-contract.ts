import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface MobileBaseStaticSection {
  rustMsrv: string;
  rootCargo: string;
  cargoLock: string;
  crateManifests: string[];
  udl: string;
  uniffiConfig: string;
  bindgen: string;
  tokenSource: string;
  generatedTokenFiles: string[];
  requiredPaths: string[];
  scanRoots: string[];
  forbiddenTokens: string[];
  allowlistedFiles?: string[];
  secretPathPatterns?: string[];
}

const slash = (path: string): string => path.split(sep).join("/");
const inRoot = (root: string, path: string): string =>
  isAbsolute(path) ? path : join(root, path);

function walkFiles(root: string): string[] {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return [];
  if (!stat.isDirectory()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === "target" ||
      entry.name === "build"
    ) {
      return [];
    }
    const child = join(root, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walkFiles(child) : [child];
  });
}

function gitVisibleFiles(root: string, scanRoots: string[]): string[] | null {
  try {
    const output = execFileSync(
      "git",
      [
        "-C",
        root,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...scanRoots,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output
      .split("\0")
      .filter(Boolean)
      .map((path) => join(root, path));
  } catch {
    return null;
  }
}

function textIfSource(path: string): string | null {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

export function validateMobileScaffold(
  root: string,
  section: MobileBaseStaticSection,
): string[] {
  const errors: string[] = [];
  if (section.crateManifests.length !== 3)
    errors.push("crateManifests must contain exactly three manifests");
  if (section.generatedTokenFiles.length < 2)
    errors.push("generatedTokenFiles must contain Kotlin and Swift outputs");

  const declared = [
    section.rootCargo,
    section.cargoLock,
    ...section.crateManifests,
    section.udl,
    section.uniffiConfig,
    section.bindgen,
    section.tokenSource,
    ...section.generatedTokenFiles,
    ...section.requiredPaths,
  ];
  for (const path of declared) {
    if (!existsSync(inRoot(root, path)))
      errors.push(`missing declared mobile-base path: ${path}`);
  }
  if (errors.some((error) => error.startsWith("missing declared")))
    return errors;

  const workspace = readFileSync(inRoot(root, section.rootCargo), "utf8");
  if (!/\[workspace\]/.test(workspace))
    errors.push(`${section.rootCargo}: missing [workspace]`);
  if (!/resolver\s*=\s*["']2["']/.test(workspace))
    errors.push(`${section.rootCargo}: missing resolver = "2"`);
  const escapedMsrv = section.rustMsrv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    !new RegExp(`rust-version\\s*=\\s*["']${escapedMsrv}["']`).test(workspace)
  ) {
    errors.push(
      `${section.rootCargo}: missing declared rust-version ${section.rustMsrv}`,
    );
  }
  for (const manifest of section.crateManifests) {
    if (!/\[package\]/.test(readFileSync(inRoot(root, manifest), "utf8")))
      errors.push(`${manifest}: missing [package]`);
  }

  const udl = readFileSync(inRoot(root, section.udl), "utf8");
  if (!/\bnamespace\b/.test(udl))
    errors.push(`${section.udl}: missing namespace declaration`);
  if (!/\b(interface|dictionary|record|enum)\b/.test(udl))
    errors.push(`${section.udl}: missing exported type`);
  const uniffi = readFileSync(
    inRoot(root, section.uniffiConfig),
    "utf8",
  ).toLowerCase();
  if (!uniffi.includes("kotlin"))
    errors.push(
      `${section.uniffiConfig}: missing Kotlin binding configuration`,
    );
  if (!uniffi.includes("swift"))
    errors.push(`${section.uniffiConfig}: missing Swift binding configuration`);

  try {
    const tokenSource = JSON.parse(
      readFileSync(inRoot(root, section.tokenSource), "utf8"),
    );
    if (
      typeof tokenSource !== "object" ||
      tokenSource === null ||
      Array.isArray(tokenSource)
    ) {
      errors.push(`${section.tokenSource}: token source must be a JSON object`);
    }
  } catch (error) {
    errors.push(
      `${section.tokenSource}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return errors;
}

export function collectMobileSourceViolations(
  root: string,
  section: MobileBaseStaticSection,
): string[] {
  const allowlisted = new Set((section.allowlistedFiles ?? []).map(slash));
  const defaultSecretPaths = [
    /(^|\/)local\.properties$/,
    /(^|\/)google-services\.json$/,
    /(^|\/)GoogleService-Info\.plist$/,
    /\.(jks|keystore|p12|mobileprovision)$/,
  ];
  const configuredSecretPaths: RegExp[] = [];
  const violations: string[] = [];
  for (const pattern of section.secretPathPatterns ?? []) {
    try {
      configuredSecretPaths.push(new RegExp(pattern));
    } catch (error) {
      violations.push(
        `invalid secretPathPatterns regex '${pattern}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const credentialSignatures = [
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
  ];

  const availableRoots: string[] = [];
  for (const scanRoot of section.scanRoots) {
    const absoluteRoot = inRoot(root, scanRoot);
    if (!existsSync(absoluteRoot)) {
      violations.push(`missing mobileBase.scanRoots entry: ${scanRoot}`);
      continue;
    }
    availableRoots.push(scanRoot);
  }

  const files =
    gitVisibleFiles(resolve(root), availableRoots) ??
    availableRoots.flatMap((scanRoot) => walkFiles(inRoot(root, scanRoot)));
  for (const path of new Set(files)) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) continue;
    const rel = slash(relative(resolve(root), path));
    if (
      [...defaultSecretPaths, ...configuredSecretPaths].some((pattern) =>
        pattern.test(rel),
      )
    ) {
      violations.push(`${rel}: secret/service/signing path`);
    }
    if (allowlisted.has(rel)) continue;
    const text = textIfSource(path);
    if (text === null) continue;
    for (const token of section.forbiddenTokens) {
      if (text.includes(token))
        violations.push(`${rel}: forbidden token '${token}'`);
    }
    for (const signature of credentialSignatures) {
      if (signature.test(text))
        violations.push(`${rel}: credential signature ${signature.source}`);
    }
  }
  return violations;
}
