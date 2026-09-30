/**
 * Mockup-to-implementation validation: the real Playwright capture driver.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-004).
 *
 * `capture.ts` holds the policy — what a contracted environment means, what
 * counts as a mismatch, what may be refused. This file holds the only part that
 * needs a browser, and it is kept deliberately thin and separate so the policy
 * stays unit-testable without launching Chromium.
 *
 * The engine is `playwright-core`, declared as a direct dependency of
 * operator-core rather than reached through lost-pixel's transitive copy —
 * the difference between a dependency and a borrowed one.
 *
 * CORRECTION (P-008): an earlier version of this comment claimed this was "the
 * same package and the same installed version lost-pixel launches". It is the
 * same package and a DIFFERENT version. lost-pixel pins its own nested
 * playwright-core at 1.47.2 (chromium-1217); the hoisted copy operator-core
 * resolves is 1.59.1 (chromium-1234). Two versions means two browser builds,
 * and any environment that installs only one of them — as CI did until P-008
 * added a second install step — fails to launch this one. A dev box hides that
 * completely, because ~/.cache/ms-playwright accumulates both.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import {
  browserIdentityFromUserAgent,
  canonicalRenderHost,
  type FontMetrics,
} from './render-host';

import type {
  CaptureBrowser,
  CapturePage,
  ObservedEnvironment,
  PageSpec,
  ScreenshotOptions,
  SettleOptions,
  StateDirective,
} from './capture';

/**
 * Two animation frames, which is the cheapest reliable "layout has settled"
 * signal: the first lets pending style/layout work flush, the second confirms
 * nothing scheduled more work off the first.
 */
async function waitForStableFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

class PlaywrightCapturePage implements CapturePage {
  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
  ) {}

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.page.goto(url, { timeout: timeoutMs, waitUntil: 'load' });
  }

  async applyDocumentAttribute(attribute: { name: string; value: string }): Promise<void> {
    await this.page.evaluate(
      ({ name, value }) => {
        document.documentElement.setAttribute(name, value);
      },
      attribute,
    );
  }

  async applyState(directive: StateDirective): Promise<void> {
    switch (directive.kind) {
      case 'none':
        return;
      case 'hover':
        await this.page.hover(directive.selector);
        return;
      case 'focus':
        await this.page.focus(directive.selector);
        return;
      case 'click':
        await this.page.click(directive.selector);
        return;
    }
  }

  async settle(options: SettleOptions): Promise<void> {
    // Network idle is a HINT here, never a precondition, and the bound is the
    // point. This repo's surfaces hold an SSE connection open by design
    // (`@papercusp/sync` uses SSE in every runtime), so a page that is working
    // perfectly may never go idle. Waiting unbounded would fail every capture of
    // a healthy page; not waiting at all would capture mid-fetch. Bounded, then
    // proceed, is the only correct shape — and the environment verification that
    // follows is what actually decides whether the capture is admissible.
    try {
      await this.page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs });
    } catch {
      // Expected on any SSE-backed surface. Deliberately not an error.
    }

    // Fonts must be resolved before the screenshot, or the first paint captures
    // fallback glyphs and every subsequent one captures the real ones — which
    // presents as an unstable capture rather than as the font problem it is.
    await this.page.evaluate(async () => {
      await document.fonts.ready;
    });

    await waitForStableFrames(this.page);
  }

  async observeEnvironment(options: {
    readonly requiredFontFamilies: readonly string[];
    readonly documentAttributeName?: string;
  }): Promise<ObservedEnvironment> {
    const pageFacts = await this.page.evaluate(
      ({ families, attributeName }) => ({
        devicePixelRatio: window.devicePixelRatio,
        prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        documentAttributeValue: attributeName
          ? document.documentElement.getAttribute(attributeName)
          : undefined,
        fontsReady: document.fonts.status === 'loaded',
        // Font availability is measured by METRICS, not asked of
        // `document.fonts.check`.
        //
        // `check()` was the obvious call and it is the wrong instrument: it
        // answers "is there a pending FontFace blocking this family", so for any
        // family that is not a still-loading webfont — including a family that
        // does not exist anywhere — it returns TRUE. Measured against real
        // Chromium: `document.fonts.check('16px "Totally Not Installed Face"')`
        // is `true`. A substitution detector built on it can never fire.
        //
        // What actually answers "will this family change the rendering" is
        // whether it measures differently from the generic it would fall back
        // to. If the family is unavailable, `"Family", monospace` resolves to
        // plain monospace and the widths are identical — and identical against
        // all three generics, which is what makes a false negative require a
        // family metrically identical to monospace AND sans-serif AND serif.
        missingFontFamilies: families.filter((family) => {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (!context) return false;
          const probe = 'mmmmmmmmmmlliWWWW@1234567890';
          const available = ['monospace', 'sans-serif', 'serif'].some((generic) => {
            context.font = `72px ${generic}`;
            const fallbackWidth = context.measureText(probe).width;
            context.font = `72px "${family}", ${generic}`;
            return context.measureText(probe).width !== fallbackWidth;
          });
          return !available;
        }),
        // P-011/D-023: the same instrument, asked one more question.
        //
        // The filter above throws these widths away after comparing them. Kept,
        // they identify the MACHINE: the generics resolve to whatever fonts the
        // host actually has, so two boxes with different font packages measure
        // differently here even though every field of CaptureEnvironment agrees.
        // That is the axis D-021 recorded as unmeasured, and it is the reason a
        // same-host threshold of ~34 pixels cannot be enforced across hosts.
        fontMetrics: Object.fromEntries(
          ['monospace', 'sans-serif', 'serif'].map((generic) => {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (!context) return [generic, 0];
            context.font = `72px ${generic}`;
            return [generic, context.measureText('mmmmmmmmmmlliWWWW@1234567890').width];
          }),
        ),
        userAgent: navigator.userAgent,
      }),
      {
        families: [...options.requiredFontFamilies],
        attributeName: options.documentAttributeName ?? null,
      },
    );

    // Viewport comes from Playwright rather than `window.innerWidth` on purpose:
    // `innerWidth` includes or excludes a scrollbar depending on the platform's
    // scrollbar style, so it produces false mismatches on pages that happen to
    // scroll. This reading catches a context that was never configured; the
    // authoritative geometry check is the produced image's own dimensions,
    // enforced against `expectedDimensions` in `capture.ts`.
    const viewport = this.page.viewportSize();

    return {
      viewport: viewport ?? { width: 0, height: 0 },
      devicePixelRatio: pageFacts.devicePixelRatio,
      prefersDark: pageFacts.prefersDark,
      prefersReducedMotion: pageFacts.prefersReducedMotion,
      ...(options.documentAttributeName
        ? { documentAttributeValue: pageFacts.documentAttributeValue ?? null }
        : {}),
      fontsReady: pageFacts.fontsReady,
      missingFontFamilies: pageFacts.missingFontFamilies,
      renderHost: canonicalRenderHost({
        ...browserIdentityFromUserAgent(pageFacts.userAgent),
        fontMetrics: pageFacts.fontMetrics as FontMetrics,
      }),
    };
  }

  async screenshot(options: ScreenshotOptions): Promise<void> {
    await this.page.screenshot({
      path: options.outputPath,
      fullPage: options.fullPage,
      type: 'png',
      // `animations: 'disabled'` is lost-pixel's own setting
      // (dist/shots/shots.js:107) and it does more than pause: it finishes
      // finite CSS animations and transitions at their end state, so a capture
      // is not a race against a 200ms fade.
      animations: 'disabled',
      // A blinking caret is a two-state capture. `hide` is Playwright's default;
      // it is stated because a default that silently changes would present as
      // flakiness with no obvious cause.
      caret: 'hide',
      // Capture at device pixels, so the image is viewport x deviceScaleFactor.
      // `expectedDimensionsFor` computes that product, and this is the setting
      // that makes the product true rather than aspirational.
      scale: 'device',
    });
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

export interface PlaywrightCaptureBrowser extends CaptureBrowser {
  close(): Promise<void>;
}

/**
 * Launch a headless Chromium and hand back a `CaptureBrowser`.
 *
 * Each capture gets its own context, never a shared one: `deviceScaleFactor`,
 * `colorScheme` and `reducedMotion` are all context-creation options in
 * Playwright and cannot be changed afterwards. A shared context would silently
 * pin every capture in a run to the first one's environment — which would pass
 * the environment check, because the check reads the context it was given.
 */
export async function launchPlaywrightCaptureBrowser(options?: {
  readonly browser?: Browser;
}): Promise<PlaywrightCaptureBrowser> {
  const owned = options?.browser === undefined;
  const browser = options?.browser ?? (await chromium.launch({ headless: true }));

  return {
    browserName: browser.browserType().name(),
    async newPage(spec: PageSpec): Promise<CapturePage> {
      const context = await browser.newContext({
        viewport: { width: spec.viewport.width, height: spec.viewport.height },
        deviceScaleFactor: spec.deviceScaleFactor,
        colorScheme: spec.colorScheme,
        reducedMotion: spec.reducedMotion,
      });
      const page = await context.newPage();
      return new PlaywrightCapturePage(page, context);
    },
    async close(): Promise<void> {
      if (owned) await browser.close();
    },
  };
}
