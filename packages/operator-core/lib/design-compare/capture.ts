/**
 * Mockup-to-implementation validation: implementation-target capture adapters.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-004).
 *
 * P-005 compares two images. This module produces the second one — the capture
 * of the real implementation — and, more importantly, *refuses* to produce it
 * when the environment it was taken at is not the environment the contract
 * asked for. A capture at the wrong viewport, scale, theme or font set is not
 * weaker evidence about this reference; it is evidence about a different render,
 * and admitting it is how a fidelity gate silently starts approving the wrong
 * thing.
 *
 * ─── WHY THIS IS NOT LOST-PIXEL'S CAPTURE PATH ───────────────────────────────
 *
 * D-014 records the full reuse analysis. In short, all three measured
 * disqualifiers are structural rather than configurable, read out of
 * `node_modules/lost-pixel/dist/shots/shots.js` at the installed 3.22.0:
 *
 *  1. A contracted viewport HEIGHT cannot be honored. Line 86-88 sets the
 *     viewport to `{ width: shotItem.viewport.width, height: currentViewport?.height ?? 500 }`
 *     — the declared height is discarded.
 *  2. There is no device-scale, color-scheme or font control in this repo at
 *     all. The context is `browser.newContext(shotItem.browserConfig)` (line 15)
 *     and `browserConfig` comes only from a `configureBrowser` hook that none of
 *     the five `lostpixel.config.ts` files defines. (Five, not three: D-015
 *     corrects a census D-014 recorded from a remembered subset. The count is
 *     now pinned by `lostpixel-config-census.test.ts` so it cannot drift here.)
 *  3. Shots are full-page by default (line 118), so image height is
 *     document-determined — right for build-to-build regression, wrong as the
 *     only mode for a fixed-geometry fidelity reference.
 *
 * What IS reused: Playwright at the same installed version lost-pixel launches,
 * lost-pixel's Storybook URL convention verbatim (pinned by a parity test that
 * imports lost-pixel's own `getIframeUrl`, not restated in a comment), and its
 * `animations: 'disabled'` and consecutive-identical-hash stability retry.
 *
 * What is NOT touched: any of the five `lostpixel.config.ts` files, and lost-pixel's
 * module-scoped config singleton. Existing build-to-build visual regression runs
 * exactly as it does today; this path is additive and separately invoked.
 *
 * ─── THE DESIGN RULE THAT SHAPES EVERY SEAM BELOW ────────────────────────────
 *
 * Nothing here infers an achieved environment from a requested one. The adapter
 * asks the page what it ACTUALLY has and compares. That is why `CapturePage`
 * exposes `observeEnvironment()` rather than a generic `evaluate()`: a seam
 * shaped as "run arbitrary code" can be faked into agreeing with whatever the
 * test wants, and a seam shaped as "report these specific facts" cannot.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { CaptureEnvironment, ImplementationTarget, InvalidReason, Viewport } from './contract';
import { readPngDimensionsSafe, type PngDimensions } from './png-header';

// ─── capture geometry ────────────────────────────────────────────────────────

/**
 * Whether the image covers exactly the contracted viewport, or the whole
 * document.
 *
 * This is not a convenience toggle: it decides whether the capture has a
 * PREDICTABLE geometry at all, and therefore whether P-005 can be handed an
 * `expectedDimensions` to check against. See `expectedDimensionsFor`.
 */
export const CAPTURE_MODES = ['viewport', 'full-page'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

/**
 * The dimensions the contract says the capture must have, or `undefined` when
 * the contract cannot say.
 *
 * D-012 left this to P-004 because the relation between a declared viewport and
 * a produced image belongs to the capture adapter, not to the comparison
 * adapter. Here is that relation, and it is asymmetric:
 *
 *  - `viewport` mode: the image is exactly the viewport scaled by the device
 *    scale factor, so the contract knows both axes up front and P-005 gets a
 *    real precondition to enforce.
 *  - `full-page` mode: the height is whatever the document turned out to be.
 *    That is content-determined, so there is NO honest expectation to state.
 *    Returning a guess here — say, the viewport height — would manufacture a
 *    precondition that fails on every correct capture of a scrolling page.
 *    Returning `undefined` is the truthful answer, and P-005 already documents
 *    that omitting it leaves the image-vs-image check as the sole geometry test.
 *
 * Returns `undefined` for full-page mode, and also when the scaled dimensions
 * are not whole pixels — see `scaledAxis`, which refuses rather than rounds.
 */
export function expectedDimensionsFor(
  environment: CaptureEnvironment,
  mode: CaptureMode,
): PngDimensions | undefined {
  if (mode === 'full-page') return undefined;
  const width = scaledAxis(environment.viewport.width, environment.deviceScaleFactor);
  const height = scaledAxis(environment.viewport.height, environment.deviceScaleFactor);
  if (width === undefined || height === undefined) return undefined;
  return { width, height };
}

/**
 * A viewport axis scaled by the device scale factor, or `undefined` when the
 * product is not a whole number of pixels.
 *
 * Rounding here would be the exact failure D-005 forbids one layer down:
 * quietly normalising a geometry discrepancy so a comparison can proceed. A
 * contract at 801px and a 1.5x scale has no integer pixel expectation, so the
 * adapter says so (`unsupported-input`) instead of inventing 1202 or 1201.
 */
function scaledAxis(axis: number, deviceScaleFactor: number): number | undefined {
  if (!Number.isInteger(axis) || axis <= 0) return undefined;
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) return undefined;
  const scaled = axis * deviceScaleFactor;
  return Number.isInteger(scaled) ? scaled : undefined;
}

// ─── how an environment field is realized in a browser ───────────────────────

/**
 * How a `CaptureEnvironment.theme` name is actually applied to a page.
 *
 * A theme is a product concept, not a browser one, and the mapping differs per
 * surface: some read `prefers-color-scheme`, some read a `data-theme`
 * attribute, most read both. So the mapping is supplied, not assumed.
 */
export interface ThemeApplication {
  readonly colorScheme: 'light' | 'dark' | 'no-preference';
  /** Set on the document element before capture, when the surface needs one. */
  readonly documentAttribute?: { readonly name: string; readonly value: string };
}

export type ThemeResolver = (theme: string) => ThemeApplication | undefined;

/**
 * Knows `light` and `dark`, and refuses everything else.
 *
 * Refusing is the point. An unknown theme name treated as light is a capture
 * that looks fine, compares fine, and is about the wrong render — the silent
 * form of the failure this whole module exists to make loud. A product with more
 * themes registers them; it does not get them guessed.
 */
export const defaultThemeResolver: ThemeResolver = (theme) => {
  if (theme === 'light') return { colorScheme: 'light' };
  if (theme === 'dark') return { colorScheme: 'dark' };
  return undefined;
};

/**
 * The font families a named font set REQUIRES to be loaded before capture.
 *
 * Font substitution is the most under-detected source of visual drift: a
 * missing webfont falls back silently, every glyph shifts a fraction, and the
 * diff reads as a hundred scattered regions with no obvious cause.
 */
export type FontSetResolver = (fontSet: string) => readonly string[] | undefined;

/**
 * Knows exactly one font set: `system`, which requires no specific families.
 *
 * That is a deliberate, declared *absence* of a font requirement rather than an
 * unchecked one — a capture at `fontSet: 'system'` asserts nothing about fonts
 * and the contract says so out loud. Any other name is unregistered and is
 * refused, so a typo in a font set cannot silently downgrade to "no check".
 */
export const defaultFontSetResolver: FontSetResolver = (fontSet) =>
  fontSet === 'system' ? [] : undefined;

/**
 * An interaction to drive before capturing, expressed declaratively.
 *
 * Declarative on purpose. A `(page) => Promise<void>` callback would be more
 * flexible and strictly worse here: it cannot be stored alongside a ratified
 * reference, cannot be reviewed as part of a contract, and lets arbitrary code
 * run inside something whose whole job is to be trustworthy evidence.
 */
export type StateDirective =
  | { readonly kind: 'none' }
  | { readonly kind: 'hover'; readonly selector: string }
  | { readonly kind: 'focus'; readonly selector: string }
  | { readonly kind: 'click'; readonly selector: string };

export type StateResolver = (state: string) => StateDirective | undefined;

/** Knows `default` (no interaction). Anything else must be registered. */
export const defaultStateResolver: StateResolver = (state) =>
  state === 'default' ? { kind: 'none' } : undefined;

// ─── the browser seam ────────────────────────────────────────────────────────

/** Everything that must be fixed at context-creation time in a real browser. */
export interface PageSpec {
  readonly viewport: Viewport;
  readonly deviceScaleFactor: number;
  readonly colorScheme: 'light' | 'dark' | 'no-preference';
  /** Always requested. Motion is a top source of capture-to-capture noise. */
  readonly reducedMotion: 'reduce' | 'no-preference';
}

/**
 * What the page reports about itself. Read back, never assumed.
 *
 * `requiredFontFamilies` is passed in rather than inspected globally because
 * "is this family available" is only answerable against a specific list; asking
 * for "all loaded fonts" invites a check that passes because something loaded.
 */
export interface ObservedEnvironment {
  readonly viewport: Viewport;
  readonly devicePixelRatio: number;
  readonly prefersDark: boolean;
  readonly prefersReducedMotion: boolean;
  /** Value of the theme attribute the request asked for, when it asked. */
  readonly documentAttributeValue?: string | null;
  readonly fontsReady: boolean;
  /** Requested families the page cannot render. Non-empty ⇒ silent substitution. */
  readonly missingFontFamilies: readonly string[];
  /**
   * The rendering host this page reports (P-011/D-023), as `render-host.ts`'s
   * canonical string.
   *
   * Optional so a test double is not forced to synthesise a fingerprint it has
   * no opinion about. A capture that reports none simply cannot be used as
   * evidence for a reference that records one — it is never treated as a match.
   */
  readonly renderHost?: string;
}

export interface SettleOptions {
  /** Wait for network to go quiet, bounded. */
  readonly networkIdleTimeoutMs: number;
  /** Families whose availability must be confirmed before capture. */
  readonly requiredFontFamilies: readonly string[];
}

export interface ScreenshotOptions {
  readonly outputPath: string;
  readonly fullPage: boolean;
}

export interface CapturePage {
  goto(url: string, timeoutMs: number): Promise<void>;
  /** Apply the theme attribute, when the resolved theme needs one. */
  applyDocumentAttribute(attribute: { name: string; value: string }): Promise<void>;
  applyState(directive: StateDirective): Promise<void>;
  settle(options: SettleOptions): Promise<void>;
  observeEnvironment(options: {
    readonly requiredFontFamilies: readonly string[];
    readonly documentAttributeName?: string;
  }): Promise<ObservedEnvironment>;
  screenshot(options: ScreenshotOptions): Promise<void>;
  close(): Promise<void>;
}

export interface CaptureBrowser {
  /** Identity of the engine actually driving, e.g. `chromium`. */
  readonly browserName: string;
  newPage(spec: PageSpec): Promise<CapturePage>;
}

// ─── the artifact seam ───────────────────────────────────────────────────────

export type CaptureArtifact =
  | { readonly ok: true; readonly dimensions: PngDimensions; readonly sha256: string }
  | { readonly ok: false; readonly detail: string };

export type CaptureArtifactReader = (imagePath: string) => CaptureArtifact;

/**
 * Read the written capture: hash it, and parse its IHDR for dimensions.
 *
 * The hash is what makes the stability retry meaningful — two captures that
 * differ by one antialiased pixel are not a stable capture, and only a
 * byte-level identity can say so.
 */
export const filesystemCaptureArtifactReader: CaptureArtifactReader = (imagePath) => {
  let bytes: Buffer;
  try {
    bytes = readFileSync(imagePath);
  } catch (error) {
    return {
      ok: false,
      detail: `capture artifact could not be read at ${imagePath}: ${describeThrown(error)}`,
    };
  }
  const outcome = readPngDimensionsSafe(bytes);
  if (!outcome.ok) {
    return { ok: false, detail: `capture artifact at ${imagePath} is not a readable PNG: ${outcome.detail}` };
  }
  return {
    ok: true,
    dimensions: outcome.dimensions,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

/**
 * Describe a thrown value without trusting it.
 *
 * Learned in P-005: the first version of this helper read `error.message`
 * directly, and a value whose `message` getter throws made the DESCRIBER throw —
 * inside the catch block meant to contain the failure. Any error formatter on a
 * catch-everything path has that shape, because the value being described is
 * the value that was already misbehaving.
 */
function describeThrown(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      return typeof message === 'string' && message.length > 0 ? message : error.name;
    }
    if (typeof error === 'string') return error;
    return String(error);
  } catch {
    return 'a thrown value that could not be described';
  }
}

// ─── request / outcome ───────────────────────────────────────────────────────

export interface CaptureRequest {
  readonly target: ImplementationTarget;
  readonly environment: CaptureEnvironment;
  readonly mode: CaptureMode;
  /** Where the PNG is written. Must end in `.png` (D-013: the engine reads PNG only). */
  readonly outputPath: string;
  /**
   * Root the target is resolved against — a Storybook base URL for a story, an
   * origin for a page route.
   */
  readonly baseUrl: string;
  readonly navigationTimeoutMs?: number;
  readonly networkIdleTimeoutMs?: number;
  /**
   * How many additional attempts a capture gets to reproduce itself byte-for-byte.
   * 0 disables the check (one shot, taken as-is).
   */
  readonly stabilityRetries?: number;
}

export interface CaptureSuccess {
  readonly ok: true;
  readonly imagePath: string;
  readonly url: string;
  readonly dimensions: PngDimensions;
  readonly sha256: string;
  /** The environment observed on the page — not the one requested. */
  readonly observed: ObservedEnvironment;
  /** Ready to hand to P-005's `ComparisonRequest`. `undefined` in full-page mode. */
  readonly expectedDimensions: PngDimensions | undefined;
  /** How many extra attempts stability took. 0 ⇒ stable first time. */
  readonly stabilityAttempts: number;
}

export interface CaptureRefusal {
  readonly ok: false;
  /** Reuses the contract's vocabulary so a refusal composes into a CompareResult. */
  readonly invalidReason: InvalidReason;
  readonly detail: string;
  readonly url?: string;
}

export type CaptureOutcome = CaptureSuccess | CaptureRefusal;

export interface CaptureDeps {
  readonly browser: CaptureBrowser;
  readonly themeResolver?: ThemeResolver;
  readonly fontSetResolver?: FontSetResolver;
  readonly stateResolver?: StateResolver;
  readonly readArtifact?: CaptureArtifactReader;
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_NETWORK_IDLE_TIMEOUT_MS = 5_000;
const DEFAULT_STABILITY_RETRIES = 2;

// ─── URL construction (lost-pixel's convention, reused verbatim) ─────────────

/**
 * The Storybook iframe URL for a base URL.
 *
 * Byte-identical to lost-pixel's `getIframeUrl`, and `capture.test.ts` asserts
 * that against lost-pixel's own exported function rather than against this
 * comment — a restated convention drifts, a pinned one fails the build.
 */
export function storybookIframeUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? `${baseUrl}iframe.html` : `${baseUrl}/iframe.html`;
}

/** lost-pixel's story-args encoding: `key:value` pairs joined by `;`. */
export function encodeStoryArgs(args: Readonly<Record<string, string>>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}

export function storybookStoryUrl(options: {
  readonly baseUrl: string;
  readonly storyId: string;
  readonly args?: Readonly<Record<string, string>>;
}): string {
  const iframeUrl = storybookIframeUrl(options.baseUrl);
  let url = `${iframeUrl}?id=${options.storyId}&viewMode=story`;
  if (options.args && Object.keys(options.args).length > 0) {
    url += `&args=${encodeStoryArgs(options.args)}`;
  }
  return url;
}

/** Join an origin and a route path without doubling or dropping the separator. */
export function pageRouteUrl(baseUrl: string, route: string): string {
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const trimmedRoute = route.startsWith('/') ? route : `/${route}`;
  return `${trimmedBase}${trimmedRoute}`;
}

/**
 * A `fixture` identifier parsed into Storybook story args.
 *
 * The contract carries `fixture` as an opaque string because most surfaces need
 * no more than a name. Storybook's is `key=value` pairs separated by `&`, which
 * is what a story's controls serialize to.
 */
export function parseFixtureArgs(fixture: string | undefined): Record<string, string> | undefined {
  if (fixture === undefined || fixture.length === 0) return undefined;
  const args: Record<string, string> = {};
  for (const pair of fixture.split('&')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    args[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

// ─── environment verification ────────────────────────────────────────────────

/**
 * Every way the achieved environment departs from the contracted one.
 *
 * ALL mismatches, not the first: a capture that is wrong on viewport, scale and
 * theme should say so once, so whoever fixes it fixes it once. Same reason
 * `isEvidenceCurrent` collects rather than short-circuits.
 */
export function environmentMismatches(options: {
  readonly requested: CaptureEnvironment;
  readonly observed: ObservedEnvironment;
  readonly browserName: string;
  readonly themeApplication: ThemeApplication;
}): string[] {
  const { requested, observed, browserName, themeApplication } = options;
  const mismatches: string[] = [];

  if (browserName !== requested.browser) {
    mismatches.push(`browser (contracted ${requested.browser}, driving ${browserName})`);
  }
  if (
    observed.viewport.width !== requested.viewport.width ||
    observed.viewport.height !== requested.viewport.height
  ) {
    mismatches.push(
      `viewport (contracted ${requested.viewport.width}x${requested.viewport.height}, ` +
        `page reports ${observed.viewport.width}x${observed.viewport.height})`,
    );
  }
  if (observed.devicePixelRatio !== requested.deviceScaleFactor) {
    mismatches.push(
      `device scale factor (contracted ${requested.deviceScaleFactor}, page reports ${observed.devicePixelRatio})`,
    );
  }

  if (themeApplication.colorScheme !== 'no-preference') {
    const wantDark = themeApplication.colorScheme === 'dark';
    if (observed.prefersDark !== wantDark) {
      mismatches.push(
        `theme '${requested.theme}' (contracted prefers-color-scheme: ${themeApplication.colorScheme}, ` +
          `page reports ${observed.prefersDark ? 'dark' : 'light'})`,
      );
    }
  }
  if (themeApplication.documentAttribute) {
    const { name, value } = themeApplication.documentAttribute;
    if (observed.documentAttributeValue !== value) {
      mismatches.push(
        `theme '${requested.theme}' document attribute ${name} ` +
          `(contracted '${value}', page reports ${
            observed.documentAttributeValue === null || observed.documentAttributeValue === undefined
              ? 'no such attribute'
              : `'${observed.documentAttributeValue}'`
          })`,
      );
    }
  }

  if (!observed.prefersReducedMotion) {
    mismatches.push(
      'reduced motion (the capture requested prefers-reduced-motion: reduce, and the page reports it is not in effect)',
    );
  }
  if (!observed.fontsReady) {
    mismatches.push('font loading (document.fonts never reached a loaded state before capture)');
  }
  if (observed.missingFontFamilies.length > 0) {
    mismatches.push(
      `font set '${requested.fontSet}' (families the page cannot render, so they are being ` +
        `substituted silently: ${observed.missingFontFamilies.join(', ')})`,
    );
  }

  return mismatches;
}

// ─── the adapter ─────────────────────────────────────────────────────────────

function refuse(invalidReason: InvalidReason, detail: string, url?: string): CaptureRefusal {
  return { ok: false, invalidReason, detail, ...(url === undefined ? {} : { url }) };
}

/**
 * Resolve the contracted environment into browser-level settings, refusing any
 * field this deployment has not registered a meaning for.
 *
 * Every refusal here happens BEFORE a browser is opened. That is deliberate: an
 * unregistered theme or font set is a contract error, and finding it after a
 * 30-second navigation buries it under whatever the page did in the meantime.
 */
function resolveEnvironment(
  request: CaptureRequest,
  deps: CaptureDeps,
):
  | {
      readonly ok: true;
      readonly themeApplication: ThemeApplication;
      readonly requiredFontFamilies: readonly string[];
      readonly stateDirective: StateDirective;
      readonly expectedDimensions: PngDimensions | undefined;
    }
  | CaptureRefusal {
  const { environment, mode } = request;

  if (path.extname(request.outputPath).toLowerCase() !== '.png') {
    return refuse(
      'unsupported-input',
      `capture output path must be a .png (D-013: the mandated pixelmatch path decodes PNG only), got '${request.outputPath}'`,
    );
  }
  if (!Number.isInteger(environment.viewport.width) || environment.viewport.width <= 0) {
    return refuse(
      'unsupported-input',
      `viewport width must be a positive whole number of CSS pixels, got ${environment.viewport.width}`,
    );
  }
  if (!Number.isInteger(environment.viewport.height) || environment.viewport.height <= 0) {
    return refuse(
      'unsupported-input',
      `viewport height must be a positive whole number of CSS pixels, got ${environment.viewport.height}`,
    );
  }
  if (!Number.isFinite(environment.deviceScaleFactor) || environment.deviceScaleFactor <= 0) {
    return refuse(
      'unsupported-input',
      `device scale factor must be a positive finite number, got ${environment.deviceScaleFactor}`,
    );
  }

  const themeApplication = (deps.themeResolver ?? defaultThemeResolver)(environment.theme);
  if (!themeApplication) {
    return refuse(
      'unsupported-input',
      `theme '${environment.theme}' has no registered browser mapping, so this capture cannot be ` +
        `taken at it. Register the theme rather than letting it default — an unregistered theme ` +
        `treated as light produces a capture of the wrong render that compares cleanly.`,
    );
  }

  const requiredFontFamilies = (deps.fontSetResolver ?? defaultFontSetResolver)(environment.fontSet);
  if (!requiredFontFamilies) {
    return refuse(
      'unsupported-input',
      `font set '${environment.fontSet}' is not registered, so the capture cannot confirm the ` +
        `right fonts are loaded. An unregistered font set is an unchecked one, and silent font ` +
        `substitution is the least visible source of visual drift.`,
    );
  }

  const stateName = environment.state ?? 'default';
  const stateDirective = (deps.stateResolver ?? defaultStateResolver)(stateName);
  if (!stateDirective) {
    return refuse(
      'unsupported-input',
      `interaction state '${stateName}' is not registered, so the capture cannot reach it`,
    );
  }

  if (mode === 'viewport') {
    const expected = expectedDimensionsFor(environment, mode);
    if (!expected) {
      return refuse(
        'unsupported-input',
        `viewport ${environment.viewport.width}x${environment.viewport.height} at device scale ` +
          `${environment.deviceScaleFactor} does not produce whole pixels ` +
          `(${environment.viewport.width * environment.deviceScaleFactor}x` +
          `${environment.viewport.height * environment.deviceScaleFactor}); a contract with no ` +
          `exact pixel expectation cannot be checked, and rounding it is the geometry error D-005 forbids`,
      );
    }
    return { ok: true, themeApplication, requiredFontFamilies, stateDirective, expectedDimensions: expected };
  }

  return {
    ok: true,
    themeApplication,
    requiredFontFamilies,
    stateDirective,
    expectedDimensions: undefined,
  };
}

/**
 * Capture one implementation target at one contracted environment.
 *
 * The order is load-bearing. Resolve and refuse first (no browser), then open,
 * navigate, drive state, settle, and only then OBSERVE and verify — because a
 * theme attribute or a webfont can still be wrong after everything looked like
 * it worked. Verification precedes the screenshot so a mismatched environment
 * never writes an artifact that someone can later mistake for evidence.
 */
export async function captureImplementationTarget(
  request: CaptureRequest,
  url: string,
  deps: CaptureDeps,
): Promise<CaptureOutcome> {
  const resolved = resolveEnvironment(request, deps);
  if (!resolved.ok) return resolved;

  const { themeApplication, requiredFontFamilies, stateDirective, expectedDimensions } = resolved;
  const { environment } = request;
  const readArtifact = deps.readArtifact ?? filesystemCaptureArtifactReader;
  const navigationTimeoutMs = request.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const networkIdleTimeoutMs = request.networkIdleTimeoutMs ?? DEFAULT_NETWORK_IDLE_TIMEOUT_MS;
  const stabilityRetries = request.stabilityRetries ?? DEFAULT_STABILITY_RETRIES;

  let page: CapturePage | undefined;
  try {
    page = await deps.browser.newPage({
      viewport: environment.viewport,
      deviceScaleFactor: environment.deviceScaleFactor,
      colorScheme: themeApplication.colorScheme,
      reducedMotion: 'reduce',
    });

    await page.goto(url, navigationTimeoutMs);

    if (themeApplication.documentAttribute) {
      await page.applyDocumentAttribute(themeApplication.documentAttribute);
    }
    await page.applyState(stateDirective);
    await page.settle({ networkIdleTimeoutMs, requiredFontFamilies });

    const observed = await page.observeEnvironment({
      requiredFontFamilies,
      ...(themeApplication.documentAttribute
        ? { documentAttributeName: themeApplication.documentAttribute.name }
        : {}),
    });

    const mismatches = environmentMismatches({
      requested: environment,
      observed,
      browserName: deps.browser.browserName,
      themeApplication,
    });
    if (mismatches.length > 0) {
      return refuse(
        'environment-mismatch',
        `the capture environment does not match the contracted one, so this render is not evidence ` +
          `about this reference: ${mismatches.join('; ')}`,
        url,
      );
    }

    const fullPage = request.mode === 'full-page';
    let previous: { dimensions: PngDimensions; sha256: string } | undefined;
    let stabilityAttempts = 0;

    for (let attempt = 0; attempt <= stabilityRetries; attempt += 1) {
      await page.screenshot({ outputPath: request.outputPath, fullPage });
      const artifact = readArtifact(request.outputPath);
      if (!artifact.ok) return refuse('capture-failed', artifact.detail, url);

      if (previous && previous.sha256 === artifact.sha256) {
        return finishCapture({
          request,
          url,
          artifact,
          observed,
          expectedDimensions,
          stabilityAttempts,
        });
      }
      if (attempt === stabilityRetries) {
        if (stabilityRetries === 0) {
          return finishCapture({
            request,
            url,
            artifact,
            observed,
            expectedDimensions,
            stabilityAttempts,
          });
        }
        return refuse(
          'capture-failed',
          `capture never reproduced itself: ${stabilityRetries + 1} attempts produced ` +
            `${stabilityRetries + 1} different images (last two digests ` +
            `${previous?.sha256.slice(0, 12) ?? '(none)'} then ${artifact.sha256.slice(0, 12)}). An unstable ` +
            `capture cannot support a pass/fail verdict, because the next run would compare a ` +
            `different image.`,
          url,
        );
      }
      previous = { dimensions: artifact.dimensions, sha256: artifact.sha256 };
      stabilityAttempts += 1;
    }

    /* c8 ignore next 2 -- the loop always returns; this satisfies the type checker */
    return refuse('capture-failed', 'capture loop ended without producing a result', url);
  } catch (error) {
    return refuse('capture-failed', `capture threw: ${describeThrown(error)}`, url);
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // A page that will not close cannot invalidate a capture that already
        // succeeded, and cannot make a refusal any more true. Swallowing here is
        // narrow and deliberate: it is the only swallow in this file.
      }
    }
  }
}

function finishCapture(options: {
  readonly request: CaptureRequest;
  readonly url: string;
  readonly artifact: { readonly dimensions: PngDimensions; readonly sha256: string };
  readonly observed: ObservedEnvironment;
  readonly expectedDimensions: PngDimensions | undefined;
  readonly stabilityAttempts: number;
}): CaptureOutcome {
  const { request, url, artifact, observed, expectedDimensions, stabilityAttempts } = options;

  // The capture-vs-contract geometry check. Distinct from P-005's
  // reference-vs-capture check, and it has to happen here: only this adapter
  // knows what geometry the contract implied.
  if (
    expectedDimensions &&
    (artifact.dimensions.width !== expectedDimensions.width ||
      artifact.dimensions.height !== expectedDimensions.height)
  ) {
    return refuse(
      'dimension-mismatch',
      `the capture's own geometry does not match the contracted environment (this is the ` +
        `capture-vs-contract check, not the reference-vs-capture one): contracted ` +
        `${expectedDimensions.width}x${expectedDimensions.height} from viewport ` +
        `${request.environment.viewport.width}x${request.environment.viewport.height} at scale ` +
        `${request.environment.deviceScaleFactor}, produced ` +
        `${artifact.dimensions.width}x${artifact.dimensions.height}`,
      url,
    );
  }

  return {
    ok: true,
    imagePath: request.outputPath,
    url,
    dimensions: artifact.dimensions,
    sha256: artifact.sha256,
    observed,
    expectedDimensions,
    stabilityAttempts,
  };
}

// ─── the two target adapters ─────────────────────────────────────────────────

export interface CaptureAdapter {
  readonly targetKinds: readonly ImplementationTarget['targetKind'][];
  capture(request: CaptureRequest): Promise<CaptureOutcome>;
}

/**
 * Storybook stories and components.
 *
 * `fixture` becomes story args, which is what makes a data fixture part of
 * environment identity rather than an invisible default: two captures of the
 * same story with different args are different renders, and the contract
 * already treats `fixture` as identity-bearing.
 */
export function createStorybookCaptureAdapter(deps: CaptureDeps): CaptureAdapter {
  return {
    targetKinds: ['storybook-story', 'component'],
    async capture(request) {
      if (request.target.targetKind === 'page-route') {
        return refuse(
          'unsupported-input',
          `the Storybook capture adapter was handed a page-route target ('${request.target.targetId}'); ` +
            `use the page-route adapter`,
        );
      }
      const args = parseFixtureArgs(request.environment.fixture);
      const url = storybookStoryUrl({
        baseUrl: request.baseUrl,
        storyId: request.target.targetId,
        ...(args ? { args } : {}),
      });
      return captureImplementationTarget(request, url, deps);
    },
  };
}

/** Full-page routes, driven through the same Playwright the e2e suite uses. */
export function createPageRouteCaptureAdapter(deps: CaptureDeps): CaptureAdapter {
  return {
    targetKinds: ['page-route'],
    async capture(request) {
      if (request.target.targetKind !== 'page-route') {
        return refuse(
          'unsupported-input',
          `the page-route capture adapter was handed a ${request.target.targetKind} target ` +
            `('${request.target.targetId}'); use the Storybook adapter`,
        );
      }
      const url = pageRouteUrl(request.baseUrl, request.target.targetId);
      return captureImplementationTarget(request, url, deps);
    },
  };
}
