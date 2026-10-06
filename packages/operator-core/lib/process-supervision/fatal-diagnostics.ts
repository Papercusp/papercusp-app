import { mkdirSync } from 'node:fs';
import { papercuspPath } from '../papercusp-root';

/**
 * WI-3849 follow-up — installFatalDiagnostics: arm Node's built-in diagnostic
 * report on SIGABRT so the NEXT `terminate called after throwing an instance
 * of 'Napi::Error'` crash (WI-3795/WI-3848/WI-3849 — a raw C++ exception
 * escaping a native addon's background thread, below the JS layer where no
 * try/catch here can intervene) writes a full report (native + JS stack,
 * loaded native modules, resource usage) to disk BEFORE the process dies —
 * instead of only a bare `terminate called…` line + an apport coredump that
 * needs a live gdb session and a matching unstripped binary to symbolize.
 *
 * Live forensics on 4 real 2026-07-11 coredumps (apport, `/var/lib/apport/
 * coredump/`) already NARROWED the suspect set: 2 of 4 crashed even with
 * `skipSubstrateTeardown`/`isSaturated` skipping `closeAllBootedHarnesses()`
 * entirely — proving the P2P-substrate close (hyperswarm/hypercore) is NOT
 * the (sole) trigger, contrary to the WI-3795 header doc's original
 * hypothesis. A symbol scan of every native addon actually mapped into the
 * live `papercup-dev-api`/`papercup-staging-api` processes (`/proc/<pid>/
 * maps`) found the P2P stack (sodium-native, udx-native, quickbit-native,
 * rocksdb-native, simdle-native) does NOT even link the `Napi::Error` C++
 * class — it CANNOT be the thrower. Only `sharp`, `onnxruntime-node`, and
 * `@lydell/node-pty` do (confirmed via `nm -D` + `_ZTVN4Napi5ErrorE`/
 * `_ZN4Napi5ErrorD2Ev` symbols), narrowing the real suspects to an in-flight
 * onnxruntime AsyncWorker completion or a node-pty child-exit callback firing
 * as the Node environment tears down. Pinning the EXACT call site needs a
 * live-captured native stack — this function makes that automatic on the
 * next occurrence (this crash recurs ~dozens of times/day under load per the
 * WI-3849 evidence) instead of requiring a deliberately-induced repro.
 *
 * Best-effort + idempotent: never throws (this must not become a NEW crash
 * source), and a second call is a no-op. Safe on any Node build — silently
 * skips if `process.report` isn't present (older/non-standard runtimes).
 */
let fatalDiagnosticsInstalled = false;

/** Test-only reset — never call from production code. */
export function _resetFatalDiagnosticsForTests(): void {
  fatalDiagnosticsInstalled = false;
}

export interface FatalDiagnosticsOpts {
  /** Test seam — defaults to the real `process.report`. */
  report?: {
    directory?: string;
    signal?: string;
    reportOnSignal?: boolean;
    reportOnFatalError?: boolean;
  };
  /** Directory the report is written to. Default: `<papercuspRoot>/crash-reports`. */
  directory?: string;
  /** Test seam — defaults to `mkdirSync` (skipped entirely when `report` is injected). */
  mkdir?: (dir: string) => void;
  /** Test seam — defaults to `console.log`. */
  log?: (msg: string) => void;
}

export function installFatalDiagnostics(opts: FatalDiagnosticsOpts = {}): void {
  if (fatalDiagnosticsInstalled) return;
  try {
    const report =
      opts.report ?? (process as unknown as { report?: FatalDiagnosticsOpts['report'] }).report;
    if (!report) return; // no diagnostic-report support on this Node build — best-effort
    const directory = opts.directory ?? papercuspPath('crash-reports');
    if (!opts.report) {
      // Only touch the real filesystem when arming the real process.report.
      const mkdir = opts.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
      mkdir(directory);
    }
    report.directory = directory;
    report.signal = 'SIGABRT';
    report.reportOnSignal = true;
    report.reportOnFatalError = true;
    fatalDiagnosticsInstalled = true;
    (opts.log ?? ((m: string) => console.log(m)))(
      `[host-recycle] fatal-diagnostics armed (WI-3849) — a native SIGABRT now writes a diagnostic report (native+JS stack, loaded modules) to ${directory} before the process dies`,
    );
  } catch {
    // best-effort — arming diagnostics must never itself crash the host
  }
}
