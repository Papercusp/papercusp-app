/**
 * `system:gate-watcher-tick` — the cadence wrapper for the client-agnostic
 * session-gate transcript watcher (owner-inbox-single-pane-2026-07-17 P-002;
 * design + idempotency model in `gate-watch.ts`).
 *
 * Runs as ONE durable step (the system-actions contract) — safe to re-run:
 * every file delta is fenced by its own byte watermark (session_gate_watcher_files).
 *
 * Config (routine `trigger_config`, all optional):
 *   - `roots`     — transcript roots (JSON array, or comma-separated string).
 *                   Default: the psu root AND the native `~/.claude/projects`
 *                   — see `defaultGateWatchRoots`, WI-10002079/R1.
 *   - `root`      — single-root override, kept for back-compat; when set it
 *                   REPLACES the defaults.
 *   - `max_files` — per-tick file BUDGET (default 5000). Files already at
 *                   their watermark do not consume it; a tick that hits it
 *                   resumes from the same place next tick.
 *   - `cold_start_open_window_ms` — a FIRST-SEEN transcript last written
 *                   longer ago than this is replayed for closes only, never
 *                   minting a gate from dead history (default 24h; R3).
 */
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { tickGateWatch } from './gate-watch';
import { sweepSessionIndependentGates } from './gate-reaper';

registerSystemAction('gate-watcher-tick', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const maxFiles = Number(cfg.max_files);
  const result = await tickGateWatch({
    roots: readRoots(cfg.roots),
    root: typeof cfg.root === 'string' && cfg.root.length > 0 ? cfg.root : undefined,
    maxFilesPerTick: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : undefined,
    coldStartOpenWindowMs: readPositiveMs(cfg.cold_start_open_window_ms),
  });
  console.log(
    `[gate-watch] scanned ${result.scannedFiles} transcript(s) under ${result.roots.length} root(s) → ` +
      `${result.opened} opened, ${result.alreadyOpen} already-open, ${result.closed} closed` +
      (result.coldStartSkippedOpens
        ? `, ${result.coldStartSkippedOpens} cold-start open(s) suppressed`
        : '') +
      (result.budgetExhausted ? ', BUDGET EXHAUSTED — more remain for next tick' : '') +
      (result.errors.length ? `, ${result.errors.length} error(s)` : ''),
  );
  for (const e of result.errors.slice(0, 5)) console.warn(`[gate-watch]   ! ${e.file}: ${e.error}`);

  // WI-10002067: the SESSION-INDEPENDENT half. The watcher above can only ever
  // close a gate whose asking session is alive to be observed, which is why 241
  // gates had accumulated with no code path able to discharge them. This runs
  // inside the existing handler deliberately — the brief forbids a new routine,
  // and the repo's scheduling rule bans adding a third mechanism.
  //
  // Isolated in its own try/catch because it is ADDITIVE: it requires migration
  // 1185's columns, so on a host where that has not been applied yet it must
  // degrade to a logged warning rather than take the transcript watcher — which
  // predates it and is independently useful — down with it.
  try {
    const swept = await sweepSessionIndependentGates({
      unknownGoneAfterMs: readPositiveMs(cfg.unknown_gone_after_ms),
      limit: readPositiveMs(cfg.sweep_limit),
    });
    console.log(
      `[gate-reaper] examined ${swept.examined} open gate(s) → ${swept.closedAskerGone} asker_gone, ` +
        `${swept.closedDefaultApplied} default_applied; skipped ` +
        `${swept.skipped['asker-live']} live / ${swept.skipped['asker-unknown-within-grace']} within-grace` +
        (swept.truncatedByLimit ? ' — TRUNCATED BY LIMIT, more remain' : ''),
    );
  } catch (err) {
    console.warn(`[gate-reaper]   ! sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/** `undefined` for anything not a usable positive number, so the callee's own
 *  default applies rather than a NaN silently disabling a bound. */
function readPositiveMs(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Transcript roots from `trigger_config`: a JSON array, or a comma-separated
 *  string for hand-edited config. `undefined` (never `[]`) when nothing usable
 *  is configured, so `tickGateWatch` falls back to its own defaults rather
 *  than being handed an empty list that would silently scan nothing. */
function readRoots(raw: unknown): string[] | undefined {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const roots = parts.filter((r): r is string => typeof r === 'string').map((r) => r.trim()).filter(Boolean);
  return roots.length ? roots : undefined;
}
