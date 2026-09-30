/**
 * User-defined hook runner. Mirrors bash's `run_hook <name>`:
 *
 *   - Looks for `<stateDir>/hooks/<name>.sh`
 *   - If executable, runs it with cwd = projectDir and env from caller
 *   - Captures stdout/stderr to `<stateDir>/logs/hooks/<ts>-<name>.log`
 *   - Logs failures but never aborts the mission
 *
 * Used at lifecycle points (pre-worker, post-worker, pre-validator,
 * post-validator, on-smoke-pass, on-smoke-fail, on-competition-start,
 * on-synthesis-won, afterDone). Each hook receives env vars set by the
 * caller — typically ROLE / FEATURE_ID / RC / REASON / TRIGGER.
 *
 * On Windows: the user must have bash on PATH (Git for Windows ships it).
 * The desktop bootstrap UI surfaces this prereq when `bash` isn't found.
 *
 * # Hook context contract (Phase 6)
 *
 * Hooks should never read state from the harness directory's filesystem
 * (`lanes.json`, `escalation.md`, etc) — that data lives in PG and the
 * FS files no longer exist at runtime (PG is canonical; features moved
 * to `harness_features` in Phase 1). Instead, hooks get this
 * auto-injected env:
 *
 *   - `HARNESS_SLUG`     — current harness slug (set when known)
 *   - `WORKSPACE_ID`     — active workspace (RLS-scoped)
 *   - `OPERATOR_BASE`    — base URL for the operator API
 *                          (defaults to http://localhost:3055)
 *   - `PROJECT_DIR`      — same as before
 *   - `STATE_DIR`        — same as before
 *
 * Recommended pattern for hooks that need rich state:
 *
 *   ```bash
 *   # Hook script
 *   features=$(curl -fsS "$OPERATOR_BASE/api/harness/$HARNESS_SLUG/features")
 *   status=$(echo "$features" | jq -r '.[] | select(.id == "'"$FEATURE_ID"'") | .status')
 *   ```
 *
 * No filesystem reads, no fragile JSON parsing of harness files.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface RunHookOptions {
  /** State dir where `hooks/<name>.sh` lives. */
  stateDir: string;
  /** Project dir used as cwd for the hook script. */
  projectDir: string;
  /** Log dir where hook output lands; usually `<stateDir>/logs`. */
  logDir: string;
  /** Env vars to pass to the hook (merged on top of process.env). */
  env: Record<string, string>;
  /** Logger for the orchestrator's run.log. */
  log: (message: string) => void;
  /**
   * Phase 6 context auto-injected as env vars. Hooks consume these to
   * query operator/PG instead of reading harness FS state.
   *   - harnessSlug → HARNESS_SLUG
   *   - workspaceId → WORKSPACE_ID
   *   - operatorBase → OPERATOR_BASE (defaults to env or http://localhost:3055)
   */
  harnessSlug?: string;
  workspaceId?: string;
  operatorBase?: string;
}

export interface RunHookResult {
  /** Whether a hook was run (false = no script, no script-not-executable). */
  ran: boolean;
  /** Exit code if ran. Undefined if not. */
  exitCode?: number;
  /** Path to the hook log file if ran. */
  logfile?: string;
}

export function runHook(hookName: string, opts: RunHookOptions): RunHookResult {
  const script = join(opts.stateDir, 'hooks', `${hookName}.sh`);
  if (!isExecutable(script)) {
    return { ran: false };
  }

  const hookLogDir = join(opts.logDir, 'hooks');
  if (!existsSync(hookLogDir)) {
    mkdirSync(hookLogDir, { recursive: true });
  }
  const ts = Math.floor(Date.now() / 1000);
  const logfile = join(hookLogDir, `${ts}-${hookName}.log`);
  writeFileSync(logfile, ''); // truncate

  opts.log(`HOOK ${hookName} running (log: ${logfile})`);

  // Phase 6 auto-inject — hooks need these to query operator/PG instead
  // of reading harness FS state. Caller's explicit env wins on conflict
  // (e.g. a caller that overrides HARNESS_SLUG for some test scenario).
  // harnessSlug defaults to basename(projectDir) when not provided —
  // matches the harness-slug convention used everywhere else.
  const injected: Record<string, string> = {};
  injected.HARNESS_SLUG = opts.harnessSlug ?? basenameOf(opts.projectDir);
  if (opts.workspaceId) injected.WORKSPACE_ID = opts.workspaceId;
  injected.OPERATOR_BASE =
    opts.operatorBase ??
    process.env.PAPERCUSP_OPERATOR_BASE ??
    // The operator API serves :3070; :3055 is the Vite content port with no
    // /api routes (EI-113 wrong-stack default, fixed with audit P-038).
    'http://localhost:3070';

  const result = spawnSync(script, [], {
    cwd: opts.projectDir,
    env: { ...process.env, ...injected, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Append both streams to the hook log file (combined, like bash 2>&1).
  if (result.stdout) appendFileSync(logfile, result.stdout);
  if (result.stderr) appendFileSync(logfile, result.stderr);

  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    opts.log(`  HOOK ${hookName} failed rc=${exitCode} — continuing (see ${logfile})`);
  }
  return { ran: true, exitCode, logfile };
}

function basenameOf(p: string): string {
  // Cross-platform basename without importing path (keeps the module
  // tree-shakable + avoids circular dep with state.ts).
  const m = p.replace(/[/\\]+$/, '').match(/[^/\\]+$/);
  return m ? m[0] : p;
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    // Owner-execute bit. Node doesn't expose access(X_OK) sync-friendly; bit
    // mask is the safest cross-platform check.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
