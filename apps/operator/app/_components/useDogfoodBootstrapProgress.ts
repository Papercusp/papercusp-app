'use client';

/**
 * useDogfoodBootstrapProgress — the shared client read of the "Papercusp dogfood
 * hive clone-on-first-boot" progress (clone-on-first-boot stage 2 / the desktop
 * UI). One hook so the top banner (DogfoodBootstrapBanner) and the setup-finish
 * gate (SetupWizard) settle from the SAME real rows + the SAME "ready" rule —
 * never two slightly-different interpretations of the sync rows.
 *
 * Backend contract (already implemented — packages/operator-core/lib/harness/
 * bootstrap-papercusp-hive.ts + from-repo-progress.ts):
 *   useSyncQuery({ queryName: 'hiveFromRepo.progress', args: { progressId } })
 *   → rows: { step, status, ts, percent?, detail? }
 *   step:   'clone' then 'submodules'
 *   status: 'running' | 'done' | 'error' | 'skipped'
 *   percent: 0–100 (present while a clone/submodules step is running)
 *   detail:  short string ('downloading', '8/27 submodules', 'local checkout', …)
 *
 * Outside a SyncProvider the hook degrades to `{ data: undefined }` (see
 * SyncContext) — here that surfaces as `rows: []` / `hasRows: false`, so the
 * banner simply stays hidden and the gate falls back to its soft "still
 * preparing…" path rather than hard-blocking forever.
 */

import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';

// The fixed, well-known progressId the boot-time bootstrap records under. The
// canonical source is the exported BOOTSTRAP_PROGRESS_ID constant in
// `@papercusp/operator-core/lib/harness/bootstrap-papercusp-hive` — but that
// module imports node:child_process (the clone/submodule spawners), so it is
// NOT SPA-bundle-safe. Per the EntryGithubUrlForm precedent (parseGithubUrlClient
// duplicates a server regex rather than import the node-importing clone module),
// we duplicate the literal here with a pointer back to the source of truth.
// Keep in sync with bootstrap-papercusp-hive.ts → BOOTSTRAP_PROGRESS_ID.
export const BOOTSTRAP_PROGRESS_ID = 'bootstrap-papercusp-hive';

export type BootstrapStep = 'clone' | 'submodules';
export type BootstrapStatus = 'running' | 'done' | 'error' | 'skipped';

export interface BootstrapProgressRow {
  step: BootstrapStep;
  status: BootstrapStatus;
  ts: number;
  percent?: number;
  detail?: string;
}

export interface DogfoodBootstrapProgress {
  /** All rows for the bootstrap progressId, oldest first (as recorded). */
  rows: BootstrapProgressRow[];
  /** The most recent row per step (the evolving `running` row coalesces). */
  clone?: BootstrapProgressRow;
  submodules?: BootstrapProgressRow;
  /** True once any row exists — i.e. the bootstrap has been triggered + is recording. */
  hasRows: boolean;
  /** Any row reported `status: 'error'`. */
  hasError: boolean;
  /**
   * The error (if any) is a TRANSIENT network fault — a connect timeout / DNS /
   * unreachable host reaching GitHub — rather than a credential or
   * repo-not-found problem (EI-3548). The UI keys off this to message "couldn't
   * reach GitHub — retrying" and AUTO-retry, instead of a terminal "failed" that
   * (uselessly) implies re-authenticating GitHub. Derived from the error row's
   * `detail` (the clone path records `detail: 'network_timeout'`).
   */
  networkError: boolean;
  /**
   * The error is "git isn't available on this machine" — on a fresh macOS the
   * `/usr/bin/git` Command-Line-Tools stub fails non-interactively (the desktop
   * doesn't vendor git on macOS). This is NOT transient: auto-retry is pointless;
   * the user must install git first. The UI shows an actionable install hint.
   */
  gitMissing: boolean;
  /**
   * READY — the flow is finished and the app may proceed. There is a
   * `submodules` row whose status is `done` OR `skipped`, AND no row errored.
   * (Fresh clone → clone done + submodules done; local checkout → clone done +
   * submodules skipped.)
   */
  ready: boolean;
  /**
   * True while rows exist, nothing has errored, and the flow is NOT yet ready —
   * i.e. an in-progress download the banner should show / the gate should block on.
   */
  inProgress: boolean;
  /**
   * The step currently driving the UI: the running step if any, else the latest
   * non-terminal step, else the latest row's step. Undefined when there are no rows.
   */
  activeStep?: BootstrapStep;
  /** The active step's measured percent (0–100), when present. */
  activePercent?: number;
  /** The active step's short human detail, when present. */
  activeDetail?: string;
}

const TERMINAL: ReadonlySet<BootstrapStatus> = new Set(['done', 'skipped', 'error']);

/** Pure reducer over the rows — exported for unit tests (no React, no sync). */
export function reduceBootstrapRows(rows: BootstrapProgressRow[]): DogfoodBootstrapProgress {
  // Latest row per step (later rows supersede earlier ones for the same step).
  // The progress store is APPEND-ONLY on status transitions (only same-step
  // `running` percent ticks coalesce — see from-repo-progress.ts), so a step that
  // fails and is then RETRIED keeps its stale attempt-1 `error` row in `rows`
  // alongside the later `running`/`done` rows. The CURRENT state of a step is
  // therefore its LATEST row — never "did ANY row ever error". Deriving hasError
  // from all of `rows` latched the attempt-1 error and kept the red "didn't
  // finish downloading" banner up over a successful retry (and wedged the
  // setup-finish gate on "Setup needs attention") — WI-1706. Every terminal
  // signal below is computed from the latest-per-step rows instead.
  const latestByStep = new Map<BootstrapStep, BootstrapProgressRow>();
  for (const r of rows) latestByStep.set(r.step, r);
  const clone = latestByStep.get('clone');
  const submodules = latestByStep.get('submodules');

  const hasRows = rows.length > 0;
  // Only a step whose CURRENT (latest) row is `error` counts — a superseded error
  // from a since-retried attempt must NOT keep the error state latched (WI-1706).
  const errorRows = [...latestByStep.values()].filter((r) => r.status === 'error');
  const hasError = errorRows.length > 0;
  // A transient network fault (clone records `detail: 'network_timeout'`; also
  // match the broader connect/DNS/unreachable wording defensively). Keep in sync
  // with clone-github.ts `network_timeout` classification.
  const NETWORK_DETAIL = /network_timeout|timed out|could not resolve|failed to connect|unreachable|connection reset/i;
  const networkError = errorRows.some((r) => !!r.detail && NETWORK_DETAIL.test(r.detail));
  // Keep in sync with clone-github.ts `git_missing` code.
  const gitMissing = errorRows.some((r) => r.detail === 'git_missing');
  const ready =
    !hasError && !!submodules && (submodules.status === 'done' || submodules.status === 'skipped');
  const inProgress = hasRows && !hasError && !ready;

  // Drive the UI from the row that's actually running; otherwise the last
  // non-terminal step; otherwise the most-recent row (settled state).
  const running = [...rows].reverse().find((r) => r.status === 'running');
  const lastNonTerminal = [...rows].reverse().find((r) => !TERMINAL.has(r.status));
  const last = rows[rows.length - 1];
  const driver = running ?? lastNonTerminal ?? last;

  return {
    rows,
    ...(clone ? { clone } : {}),
    ...(submodules ? { submodules } : {}),
    hasRows,
    hasError,
    networkError,
    gitMissing,
    ready,
    inProgress,
    ...(driver
      ? {
          activeStep: driver.step,
          ...(driver.percent != null ? { activePercent: driver.percent } : {}),
          ...(driver.detail ? { activeDetail: driver.detail } : {}),
        }
      : {}),
  };
}

/**
 * Subscribe to the dogfood bootstrap progress over the sync channel and reduce
 * it to a ready-to-render shape. `enabled` (default true) is a cheap guard so a
 * surface can opt out of the subscription entirely.
 */
export function useDogfoodBootstrapProgress(opts?: { enabled?: boolean }): DogfoodBootstrapProgress {
  const enabled = opts?.enabled ?? true;
  const { data } = useSyncQuery<BootstrapProgressRow>({
    queryName: 'hiveFromRepo.progress',
    args: { progressId: BOOTSTRAP_PROGRESS_ID },
    enabled,
    // The store coalesces a clone's ~100 percent ticks into one evolving row and
    // each write invalidates over SSE, so a short staleTime keeps it live without
    // refetch storms.
    staleTime: 2_000,
  });
  // Outside a SyncProvider `data` is undefined; treat as no rows.
  const rows = useMemo<BootstrapProgressRow[]>(() => (Array.isArray(data) ? data : []), [data]);
  return useMemo(() => reduceBootstrapRows(rows), [rows]);
}

/** Human label for the banner / gate, per the current step. */
export function bootstrapStepLabel(step: BootstrapStep | undefined): string {
  switch (step) {
    case 'clone':
      return 'Downloading Papercusp workspace';
    case 'submodules':
      return 'Fetching submodules';
    default:
      return 'Setting up Papercusp workspace';
  }
}

/** Fire-and-forget trigger for the dogfood clone (idempotent, single-flight). */
export async function startDogfoodBootstrap(): Promise<{ ok: boolean; started?: boolean; progressId?: string }> {
  try {
    const res = await fetch('/api/desktop/bootstrap-pot/start', { method: 'POST' });
    return (await res.json().catch(() => ({ ok: res.ok }))) as {
      ok: boolean;
      started?: boolean;
      progressId?: string;
    };
  } catch {
    return { ok: false };
  }
}
