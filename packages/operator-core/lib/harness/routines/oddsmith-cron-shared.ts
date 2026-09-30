/**
 * Shared helpers for the oddsmith cron→routine migration
 * (scheduling-and-liveness-source-of-truth-2026-08-31 P-005).
 *
 * WHY THIS EXISTS: three Unix crontab entries (paper-trading feed, error-triage
 * ingest, error-triage autofix — see `apps/desktop/scripts/{paper,error-triage}
 * -cron.sh` in the oddsmith repo) ran outside DBOS entirely, invisible to the
 * routines pause/status/liveness machinery (`routines:list`, the improvement-
 * watchdog's `routine-failure` collector, the Agents pane). Each cron wrapper had
 * ALSO hand-rolled its own consecutive-failure alarm (`cron-alarm.sh`) because the
 * routines engine's OWN failure tracking (a thrown system-action handler writes
 * `routines.metadata.last_error`/`last_error_at` — see `routines-workflow.ts`)
 * was unreachable from a bare crontab line. Moving execution INTO a
 * `system:<action>` handler makes that hand-rolled alarm redundant: throwing on a
 * real failure is now sufficient, and the routines engine's generic bookkeeping
 * (visible via `routines:list`'s `health`/`metadata` and consumed by the
 * improvement-watchdog) replaces the `~/.oddsmith` streak-counter file entirely.
 *
 * These three actions therefore do LESS than the shell scripts they replace —
 * they run the same underlying npm command in the same repo with the same
 * tunables, and let a genuine failure propagate as a thrown error instead of
 * writing to a bespoke error_events streak file.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { collectChildOutput } from '../../child-output';
import { resolveHarnessPaths } from '../../resolve-harness-paths';

/** The oddsmith harness slug these routines are scoped to (override for tests). */
export const ODDSMITH_HARNESS_SLUG = process.env.ODDSMITH_CRON_HARNESS_SLUG ?? 'oddsmith';

/** Default embedded-pg coordinates for the oddsmith app's OWN database (distinct
 *  from papercusp's own `harness_shared` schema) — mirrors error-triage-cron.sh. */
const DEFAULT_ODDSMITH_PG_HOST = 'localhost';
const DEFAULT_ODDSMITH_PG_PORT = 5544;

/**
 * A routine row fired against the wrong install_slug (a stray manual fire, a
 * misconfigured seed) must skip cleanly rather than run oddsmith's npm scripts
 * against whatever repo the caller happens to be in. Mirrors
 * `cargo-test-action.ts`'s `shouldSkipForHive`.
 */
export function shouldSkipForOddsmith(installSlug: string | null | undefined): { skip: true; reason: string } | { skip: false } {
  if (installSlug && installSlug !== ODDSMITH_HARNESS_SLUG) {
    return { skip: true, reason: `not the oddsmith harness (got "${installSlug}", expected "${ODDSMITH_HARNESS_SLUG}")` };
  }
  return { skip: false };
}

/**
 * Resolve the oddsmith repo checkout root from the harness registry (PG-canonical
 * — never a hardcoded path). Throws when the harness cannot be resolved or the
 * checkout is missing on disk, since a routine row scoped to `oddsmith` firing
 * with no resolvable checkout is a real misconfiguration worth surfacing via
 * `routines.metadata.last_error`, not a silent skip.
 */
export async function resolveOddsmithRoot(workspaceId: string): Promise<string> {
  const { projectDir } = await resolveHarnessPaths(ODDSMITH_HARNESS_SLUG, workspaceId);
  if (!projectDir || projectDir.startsWith('/tmp/papercusp-unresolved/') || !existsSync(projectDir)) {
    throw new Error(`oddsmith harness "${ODDSMITH_HARNESS_SLUG}" did not resolve to a real checkout (got "${projectDir}")`);
  }
  return projectDir;
}

/**
 * The oddsmith app's own embedded-pg URL, built the same way error-triage-cron.sh
 * builds it (env override, else the fixed local sidecar coordinates). This is a
 * SEPARATE database from papercusp's `harness_shared` schema.
 */
export function oddsmithDatabaseUrl(): string {
  if (process.env.ODDSMITH_DATABASE_URL) return process.env.ODDSMITH_DATABASE_URL;
  const host = process.env.ODDSMITH_PG_HOST ?? DEFAULT_ODDSMITH_PG_HOST;
  const port = process.env.ODDSMITH_PG_PORT ?? String(DEFAULT_ODDSMITH_PG_PORT);
  return `postgresql://oddsmith_admin:oddsmith_admin_pwd@${host}:${port}/oddsmith`;
}

/**
 * Best-effort TCP reachability probe for oddsmith's embedded pg sidecar. The
 * sidecar is frequently down in exactly the states worth alarming on for OTHER
 * reasons (its own watchdog's job) — error-triage-cron.sh deliberately treats an
 * unreachable DB as a clean skip rather than a triage failure, so a sidecar
 * outage never masquerades as this routine being broken. Mirrored here.
 */
export function probeOddsmithPgReachable(timeoutMs = 2000): Promise<boolean> {
  const host = process.env.ODDSMITH_PG_HOST ?? DEFAULT_ODDSMITH_PG_HOST;
  const port = Number(process.env.ODDSMITH_PG_PORT ?? DEFAULT_ODDSMITH_PG_PORT);
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a command (detached process-group leader) with a hard wall-clock bound,
 * SIGTERM then SIGKILL on timeout, killing the whole tree — mirrors
 * `cargo-test-action.ts`'s `runCargoTestReporter` so a wedged npm/claude child
 * can never wedge the routines tick indefinitely.
 */
export function runBounded(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true });
    // Boundary-safe accumulation: a multi-byte UTF-8 character split across two
    // 'data' events decodes to replacement characters under `d.toString()`.
    const out = collectChildOutput(child);
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
    }, opts.timeoutMs);
    const finish = (res: RunResult): void => {
      clearTimeout(killer);
      if (escalate) clearTimeout(escalate);
      resolvePromise(res);
    };
    child.on('error', (e) =>
      finish({
        code: 1,
        stdout: out.stdout.text(),
        stderr: out.stderr.text() + String(e),
        timedOut,
      }),
    );
    child.on('close', (code) =>
      finish({ code: code ?? 1, stdout: out.stdout.text(), stderr: out.stderr.text(), timedOut }),
    );
  });
}

/** Throw with a bounded, human-readable message when a bounded run failed. */
export function assertRunOk(label: string, r: RunResult): void {
  if (r.timedOut) {
    throw new Error(`${label}: TIMED OUT — killed`);
  }
  if (r.code !== 0) {
    throw new Error(`${label}: exited ${r.code} — ${(r.stderr || r.stdout).slice(-500)}`);
  }
}
