// Shared-host Vitest worker cap (WI-3792 follow-up; extracted + widened WI-5621).
//
// Vitest defaults each suite's fork pool to EVERY core. On the shared 128-core
// dev box that means ONE full-suite run spawns ~128 workers — and the gate,
// peers' runs, and agent sessions routinely overlap, so a handful of concurrent
// suites put hundreds of runnable tasks on the host (loadavg 60-100+ observed;
// the box has melted under this more than once). `scripts/affected-tests.mjs`
// capped itself at `min(32, max(8, cores/4))` for this reason (WI-3792), but
// `scripts/test-files.mjs` — the far more frequently invoked single/few-file
// runner every agent is told to prefer (CLAUDE.md "Tests after editing") — never
// got the same cap and ran every invocation at Vitest's uncapped default. On a
// ~90-agent fleet where `test:file` is the default quick-verify command, that is
// the dominant source of the concurrent-fork pile-up (WI-5621): dozens of
// concurrent `test:file` calls each free to grab up to ~127 workers.
//
// This module is the ONE place both runners get their cap from, so the fix
// (and any future tuning) lives in one spot instead of drifting between two
// copies. `computeWorkerCap` is a pure function (unit-testable without spawning
// a subprocess or stubbing `os.loadavg`); `applyWorkerCapEnv` is the side-effecting
// call site each script uses at startup.

// scripts/affected-tests.mjs's own pre-existing flake-absorber (EI-9103) already
// treats `load1 > 40` as "this 128-core box is loaded enough to plausibly flake
// tests" — an empirically-tuned number, not derived from the core count. Express
// the adaptive-shrink activation line as the SAME ratio (40/128 ≈ 0.3125) so it
// kicks in at the load level this codebase has already observed causing real
// flakiness, rather than waiting until load1 exceeds the full core count (which
// the WI-5621 incident's own reported loadavg of 58-105 on 128 cores never did —
// a naive "load1 > cores" line would have left this fix inert for the exact
// incident it exists to address).
const OVERSUBSCRIBED_AT_RATIO = 0.3125;

/**
 * @param {{ cores: number, load1?: number }} input
 *   `cores` — availableParallelism() (or equivalent). `load1` — the 1-minute
 *   loadavg, when known; omit to skip the adaptive-shrink term (matches the
 *   original static formula).
 * @returns {number} the worker/fork/thread cap to apply
 */
export function computeWorkerCap({ cores, load1 }) {
  const base = Math.min(32, Math.max(8, Math.floor(cores / 4)));
  const threshold = cores * OVERSUBSCRIBED_AT_RATIO;
  if (typeof load1 !== 'number' || !Number.isFinite(load1) || load1 <= threshold) {
    // Load not known, or the host isn't yet at the empirically-flaky level —
    // the static per-suite cap (proven safe since WI-3792) is unchanged.
    return base;
  }
  // The host is ALREADY at (or past) the load level known to cause test
  // flakiness on this box (other concurrent test:affected/test:file
  // invocations, the fleet's agent processes, etc). A NEW run piling on the
  // full static cap just adds fuel — shrink proportionally to how far past
  // that line we already are, floored at 4 (a suite must still get at least a
  // few workers to make forward progress; below that, wall-clock blows up
  // worse than the contention it avoids).
  const oversubscription = load1 / threshold; // > 1 by construction here
  const shrunk = Math.floor(base / oversubscription);
  return Math.max(4, shrunk);
}

/**
 * Sets VITEST_MAX_WORKERS/FORKS/THREADS from `computeWorkerCap`, unless the
 * caller (or a wrapping script) already set one — never overrides an explicit
 * choice. Returns the cap actually in effect (existing env value or the one
 * just computed), for logging.
 * @param {{ cores: number, load1?: number, env?: NodeJS.ProcessEnv }} input
 */
export function applyWorkerCapEnv({ cores, load1, env = process.env }) {
  if (env.VITEST_MAX_WORKERS) return env.VITEST_MAX_WORKERS;
  const cap = String(computeWorkerCap({ cores, load1 }));
  env.VITEST_MAX_WORKERS = cap;
  if (!env.VITEST_MAX_FORKS) env.VITEST_MAX_FORKS = cap;
  if (!env.VITEST_MAX_THREADS) env.VITEST_MAX_THREADS = cap;
  return cap;
}
