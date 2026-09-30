#!/usr/bin/env node
/**
 * chaos-runner.mjs — the browser variant of `chaos` (P-004 of
 * testing-shell-platform-variants-2026-06-01).
 *
 * Mirrors the desktop chaos (which drives the Tauri shell externally) and the
 * `ai` Stagehand-runner: a headless-Chromium subprocess that loads a base URL
 * and autonomously clicks visible interactive elements for N steps, capturing
 * console errors / page errors / crashes / dialogs, emitting NDJSON progress
 * on stdout. A per-host SSE route spawns this and relays the NDJSON.
 *
 * Usage:  node chaos-runner.mjs <baseUrl> <maxSteps>
 *   env:  CHAOS_BASE_URL, CHAOS_MAX_STEPS
 *
 * Playwright is imported dynamically inside main() so this module can be
 * imported for its pure helpers (tests) without a browser or the dep present.
 */

/** Serialize one event as a single NDJSON line. Pure. */
export function formatEvent(evt) {
  return JSON.stringify(evt) + '\n';
}

/** Bound a requested step count to [1, max]; NaN/≤0 → 1. Pure. */
export function clampSteps(n, max = 200) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, max);
}

/** Map a [0,1) value to a valid index over `len`; -1 when empty. Pure. */
export function pickIndex(len, rnd) {
  if (len <= 0) return -1;
  return Math.min(len - 1, Math.floor(rnd * len));
}

async function main() {
  const emit = (evt) => process.stdout.write(formatEvent(evt));
  const baseUrl = process.env.CHAOS_BASE_URL || process.argv[2] || 'http://127.0.0.1:3000/';
  const maxSteps = clampSteps(process.env.CHAOS_MAX_STEPS || process.argv[3] || 25);

  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    page.on('console', (m) => {
      if (m.type() === 'error') emit({ type: 'console', level: 'error', text: m.text() });
    });
    page.on('pageerror', (e) => emit({ type: 'pageerror', message: String(e?.message ?? e) }));
    page.on('crash', () => emit({ type: 'crash' }));
    page.on('dialog', async (d) => {
      emit({ type: 'dialog', message: d.message() });
      await d.dismiss().catch(() => {});
    });

    emit({ type: 'start', baseUrl, maxSteps });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    let clicks = 0;
    for (let n = 1; n <= maxSteps; n++) {
      const handles = await page.$$('a[href], button, [role="button"], input:not([type=hidden]), select, [onclick]');
      const visible = [];
      for (const h of handles) {
        if (await h.isVisible().catch(() => false)) visible.push(h);
      }
      const idx = pickIndex(visible.length, Math.random());
      if (idx < 0) {
        emit({ type: 'step', n, action: 'noop', ok: true, note: 'no clickable elements' });
        break;
      }
      const el = visible[idx];
      let ok = true;
      let target = '';
      try {
        target = ((await el.innerText().catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim().slice(0, 40);
        await el.click({ timeout: 2_000 });
        clicks++;
      } catch (e) {
        ok = false;
        target = String(e?.message ?? e).slice(0, 80);
      }
      emit({ type: 'step', n, action: 'click', ok, target });
      await page.waitForTimeout(150);
    }

    emit({ type: 'done', steps: maxSteps, clicks });
    await browser.close();
    process.exit(0);
  } catch (err) {
    emit({ type: 'error', message: String(err?.message ?? err) });
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}

// Run only when executed directly — not when imported for the pure helpers.
const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
if (argv1.endsWith('chaos-runner.mjs')) {
  void main();
}
