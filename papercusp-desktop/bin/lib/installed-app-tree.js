'use strict';
/**
 * Is a BUILT papercusp-desktop binary backed by a COMPLETE installation tree
 * for the PRODUCT ROLE it was bundled as?
 *
 * WHY THIS EXISTS (EI-18885442084466501)
 * ------------------------------------------------------------------
 * The desktop now ships as TWO products from one Rust binary. Papercusp GUI is
 * attach-only and deliberately carries only `sidecar/spa`; Papercusp Server owns
 * `serve.mjs` and the full runtime. Treating the GUI like the old self-hosting app
 * makes every correct thin-GUI package look corrupt, while treating the Server
 * like the GUI would let a genuinely unbootable backend through.
 *
 * The failure is silent and expensive because it is INVISIBLE AT LAUNCH. The app
 * starts, the window opens, the webview paints its shell — and only then does it
 * discover it has no sidecar, wait out its full 120s operator-boot timeout
 * (`operator_boot_timeout`, src-tauri/src/main.rs), and fall back to whatever
 * foreign environment it can reach. Everything downstream that merely checks
 * "did the binary launch" therefore reports success.
 *
 * That is what broke the packaged-binary perf suite: its 30s UI-mount wait
 * expired 90 SECONDS BEFORE the app had even finished deciding which environment
 * to use, so all four specs failed at the same precondition with a timeout
 * message that pointed at the UI. No timeout value below 120s could ever have
 * passed, and raising it would only have traded a fast wrong answer for a slow
 * one — the app would then have been measured against a FALLBACK environment
 * over HTTP, which is precisely the configuration the egress invariant exists to
 * forbid. A green run there would have been worse than a red one.
 *
 * So the check has to be on the ARTIFACT, before anything is measured.
 *
 * The role-specific lists below mirror the product distribution contract and
 * the Rust role split (`app_role.rs` + `missing_sidecar_entrypoints` in main.rs).
 * This module answers "does this artifact contain what THIS product needs?".
 */
const fs = require('node:fs');
const path = require('node:path');

const GUI_PRODUCT_NAME = 'Papercusp GUI';
const SERVER_PRODUCT_NAME = 'Papercusp Server';

/** The attach-only GUI renders its shell from the packaged SPA. */
const REQUIRED_GUI_SIDECAR_ENTRYPOINTS = ['spa/index.html'];

/** Mirrors `missing_sidecar_entrypoints` in src-tauri/src/main.rs. */
const REQUIRED_SERVER_SIDECAR_ENTRYPOINTS = ['serve.mjs', 'sidecar-preload.js'];

// Backward-compatible export for callers that mean the operator-owning Server.
const REQUIRED_SIDECAR_ENTRYPOINTS = REQUIRED_SERVER_SIDECAR_ENTRYPOINTS;

/** Written by build.rs into the placeholder sidecar dir. */
const PLACEHOLDER_MARKER = 'PLACEHOLDER-README.txt';

const DEFAULT_PRODUCT_NAME = GUI_PRODUCT_NAME;

function requiredSidecarEntrypointsFor(productName = DEFAULT_PRODUCT_NAME) {
  return productName === SERVER_PRODUCT_NAME
    ? REQUIRED_SERVER_SIDECAR_ENTRYPOINTS
    : REQUIRED_GUI_SIDECAR_ENTRYPOINTS;
}

/**
 * Where a launched binary looks for its bundled resources.
 *
 * Tauri's Linux resolution is `<dir-of-binary>/../lib/<productName>/`, which
 * holds for BOTH shapes this repo produces — verified against each:
 *   deb tree   .../data/usr/bin/papercusp-desktop
 *              → .../data/usr/lib/Papercusp GUI/sidecar
 *   bare cargo <target>/release/papercusp-desktop
 *              → <target>/lib/Papercusp GUI/sidecar
 * The bare-cargo case is the trap: `cargo build --release` never populates that
 * sibling tree at all, so a raw target-dir binary is complete only by accident.
 */
function resourceRootFor(appBinaryPath, productName = DEFAULT_PRODUCT_NAME) {
  return path.resolve(path.dirname(appBinaryPath), '..', 'lib', productName);
}

function sidecarDirFor(appBinaryPath, productName = DEFAULT_PRODUCT_NAME) {
  return path.join(resourceRootFor(appBinaryPath, productName), 'sidecar');
}

/**
 * Inspect one built binary. Pure filesystem reads; never throws for a missing
 * path (an absent tree is a RESULT, not an error — the caller decides how loud
 * to be about it).
 *
 * @returns {{
 *   appPath: string, exists: boolean, sidecarDir: string,
 *   productName: string, required: string[], missing: string[],
 *   placeholder: boolean, complete: boolean,
 * }}
 */
function inspectInstalledApp(appBinaryPath, productName = DEFAULT_PRODUCT_NAME) {
  const sidecarDir = sidecarDirFor(appBinaryPath, productName);
  const required = requiredSidecarEntrypointsFor(productName);
  const missing = required.filter(
    (entry) => !fs.existsSync(path.join(sidecarDir, entry)),
  );
  const exists = fs.existsSync(appBinaryPath);
  return {
    appPath: appBinaryPath,
    exists,
    productName,
    sidecarDir,
    required,
    missing,
    placeholder: fs.existsSync(path.join(sidecarDir, PLACEHOLDER_MARKER)),
    complete: exists && missing.length === 0,
  };
}

/**
 * Render the actionable message for an incomplete tree.
 *
 * Distinguishing "never built" (placeholder present) from "corrupt/partial"
 * matters: they have DIFFERENT remediations, and the generic runtime FATAL
 * ("Reinstall Papercusp to recover") is actively misleading for a dev-box build
 * where the real answer is that one build step was skipped.
 */
function describeIncompleteInstall(report) {
  if (report.complete) return null;
  if (report.productName === GUI_PRODUCT_NAME) {
    return (
      `Incomplete ${GUI_PRODUCT_NAME} installation: the attach-only GUI resource tree at ` +
      `${report.sidecarDir} is missing ${report.missing.join(', ')}.\n\n` +
      `  binary: ${report.appPath}\n\n` +
      `The GUI must carry its packaged SPA, but it must NOT carry Server-only ` +
      `serve.mjs or sidecar-preload.js. Rebuild the current SPA/sidecar source if its ` +
      `freshness guard reports drift, then run \`npm run build\` to re-bundle the thin GUI.\n\n` +
      `(thin GUI / Server product split)`
    );
  }
  const lead = report.placeholder
    ? `the sidecar was NEVER BUILT — ${report.sidecarDir} still holds build.rs's ` +
      `placeholder (${PLACEHOLDER_MARKER}), not a real bundle`
    : `the sidecar at ${report.sidecarDir} is missing ${report.missing.join(', ')}`;
  return (
    `Incomplete papercusp-desktop installation: ${lead}.\n\n` +
    `  binary: ${report.appPath}\n\n` +
    `The app WILL still launch and open a window, then fail to start its operator, ` +
    `burn its full 120s boot timeout, and fall back to a foreign environment — so ` +
    `anything measured against it describes the wrong configuration.\n\n` +
    `Fix (in papercusp-desktop/):\n` +
    `  bash bin/build-desktop-sidecar.sh   # populates src-tauri/sidecar/\n` +
    `  npm run build                       # re-bundles it into the app tree\n\n` +
    `\`npm run build\` alone is NOT enough: it is plain \`tauri build\`, which never ` +
    `builds the sidecar (only bin/build-linux-local.sh and bin/release.config.ts do). ` +
    `A bare \`cargo build --release\` binary in the target dir is never complete — ` +
    `use the bundled tree under release/bundle/. (EI-18885442084466501)`
  );
}

module.exports = {
  GUI_PRODUCT_NAME,
  SERVER_PRODUCT_NAME,
  REQUIRED_GUI_SIDECAR_ENTRYPOINTS,
  REQUIRED_SERVER_SIDECAR_ENTRYPOINTS,
  REQUIRED_SIDECAR_ENTRYPOINTS,
  PLACEHOLDER_MARKER,
  DEFAULT_PRODUCT_NAME,
  requiredSidecarEntrypointsFor,
  resourceRootFor,
  sidecarDirFor,
  inspectInstalledApp,
  describeIncompleteInstall,
};
