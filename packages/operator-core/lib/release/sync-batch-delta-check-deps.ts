/**
 * `sync-batch-delta-check-deps.ts` — the IO binding for the pure sync-batch delta
 * check (`./sync-batch-delta-check.ts`, gate-verdict-liveness P-012).
 *
 * Same split as `frozen-candidate-drift-sweep.ts` / its action: every DECISION is
 * pure and unit-tested in the sibling module against `SyncBatchDeltaDeps` fakes;
 * this module is the one place those seams touch git, the runner scripts, the
 * routine's own metadata row and the work-item store. Keep logic OUT of here —
 * a lambda that decides something in this file is invisible to the tests
 * (EI-21559794492221235).
 *
 * Every subprocess is bounded (an execFile timeout) and every failure resolves to
 * the deps contract's "could not measure" value (`null` / `ok:false`), never to a
 * fake green — the pure runner treats those as skip-and-hold-cursor.
 *
 * ⛔ EVERY subprocess leg here MUST stay async — never `spawnSync`/`execFileSync`
 * (WI-10001771). This module runs inside bg-host, which also serves :3271 and the
 * DBOS routine engine on the SAME event loop. `spawnSync` pumps its child on a
 * NESTED uv loop, so the main thread parks in one `epoll_pwait` for the child's
 * whole lifetime: the outer loop's timers stop, the listening socket is never
 * polled, and :3271 answers nothing. Bounding the CHILD's lifetime does not help —
 * that was the original (wrong) reasoning here. Measured 2026-09-17: the
 * `runAffected` leg's 25-minute budget became a 25-minute `epoll_pwait` timeout
 * (strace arg `0x16e1ae` = 1,499,566 ms), bg-host served :3271 for ~4s per boot,
 * its own watchdog SIGKILLed it at 184s, and the restart re-derived the same
 * commit and blocked again — a self-perpetuating loop that took the routine engine
 * down fleet-wide (~108 routines overdue) until the routine was deactivated.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import { createOneWorkItem } from '../agent-tools/work_items/_create-core';
import {
  parseAffectedProbe,
  parseFailingFilesLine,
  parseLoadavg1,
  parseSyncBatches,
  parseTscFailingFiles,
  type ConfirmVerdict,
  type LoadReading,
  type RadiusProbe,
  type RedFinding,
  type SyncBatch,
  type SyncBatchDeltaDeps,
  type SyncDeltaCursor,
} from './sync-batch-delta-check';

/** The `harness_shared.routines.name` whose metadata row carries the durable cursor
 *  (`metadata.sync_delta`) — the same row the seed script upserts. */
export const SYNC_DELTA_ROUTINE_NAME = 'sync-batch-delta-check';

/** Per-leg subprocess budgets. Generous for a quiet box, but bounded so a wedged
 *  child can never wedge the routines tick past the action's own deadline. */
export const SYNC_DELTA_TIMEOUTS_MS = {
  git: 60_000,
  procGuard: 30_000,
  /** `--print-affected` is an enumeration — no test execution. */
  probe: 5 * 60_000,
  /** The actual affected run, already capped at maxWorkspaces=3. */
  affected: 25 * 60_000,
  tsc: 10 * 60_000,
  /** One file in its own invocation. */
  confirm: 10 * 60_000,
} as const;

/** SGR escapes, built without a raw control byte in source (`lint:no-control-bytes`
 *  is a green-checkpoint leg — EI-19478121013052934). */
const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export interface SyncBatchDeltaDepsConfig {
  /** Harness slug — the routine row's `install_slug`, and the harness reds file under. */
  installSlug: string;
  /** Workspace the filed work-items belong to. */
  workspaceId: string;
  /** Repo root the git/script legs run in. */
  root: string;
  /** Integration branch (`staging` here). */
  branch: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const execFileAsync = promisify(execFile);

/** argv spawn, never a shell string. ASYNC by contract — see the ⛔ note in the module
 *  header; a sync variant here wedges bg-host's shared event loop. `null` = the spawn
 *  itself could not be measured (ENOENT, timeout kill, …) — callers map that to their
 *  contract's undetermined value.
 *
 *  `execFile` REJECTS on a non-zero exit, but a non-zero exit is a MEASUREMENT here
 *  (a red), not a failure to measure. So the catch splits them the same way the old
 *  `spawnSync` branch did: a numeric `code` on a child that was not killed is a real
 *  exit status; ENOENT (string code) and a timeout/signal kill (`killed`) are `null`. */
async function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<RunResult | null> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs,
      killSignal: 'SIGTERM',
    });
    return { status: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
    if (typeof e.code === 'number' && e.killed !== true) {
      return { status: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
    return null;
  }
}

function stripSgr(s: string): string {
  return s.replace(SGR_RE, '');
}

/** Parse the router's terminal `TEST_FILE_RESULT … status=…` line. Contract (root
 *  CLAUDE.md + the pure module's header): an ABSENT line or `matched=0` is `null`
 *  (undetermined), never `false` — a batch/collection abort must not read as a red. */
export function parseConfirmOutput(text: string): ConfirmVerdict {
  let line: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = stripSgr(raw);
    if (/^\s*TEST_FILE_RESULT\s/.test(l)) line = l; // keep the LAST terminal line
  }
  if (!line) return null;
  if (/\bmatched=0\b/.test(line)) return null;
  const m = /\bstatus=([A-Za-z-]+)/.exec(line);
  if (!m?.[1]) return null;
  if (m[1] === 'passed' || m[1] === 'pass') return true;
  if (m[1] === 'failed' || m[1] === 'fail' || m[1] === 'error') return false;
  return null;
}

/** Bind `SyncBatchDeltaDeps` to the real box. Pure module decides; this executes. */
export function buildSyncBatchDeltaDeps(cfg: SyncBatchDeltaDepsConfig): SyncBatchDeltaDeps {
  const script = (rel: string): string => path.join(cfg.root, rel);

  return {
    async readCursor(): Promise<SyncDeltaCursor | null> {
      const { sql } = getOrgPg();
      const rows = await sql`
        SELECT metadata->'sync_delta' AS sync_delta
          FROM harness_shared.routines
         WHERE install_slug = ${cfg.installSlug} AND name = ${SYNC_DELTA_ROUTINE_NAME}
         LIMIT 1`;
      const raw: unknown = rows[0]?.sync_delta;
      if (!raw || typeof raw !== 'object') return null;
      const c = raw as Partial<SyncDeltaCursor>;
      if (typeof c.sha !== 'string' || c.sha.length === 0) return null;
      return c as SyncDeltaCursor;
    },

    async writeCursor(next: SyncDeltaCursor): Promise<void> {
      // Scoped merge that leaves sibling metadata keys alone — the
      // `dead-target-sweep.ts` stampHealth precedent, one level up (the whole
      // `sync_delta` object IS this check's state, so replacing it is correct).
      const { sql } = getOrgPg();
      const json = JSON.stringify(next);
      await sql`
        UPDATE harness_shared.routines
           SET metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object('sync_delta', ${json}::text::jsonb)
         WHERE install_slug = ${cfg.installSlug} AND name = ${SYNC_DELTA_ROUTINE_NAME}`;
    },

    hostLoad(): LoadReading | null {
      try {
        const load1 = parseLoadavg1(readFileSync('/proc/loadavg', 'utf8'));
        if (load1 === null) return null;
        const cores = os.cpus().length;
        if (!(cores > 0)) return null;
        return { load1, cores };
      } catch {
        return null;
      }
    },

    async greenCheckpointRunning(): Promise<boolean | null> {
      // proc-guard excludes the caller's own ancestor chain, so this cannot
      // self-match (root CLAUDE.md's pattern-poll trap). exit 0 = running,
      // 1 = not running, 2/other = usage error ⇒ undetectable.
      const r = await run('node', [script('scripts/proc-guard.mjs'), 'check', 'green-checkpoint'], {
        cwd: cfg.root,
        timeoutMs: SYNC_DELTA_TIMEOUTS_MS.procGuard,
      });
      if (!r) return null;
      if (r.status === 0) return true;
      if (r.status === 1) return false;
      return null;
    },

    async headSha(): Promise<string | null> {
      const r = await run('git', ['-C', cfg.root, 'rev-parse', cfg.branch], {
        cwd: cfg.root,
        timeoutMs: SYNC_DELTA_TIMEOUTS_MS.git,
      });
      if (!r || r.status !== 0) return null;
      const sha = r.stdout.trim();
      return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
    },

    async listBatches(sinceSha: string): Promise<SyncBatch[] | null> {
      const r = await run(
        'git',
        [
          '-C',
          cfg.root,
          'log',
          `${sinceSha}..${cfg.branch}`,
          '--no-merges',
          '--name-only',
          '--format=%x00%H %ct%n%(trailers:key=Papercusp-Agent)',
        ],
        { cwd: cfg.root, timeoutMs: SYNC_DELTA_TIMEOUTS_MS.git },
      );
      if (!r || r.status !== 0) return null;
      return parseSyncBatches(r.stdout);
    },

    async probeRadius(paths: readonly string[]): Promise<RadiusProbe | null> {
      const r = await run(
        'node',
        [script('scripts/affected-tests.mjs'), '--changed-paths', paths.join(','), '--print-affected'],
        { cwd: cfg.root, timeoutMs: SYNC_DELTA_TIMEOUTS_MS.probe },
      );
      if (!r || r.status !== 0) return null;
      return parseAffectedProbe(r.stdout);
    },

    async runAffected(
      paths: readonly string[],
    ): Promise<{ ok: boolean; failing: ReturnType<typeof parseFailingFilesLine> }> {
      const r = await run('node', [script('scripts/affected-tests.mjs'), '--changed-paths', paths.join(',')], {
        cwd: cfg.root,
        timeoutMs: SYNC_DELTA_TIMEOUTS_MS.affected,
      });
      // Unmeasurable spawn ⇒ red-with-no-break-set: the runner treats that as
      // UNDETERMINED and holds the cursor, which is the failure direction we want.
      if (!r) return { ok: false, failing: null };
      if (r.status === 0) return { ok: true, failing: [] };
      return { ok: false, failing: parseFailingFilesLine(`${r.stdout}\n${r.stderr}`) };
    },

    async runTsc(files: readonly string[]): Promise<{ ok: boolean; failing: string[] }> {
      const r = await run('node', [script('scripts/lint-tsc.mjs'), `--files=${files.join(',')}`], {
        cwd: cfg.root,
        timeoutMs: SYNC_DELTA_TIMEOUTS_MS.tsc,
      });
      // Unmeasurable ⇒ ok:false with zero named files: files nothing, reds nothing.
      if (!r) return { ok: false, failing: [] };
      if (r.status === 0) return { ok: true, failing: [] };
      return { ok: false, failing: parseTscFailingFiles(`${r.stdout}\n${r.stderr}`) };
    },

    async confirmOne(file: string): Promise<ConfirmVerdict> {
      const r = await run('node', [script('scripts/test-files.mjs'), file], {
        cwd: cfg.root,
        timeoutMs: SYNC_DELTA_TIMEOUTS_MS.confirm,
      });
      if (!r) return null;
      return parseConfirmOutput(`${r.stdout}\n${r.stderr}`);
    },

    async fileRed(finding: RedFinding): Promise<{ ok: boolean; id?: string; adopted?: boolean; error?: string }> {
      try {
        const res = await createOneWorkItem(
          {
            kind: 'bug',
            severity: 'major',
            harness: cfg.installSlug,
            title: finding.title,
            summary: finding.body,
            conditionKey: finding.conditionKey,
            payload: { paths: finding.paths, filedBy: 'system:sync-batch-delta-check' },
          },
          {
            ownerId: 'system:sync-batch-delta-check',
            workspaceId: cfg.workspaceId,
            harnessSlug: cfg.installSlug,
          },
        );
        if (res.ok) {
          const wi = res.workItem as { id?: unknown; feature_id?: unknown };
          const id =
            typeof wi.id === 'string' ? wi.id : typeof wi.feature_id === 'string' ? wi.feature_id : undefined;
          return {
            ok: true,
            ...(id ? { id } : {}),
            ...(res.conditionUpsert?.adopted ? { adopted: true } : {}),
          };
        }
        const refusal = res as { error?: string; message?: string };
        return { ok: false, error: refusal.message ?? refusal.error ?? 'create_failed' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    now: () => Date.now(),
    log: (message: string) => console.log(message),
  };
}
