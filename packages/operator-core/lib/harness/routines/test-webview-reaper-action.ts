/**
 * `system:test-webview-reaper` — reap leaked agent-spawned Tauri/WebKit desktops
 * and surface zombie-pile warnings.
 *
 * Plan: infra-perf-reliability-audit-round3-2026-06-19 P-013 / WI-345 (F12).
 *
 * E2E / UI-verification test runs fork `papercusp-desktop` (and similar Tauri
 * builds) and never clean them up when the test finishes. Those desktops leave
 * WebKitWebProcess children pegged at ~99% CPU for hours, saturating the host and
 * starving the operator event loop (the F12/F1 root cause).
 *
 * This action does two things per tick:
 *
 *  1. DETECTION (always): scan /proc for Playwright/headless-marker browsers and
 *     a zombie pile; emit a toast if the threshold is met so the operator can
 *     inspect. Read-only, never-throws.
 *
 *  2. KILL (flag-gated on FLAGS.TEST_WEBVIEW_REAPER, default ON):
 *     find papercusp-desktop processes whose PAPERCUSP_ADV_SESSION_ID points to
 *     an ENDED adv_session row (≥2 min old), SIGTERM → 3-second grace → SIGKILL
 *     them AND their WebKitWebProcess children. Per-process errors are isolated
 *     (never-throws). dryRun=true logs without signalling.
 *
 * DOUBLE-GATED:
 *  - The flag defaults ON (no-op if you flip it OFF).
 *  - The routine is seeded INACTIVE — the kill never fires until an operator
 *    activates it via the routines admin (or `seed-test-webview-reaper-routine.ts
 *    --active`), typically after reviewing dry-run output first.
 *
 * Config knobs (routine `trigger_config`, all optional):
 *   - `dry_run` (boolean, default false) — detect + log but kill nothing.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { runTestDesktopReaperOnce, killDesktopProcsWithEndedSessions } from '../../test-desktop-reaper';

registerSystemAction('test-webview-reaper', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;

  // ── Slice 1: detection (toast notification, always on) ─────────────────────
  let detection: { sampled: number; candidates: number; alarmed: boolean } = {
    sampled: 0,
    candidates: 0,
    alarmed: false,
  };
  try {
    const r = await runTestDesktopReaperOnce();
    detection = { sampled: r.sampled, candidates: r.candidates.length, alarmed: r.alarmed };
  } catch (err) {
    console.warn(`[test-webview-reaper] detection pass failed (non-fatal): ${(err as Error)?.message ?? err}`);
  }
  console.log(
    `[test-webview-reaper] detection: ${detection.sampled} proc(s) scanned, ` +
      `${detection.candidates} candidate(s), alarmed=${detection.alarmed}`,
  );

  // ── Slice 2: adv-session-based kill (flag-gated) ───────────────────────────
  const flagOn = await getFlag(FLAGS.TEST_WEBVIEW_REAPER, 'system').catch(() => false);
  if (!flagOn) {
    console.log(
      '[test-webview-reaper] kill disabled (papercusp-test-webview-reaper flag OFF) — detection-only mode',
    );
    return;
  }

  const kill = await killDesktopProcsWithEndedSessions({ dryRun });
  console.log(
    `[test-webview-reaper] kill: ${kill.scanned} desktop(s) scanned → ` +
      `${kill.dryRun ? 'WOULD kill' : 'killed'} ${kill.killed.length} leaked instance(s)` +
      (kill.killed.length ? ` [pids: ${kill.killed.slice(0, 20).join(',')}${kill.killed.length > 20 ? ',…' : ''}]` : '') +
      (kill.skipped.length ? ` (${kill.skipped.length} skipped — session still open or too fresh)` : ''),
  );
});
