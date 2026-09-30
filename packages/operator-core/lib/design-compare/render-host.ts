/**
 * The identity of the MACHINE a capture was rendered on (P-011, D-023).
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * D-021 recorded a scope limit on the shipped threshold: every noise sample
 * behind it is same-host, so host-to-host variance is entirely unmeasured, and
 * "a threshold derived from same-host noise, enforced across hosts, fails
 * correct work on the first runner whose fonts differ."
 *
 * Probing that before acting on it found something sharper than a missing
 * number. `CaptureEnvironment` has seven fields — viewport, deviceScaleFactor,
 * browser, theme, fontSet, fixture, state — and NONE of them carries host
 * identity, so `environmentsMatch` returns true for two captures taken on
 * machines with entirely different fonts, and `describeEnvironment` renders
 * them identically. A cross-host comparison was not merely unmeasured; it was
 * indistinguishable from a same-host one at every precondition the gate checks.
 * `fontSet: 'system'` is the mechanism: capture.ts says in its own docstring
 * that it "asserts nothing about fonts", which is honest, but it means the one
 * environment field naming fonts is satisfied identically by two hosts whose
 * fonts differ.
 *
 * At a derived tolerance of 3.3816e-5 — about 34 pixels of a 1280x800 render —
 * that gap is the whole difference between a gate that works and a gate that
 * red-lines correct work the first time it runs somewhere else.
 *
 * ─── WHY METRICS AND NOT `process.platform` ──────────────────────────────────
 *
 * The cheap fingerprint is platform + arch + release. It is also the wrong one:
 * two Linux x64 boxes with different font packages installed are EXACTLY the
 * case D-021 is afraid of, and platform+arch calls them identical. What has to
 * be sensitive here is the thing that actually moves pixels — the resolved
 * fonts — so the fingerprint measures them directly.
 *
 * The instrument is already in this codebase and already validated: D-016
 * established that font availability is read by METRIC COMPARISON and never by
 * `document.fonts.check` (which returns true for families that do not exist).
 * `capture-playwright.ts` measures a probe string against the three generics to
 * detect substitution; this reuses the same probe, at the same size, against
 * the same generics, and keeps the widths instead of throwing them away.
 * Different installed fonts resolve the generics differently and the widths
 * move. Same instrument, one more question asked of it.
 *
 * ─── WHY MAJOR VERSION AND NOT THE FULL UA ───────────────────────────────────
 *
 * A full user-agent string changes on every Chrome patch. Folding it into the
 * fingerprint would silently DISABLE enforcement after a routine browser
 * update — a gate that stops firing without anyone deciding it should, which is
 * the failure mode this whole module exists to prevent, arriving by a different
 * door. The major version catches engine-scale change; the font metrics catch
 * what actually differs between machines.
 *
 * RESIDUAL LIMIT, STATED RATHER THAN PAPERED OVER: matching fingerprints mean
 * the resolved generic metrics and the browser major agree. They do not prove
 * two machines rasterize identically — a hinting or freetype difference that
 * leaves advance widths untouched would not show up here. This is a
 * conservative identity, not a proof of pixel equality, and the same-host noise
 * measurement it guards carries the identical limitation: it was taken at one
 * moment on one machine.
 */
import { createHash } from 'node:crypto';

/**
 * The probe string and size the metrics are taken at.
 *
 * Deliberately the same literals `capture-playwright.ts` uses for substitution
 * detection. Two spellings of one measurement would drift, and these two
 * readings have to be comparable to be worth taking.
 */
export const FONT_METRIC_PROBE = 'mmmmmmmmmmlliWWWW@1234567890';
export const FONT_METRIC_PX = 72;
/** The generics whose resolution depends on what the host actually has installed. */
export const FONT_METRIC_GENERICS = ['monospace', 'sans-serif', 'serif'] as const;

export type FontMetricGeneric = (typeof FONT_METRIC_GENERICS)[number];

/**
 * Measured advance widths, keyed by generic.
 *
 * A plain record rather than an array so a reader cannot mistake ordering for
 * meaning, and so a missing generic is visibly missing.
 */
export type FontMetrics = Readonly<Record<FontMetricGeneric, number>>;

/** What the rendering context reports about itself. Read back, never assumed. */
export interface RenderHostIdentity {
  /** Browser family, e.g. 'chromium'. */
  readonly browserName: string;
  /** MAJOR version only — see the header on why the patch is excluded. */
  readonly browserMajorVersion: string;
  readonly fontMetrics: FontMetrics;
}

/**
 * Widths are rounded before they enter the fingerprint.
 *
 * `measureText` returns a float, and a fingerprint that changes in the last
 * binary digit between two runs on ONE machine would disable enforcement at
 * random — indistinguishable, from the outside, from the cross-host case this
 * is built to catch. Three decimals is far finer than any real font difference
 * and coarse enough that identical inputs agree.
 */
export function canonicalWidth(width: number): number {
  return Number(width.toFixed(3));
}

/**
 * The exact string the fingerprint hashes.
 *
 * Exported because a fingerprint mismatch is something a human has to be able
 * to read: the hash says two hosts differ and this says how.
 */
export function canonicalRenderHost(identity: RenderHostIdentity): string {
  const metrics = FONT_METRIC_GENERICS.map(
    (generic) => `${generic}=${canonicalWidth(identity.fontMetrics[generic])}`,
  ).join(',');
  return `${identity.browserName}/${identity.browserMajorVersion};probe@${FONT_METRIC_PX}px[${metrics}]`;
}

/**
 * A stable short identifier for one rendering host.
 *
 * Truncated to 16 hex characters: this is an equality check between values
 * produced by the same code, not a defence against a chosen-prefix attack.
 */
export function renderHostFingerprint(identity: RenderHostIdentity): string {
  return createHash('sha256').update(canonicalRenderHost(identity)).digest('hex').slice(0, 16);
}

/** One-line human rendering, for the message that explains a mismatch. */
export function describeRenderHost(identity: RenderHostIdentity): string {
  return `${renderHostFingerprint(identity)} (${canonicalRenderHost(identity)})`;
}

/**
 * Extract browser family + major version from a user-agent string.
 *
 * Lives here rather than in the page so it is testable without a browser, and
 * so the page reports a raw observation instead of a parsed conclusion.
 */
export function browserIdentityFromUserAgent(userAgent: string): {
  readonly browserName: string;
  readonly browserMajorVersion: string;
} {
  // Chrome/Chromium report `Chrome/<major>.<minor>...`; HeadlessChrome reports
  // `HeadlessChrome/<major>...`. Both are the chromium family for our purposes:
  // headless and headful of the same major share a rasterizer, and treating
  // them as different hosts would refuse to enforce on exactly the setup that
  // produced the calibration.
  const chromium = /(?:Headless)?Chrome\/(\d+)\./.exec(userAgent);
  if (chromium) return { browserName: 'chromium', browserMajorVersion: chromium[1] };

  const firefox = /Firefox\/(\d+)\./.exec(userAgent);
  if (firefox) return { browserName: 'firefox', browserMajorVersion: firefox[1] };

  const webkit = /Version\/(\d+)\..*Safari\//.exec(userAgent);
  if (webkit) return { browserName: 'webkit', browserMajorVersion: webkit[1] };

  // Deliberately not a guess. An unrecognized agent yields an identity that
  // cannot match anything, so the outcome is "we do not know this host" —
  // report-only — rather than a fingerprint that collides with a real one.
  return { browserName: 'unknown', browserMajorVersion: '0' };
}

/** Why two hosts are not the same one, in a form a refusal can quote. */
export function explainRenderHostMismatch(
  expected: RenderHostIdentity,
  actual: RenderHostIdentity,
): string {
  const differences: string[] = [];
  if (expected.browserName !== actual.browserName) {
    differences.push(`browser ${expected.browserName} vs ${actual.browserName}`);
  }
  if (expected.browserMajorVersion !== actual.browserMajorVersion) {
    differences.push(
      `browser major ${expected.browserMajorVersion} vs ${actual.browserMajorVersion}`,
    );
  }
  for (const generic of FONT_METRIC_GENERICS) {
    const a = canonicalWidth(expected.fontMetrics[generic]);
    const b = canonicalWidth(actual.fontMetrics[generic]);
    if (a !== b) differences.push(`${generic} advance ${a} vs ${b}`);
  }
  return differences.length > 0 ? differences.join('; ') : 'no expressible difference';
}
