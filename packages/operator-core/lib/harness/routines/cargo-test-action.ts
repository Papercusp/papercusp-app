/**
 * `system:cargo-test` — run the desktop shell's Rust/cargo native test suite on the
 * same routine cadence as the rest of the test signal, and record its results into
 * `harness_shared.test_runs` (framework='cargo') via `scripts/report-cargo-tests.mjs`.
 *
 * production-test-readiness-2026-07-06 P-009 (WI-3206): ~150-200 cargo `#[test]` fns
 * exist under `papercusp-desktop/src-tauri` (the Tauri shell) but the ledger had ZERO
 * `framework='cargo'` rows — vitest (green-checkpoint's hourly `test:affected`) and
 * playwright both feed the ledger on a routine cadence; the native suite had no
 * equivalent wiring, so a desktop-shell regression was invisible to the Tests tab.
 * `report-cargo-tests.mjs` (the recorder) already existed and works when run by
 * hand — what was missing was a routine that FIRES it periodically. This registers
 * that routine leg.
 *
 * The desktop shell only exists in the operator-home (papercusp) repo, so this
 * self-gates to operator-home installSlugs — a per-hive coding repo has no
 * `papercusp-desktop` directory and must never try to run this suite.
 *
 * Bounded + fail-soft, mirroring green-checkpoint/p2p-perf-actions: a hung `cargo
 * test` is SIGTERM'd (then SIGKILL'd) after CARGO_TEST_TIMEOUT_MS so a wedged
 * compiler can never wedge the routines tick; the recorder script's own DB faults
 * never change cargo's real exit code (D-007, enforced inside the script itself).
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

/** The manifest this routine records (the Tauri shell — WI-3206's named scope).
 *  Other Rust crates in the repo (apps/tui, pui-companion-proto, …) are out of
 *  scope for this WI; a follow-up can extend `MANIFESTS` if their coverage is
 *  wanted in the ledger too. */
const MANIFESTS = ['papercusp-desktop/src-tauri/Cargo.toml'];

/** cargo test (cold-ish, ~150-200 tests) ran ~47s on the dev box when timed by hand;
 *  give it generous headroom for a colder cache / a busier box without letting a
 *  genuinely wedged compiler hang the routines tick indefinitely. */
export const CARGO_TEST_TIMEOUT_MS = 15 * 60_000;

function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

export interface CargoTestRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCargoTestReporter(root: string, manifestRel: string, timeoutMs: number): Promise<CargoTestRunResult> {
  return new Promise((resolvePromise) => {
    const script = path.join(root, 'scripts/report-cargo-tests.mjs');
    // detached ⇒ own process-group leader, so a timeout SIGTERM/SIGKILLs the whole
    // group (node → cargo → rustc/test binaries), never just the wrapper (mirrors
    // release-actions.ts/p2p-perf-actions.ts's runScript/runRunner precedent).
    const child = spawn('node', [script, '--manifest-path', manifestRel], {
      cwd: root,
      env: process.env,
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let escalate: NodeJS.Timeout | null = null;
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };
    const killer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      escalate = setTimeout(() => killTree('SIGKILL'), 15_000);
      escalate.unref();
    }, timeoutMs);
    const finish = (res: CargoTestRunResult): void => {
      clearTimeout(killer);
      if (escalate) clearTimeout(escalate);
      resolvePromise(res);
    };
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => finish({ code: 1, stdout, stderr: stderr + String(e), timedOut }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr, timedOut }));
  });
}

/** The Tauri desktop shell only lives in the operator-home repo — a per-hive coding
 *  repo has no papercusp-desktop tree, so a stray routine there must skip, never
 *  try (and never misreport a per-hive workspace's own state). A blank/undefined
 *  installSlug (e.g. a manual/legacy fire) is treated as operator-home, matching
 *  resolveCheckpointRouting's convention elsewhere in this dir. */
export function shouldSkipForHive(installSlug: string | null | undefined, homeSlug: string): { skip: true; reason: string } | { skip: false } {
  if (installSlug && installSlug !== homeSlug) {
    return { skip: true, reason: `not the operator-home harness (got "${installSlug}", home is "${homeSlug}")` };
  }
  return { skip: false };
}

registerSystemAction('cargo-test', async (ctx: SystemActionCtx) => {
  const gate = shouldSkipForHive(ctx.installSlug, operatorHomeHarnessSlug());
  if (gate.skip) {
    console.log(`[cargo-test] skip: ${gate.reason}`);
    return;
  }
  const root = integrationRoot();
  for (const manifestRel of MANIFESTS) {
    if (!existsSync(path.join(root, manifestRel))) {
      console.warn(`[cargo-test] skip ${manifestRel}: not found under ${root}`);
      continue;
    }
    const r = await runCargoTestReporter(root, manifestRel, CARGO_TEST_TIMEOUT_MS);
    if (r.timedOut) {
      console.warn(`[cargo-test] ${manifestRel}: TIMED OUT after ${CARGO_TEST_TIMEOUT_MS}ms — killed`);
    } else if (r.code !== 0) {
      console.warn(`[cargo-test] ${manifestRel}: exited ${r.code} — ${(r.stderr || r.stdout).slice(-500)}`);
    } else {
      console.log(`[cargo-test] ${manifestRel}: ${(r.stdout || '').trim().split('\n').slice(-1)[0]}`);
    }
  }
});
