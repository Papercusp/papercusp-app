import { accessSync, constants, existsSync } from 'node:fs';
import { wsLocalKey } from './browser-workspace';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ADMIN_TEST_SUITES,
  type AdminTestCheckResult,
  type AdminTestStatus,
  type AdminTestSuiteDone,
  type AdminTestSuiteId,
  type AdminTestSuiteSpec,
  type DesktopPerfMeasure,
} from './admin-test-suites-shared';
import { DESKTOP_PERF_BUDGETS, evaluateInteractionBudget } from './system-health/desktop-perf-budgets';
import { waitForMainThreadQuiet } from '../../../libs/generic/gui-readiness/src/main-thread-quiet';

export interface AdminTestEventSink {
  suite: (payload: { suiteId: AdminTestSuiteId; label: string; startedAt: number; description: string }) => void;
  progress: (payload: {
    suiteId: AdminTestSuiteId;
    checkId: string;
    label: string;
    index: number;
    total: number;
  }) => void;
  result: (payload: AdminTestCheckResult) => void;
  done: (payload: AdminTestSuiteDone) => void;
  log: (payload: { suiteId: AdminTestSuiteId; level: 'info' | 'warn' | 'error'; line: string }) => void;
}

/**
 * Origin used only when the pinned window cannot tell us its own — the shared
 * dev server. Never navigate to this literal directly; go through `ctx.origin`.
 */
const FALLBACK_DESKTOP_ORIGIN = 'http://127.0.0.1:3055';

interface SuiteContext {
  signal: AbortSignal;
  sink: AdminTestEventSink;
  spec: AdminTestSuiteSpec;
  repoRoot: string;
  desktopRoot: string;
  /** Tauri instance every tauri-agent-tools call is pinned to (null = no live bridge found). */
  bridgePid: number | null;
  /**
   * The origin the PINNED instance is actually serving from, read from the window
   * itself before any navigation.
   *
   * Do NOT hardcode :3055 in a navigation. An isolated verifier shell
   * (`VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh`) runs its own
   * sidecar on its own port against a THROWAWAY database; sending its window to
   * :3055 walks it off that isolated origin and onto the shared, live-DB dev
   * server — silently defeating the isolation the caller asked for. Measured
   * 2026-08-16: this suite drove a VERIFY_TAURI_ISOLATED_DB window (own sidecar
   * :33700, own postgres :35789) onto :3055, and only the chaos surfaces failing
   * to hydrate kept it from clicking on shared state.
   */
  origin: string;
}

interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error: string | null;
}

interface DesktopState {
  origin: string;
  href: string;
  title: string;
  hasTauri: boolean;
  activeSlug: string;
}

interface RoutePage {
  href: string;
  /** Exact trimmed text of every h1 AND h2 on the page (predicates use Array.includes — exact element match). */
  h1: string[];
  domNodes: number;
  hasHarnessRoot: boolean;
  details: string[];
  summary: string;
}

/**
 * How `measureRoute` actually got to the route — NOT what the caller wanted.
 *
 * `in-page`: `history.pushState` + popstate, i.e. an SPA transition inside the
 * already-booted app. This is the only thing a WARM-route budget describes.
 *
 * `document-load`: a real webview navigation — the whole SPA boots again. Never
 * gradeable against a warm budget; it is a cold-load measurement wearing a warm
 * label, which is exactly how WI-39494's 2912ms cold boot was reported as a
 * 1.94x warm-route breach.
 */
export type RouteNavKind = 'in-page' | 'document-load';

export interface RouteMeasurement {
  ok: boolean;
  elapsedMs: number;
  page: RoutePage;
  stabilized: boolean;
  navKind: RouteNavKind;
}

interface MemoryRow {
  pid: number;
  name: string | null;
  rssKb: number;
  hwmKb: number;
  threads: number;
}

interface MemoryTree {
  totalRssKb: number;
  rows: MemoryRow[];
}

export interface ChaosRecorderSummary {
  clicks: number;
  durationMs: number;
  /**
   * How many Event Timing entries the recorder actually OBSERVED — NOT how many
   * clicks it made.
   *
   * ⚠ These two diverge permanently, and the gap is why chaos INP has always
   * read 0 (WI-39495). The chaos driver is gremlins.js, which SYNTHESISES its
   * clicks — and Event Timing ignores untrusted events, so a synthetic click
   * runs the handler and produces no entry. Measured 2026-08-16 in this exact
   * WebKitGTK, one button / one observer / a 60ms-blocking handler: 2 synthetic
   * clicks => 0 entries; 2 real xdotool clicks => 6 entries (click dur=64ms,
   * interactionId=1285). The engine is fine; the DRIVER cannot produce INP.
   *
   * Without this field `maxInp`/`p95Inp` of 0 is ambiguous between "nothing was
   * slow" (a real pass) and "nothing was ever observed" (no measurement at all),
   * and the budget comparison silently accepted the second as the first.
   */
  inpSamples: number;
  maxInp: number;
  p95Inp: number;
  longTasks: number;
  errors: number;
  reloads: number;
  frameDrops: number;
  maxFrameMs: number;
  /**
   * Offset of `maxFrameMs` within the measured window, and the recorder's own
   * arming cost, split out so a frame breach can be attributed instead of
   * re-litigated. Arming dynamically imports the ~226KB gremlins-runtime chunk
   * and walks the document tagging blocked elements; before the split, that
   * blocked frame landed in `maxFrameMs` and the chaos suite failed a 200ms APP
   * budget on the INSTRUMENT's startup.
   *
   * `undefined` means THIS RECORDER BUILD DOES NOT REPORT IT — deliberately not
   * 0, because a stale SPA bundle would otherwise read as "arming was free",
   * which is the absent-vs-zero conflation this suite keeps rediscovering.
   */
  maxFrameAtMs?: number;
  maxFrameTimerTicks?: number;
  maxFrameTimerGapMs?: number;
  setupMaxFrameMs?: number;
  setupFrameDrops?: number;
  /** Last synthetic/trusted click dispatch preceding the worst frame. */
  maxFrameContext?: string;
  routes: string[];
}

interface AiExploreRunSummary {
  goal: string;
  steps: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Number of terminal usage frames whose metrics were absent or incomplete. */
  unreportedFrames?: number;
  exitCode: number | null;
  errors: string[];
  logs: string[];
}

export interface AiExploreParserState {
  metricsSeen: boolean;
  metricsIncomplete: boolean;
}

/**
 * Apply one AI Explore SSE event without turning an absent metric into a measured zero.
 * This function is also embedded in the Tauri-evaluated parser below, so the tested
 * reducer and the generated reader share one presence contract.
 */
export function applyAiExploreEvent(
  summary: AiExploreRunSummary,
  type: string,
  payload: Record<string, unknown>,
  state: AiExploreParserState,
): void {
  const finiteNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const markUnreported = () => {
    if (summary.unreportedFrames === undefined) summary.unreportedFrames = 1;
  };

  if (type === 'step') {
    const n = finiteNumber(payload.n);
    if (n !== undefined) summary.steps = Math.max(summary.steps, n);
  } else if (type === 'metrics') {
    state.metricsSeen = true;
    const inputTokens = finiteNumber(payload.inputTokens);
    const outputTokens = finiteNumber(payload.outputTokens);
    const totalTokens = finiteNumber(payload.totalTokens);
    const costUsd = finiteNumber(payload.costUsd);
    if ([inputTokens, outputTokens, totalTokens, costUsd].some((value) => value === undefined)) {
      state.metricsIncomplete = true;
      markUnreported();
    }
    if (inputTokens !== undefined) summary.inputTokens = inputTokens;
    if (outputTokens !== undefined) summary.outputTokens = outputTokens;
    if (totalTokens !== undefined) summary.totalTokens = totalTokens;
    if (costUsd !== undefined) summary.costUsd = costUsd;
  } else if (type === 'done') {
    // The runner's done frame carries a cost fallback, but no token totals. Without
    // a metrics frame that fallback is not enough to call the usage complete.
    if (!state.metricsSeen) {
      state.metricsIncomplete = true;
      markUnreported();
    }
    const totalMs = finiteNumber(payload.totalMs);
    const steps = finiteNumber(payload.steps);
    const costUsd = finiteNumber(payload.costUsd);
    if (totalMs !== undefined) summary.totalMs = totalMs;
    if (steps !== undefined) summary.steps = Math.max(summary.steps, steps);
    if (costUsd !== undefined) summary.costUsd = costUsd;
    summary.exitCode =
      typeof payload.exitCode === 'number' && Number.isFinite(payload.exitCode) ? payload.exitCode : null;
  } else if (type === 'error') {
    summary.errors.push(String(payload.message === undefined ? 'unknown error' : payload.message));
  } else if (type === 'log' && payload.level === 'error') {
    summary.logs.push(String(payload.line === undefined ? '' : payload.line).slice(0, 300));
  }
}

const SUITE_MAP = new Map(ADMIN_TEST_SUITES.map((suite) => [suite.id, suite] as const));
const SAFE_DEFAULT_IDS = ADMIN_TEST_SUITES.filter((suite) => suite.safeDefault).map((suite) => suite.id);

export function listAdminTestSuites(): AdminTestSuiteSpec[] {
  return ADMIN_TEST_SUITES;
}

export function expandAdminTestSuiteSelection(selection: AdminTestSuiteId | 'all-safe'): AdminTestSuiteId[] {
  return selection === 'all-safe' ? SAFE_DEFAULT_IDS : [selection];
}

export function isAdminTestSuiteId(value: string): value is AdminTestSuiteId {
  return SUITE_MAP.has(value as AdminTestSuiteId);
}

const BRIDGE_TOKEN_RE = /^tauri-dev-bridge-(\d+)\.token$/;

/** Live Tauri bridge pids advertised via tmpdir token files (the tauri-agent-tools discovery contract). */
async function listLiveBridgePids(): Promise<number[]> {
  const entries = await readdir(tmpdir()).catch(() => [] as string[]);
  const pids: number[] = [];
  for (const entry of entries) {
    const match = BRIDGE_TOKEN_RE.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    try {
      process.kill(pid, 0);
      pids.push(pid);
    } catch {
      /* dead instance — the CLI reaps its token lazily */
    }
  }
  return pids;
}

/** Pids on this operator's own ancestry chain — the dev-shell sidecar's ancestor IS its desktop. */
async function operatorAncestorPids(): Promise<Set<number>> {
  const out = new Set<number>();
  let pid = process.pid;
  for (let hops = 0; hops < 32 && pid > 1; hops += 1) {
    const fields = await readProcStatusFields(pid, ['PPid']);
    const ppid = Number(fields?.PPid ?? 0);
    if (!Number.isInteger(ppid) || ppid <= 1) break;
    out.add(ppid);
    pid = ppid;
  }
  return out;
}

/**
 * Pure pin decision — exported for tests. Throws on an ambiguous multi-instance
 * box rather than letting the CLI's discoverBridge() drive an arbitrary window.
 */
export function pickBridgePid(input: {
  explicit: number | null;
  envPid: number | null;
  live: number[];
  ancestors: Set<number>;
}): number | null {
  if (input.explicit !== null) return input.explicit;
  if (input.envPid !== null) return input.envPid;
  if (input.live.length === 0) return null; // checks fail with the normal bridge-unreachable error
  if (input.live.length === 1) return input.live[0];
  const own = input.live.find((pid) => input.ancestors.has(pid));
  if (own !== undefined) return own;
  throw new Error(
    `${input.live.length} Tauri instances are running (pids ${input.live.join(', ')}) — refusing to drive an arbitrary one. ` +
      'Pass tauriPid in the run request (or set PAPERCUSP_SUITE_TAURI_PID on the operator).',
  );
}

/**
 * Resolve the Tauri instance this run drives. Without a pin, tauri-agent-tools'
 * discoverBridge() picks whichever live token file lists first — on a box
 * running several desktops (the owner's seat + agents' Xvfb instances) a suite
 * run could navigate or chaos-click someone ELSE's window.
 */
async function resolveBridgePid(explicit: number | null): Promise<number | null> {
  const rawEnv = Number(process.env.PAPERCUSP_SUITE_TAURI_PID ?? '');
  return pickBridgePid({
    explicit,
    envPid: Number.isInteger(rawEnv) && rawEnv > 0 ? rawEnv : null,
    live: await listLiveBridgePids(),
    ancestors: await operatorAncestorPids(),
  });
}

export async function runAdminTestSuites(
  selection: AdminTestSuiteId | 'all-safe',
  sink: AdminTestEventSink,
  signal: AbortSignal,
  opts: { returnHref?: string | null; tauriPid?: number | null } = {},
): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const desktopRoot = resolveDesktopRoot(repoRoot);
  const suiteIds = expandAdminTestSuiteSelection(selection);
  const firstSpec = SUITE_MAP.get(suiteIds[0] ?? 'desktop-health') ?? ADMIN_TEST_SUITES[0];
  const bridgePid = await resolveBridgePid(opts.tauriPid ?? null);
  // Read the window's own origin/href ONCE, before anything navigates it, so every
  // later navigation stays on the pinned instance's origin (see SuiteContext.origin).
  const bootstrapCtx: SuiteContext = {
    signal,
    sink,
    repoRoot,
    desktopRoot,
    bridgePid,
    spec: firstSpec,
    origin: FALLBACK_DESKTOP_ORIGIN,
  };
  const initialState = await getDesktopState(bootstrapCtx).catch(() => null);
  const origin = initialState?.origin ?? FALLBACK_DESKTOP_ORIGIN;
  const ctxBase = { signal, sink, repoRoot, desktopRoot, bridgePid, origin };
  const restoreCtx: SuiteContext = { ...ctxBase, spec: firstSpec };
  const returnHref = opts.returnHref ?? initialState?.href ?? null;
  try {
    for (const suiteId of suiteIds) {
      signal.throwIfAborted();
      const spec = SUITE_MAP.get(suiteId);
      if (!spec) continue;
      const ctx: SuiteContext = { ...ctxBase, spec };
      await runSuite(ctx);
    }
  } finally {
    if (returnHref) {
      await runTauri(restoreCtx, ['navigate', returnHref], 12_000).catch(() => undefined);
    }
  }
}

async function runSuite(ctx: SuiteContext): Promise<void> {
  const { spec, sink, signal } = ctx;
  signal.throwIfAborted();
  sink.suite({ suiteId: spec.id, label: spec.label, startedAt: Date.now(), description: spec.description });
  const startedAt = Date.now();
  const checks = getSuiteChecks(ctx);
  const results: AdminTestCheckResult[] = [];
  for (let index = 0; index < checks.length; index += 1) {
    signal.throwIfAborted();
    const check = checks[index];
    sink.progress({ suiteId: spec.id, checkId: check.id, label: check.label, index: index + 1, total: checks.length });
    const result = await executeCheck(ctx, check.id, check.label, check.run);
    results.push(result);
    sink.result(result);
  }
  const done = summarizeSuite(spec, results, Date.now() - startedAt);
  sink.done(done);
}

function getSuiteChecks(ctx: SuiteContext): Array<{
  id: string;
  label: string;
  run: () => Promise<Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'>>;
}> {
  switch (ctx.spec.id) {
    case 'desktop-health':
      return desktopHealthChecks(ctx);
    case 'admin-testing-core':
      return adminTestingCoreChecks(ctx);
    case 'admin-testing-extended':
      return adminTestingExtendedChecks(ctx);
    case 'desktop-performance':
      return desktopPerformanceChecks(ctx);
    case 'packaged-readiness':
      return packagedReadinessChecks(ctx);
    case 'memory-core':
      return memoryCoreChecks(ctx);
    case 'shared-hive-core':
      return sharedHiveCoreChecks(ctx);
    case 'ai-explore-prompts':
      return aiExplorePromptChecks(ctx);
  }
}

function sharedHiveCoreChecks(_ctx: SuiteContext) {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return [
    {
      id: 'shared-hive-suite',
      label: 'Shared Hive federation end-to-end',
      run: async () => {
        const { buildSharedHiveCoreChecks } = await import('./shared-pot/suite/checks');
        const checks = buildSharedHiveCoreChecks(runId);
        const counts: Record<AdminTestStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
        const failures: string[] = [];
        for (const c of checks) {
          try {
            const r = await c.run();
            counts[r.status] += 1;
            if (r.status === 'fail') failures.push(`${c.id}: ${r.actual}`);
          } catch (error) {
            counts.fail += 1;
            failures.push(`${c.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const status: AdminTestStatus = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : 'pass';
        return {
          status,
          expected: 'All Shared Hive federation sub-checks pass.',
          actual: `${counts.pass} pass · ${counts.warn} warn · ${counts.fail} fail · ${counts.skip} skip · ${checks.length} total`,
          details: failures.length > 0 ? failures.slice(0, 8) : undefined,
        };
      },
    },
  ];
}

function memoryCoreChecks(_ctx: SuiteContext) {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return [
    {
      id: 'memory-suite',
      label: 'Memory system end-to-end',
      run: async () => {
        const { buildMemoryCoreChecks } = await import('./memory/suite/checks');
        const checks = buildMemoryCoreChecks(runId);
        let failed = 0,
          warned = 0,
          passed = 0,
          skipped = 0;
        const failures: string[] = [];
        for (const c of checks) {
          const r = await c.run();
          if (r.status === 'fail') {
            failed += 1;
            failures.push(`${c.id}: ${r.actual}`);
          } else if (r.status === 'warn') warned += 1;
          else if (r.status === 'pass') passed += 1;
          else skipped += 1;
        }
        const status: 'pass' | 'warn' | 'fail' = failed > 0 ? 'fail' : warned > 0 ? 'warn' : 'pass';
        return {
          status,
          expected: 'All memory-system sub-checks pass.',
          actual: `${passed} pass · ${warned} warn · ${failed} fail · ${skipped} skip · ${checks.length} total`,
          details: failures.length > 0 ? failures.slice(0, 8) : undefined,
        };
      },
    },
  ];
}

async function executeCheck(
  ctx: SuiteContext,
  id: string,
  label: string,
  run: () => Promise<Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'>>,
): Promise<AdminTestCheckResult> {
  const startedAt = Date.now();
  try {
    ctx.signal.throwIfAborted();
    const result = await run();
    return {
      suiteId: ctx.spec.id,
      id,
      label,
      durationMs: Date.now() - startedAt,
      ...result,
    };
  } catch (error) {
    return {
      suiteId: ctx.spec.id,
      id,
      label,
      status: 'fail',
      expected: 'Check completes without throwing.',
      actual: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

function summarizeSuite(
  spec: AdminTestSuiteSpec,
  results: AdminTestCheckResult[],
  durationMs: number,
): AdminTestSuiteDone {
  const counts: Record<AdminTestStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) counts[result.status] += 1;
  const status: AdminTestStatus =
    counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : counts.pass > 0 ? 'pass' : 'skip';
  return { suiteId: spec.id, label: spec.label, status, durationMs, counts };
}

function desktopHealthChecks(ctx: SuiteContext) {
  return [
    {
      id: 'bridge-health',
      label: 'Tauri bridge health',
      run: async () => {
        const health = await runTauriJson<{ uptime_ms: number; webview_ready: boolean; sidecars_alive: boolean }>(ctx, [
          'health',
          '--json',
        ]);
        if (!health.ok || !health.value)
          return fail('webview_ready=true and sidecars_alive=true.', describeCommandFailure(health));
        const { uptime_ms, webview_ready, sidecars_alive } = health.value;
        return statusResult(
          webview_ready && sidecars_alive,
          'webview_ready=true and sidecars_alive=true.',
          `webview_ready=${webview_ready}, sidecars_alive=${sidecars_alive}, uptime=${uptime_ms}ms.`,
        );
      },
    },
    {
      id: 'desktop-page-state',
      label: 'Desktop shell identity',
      run: async () => {
        const state = await getDesktopState(ctx);
        return statusResult(
          state.hasTauri && state.title.includes('Papercusp'),
          'hasTauri=true and a Papercusp page is loaded in the desktop shell.',
          `hasTauri=${state.hasTauri}, title=${state.title}, href=${state.href}.`,
        );
      },
    },
    {
      id: 'console-clean',
      label: 'Console error window',
      run: async () => {
        const result = await runTauriEvalResultJson<{
          count: number;
          errs: Array<{ kind: string; detail?: string; target: string }>;
        }>(
          ctx,
          `(async () => {
            const s = window.__papercuspPerfRecorder;
            if (s && Array.isArray(s.events)) s.events.length = 0;
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const errs = (window.__papercuspPerfRecorder?.events || [])
              .filter((event) => event.kind === 'console-error' || event.kind === 'unhandled-error')
              .map((event) => ({ kind: event.kind, detail: event.detail, target: event.target }));
            return { count: errs.length, errs };
          })()`,
        );
        if (!result.ok || !result.value)
          return fail('0 console errors during a 3s observation window.', describeCommandFailure(result));
        return statusResult(
          result.value.count === 0,
          '0 console errors during a 3s observation window.',
          result.value.count === 0
            ? 'No console errors observed.'
            : `${result.value.count} console error event(s) observed.`,
          result.value.count > 0
            ? result.value.errs.map((entry) => `${entry.kind}: ${entry.detail ?? entry.target}`).slice(0, 6)
            : undefined,
        );
      },
    },
    {
      id: 'voice-assets',
      label: 'Voice runtime assets',
      run: async () => {
        const assets = await runTauriEvalResultJson<
          Array<{ u: string; status?: number; contentType?: string | null; len?: string | null; error?: string }>
        >(
          ctx,
          `(async () => {
            const urls = [
              '/silero_vad_v5.onnx',
              '/vad.worklet.bundle.min.js',
              '/vad-runtime/ort-wasm-simd-threaded.wasm',
              '/vad-runtime/ort-wasm-simd-threaded.mjs',
              '/ort-wasm-simd-threaded.wasm',
              '/ort-wasm-simd-threaded.mjs',
            ];
            const out = [];
            for (const u of urls) {
              try {
                const r = await fetch(u, { method: 'HEAD' });
                out.push({ u, status: r.status, contentType: r.headers.get('content-type'), len: r.headers.get('content-length') });
              } catch (e) {
                out.push({ u, error: String(e) });
              }
            }
            return out;
          })()`,
        );
        if (!assets.ok || !assets.value)
          return fail(
            'All required VAD/ONNX assets resolve successfully inside the Tauri webview.',
            describeCommandFailure(assets),
          );
        const rows = assets.value;
        const required = rows;
        const requiredOk = required.every((row) => row.status === 200);
        const scriptTypesOk = rows
          .filter((row) => row.u.endsWith('.mjs') || row.u.endsWith('.js'))
          .every((row) => (row.contentType ?? '').includes('javascript'));
        const wasmTypesOk = rows
          .filter((row) => row.u.endsWith('.wasm'))
          .every((row) => (row.contentType ?? '').includes('wasm'));
        const pass = requiredOk && scriptTypesOk && wasmTypesOk;
        return statusResult(
          pass,
          'Silero model/worklet and ONNX runtime script+wasm assets resolve as real runtime assets (200 with correct MIME).',
          rows
            .map(
              (row) =>
                `${row.u} → ${row.status ?? 'ERR'}${row.contentType ? ` (${row.contentType})` : ''}${row.error ? ` ${row.error}` : ''}`,
            )
            .join(' · '),
        );
      },
    },
    {
      id: 'packaged-smoke-selector',
      label: 'Packaged smoke mount selector',
      run: async () => {
        const marker = await runTauriEvalJson<boolean>(
          ctx,
          `Boolean(document.querySelector('#root')?.firstElementChild)`,
        );
        if (!marker.ok || typeof marker.value !== 'boolean')
          return fail(
            'The packaged WDIO smoke selector (#root with mounted children) still exists.',
            describeCommandFailure(marker),
          );
        return statusResult(
          marker.value,
          'The packaged WDIO smoke selector (#root with mounted children) still exists.',
          marker.value
            ? '#root contains mounted app content.'
            : '#root has no mounted app content in the current desktop DOM.',
        );
      },
    },
  ];
}

function aiExplorePromptChecks(ctx: SuiteContext) {
  const prompts = [
    {
      id: 'testing-tab-overview',
      label: 'Testing tab overview prompt',
      goal: 'Open the Testing page and summarize which testing tools are available. Do not change settings or run destructive actions.',
      startUrl: `${ctx.origin}/admin/testing?tab=test-runs`,
    },
    {
      id: 'plans-page-overview',
      label: 'Plans page overview prompt',
      goal: 'Open the Plans page and identify whether the page renders a plans list or an empty state. Do not edit plans.',
      startUrl: `${ctx.origin}/admin/plans`,
    },
  ];
  return prompts.map((prompt) => ({
    id: prompt.id,
    label: prompt.label,
    run: async () => {
      const summary = await runAiExplorePrompt(ctx, prompt.goal, prompt.startUrl);
      const ok =
        summary.errors.length === 0 && (summary.exitCode === null || summary.exitCode === 0) && summary.costUsd <= 0.15;
      return statusResult(
        ok,
        'AI Explore backend completes the prompt without errors and stays within the $0.15 per-prompt cap.',
        `${summary.steps} steps · ${summary.totalTokens} tokens · $${summary.costUsd.toFixed(4)} · exit=${summary.exitCode ?? 'unknown'}.`,
        [
          `goal: ${summary.goal}`,
          ...summary.errors.map((error) => `error: ${error}`),
          ...summary.logs.slice(-5).map((line) => `log: ${line}`),
        ],
      );
    },
  }));
}

// The testing console lives on the harness Tests tab (/adv) — the
// /admin/testing route was removed once the Tests tab covered it. Headings
// are exact h1/h2 text (readRoutePage collects both; AiExplorePanel only
// renders an h2).
const TESTS_TAB = '/adv?slug=papercup&tab=testing';

function adminTestingCoreChecks(ctx: SuiteContext) {
  return [
    routeCheck(ctx, 'live-route', 'Live metrics route', `${TESTS_TAB}&testsTab=vitals`, 'Live metrics'),
    routeCheck(ctx, 'chaos-route', 'Chaos route', `${TESTS_TAB}&testsTab=chaos-desktop`, 'Chaos (desktop)'),
    routeCheck(ctx, 'routes-route', 'Routes route', `${TESTS_TAB}&testsTab=routes`, 'Routes'),
    routeCheck(ctx, 'packaged-route', 'Packaged build route', `${TESTS_TAB}&testsTab=packaged`, 'Packaged build'),
  ];
}

function adminTestingExtendedChecks(ctx: SuiteContext) {
  return [
    routeCheck(ctx, 'ai-route', 'AI Explore route', `${TESTS_TAB}&testsTab=ai-explore`, 'AI Explore'),
    routeCheck(ctx, 'llm-route', 'LLM testing route', `${TESTS_TAB}&testsTab=llm`, 'LLM testing'),
  ];
}

function desktopPerformanceChecks(ctx: SuiteContext) {
  const startedAt = Date.now();

  return [
    {
      id: 'webview-http-egress',
      label: 'Webview HTTP egress is zero',
      run: async () => {
        // P-003(c) of no-http-anywhere-2026-07-28. D-005: the webview has no usable
        // network stack, so ANY HTTP egress from it is a loud failure, never a
        // fallback — a silence is why the same transport defect survived three
        // separate times. This is the gate leg that makes the ruling enforceable.
        //
        // Sensor: resource timing. An IPC-routed request produces NO
        // PerformanceResourceTiming entry at all, so an /api entry IS the bug —
        // exact in both directions, needing no instrumentation of the transport
        // that is itself under suspicion, and it catches XHR/img/third-party calls
        // a patched-fetch counter cannot see by construction.
        // The control is REAL, not a proxy. It used to be "did the timeline
        // collect >20 resources" — which is worthless in the shipped app, where
        // WebKitGTK records nothing for `papercusp://` loads, so a fully mounted
        // SPA legitimately shows ZERO entries (measured: 483/483 polls, WI-6657).
        // Instead ask the sensor to prove itself: emit one nonce-tagged request
        // it MUST see, and only trust a zero once that lands. This is the one
        // place that deliberate HTTP request is allowed — a test rig auditing the
        // invariant, never the shipped app.
        const controlUrl = new URL('/__egress_control__', (await getDesktopState(ctx)).origin).toString();
        const probe = await runTauriEvalResultJson<{
          monitorPresent: boolean;
          verdict: string | null;
          total: number | null;
          byPath: Record<string, { count: number }>;
          controlObserved: boolean;
          controlReason: string | null;
          blindTo: string[];
          resourceEntries: number;
          appMounted: boolean;
        }>(
          ctx,
          `(async () => {
            const m = window.__papercusp_egress__;
            const base = {
              resourceEntries: performance.getEntriesByType('resource').length,
              appMounted: Boolean(document.querySelector('#root')?.firstElementChild),
            };
            if (!m) {
              return { ...base, monitorPresent: false, verdict: null, total: null, byPath: {},
                       controlObserved: false, controlReason: 'no monitor', blindTo: [] };
            }
            let proof = { observed: false, reason: 'verify() is absent — this build predates the sensor control' };
            try {
              if (typeof m.verify === 'function') proof = await m.verify({ controlUrl: ${JSON.stringify(controlUrl)} });
            } catch (e) { proof = { observed: false, reason: String(e) }; }
            const r = m.report();
            return {
              ...base,
              monitorPresent: true,
              verdict: r.verdict,
              total: r.total,
              byPath: r.byPath,
              controlObserved: Boolean(proof.observed),
              controlReason: proof.reason || null,
              blindTo: (r.sensor && r.sensor.blindTo) || [],
            };
          })()`,
        );
        if (!probe.ok || !probe.value) {
          return statusResult(false, 'Webview reports zero HTTP egress.', describeCommandFailure(probe));
        }
        const v = probe.value;

        // A MISSING detector must FAIL, never pass. getEgressReport() returns null
        // for UNKNOWN, and an absent/crashed/tree-shaken monitor reports the same
        // zero as a genuinely clean shell — treating that as green would rebuild
        // the exact silence this check exists to remove.
        if (!v.monitorPresent || v.total === null) {
          return statusResult(
            false,
            'Webview reports zero HTTP egress.',
            'the egress monitor is NOT installed, so egress is UNKNOWN — not zero.',
            [
              'window.__papercusp_egress__ is absent. installDesktopIpcPolyfills() installs it; if the shell is not Tauri, or forceHttp pulled the rollback lever, this check cannot speak.',
            ],
          );
        }
        // An unloaded page trivially reports zero egress, and a green "no HTTP"
        // from a blank webview is the most dangerous false pass available here.
        // Note what is NOT asserted any more: resource-entry COUNT. In the
        // packaged shell that count is legitimately zero however healthy the app
        // is, because WebKitGTK records nothing for `papercusp://` loads — so the
        // old `resourceEntries <= 20` guard failed the shipped app for a reason
        // that had nothing to do with egress (WI-6657).
        if (!v.appMounted) {
          return statusResult(
            false,
            'Webview reports zero HTTP egress.',
            'sample is not trustworthy: the app never mounted, so nothing ran to escape.',
            ['A zero from a blank webview is meaningless rather than clean.'],
          );
        }

        // THE CONTROL. `unknown` is a failure, not a pass: it is what a dead
        // detector reports, and it is exactly what a zero looks like.
        if (v.verdict === 'unknown' || !v.controlObserved) {
          return statusResult(
            false,
            'Webview reports zero HTTP egress.',
            `egress is UNKNOWN, not zero: the sensor could not prove itself live (${v.controlReason ?? 'no reason given'}).`,
            [
              'A deliberate control request was issued and the sensor never saw it, so a zero here carries no information. Fix the sensor before trusting any green from this check.',
              ...(v.blindTo.length > 0 ? [`Sensor blind spots: ${v.blindTo.join('; ')}.`] : []),
            ],
          );
        }

        const pass = v.verdict === 'clean';
        const worst = Object.entries(v.byPath)
          .sort((a, b) => (b[1]?.count ?? 0) - (a[1]?.count ?? 0))
          .slice(0, 5)
          .map(([p, agg]) => `${p}×${agg?.count ?? 0}`)
          .join(', ');
        return statusResult(
          pass,
          'Every /api call inside the desktop shell rides the IPC bridge (0 HTTP requests).',
          pass
            ? `0 escapes, and the sensor proved itself live on a control request.`
            : `${v.total} HTTP escape(s): ${worst}.`,
          pass
            ? undefined
            : [
                'A path recurring at ~30s boundaries is a background poll escaping on a ROUTING rule (see D-008), not a startup race; one appearing only before the polyfill installs is genuinely an ordering bug.',
                ...(v.blindTo.length > 0 ? [`Sensor blind spots: ${v.blindTo.join('; ')}.`] : []),
              ],
        );
      },
    },
    {
      id: 'harness-warm-route',
      label: 'Harness warm route',
      run: async () => {
        await clearPerfRecorder(ctx);
        const state = await getDesktopState(ctx);
        // ⚠ Target the POST-REDIRECT url, not `/harness`. `/harness` is not a
        // rendered route — apps/operator-vite/src/routes/harness/index.tsx
        // throws a `beforeLoad` redirect to `/adv?tab=harnesses` — and that
        // redirect used to break this check TWICE over:
        //   1. `.h-root` belongs to the retired harness surface, so BOTH halves
        //      of the old predicate (`href.includes('/harness') &&
        //      hasHarnessRoot`) were permanently false → a 10695ms poll-ceiling
        //      artifact reported as a page latency.
        //   2. measureRoute picks in-page-vs-document-load by comparing path
        //      ROOTS, and the landing root (`adv`) can never equal the requested
        //      root (`harness`) — so BOTH passes did a full webview reload and
        //      the "warm" pass measured an SPA COLD BOOT. That is what produced
        //      the 2912ms "1.94x warm-route breach" in WI-39494, against
        //      siblings measuring 451-517ms warm. Requesting `/adv?tab=harnesses`
        //      directly lets the second pass take the in-page branch, which is
        //      what a warm-route budget actually describes.
        // The legacy `/harness` → `/adv` redirect itself is covered by
        // apps/operator-vite/src/routes/harness/index.test.tsx; it is a routing
        // concern, not a perf one.
        const route = `/adv?tab=harnesses&slug=${encodeURIComponent(state.activeSlug)}&ws=default`;
        // Assert the post-redirect identity plus a node-count floor:
        // data-independent, so it still holds under the empty isolated DB this
        // suite requires. NOT a heading test — this tab renders ~983 nodes with
        // no h1/h2 whatsoever, so `h1.length > 0` false-negatives here.
        const result = await measureWarmRoute(
          ctx,
          route,
          (page) => page.href.includes('tab=harnesses') && page.domNodes >= ROUTE_MIN_RENDERED_NODES,
        );
        return warmRouteResult('route:harness-warm', 'Warm harness route', result);
      },
    },
    {
      id: 'testing-live-warm-route',
      label: 'Testing live warm route',
      run: async () => {
        // The testing console lives on the harness Tests tab (/adv) — the
        // /admin/testing route was removed once the Tests tab covered it.
        // ⚠ `testsTab=vitals` is NOT selectable here. TestingShell's tab list is
        // built by `tabsFromRegistry(domains)` (+ the universal panels), and
        // `vitals` is only an entry in the custom-PANEL map — no registry
        // domain declares it — so the shell silently falls back to its
        // `defaultTabId="test-runs"` and the `Live metrics` h1 never renders.
        // The old predicate therefore never held (WI-39486). Measure the Tests
        // surface this build actually reaches; the vitals panel being
        // unreachable is tracked separately, not asserted here.
        const result = await measureWarmRoute(
          ctx,
          '/adv?slug=papercup&tab=testing',
          (page) => page.href.includes('tab=testing') && page.h1.includes('Tests'),
        );
        return warmRouteResult('route:testing-live-warm', 'Warm Tests tab', result);
      },
    },
    {
      id: 'plans-warm-route',
      label: 'Plans warm route',
      run: async () => {
        const result = await measureWarmRoute(
          ctx,
          '/admin/plans',
          (page) => page.href.includes('/admin/plans') && page.h1.includes('Plans'),
        );
        return warmRouteResult('route:plans-warm', 'Warm /admin/plans', result);
      },
    },
    {
      id: 'interaction-plan-popup-open',
      label: 'Plan popup open interaction',
      run: async () => {
        // Drive the REAL "open a plan" interaction the owner hit (WI-5547): select
        // the op-chat sidebar Plans face, click a plan row, and read the
        // page-relative plan-popup-open measure the in-app perf-marks hooks emit.
        // Unlike the warm-ROUTE checks above, this asserts an INTERACTION budget —
        // the detector gap that let the "several seconds to load a plan" regression
        // ship green.
        await clearPerfRecorder(ctx);
        const result = await measureInteraction(ctx, {
          name: 'plan-popup-open',
          setup: `const u = new URL(location.href); u.searchParams.set('opcv', 'plans'); history.pushState({}, '', u.pathname + u.search + u.hash); window.dispatchEvent(new PopStateEvent('popstate'));`,
          triggerSelector: '[data-testid^="plans-pane-row-"]',
          settleTimeoutMs: 6_000,
        });
        const budgetMs = DESKTOP_PERF_BUDGETS.interactions['plan-popup-open'];
        if (!result.ok) {
          return fail(
            `The Plans sidebar popup-open interaction settles within ${budgetMs}ms in the Tauri desktop shell.`,
            `Could not measure plan-popup-open: ${result.detail}`,
            [
              'Open the op-chat sidebar on the Plans face (?opcv=plans) with at least one plan row so the interaction can be driven.',
            ],
          );
        }
        const verdict = evaluateInteractionBudget('plan-popup-open', result.measuredMs);
        return statusResult(
          verdict.ok,
          `The Plans sidebar popup-open interaction settles within ${verdict.budgetMs}ms in the Tauri desktop shell.`,
          `plan-popup-open=${result.measuredMs}ms (budget ${verdict.budgetMs}ms).`,
          undefined,
          [
            {
              key: 'interaction:plan-popup-open',
              value: result.measuredMs,
              unit: 'ms',
              budget: verdict.budgetMs,
              ok: verdict.ok,
            },
          ],
        );
      },
    },
    {
      id: 'interaction-inbox-bulk-report-open',
      label: 'Inbox bulk report open interaction',
      run: async () => {
        // A review run is data-dependent, so the long-lived desktop suite reads
        // the latest real gesture measure instead of fabricating a run. P-014
        // drives a fresh/current review and records the same canonical entry.
        const result = await readLatestInteractionMeasure(ctx, 'inbox-bulk-report-open');
        const budgetMs = DESKTOP_PERF_BUDGETS.interactions['inbox-bulk-report-open'];
        if (!result.ok) {
          return skip(
            `The Inbox grouped bulk report opens within ${budgetMs}ms in the Tauri desktop shell.`,
            `No inbox-bulk-report-open measure recorded in this shell yet — open Review decisions on a persisted Inbox bulk run (${result.detail}).`,
          );
        }
        const verdict = evaluateInteractionBudget('inbox-bulk-report-open', result.measuredMs);
        return statusResult(
          verdict.ok,
          `The Inbox grouped bulk report opens within ${verdict.budgetMs}ms in the Tauri desktop shell.`,
          `inbox-bulk-report-open=${result.measuredMs}ms (budget ${verdict.budgetMs}ms).`,
          undefined,
          [
            {
              key: 'interaction:inbox-bulk-report-open',
              value: result.measuredMs,
              unit: 'ms',
              budget: verdict.budgetMs,
              ok: verdict.ok,
            },
          ],
        );
      },
    },
    {
      id: 'interaction-command-palette-open',
      label: 'Command palette open interaction',
      run: async () => {
        // Open the global command palette via its ?palette=true deep-link — the
        // open transition begins the interaction, the lazy cmdk chunk mount ends
        // it. No click trigger: the setup IS the trigger (P-006).
        await clearPerfRecorder(ctx);
        const result = await measureInteraction(ctx, {
          name: 'command-palette-open',
          setup: `const u = new URL(location.href); u.searchParams.set('palette', 'true'); history.pushState({}, '', u.pathname + u.search + u.hash); window.dispatchEvent(new PopStateEvent('popstate'));`,
          settleTimeoutMs: 8_000,
        });
        const budgetMs = DESKTOP_PERF_BUDGETS.interactions['command-palette-open'];
        if (!result.ok) {
          return fail(
            `The global command palette opens within ${budgetMs}ms in the Tauri desktop shell.`,
            `Could not measure command-palette-open: ${result.detail}`,
            ['The app root must be mounted so ?palette=true opens the palette (GlobalCommandPalette).'],
          );
        }
        const verdict = evaluateInteractionBudget('command-palette-open', result.measuredMs);
        return statusResult(
          verdict.ok,
          `The global command palette opens within ${verdict.budgetMs}ms in the Tauri desktop shell.`,
          `command-palette-open=${result.measuredMs}ms (budget ${verdict.budgetMs}ms).`,
          undefined,
          [
            {
              key: 'interaction:command-palette-open',
              value: result.measuredMs,
              unit: 'ms',
              budget: verdict.budgetMs,
              ok: verdict.ok,
            },
          ],
        );
      },
    },
    {
      id: 'interaction-learning-view-switch',
      label: 'Learning view switch interaction',
      run: async () => {
        // Start on the Observe stage so the real Observations tab is visible,
        // then click it. This exercises LearningTab's beginInteraction on the
        // view change and ObservationsPanel's primary-read settle point (P-006).
        await clearPerfRecorder(ctx);
        const result = await measureInteraction(ctx, {
          name: 'learning-view-switch',
          setup: `const u = new URL(location.href); u.pathname = '/adv'; u.search = '?tab=learning&lview=signals&slug=papercusp&scope=self&welcome=0'; history.pushState({}, '', u.pathname + u.search); window.dispatchEvent(new PopStateEvent('popstate'));`,
          triggerSelector: 'button[aria-label="Observations"]',
          settleTimeoutMs: 8_000,
        });
        const budgetMs = DESKTOP_PERF_BUDGETS.interactions['learning-view-switch'];
        if (!result.ok) {
          return fail(
            `The Learning tab view switch settles within ${budgetMs}ms in the Tauri desktop shell.`,
            `Could not measure learning-view-switch: ${result.detail}`,
            ['The Learning tab must render the Observe stage with its Observations view trigger.'],
          );
        }
        const verdict = evaluateInteractionBudget('learning-view-switch', result.measuredMs);
        return statusResult(
          verdict.ok,
          `The Learning tab view switch settles within ${verdict.budgetMs}ms in the Tauri desktop shell.`,
          `learning-view-switch=${result.measuredMs}ms (budget ${verdict.budgetMs}ms).`,
          undefined,
          [
            {
              key: 'interaction:learning-view-switch',
              value: result.measuredMs,
              unit: 'ms',
              budget: verdict.budgetMs,
              ok: verdict.ok,
            },
          ],
        );
      },
    },
    {
      id: 'interaction-conversation-thread-load',
      label: 'Conversation thread load interaction',
      run: async () => {
        // ChatPanel emits conversation-thread-load whenever a conversation opens
        // (chatId set → transcript rendered). It needs a specific chat to drive, so
        // the fresh-binary wdio harness opens one cold; in the long-lived shell we
        // report the latest recorded measure, or skip if none was exercised (P-006).
        const result = await readLatestInteractionMeasure(ctx, 'conversation-thread-load');
        const budgetMs = DESKTOP_PERF_BUDGETS.interactions['conversation-thread-load'];
        if (!result.ok) {
          return skip(
            `A conversation thread loads within ${budgetMs}ms in the Tauri desktop shell.`,
            `No conversation-thread-load measure recorded in this shell yet — driven cold by the fresh-binary wdio harness (${result.detail}).`,
          );
        }
        const verdict = evaluateInteractionBudget('conversation-thread-load', result.measuredMs);
        return statusResult(
          verdict.ok,
          `A conversation thread loads within ${verdict.budgetMs}ms in the Tauri desktop shell.`,
          `conversation-thread-load=${result.measuredMs}ms (budget ${verdict.budgetMs}ms).`,
          undefined,
          [
            {
              key: 'interaction:conversation-thread-load',
              value: result.measuredMs,
              unit: 'ms',
              budget: verdict.budgetMs,
              ok: verdict.ok,
            },
          ],
        );
      },
    },
    {
      id: 'interaction-harness-dock-open',
      label: 'Harness dock open interaction',
      run: async () => {
        // HarnessDock emits harness-dock-open on mount → dockview API bind (layout
        // hydration). The dock mounts once per session, so we navigate to the dock
        // route (in case it isn't mounted) and read the latest recorded measure —
        // the fresh-binary wdio harness drives it cold on boot (P-006).
        await runTauri(ctx, ['navigate', `${ctx.origin}/adv?slug=papercup&ws=default`], 12_000).catch(() => undefined);
        await sleep(1200, ctx.signal);
        const result = await readLatestInteractionMeasure(ctx, 'harness-dock-open');
        const budgetMs = DESKTOP_PERF_BUDGETS.interactions['harness-dock-open'];
        if (!result.ok) {
          return skip(
            `The harness dock hydrates within ${budgetMs}ms in the Tauri desktop shell.`,
            `No harness-dock-open measure recorded in this shell yet — driven cold by the fresh-binary wdio harness (${result.detail}).`,
          );
        }
        const verdict = evaluateInteractionBudget('harness-dock-open', result.measuredMs);
        return statusResult(
          verdict.ok,
          `The harness dock hydrates within ${verdict.budgetMs}ms in the Tauri desktop shell.`,
          `harness-dock-open=${result.measuredMs}ms (budget ${verdict.budgetMs}ms).`,
          undefined,
          [
            {
              key: 'interaction:harness-dock-open',
              value: result.measuredMs,
              unit: 'ms',
              budget: verdict.budgetMs,
              ok: verdict.ok,
            },
          ],
        );
      },
    },
    {
      id: 'chaos-recorder-usability',
      label: 'Chaos recorder usability',
      run: async () => {
        const summary = await runChaosRecorder(ctx, '/adv?slug=papercup&tab=testing&testsTab=test-runs', 5_000);
        // Same grading seam as the per-surface chaos checks — in particular it
        // will NOT grade the INP legs against zeroes the recorder never observed
        // (WI-39495). The `chaos:*` measure keys are unprefixed here to keep this
        // check's original trend series.
        return gradeChaosSummary(summary, 'Existing Chaos recorder clicking around for 5s', 'chaos:', [
          `routes: ${summary.routes.join(', ') || '(none)'}`,
          `duration=${summary.durationMs}ms`,
          `longTasks=${summary.longTasks}`,
        ]);
      },
    },
    // P-009: broaden chaos coverage beyond the test-runs surface — chaos-click
    // the OTHER heavy surfaces (harness dock, plans, /adv conversations) so a
    // slow interaction on ANY major surface trips a check, each with its own
    // per-surface INP/frame budgets (prefixed measure keys, so the existing
    // `chaos:*` keys keep their trend history). Routes mirror the /adv tab
    // params; the live/wdio run validates them.
    {
      id: 'chaos-harness-dock',
      label: 'Chaos — harness dock',
      run: () => chaosSurfaceCheck(ctx, 'harness-dock', 'harness dock', '/adv?slug=papercup&tab=overview'),
    },
    {
      id: 'chaos-plans',
      label: 'Chaos — plans',
      run: () => chaosSurfaceCheck(ctx, 'plans', 'plans', '/adv?slug=papercup&tab=plans'),
    },
    {
      id: 'chaos-conversations',
      label: 'Chaos — /adv conversations',
      run: () => chaosSurfaceCheck(ctx, 'conversations', '/adv conversations', '/adv?slug=papercup&tab=conversations'),
    },
    {
      id: 'interaction-budget',
      label: 'Current slow-interaction budget',
      run: async () => {
        const summary = await runTauriEvalJson<{
          maxDuration: number;
          top: Array<{ duration: number; route: string; target: string }>;
        }>(
          ctx,
          `(() => {
            const events = (window.__papercuspPerfRecorder?.events || [])
              .filter((event) => event.kind === 'interaction' && Number(event.ts || 0) >= ${startedAt});
            const sorted = events
              .map((event) => ({ duration: Number(event.duration || 0), route: event.route || '', target: event.target || '' }))
              .sort((a, b) => b.duration - a.duration);
            return { maxDuration: sorted[0]?.duration || 0, top: sorted.slice(0, 5) };
          })()`,
        );
        if (!summary.ok || !summary.value)
          return fail(
            `The desktop interaction recorder reports max interaction <= ${DESKTOP_PERF_BUDGETS.interactionMaxMs}ms.`,
            describeCommandFailure(summary),
          );
        const top = summary.value.top.map((row) => `${row.duration}ms ${row.route} ${row.target}`).slice(0, 5);
        // ABSENT SIGNAL IS NOT A PASS. With no recorded interactions the eval above
        // yields maxDuration=0, which used to render as a green "max interaction=0ms"
        // row (measure ok:true) — a budget satisfied by having measured NOTHING. That
        // is indistinguishable from a genuinely fast shell and is exactly how a dead
        // recorder reads as healthy, so report it as UNMEASURED instead. Emitting no
        // measure also keeps the false 0 out of the perf trend series.
        if (summary.value.top.length === 0) {
          return skip(
            `The desktop interaction recorder reports max interaction <= ${DESKTOP_PERF_BUDGETS.interactionMaxMs}ms.`,
            'UNMEASURED — the recorder captured zero interactions in this run, so the budget was not exercised (0ms here means "nothing measured", not "fast").',
            [
              'window.__papercuspPerfRecorder held no interaction events at or after this run started.',
              'Check the recorder is installed in this shell and that the driven surfaces actually hydrated.',
            ],
          );
        }
        return statusResult(
          summary.value.maxDuration <= DESKTOP_PERF_BUDGETS.interactionMaxMs,
          `The desktop interaction recorder reports max interaction <= ${DESKTOP_PERF_BUDGETS.interactionMaxMs}ms.`,
          `max interaction=${summary.value.maxDuration}ms.`,
          top,
          [
            budgetMeasure(
              'interaction:recorder-max',
              summary.value.maxDuration,
              'ms',
              DESKTOP_PERF_BUDGETS.interactionMaxMs,
            ),
          ],
        );
      },
    },
    {
      id: 'desktop-memory-budget',
      label: 'Desktop RSS budget',
      run: async () => {
        await runTauri(
          ctx,
          ['navigate', `${ctx.origin}/admin/testing?tab=test-runs&suite=desktop-performance`],
          12_000,
        ).catch(() => undefined);
        await sleep(750, ctx.signal);
        // Close any stray recorder windows left by a previous chaos run (or a prior
        // failed run from this session) before reading RSS. A lingering
        // WebKitWebProcess from a leaked window can inflate RSS by several GB.
        await runTauriEvalResultJson<boolean>(
          ctx,
          `(async () => {
            const api = window.__TAURI__?.webviewWindow;
            if (!api?.getAllWebviewWindows) return true;
            const wins = await api.getAllWebviewWindows();
            await Promise.allSettled(
              wins
                .filter((w) => w.label !== 'main' && w.label.startsWith('papercusp-'))
                .map((w) => w.close()),
            );
            return true;
          })()`,
          10_000,
        ).catch(() => undefined);
        const pid = await getTauriPid(ctx);
        await sleep(1500, ctx.signal);
        if (!pid)
          return fail(
            `The largest Tauri/WebKit process RSS stays below ${Math.round(DESKTOP_PERF_BUDGETS.maxProcessRssKb / 1024)}MB.`,
            'Could not determine the running Tauri PID.',
          );
        const tree = await readMemoryTree(pid);
        const top = [...tree.rows].sort((a, b) => b.rssKb - a.rssKb).slice(0, 5);
        const largest = top[0]?.rssKb ?? 0;
        return statusResult(
          largest <= DESKTOP_PERF_BUDGETS.maxProcessRssKb,
          `The largest Tauri/WebKit process RSS stays below ${Math.round(DESKTOP_PERF_BUDGETS.maxProcessRssKb / 1024)}MB (512MB below the 4096MB kill threshold).`,
          `${Math.round(largest / 1024)}MB max RSS across ${tree.rows.length} processes (${Math.round(tree.totalRssKb / 1024)}MB total).`,
          top.map(
            (row) =>
              `${row.pid} ${row.name ?? 'unknown'} → ${Math.round(row.rssKb / 1024)}MB RSS (HWM ${Math.round(row.hwmKb / 1024)}MB)`,
          ),
          [budgetMeasure('memory:rss-kb', largest, 'kb', DESKTOP_PERF_BUDGETS.maxProcessRssKb)],
        );
      },
    },
  ];
}

function packagedReadinessChecks(ctx: SuiteContext) {
  return [
    {
      id: 'tauri-driver',
      label: 'tauri-driver installed',
      run: async () => {
        const exec = await runCommand('bash', ['-lc', 'command -v tauri-driver || true'], {
          cwd: ctx.repoRoot,
          signal: ctx.signal,
          timeoutMs: 5000,
        });
        const pathText = exec.stdout.trim();
        return statusResult(
          pathText.length > 0,
          'tauri-driver is present on PATH.',
          pathText.length > 0 ? pathText : 'tauri-driver not found on PATH.',
        );
      },
    },
    {
      id: 'webkit-webdriver',
      label: 'WebKit WebDriver installed',
      run: async () => {
        const exec = await runCommand('bash', ['-lc', 'command -v WebKitWebDriver || true'], {
          cwd: ctx.repoRoot,
          signal: ctx.signal,
          timeoutMs: 5000,
        });
        const pathText = exec.stdout.trim();
        return statusResult(
          pathText.length > 0,
          'WebKitWebDriver is present on PATH for Linux packaged runs.',
          pathText.length > 0 ? pathText : 'WebKitWebDriver not found on PATH.',
        );
      },
    },
    {
      id: 'wdio-deps',
      label: 'wdio deps installed',
      run: async () => {
        const wdioBin = path.join(ctx.repoRoot, 'tools', 'perf-test', 'wdio', 'node_modules', '.bin', 'wdio');
        return statusResult(
          existsSync(wdioBin),
          'tools/perf-test/wdio has its local npm install completed.',
          existsSync(wdioBin) ? `${wdioBin} exists.` : `${wdioBin} is missing.`,
        );
      },
    },
    {
      id: 'packaged-binary',
      label: 'packaged desktop binary present',
      run: async () => {
        const candidates = [
          path.join(ctx.desktopRoot, 'src-tauri', 'target', 'release', 'papercusp-desktop'),
          path.join(ctx.desktopRoot, 'src-tauri', 'target', 'debug', 'papercusp-desktop'),
        ];
        const found = candidates.find((candidate) => existsSync(candidate)) ?? null;
        return statusResult(
          Boolean(found),
          'A Tauri desktop binary exists at the packaged-runner paths.',
          found ? found : `No binary found at ${candidates.join(' or ')}.`,
        );
      },
    },
    {
      id: 'smoke-selector',
      label: 'packaged smoke selector stays valid',
      run: async () => {
        const marker = await runTauriEvalJson<boolean>(
          ctx,
          `Boolean(document.querySelector('#root')?.firstElementChild)`,
        );
        if (!marker.ok || typeof marker.value !== 'boolean')
          return fail(
            'The WDIO smoke spec selector (#root with mounted children) still exists.',
            describeCommandFailure(marker),
          );
        return statusResult(
          marker.value,
          'The WDIO smoke spec selector (#root with mounted children) still exists.',
          marker.value
            ? '#root contains mounted app content.'
            : '#root has no mounted app content in the current desktop shell DOM.',
        );
      },
    },
  ];
}

function routeCheck(ctx: SuiteContext, id: string, label: string, route: string, heading: string) {
  return {
    id,
    label,
    run: async () => {
      const result = await measureRoute(ctx, route, (page) => page.h1.includes(heading));
      return statusResult(
        result.ok,
        `${route} resolves inside the Tauri desktop shell and renders “${heading}”.`,
        `${result.elapsedMs}ms · href=${result.page.href}.`,
        result.ok ? [result.page.summary] : result.page.details,
      );
    },
  };
}

function statusResult(
  pass: boolean,
  expected: string,
  actual: string,
  details?: string[],
  measures?: DesktopPerfMeasure[],
): Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'> {
  return { status: pass ? 'pass' : 'fail', expected, actual, details, measures };
}

/** A warm-route measure — value in ms, asserted against warmRouteSettleMs, ok
 *  taken from the check's own pass verdict (which also folds in route-settle). */
function routeMeasure(key: string, valueMs: number, ok: boolean): DesktopPerfMeasure {
  return { key, value: valueMs, unit: 'ms', budget: DESKTOP_PERF_BUDGETS.warmRouteSettleMs, ok };
}

/** A budgeted measure whose ok is `value <= budget` (lower is better). */
function budgetMeasure(
  key: string,
  value: number,
  unit: DesktopPerfMeasure['unit'],
  budget: number,
): DesktopPerfMeasure {
  return { key, value, unit, budget, ok: value <= budget };
}

function fail(
  expected: string,
  actual: string,
  details?: string[],
): Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'> {
  return { status: 'fail', expected, actual, details };
}

/**
 * Chaos-click one heavy surface for 5s and assert its INP/frame budgets (P-009).
 * Shares runChaosRecorder + the DESKTOP_PERF_BUDGETS chaos thresholds with the
 * original test-runs check, but emits PER-SURFACE measure keys
 * (`chaos:<surfaceKey>:*`) so each surface has its own trend line and the
 * original `chaos:*` keys keep their history. `clicks > 0` guards a surface that
 * never hydrated (nothing to click ⇒ the surface is broken, a real failure).
 */
async function chaosSurfaceCheck(
  ctx: SuiteContext,
  surfaceKey: string,
  label: string,
  route: string,
): Promise<Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'>> {
  const summary = await runChaosRecorder(ctx, route, 5_000);
  return gradeChaosSummary(summary, `Chaos-clicking the ${label} surface for 5s`, `chaos:${surfaceKey}:`, [
    `route: ${route}`,
    `recorder routes: ${summary.routes.join(', ') || '(none)'}`,
    `duration=${summary.durationMs}ms · longTasks=${summary.longTasks}`,
  ]);
}

/**
 * Grade a chaos run — and REFUSE to grade the INP legs when no interaction was
 * ever observed (WI-39495).
 *
 * The chaos driver (gremlins.js) synthesises its clicks, and Event Timing
 * ignores untrusted events, so `maxInp`/`p95Inp` are permanently 0 on every
 * surface. The old verdict compared those zeroes against the budgets and they
 * PASSED trivially — an INP assertion that has never once been evaluated, sitting
 * inside a check whose other legs currently fail for unrelated (real) reasons.
 * The moment those frame breaches are fixed the whole check goes green while INP
 * remains unmeasured, which is the failure this guard exists to prevent.
 *
 * So: the frame/error/reload legs are graded normally — the synthetic driver
 * measures those validly — and the INP legs are graded ONLY when
 * `inpSamples > 0`. When they are not, the two INP measures are omitted entirely
 * rather than emitted as zeroes, so an unmeasured budget cannot enter the trend
 * series as a clean datum. A genuine failure elsewhere still reports FAIL: an
 * unmeasurable INP must not launder a real breach into a skip.
 */
export function gradeChaosSummary(
  summary: ChaosRecorderSummary,
  subject: string,
  measurePrefix: string,
  details: string[],
): Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'> {
  const inpMeasured = summary.inpSamples > 0;
  const expected = `${subject} stays within budgets (p95 INP <=${DESKTOP_PERF_BUDGETS.chaosInpP95Ms}ms, max INP <=${DESKTOP_PERF_BUDGETS.chaosInpMaxMs}ms, <=${DESKTOP_PERF_BUDGETS.chaosMaxFrameDrops} severe frame drops, max frame <=${DESKTOP_PERF_BUDGETS.chaosMaxFrameMs}ms), with no errors or reloads.`;
  const inpText = inpMeasured
    ? `p95=${summary.p95Inp}ms · max=${summary.maxInp}ms (${summary.inpSamples} samples)`
    : 'INP=UNMEASURED (0 Event Timing entries)';
  // Attribute the worst frame instead of just naming it. `maxFrameAt` says WHERE
  // in the measured window it landed, and `setup` reports the recorder's own
  // arming cost that is excluded from the grade — reported precisely so the
  // exclusion is auditable. `undefined` prints as "unreported" rather than 0, so
  // a stale SPA bundle cannot masquerade as free arming.
  const frameWhere = summary.maxFrameAtMs === undefined ? '' : ` @${summary.maxFrameAtMs}ms into window`;
  const setupText =
    summary.setupMaxFrameMs === undefined
      ? ' · setup=unreported (recorder predates the split)'
      : ` · setup maxFrame=${summary.setupMaxFrameMs}ms/drops=${summary.setupFrameDrops ?? 0} (excluded from grade)`;
  const contextText = summary.maxFrameContext ? ` · preceding=${summary.maxFrameContext}` : '';
  const timerText =
    summary.maxFrameTimerTicks === undefined
      ? ' · timer-correlation=unreported'
      : ` · timer ticks=${summary.maxFrameTimerTicks}/maxGap=${summary.maxFrameTimerGapMs ?? 0}ms inside worst frame`;
  const actual = `${summary.clicks} clicks · ${inpText} · errors=${summary.errors} · reloads=${summary.reloads} · frameDrops=${summary.frameDrops} · maxFrame=${summary.maxFrameMs}ms${frameWhere}${setupText}${contextText}${timerText}.`;

  const measures = [
    budgetMeasure(`${measurePrefix}max-frame`, summary.maxFrameMs, 'ms', DESKTOP_PERF_BUDGETS.chaosMaxFrameMs),
    budgetMeasure(`${measurePrefix}frame-drops`, summary.frameDrops, 'count', DESKTOP_PERF_BUDGETS.chaosMaxFrameDrops),
  ];
  if (inpMeasured) {
    measures.unshift(
      budgetMeasure(`${measurePrefix}inp-p95`, summary.p95Inp, 'ms', DESKTOP_PERF_BUDGETS.chaosInpP95Ms),
      budgetMeasure(`${measurePrefix}inp-max`, summary.maxInp, 'ms', DESKTOP_PERF_BUDGETS.chaosInpMaxMs),
    );
  }

  // `clicks > 0` still guards a surface that never hydrated — nothing to click
  // means the surface is broken, which is a real failure, not an unmeasured one.
  const gradableLegsPass =
    summary.clicks > 0 &&
    summary.errors === 0 &&
    summary.reloads === 0 &&
    summary.frameDrops <= DESKTOP_PERF_BUDGETS.chaosMaxFrameDrops &&
    summary.maxFrameMs <= DESKTOP_PERF_BUDGETS.chaosMaxFrameMs;

  if (!gradableLegsPass) {
    return statusResult(false, expected, actual, details, measures);
  }
  if (!inpMeasured) {
    return skip(
      expected,
      `INP UNMEASURED — ${actual}`,
      [
        `The recorder made ${summary.clicks} clicks but observed 0 Event Timing entries, so p95/max INP were never measured and are NOT reported as 0.`,
        'Cause: the chaos driver (gremlins.js) synthesises its clicks, and Event Timing only records TRUSTED events — verified 2026-08-16 in this WebKitGTK (2 synthetic clicks on a 60ms-blocking handler => 0 entries; 2 real xdotool clicks => 6 entries). Measuring chaos INP requires a real input driver, not a recorder fix (WI-39495).',
        'Every other budget on this surface (errors, reloads, frame drops, max frame) WAS measured and passed.',
        ...details,
      ],
      measures,
    );
  }
  const inpPass =
    summary.maxInp <= DESKTOP_PERF_BUDGETS.chaosInpMaxMs && summary.p95Inp <= DESKTOP_PERF_BUDGETS.chaosInpP95Ms;
  return statusResult(inpPass, expected, actual, details, measures);
}

/** A not-exercised check: 'skip' collapses to 'pass' in the run rollup, so it
 *  never reds the suite. Used for interactions the long-lived admin shell can't
 *  re-trigger (dock mounts once; a conversation needs a specific chat) — the
 *  fresh-binary wdio harness drives those cold. */
/**
 * `measures` is optional and usually omitted — a skip normally has nothing it is
 * entitled to report. Pass it only for a PARTIAL skip, where some legs were
 * genuinely measured and only the graded one was not: a chaos run whose INP is
 * unmeasurable still measured its frame timing, and dropping those samples would
 * punch a hole in a real trend series to express a different leg's absence
 * (WI-39495). Never pass a measure the run did not actually observe.
 */
function skip(
  expected: string,
  actual: string,
  details?: string[],
  measures?: DesktopPerfMeasure[],
): Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'> {
  return { status: 'skip', expected, actual, details, measures };
}

function resolveRepoRoot(): string {
  let dir = path.resolve(process.cwd());
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(path.join(dir, 'apps', 'operator', 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd());
}

function resolveDesktopRoot(repoRoot: string): string {
  const fromEnv = process.env.PAPERCUSP_DESKTOP_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  // papercusp-desktop is an in-repo submodule now (desktop-submodule-of-papercup-2026-06-09).
  return path.resolve(repoRoot, 'papercusp-desktop');
}

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal: AbortSignal },
): Promise<ExecResult> {
  const startedAt = Date.now();
  return await new Promise<ExecResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    const finish = (result: ExecResult) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      opts.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* noop */
      }
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      finish({
        code: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        error: error.message,
      });
    });
    child.on('close', (code, signal) => {
      finish({
        code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startedAt,
        timedOut,
        error: null,
      });
    });
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            /* noop */
          }
        }, opts.timeoutMs)
      : null;
  });
}

export function resolveTauriAgentToolsCommand(
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (candidate: string) => boolean = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): string {
  const explicit = env.VERIFY_TAURI_AGENT_TOOLS_BIN?.trim();
  if (explicit && path.isAbsolute(explicit) && isExecutable(explicit)) return explicit;
  return 'tauri-agent-tools';
}

async function runTauri(ctx: SuiteContext, args: string[], timeoutMs = 12_000): Promise<ExecResult> {
  ctx.signal.throwIfAborted();
  const pinned = ctx.bridgePid !== null ? [...args, '--pid', String(ctx.bridgePid)] : args;
  const command = resolveTauriAgentToolsCommand();
  ctx.sink.log({ suiteId: ctx.spec.id, level: 'info', line: `${command} ${pinned.join(' ')}` });
  return await runCommand(command, pinned, { cwd: ctx.repoRoot, signal: ctx.signal, timeoutMs });
}

async function runTauriJson<T>(
  ctx: SuiteContext,
  args: string[],
  timeoutMs = 12_000,
): Promise<{ ok: boolean; value: T | null; command: string; exec: ExecResult }> {
  const exec = await runTauri(ctx, args, timeoutMs);
  if (exec.error) return { ok: false, value: null, command: `tauri-agent-tools ${args.join(' ')}`, exec };
  try {
    return { ok: true, value: JSON.parse(exec.stdout) as T, command: `tauri-agent-tools ${args.join(' ')}`, exec };
  } catch {
    return { ok: false, value: null, command: `tauri-agent-tools ${args.join(' ')}`, exec };
  }
}

async function runTauriEvalJson<T>(
  ctx: SuiteContext,
  expression: string,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; value: T | null; command: string; exec: ExecResult }> {
  return runTauriJson<T>(ctx, ['eval', `JSON.stringify(${expression})`], timeoutMs);
}

async function runTauriEvalResultJson<T>(
  ctx: SuiteContext,
  expression: string,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; value: T | null; command: string; exec: ExecResult }> {
  const exec = await runTauri(ctx, ['eval', expression], timeoutMs);
  if (exec.error) return { ok: false, value: null, command: `tauri-agent-tools eval ${expression}`, exec };
  try {
    return { ok: true, value: JSON.parse(exec.stdout) as T, command: `tauri-agent-tools eval ${expression}`, exec };
  } catch {
    return { ok: false, value: null, command: `tauri-agent-tools eval ${expression}`, exec };
  }
}

function describeExecFailure(exec: ExecResult): string {
  const parts = [exec.error, exec.stderr, exec.stdout].filter(Boolean);
  return parts.join(' · ') || `exit ${exec.code ?? '?'}${exec.signal ? ` (${exec.signal})` : ''}`;
}

function describeCommandFailure(result: { command: string; exec: ExecResult }): string {
  const body = describeExecFailure(result.exec);
  return body ? `${result.command} → ${body}` : `${result.command} failed.`;
}

async function runAiExplorePrompt(ctx: SuiteContext, goal: string, startUrl: string): Promise<AiExploreRunSummary> {
  const state = await getDesktopState(ctx);
  const endpoint = new URL('/api/admin/testing/ai-explore', state.origin).toString();
  const script = `
    (async () => {
      const res = await fetch(${JSON.stringify(endpoint)}, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: ${JSON.stringify(goal)},
          startUrl: ${JSON.stringify(startUrl)},
          model: 'anthropic/claude-haiku-4-5',
          maxSteps: 8,
          maxCostUsd: 0.15,
          headless: true
        })
      });
      if (!res.ok || !res.body) {
        return { ok: false, status: res.status, text: await res.text().catch(() => '') };
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let currentEvent = null;
      const applyAiExploreEvent = ${applyAiExploreEvent.toString()};
      const summary = {
        goal: ${JSON.stringify(goal)},
        steps: 0,
        totalMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        exitCode: null,
        errors: [],
        logs: []
      };
      const parserState = { metricsSeen: false, metricsIncomplete: false };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split(/\\r?\\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line === '') { currentEvent = null; continue; }
          if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue; }
          if (!line.startsWith('data: ') || !currentEvent) continue;
          const payload = JSON.parse(line.slice(6));
          applyAiExploreEvent(summary, currentEvent, payload, parserState);
        }
      }
      return { ok: true, summary };
    })()
  `;
  const result = await runTauriEvalResultJson<
    { ok: true; summary: AiExploreRunSummary } | { ok: false; status: number; text: string }
  >(ctx, script, 120_000);
  if (!result.ok || !result.value) {
    return {
      goal,
      steps: 0,
      totalMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      exitCode: null,
      errors: [describeCommandFailure(result)],
      logs: [],
    };
  }
  if (!result.value.ok) {
    return {
      goal,
      steps: 0,
      totalMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      exitCode: null,
      errors: [`HTTP ${result.value.status}: ${result.value.text}`],
      logs: [],
    };
  }
  return result.value.summary;
}

async function runChaosRecorder(ctx: SuiteContext, route: string, durationMs: number): Promise<ChaosRecorderSummary> {
  const state = await getDesktopState(ctx);
  const suiteRun = `suite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const routeUrl = new URL(route, state.origin);
  routeUrl.searchParams.set('__suiteRun', suiteRun);
  // The chaos recorder lives on the harness Tests tab (/adv) — the
  // /admin/testing route was removed once the Tests tab covered it. The
  // universalized ChaosDesktopPanel still reads chaosRoute/chaosDur/dry via
  // nuqs and installs the __pcChaosIdleReset hatch, so the driver flow below
  // works unchanged once pointed at the right tab.
  const chaosUrl = new URL('/adv', state.origin);
  chaosUrl.searchParams.set('slug', 'papercup');
  chaosUrl.searchParams.set('tab', 'testing');
  chaosUrl.searchParams.set('testsTab', 'chaos-desktop');
  chaosUrl.searchParams.set('chaosRoute', `${routeUrl.pathname}${routeUrl.search}${routeUrl.hash}`);
  chaosUrl.searchParams.set('chaosDur', durationMs <= 10_000 ? '10s' : '30s');
  chaosUrl.searchParams.set('dry', 'false');
  const ready = await measureRoute(ctx, chaosUrl.toString(), (page) => page.href.includes('testsTab=chaos-desktop'));
  if (!ready.ok) {
    return {
      clicks: 0,
      durationMs,
      inpSamples: 0,
      maxInp: 0,
      p95Inp: 0,
      longTasks: 0,
      errors: 1,
      reloads: 0,
      frameDrops: 0,
      maxFrameMs: 0,
      routes: ready.page.details.length > 0 ? ready.page.details : ['chaos tab did not load'],
    };
  }
  let hydrated = false;
  for (let i = 0; i < 40; i += 1) {
    const probe = await runTauriEvalResultJson<{ resetReady: boolean; hasLaunch: boolean; hasStop: boolean }>(
      ctx,
      `(() => ({
        resetReady: typeof (window).__pcChaosIdleReset === 'function',
        hasLaunch: Array.from(document.querySelectorAll('button')).some((el) => (el.textContent || '').includes('Launch recorder window')),
        hasStop: Array.from(document.querySelectorAll('button')).some((el) => (el.textContent || '').includes('Stop')),
      }))()`,
      10_000,
    );
    if (probe.ok && probe.value && probe.value.resetReady && (probe.value.hasLaunch || probe.value.hasStop)) {
      hydrated = true;
      break;
    }
    await sleep(250, ctx.signal);
  }
  if (!hydrated) {
    return {
      clicks: 0,
      durationMs,
      inpSamples: 0,
      maxInp: 0,
      p95Inp: 0,
      longTasks: 0,
      errors: 1,
      reloads: 0,
      frameDrops: 0,
      maxFrameMs: 0,
      routes: ['chaos tab controls did not hydrate'],
    };
  }
  // Reset any stuck run state (e.g. a previous test run left the chaos store in
  // 'launching' or 'recording' state, so the button shows 'Stop' instead of
  // 'Launch recorder window'). The __pcChaosIdleReset escape hatch is installed
  // by the lib's ChaosDesktopPanel while it is mounted.
  await runTauriEvalResultJson<boolean>(
    ctx,
    `(() => {
      const reset = (window).__pcChaosIdleReset;
      if (typeof reset === 'function') reset();
      return true;
    })()`,
    5_000,
  ).catch(() => undefined);
  for (let i = 0; i < 20; i += 1) {
    const idle = await runTauriEvalResultJson<{ hasLaunch: boolean }>(
      ctx,
      `(() => ({
        hasLaunch: Array.from(document.querySelectorAll('button')).some((el) => (el.textContent || '').includes('Launch recorder window')),
      }))()`,
      10_000,
    );
    if (idle.ok && idle.value?.hasLaunch) break;
    await sleep(250, ctx.signal);
  }
  await runTauriEvalJson<boolean>(
    ctx,
    `(() => {
      try { localStorage.removeItem('papercusp.testing.chaos-runs.v1'); } catch {}
      return true;
    })()`,
    10_000,
  ).catch(() => undefined);
  const launched = await runTauriEvalResultJson<{ ok: boolean; reason?: string }>(
    ctx,
    `(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find((el) => (el.textContent || '').includes('Launch recorder window'));
      if (!(btn instanceof HTMLButtonElement)) return { ok: false, reason: 'Launch recorder window button not found' };
      btn.click();
      return { ok: true };
    })()`,
    10_000,
  );
  if (!launched.ok || !launched.value?.ok) {
    const reason =
      launched.value && 'reason' in launched.value ? launched.value.reason : describeCommandFailure(launched);
    return {
      clicks: 0,
      durationMs,
      inpSamples: 0,
      maxInp: 0,
      p95Inp: 0,
      longTasks: 0,
      errors: 1,
      reloads: 0,
      frameDrops: 0,
      maxFrameMs: 0,
      routes: [reason || 'chaos recorder launch failed'],
    };
  }
  const effectiveDurationMs = durationMs <= 10_000 ? 10_000 : 30_000;
  const deadline = Date.now() + effectiveDurationMs + 20_000;
  await sleep(effectiveDurationMs + 6_500, ctx.signal);
  while (Date.now() < deadline) {
    const summary = await runTauriEvalJson<{
      runId: string;
      startedAt: number;
      windowStartedAt?: number;
      durationMs: number;
      clicks: number;
      events: Array<{ kind: string; route: string; ts?: number; target?: string; inp?: number; duration?: number }>;
      routes: Record<string, unknown>;
      reloads?: number;
      frameDrops?: number;
      maxFrameMs?: number;
      maxFrameAtMs?: number;
      maxFrameTimerTicks?: number;
      maxFrameTimerGapMs?: number;
      setupMaxFrameMs?: number;
      setupFrameDrops?: number;
    } | null>(
      ctx,
      `(() => {
        const getSnapshot = (window).__pcGetChaosSnapshot;
        if (typeof getSnapshot === 'function') {
          try {
            const snap = getSnapshot();
            const currentRunId = snap?.runId ?? null;
            if (currentRunId) {
              const fromSummary = snap?.lastSummary && snap.lastSummary.runId === currentRunId ? snap.lastSummary : null;
              const fromHistory = Array.isArray(snap?.history)
                ? (snap.history.find((run) => run && run.runId === currentRunId) ?? null)
                : null;
              if (fromSummary || fromHistory) return fromSummary ?? fromHistory;
            }
          } catch {
            // fall through to localStorage fallback
          }
        }
        try {
          const raw = localStorage.getItem('papercusp.testing.chaos-runs.v1');
          if (!raw) return null;
          const runs = JSON.parse(raw);
          return Array.isArray(runs) && runs[0] ? runs[0] : null;
        } catch {
          return null;
        }
      })()`,
      10_000,
    );
    if (summary.ok && summary.value) {
      const source = Array.isArray(summary.value.events) ? summary.value.events : [];
      const inps = source
        .filter((ev) => ev.kind === 'click' && typeof ev.inp === 'number')
        .map((ev) => Number(ev.inp))
        .sort((a, b) => a - b);
      const errors = source.filter((ev) => ev.kind === 'console-error' || ev.kind === 'unhandled-error').length;
      const longTasks = source.filter((ev) => ev.kind === 'long-task').length;
      const routes = Object.keys(summary.value.routes || {});
      const frameAt =
        typeof summary.value.maxFrameAtMs === 'number' && typeof summary.value.windowStartedAt === 'number'
          ? summary.value.windowStartedAt + summary.value.maxFrameAtMs
          : null;
      const precedingClick =
        frameAt === null
          ? undefined
          : source
              .filter((ev) => ev.kind === 'click-dispatch' && Number(ev.ts || 0) <= frameAt)
              .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
      const maxFrameContext =
        precedingClick && frameAt !== null
          ? `${precedingClick.target || '(unknown target)'} ${Math.max(0, Math.round(frameAt - Number(precedingClick.ts || 0)))}ms before`
          : undefined;
      return {
        clicks: Number(summary.value.clicks || inps.length),
        durationMs: Number(summary.value.durationMs || durationMs),
        // The count the budget legs need in order to tell "nothing was slow"
        // apart from "nothing was observed" — see ChaosRecorderSummary.inpSamples.
        inpSamples: inps.length,
        maxInp: inps.length ? inps[inps.length - 1] : 0,
        p95Inp: inps.length ? inps[Math.min(inps.length - 1, Math.floor(inps.length * 0.95))] : 0,
        longTasks,
        errors,
        reloads: Number(summary.value.reloads || 0),
        frameDrops: Number(summary.value.frameDrops || 0),
        maxFrameMs: Number(summary.value.maxFrameMs || 0),
        // Left undefined when the recorder build does not send them, so a stale
        // SPA bundle reads as "not reported" rather than "arming cost zero".
        maxFrameAtMs: typeof summary.value.maxFrameAtMs === 'number' ? summary.value.maxFrameAtMs : undefined,
        maxFrameTimerTicks:
          typeof summary.value.maxFrameTimerTicks === 'number' ? summary.value.maxFrameTimerTicks : undefined,
        maxFrameTimerGapMs:
          typeof summary.value.maxFrameTimerGapMs === 'number' ? summary.value.maxFrameTimerGapMs : undefined,
        setupMaxFrameMs: typeof summary.value.setupMaxFrameMs === 'number' ? summary.value.setupMaxFrameMs : undefined,
        setupFrameDrops: typeof summary.value.setupFrameDrops === 'number' ? summary.value.setupFrameDrops : undefined,
        maxFrameContext,
        routes,
      };
    }
    await sleep(500, ctx.signal);
  }
  return {
    clicks: 0,
    durationMs,
    inpSamples: 0,
    maxInp: 0,
    p95Inp: 0,
    longTasks: 0,
    errors: 1,
    reloads: 0,
    frameDrops: 0,
    maxFrameMs: 0,
    routes: ['chaos recorder summary did not arrive before timeout'],
  };
}

async function getDesktopState(ctx: SuiteContext): Promise<DesktopState> {
  const state = await runTauriEvalJson<DesktopState>(
    ctx,
    // NOTE: this string is evaluated INSIDE THE WEBVIEW. Nothing imported into this
    // module exists there — interpolating a Node-side helper produces a
    // ReferenceError at runtime, not a compile error. `wsLocalKey` was referenced
    // here from 2026-06-05 until 2026-08-16 and threw "Can't find variable:
    // wsLocalKey" on every call, silently failing every check that reads desktop
    // state (webview-http-egress + all three warm routes). Keep the workspace-key
    // rule inline, mirroring wsLocalKey/getBrowserWorkspaceId in ./browser-workspace.
    `(() => {
      const url = new URL(location.href);
      const wsId = (window.__PAPERCUSP_WS__ && String(window.__PAPERCUSP_WS__).trim())
        || url.searchParams.get('ws')
        || 'default';
      return {
        origin: location.origin,
        href: location.href,
        title: document.title,
        hasTauri: Boolean(window.__TAURI_INTERNALS__),
        activeSlug: url.searchParams.get('slug') || localStorage.getItem('pc:ws:' + wsId + ':harness.activeProject') || 'sheets',
      };
    })()`,
  );
  if (!state.ok || !state.value) {
    throw new Error(describeCommandFailure(state));
  }
  return state.value;
}

async function getTauriPid(ctx: SuiteContext): Promise<number | null> {
  const tree = await runTauriJson<{ tauri?: { pid?: number } }>(ctx, ['process-tree', '--json']);
  return tree.ok && tree.value?.tauri?.pid ? Number(tree.value.tauri.pid) : null;
}

async function readMemoryTree(rootPid: number): Promise<MemoryTree> {
  const rows: MemoryRow[] = [];
  const root = await readProcStatus(rootPid);
  if (root) rows.push(root);
  const procEntries = await readdir('/proc').catch(() => [] as string[]);
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const child = await readProcStatus(Number(entry));
    if (!child) continue;
    const status = await readProcStatusFields(Number(entry), ['PPid']);
    if (status?.PPid === String(rootPid)) rows.push(child);
  }
  return { totalRssKb: rows.reduce((sum, row) => sum + row.rssKb, 0), rows };
}

async function readProcStatus(pid: number): Promise<MemoryRow | null> {
  const fields = await readProcStatusFields(pid, ['Name', 'VmRSS', 'VmHWM', 'Threads']);
  if (!fields) return null;
  return {
    pid,
    name: fields.Name ?? null,
    rssKb: parseKb(fields.VmRSS),
    hwmKb: parseKb(fields.VmHWM),
    threads: Number(fields.Threads ?? '0'),
  };
}

async function readProcStatusFields(pid: number, names: string[]): Promise<Record<string, string> | null> {
  try {
    const text = await readFile(`/proc/${pid}/status`, 'utf8');
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx);
      if (!names.includes(key)) continue;
      out[key] = line.slice(idx + 1).trim();
    }
    return out;
  } catch {
    return null;
  }
}

function parseKb(value: string | undefined): number {
  if (!value) return 0;
  const num = Number(value.split(/\s+/)[0] ?? '0');
  return Number.isFinite(num) ? num : 0;
}

async function clearPerfRecorder(ctx: SuiteContext): Promise<void> {
  await runTauriEvalJson<boolean>(
    ctx,
    `(() => {
      const s = window.__papercuspPerfRecorder;
      if (s && Array.isArray(s.events)) s.events.length = 0;
      try { localStorage.removeItem('papercusp.testing.perf-events.v1'); } catch {}
      return true;
    })()`,
  ).catch(() => undefined);
}

async function measureWarmRoute(
  ctx: SuiteContext,
  route: string,
  predicate: (page: RoutePage) => boolean,
): Promise<RouteMeasurement> {
  // ⚠ The priming pass's FAILURE IS NOT DECISIVE — do not "optimise" this into
  // an early return. A cross-root hop (e.g. /adv → /admin/plans) is a full SPA
  // reload, which on a loaded box routinely exceeds this pass's whole 24-poll
  // window; the priming pass is what ABSORBS that, so the warm pass can measure
  // an already-loaded route. Bailing here made /admin/plans — a route that
  // genuinely renders in ~440ms — report UNMEASURED forever (measured
  // 2026-08-16: a lone navigate had still not landed after 6.9s/25 polls).
  // Only when BOTH passes fail is the predicate actually wrong.
  await measureRoute(ctx, route, predicate, { stableDomPolls: ROUTE_STABLE_POLLS });
  await sleep(250, ctx.signal);
  return measureRoute(ctx, route, predicate, { stableDomPolls: ROUTE_STABLE_POLLS });
}

/**
 * A warm-route check result.
 *
 * ⚠ A route that never satisfies its predicate is UNMEASURED, not slow. The
 * poll loop above is bounded at 24 iterations, so a stale predicate makes
 * `elapsedMs` converge on the loop's own ceiling (~10.5s here) — a number that
 * reads exactly like a genuine 10.5s page load and was in fact filed as one
 * (P-021, 2026-08-16: `/harness` silently redirects to `/adv?tab=harnesses`,
 * after which `href.includes('/harness')` can never hold). Report it as a skip
 * and emit NO measure, so an instrument ceiling cannot enter the trend series
 * as a latency datum.
 */
export function warmRouteResult(
  key: string,
  routeLabel: string,
  result: RouteMeasurement,
): Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'> {
  const expected = `${routeLabel} settles within ${DESKTOP_PERF_BUDGETS.warmRouteSettleMs}ms in the Tauri desktop shell.`;
  // The measuring pass fell back to a full document load, so what was timed is a
  // cold SPA boot, not a warm route transition. Refuse to grade it: emit NO
  // measure, so a cold number cannot enter the warm-route trend series as
  // either a breach or a pass (WI-39494).
  if (result.ok && result.navKind === 'document-load') {
    return skip(
      expected,
      `UNMEASURED as a WARM route — the measuring pass had to do a full document load (SPA cold boot), so the ${result.elapsedMs}ms observed is a COLD-load time and is not comparable to the ${DESKTOP_PERF_BUDGETS.warmRouteSettleMs}ms warm budget.`,
      [
        `Landed on ${result.page.href} — a different path root than the requested route, so measureRoute could never take the in-page branch.`,
        'This check must target the POST-REDIRECT url (the one the app actually lands on) for its second pass to be warm. Cold-load timing belongs to the cold-vs-warm comparison, not here.',
      ],
    );
  }
  if (!result.ok) {
    return skip(
      expected,
      `UNMEASURED — the route never reached a settled state within ${24 * 125}ms of polling, so no settle time was measured (the elapsed ${result.elapsedMs}ms is the poll loop's own ceiling, NOT a page latency).`,
      [
        `Last observed page: ${result.page.summary}`,
        "Either the surface genuinely never settles, or this check's route predicate no longer describes the app. Confirm the predicate before reading this as a regression.",
        ...result.page.details,
      ],
    );
  }
  const pass = result.elapsedMs <= DESKTOP_PERF_BUDGETS.warmRouteSettleMs;
  const bound = result.stabilized ? '' : ' (LOWER BOUND — time to first render; the DOM never quiesced)';
  return statusResult(
    pass,
    expected,
    `${result.elapsedMs}ms${bound} · href=${result.page.href} · domNodes=${result.page.domNodes}.`,
    result.stabilized
      ? undefined
      : [
          'The surface kept mutating for the whole poll window (expected on an SSE-driven live view), so this is time-to-first-render, not full settle.',
        ],
    [routeMeasure(key, result.elapsedMs, pass)],
  );
}

export interface InteractionMeasureSpec {
  /** The perf-marks interaction name — the emitted performance.measure name
   *  (apps/operator/app/_components/perf/perf-marks.ts PERF_INTERACTIONS). */
  name: string;
  /** JS statement(s) run first to bring the trigger into view (e.g. select the
   *  Plans sidebar face). Wrapped in try/catch by the runner. Optional. */
  setup?: string;
  /** CSS selector for the element whose click STARTS the interaction. When
   *  omitted, the `setup` script IS the trigger (e.g. a ?palette=true deep-link
   *  or a route nav whose mount begins the interaction) — the runner skips the
   *  click and polls for the measure directly. */
  triggerSelector?: string;
  /** Max ms to wait for the trigger element to appear (default 8000). */
  triggerTimeoutMs?: number;
  /** Max ms to wait for the measure to be emitted after the click (default 8000). */
  settleTimeoutMs?: number;
}

interface InteractionMeasureResult {
  ok: boolean;
  measuredMs: number;
  detail: string;
}

/**
 * Build the page-relative interaction driver. The quiet barrier is placed
 * immediately before whichever operation starts timing: before `setup` when
 * setup is the trigger, or after the trigger selector is found and before its
 * click. Keeping the generated script in one function gives the recurrence
 * test a seam to inspect without driving a real Tauri shell.
 */
export function buildInteractionMeasureScript(spec: InteractionMeasureSpec): string {
  const triggerTimeoutMs = spec.triggerTimeoutMs ?? 8_000;
  const settleTimeoutMs = spec.settleTimeoutMs ?? 8_000;
  const nameJson = JSON.stringify(spec.name);
  const quietSource = `(${waitForMainThreadQuiet.toString()})`;
  const quietPrecondition = `
      const quiet = await ${quietSource}();
      if (!quiet.ok) return { stage: 'quiet', error: 'main thread did not reach the D-003 quiet precondition within ' + Math.round(quiet.elapsedMs) + 'ms' };
  `;

  // With a triggerSelector: setup brings the trigger into view, then a click
  // on it STARTS the interaction. Without one: setup IS the trigger and must
  // follow the quiet barrier directly.
  const clickBlock = spec.triggerSelector
    ? `
      const triggerDeadline = Date.now() + ${triggerTimeoutMs};
      let trigger = null;
      while (Date.now() < triggerDeadline) {
        trigger = document.querySelector(${JSON.stringify(spec.triggerSelector)});
        if (trigger) break;
        await sleep(150);
      }
      if (!trigger) return { stage: 'trigger', error: 'trigger not found: ' + ${JSON.stringify(spec.triggerSelector)} };
      ${quietPrecondition}
      try { if (performance.clearMeasures) performance.clearMeasures(${nameJson}); } catch (e) {}
      trigger.click();`
    : '';

  const triggerSetup = spec.triggerSelector
    ? `${spec.setup ? `try { ${spec.setup} } catch (e) { return { stage: 'setup', error: String((e && e.message) || e) }; }` : ''}
      ${clickBlock}`
    : `${quietPrecondition}
      ${spec.setup ? `try { ${spec.setup} } catch (e) { return { stage: 'setup', error: String((e && e.message) || e) }; }` : ''}`;

  return `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Clear any stale measure BEFORE setup so a no-trigger interaction (setup
      // is the trigger) reads only the fresh one it induces.
      try { if (performance.clearMeasures) performance.clearMeasures(${nameJson}); } catch (e) {}
      ${triggerSetup}
      const settleDeadline = Date.now() + ${settleTimeoutMs};
      let measuredMs = null;
      while (Date.now() < settleDeadline) {
        const entries = performance.getEntriesByName(${nameJson}, 'measure');
        if (entries.length > 0) { measuredMs = Math.round(entries[entries.length - 1].duration); break; }
        await sleep(100);
      }
      // Best-effort cleanup: drop the popup/palette deep-links so a modal does not
      // linger open and block the next check's clicks.
      try {
        const u = new URL(location.href);
        let changed = false;
        for (const p of ['pplan', 'palette']) {
          if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; }
        }
        if (changed) {
          history.pushState({}, '', u.pathname + u.search + u.hash);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
      } catch (e) {}
      if (measuredMs === null) return { stage: 'settle', error: 'no ' + ${nameJson} + ' measure within ' + ${settleTimeoutMs} + 'ms' };
      return { measuredMs };
    })()
  `;
}

/**
 * Drive a REAL user interaction in the Tauri shell and read its page-relative
 * `performance.measure` (perf-marks.ts). Unlike a warm-ROUTE settle, this clicks
 * the actual trigger so the in-app beginInteraction/endInteraction hooks fire —
 * the timing is immune to the eval-clock confound (EI-18128922194224210). One
 * self-contained script: setup → wait-for-trigger → clear stale measure → click
 * → poll for the measure → clean up. Reusable across interactions (P-005/P-006).
 */
async function measureInteraction(ctx: SuiteContext, spec: InteractionMeasureSpec): Promise<InteractionMeasureResult> {
  const triggerTimeoutMs = spec.triggerTimeoutMs ?? 8_000;
  const settleTimeoutMs = spec.settleTimeoutMs ?? 8_000;
  const script = buildInteractionMeasureScript(spec);
  const res = await runTauriEvalResultJson<{ measuredMs?: number; stage?: string; error?: string }>(
    ctx,
    script,
    triggerTimeoutMs + settleTimeoutMs + 10_000,
  );
  if (!res.ok || !res.value) return { ok: false, measuredMs: 0, detail: describeCommandFailure(res) };
  if (typeof res.value.measuredMs === 'number') return { ok: true, measuredMs: res.value.measuredMs, detail: '' };
  return { ok: false, measuredMs: 0, detail: `${res.value.stage ?? 'unknown'}: ${res.value.error ?? 'no measure'}` };
}

/**
 * Read the latest page-relative `performance.measure` for a named interaction
 * WITHOUT clearing or re-triggering. For interactions the long-lived shell
 * cannot re-drive on demand — the harness dock hydrates once per session, and a
 * conversation load needs a specific chat open — this reports the value already
 * recorded on the timeline (the fresh-binary wdio harness drives them cold).
 * ok:false with a detail when no measure has been emitted this session.
 */
async function readLatestInteractionMeasure(ctx: SuiteContext, name: string): Promise<InteractionMeasureResult> {
  const nameJson = JSON.stringify(name);
  const res = await runTauriEvalResultJson<{ measuredMs?: number | null }>(
    ctx,
    `(() => { try { const e = performance.getEntriesByName(${nameJson}, 'measure'); const last = e[e.length - 1]; return { measuredMs: last ? Math.round(last.duration) : null }; } catch (err) { return { measuredMs: null }; } })()`,
    10_000,
  );
  if (!res.ok || !res.value) return { ok: false, measuredMs: 0, detail: describeCommandFailure(res) };
  if (typeof res.value.measuredMs === 'number') return { ok: true, measuredMs: res.value.measuredMs, detail: '' };
  return { ok: false, measuredMs: 0, detail: 'no measure on the performance timeline' };
}

/** Consecutive polls the DOM node count must hold steady before a route counts
 *  as settled. Two is enough to reject a surface still mid-hydration without
 *  paying a long confirmation tail on every check. */
const ROUTE_STABLE_POLLS = 2;

/**
 * How much DOM churn still counts as "settled".
 *
 * ⚠ Do NOT tighten this to an exact node-count match. Every client read here
 * flows through @papercusp/sync over SSE, so a live surface (/admin/plans is
 * the reference case) keeps mutating by a handful of nodes indefinitely — it
 * has no quiescent state to wait for. Demanding an exact match made a route
 * that genuinely rendered in 441ms report UNMEASURED forever, which trades a
 * false breach for a false blind spot rather than fixing anything.
 */
const routeDomSettled = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(3, Math.round(b * 0.01));

/**
 * Node count below which a surface has not meaningfully rendered.
 *
 * This is the data-independent stand-in for "the page came up". Do NOT replace
 * it with a heading or a CSS-class probe: `.h-root` and an exact `Live metrics`
 * h1 are precisely the content-coupled assertions that rotted (WI-39486), and
 * the harnesses tab legitimately renders ~983 nodes with NO h1/h2 at all, so
 * even a generic "has a heading" test gives a false negative there.
 */
const ROUTE_MIN_RENDERED_NODES = 200;

async function measureRoute(
  ctx: SuiteContext,
  route: string,
  predicate: (page: RoutePage) => boolean,
  opts: { stableDomPolls?: number } = {},
): Promise<RouteMeasurement> {
  const state = await getDesktopState(ctx);
  const target = route.startsWith('http') ? route : new URL(route, state.origin).toString();
  const currentUrl = new URL(state.href);
  const targetUrl = new URL(target);
  const currentRoot = currentUrl.pathname.split('/')[1] ?? '';
  const targetRoot = targetUrl.pathname.split('/')[1] ?? '';
  // ⚠ This root comparison is a HEURISTIC for "can I stay in the SPA?", and a
  // REDIRECTING target defeats it permanently: `/harness` throws a beforeLoad
  // redirect to `/adv`, so the location root is `adv` while the target root
  // stays `harness` and the two can never converge. Every pass then takes the
  // document-load branch — a full webview reload + SPA cold boot. That is a
  // legitimate measurement of a different thing, which is why the branch we
  // took is REPORTED (`navKind`) rather than assumed: a warm budget must not be
  // applied to a cold boot (WI-39494 — a 2912ms cold load graded as a 1.94x
  // warm-route breach).
  const navKind: RouteNavKind = currentRoot === targetRoot ? 'in-page' : 'document-load';
  if (navKind === 'in-page') {
    const nav = await runTauriEvalJson<{ ok: boolean; href: string }>(
      ctx,
      `(() => {
        const target = new URL(${JSON.stringify(target)});
        const next = target.pathname + target.search + target.hash;
        history.pushState({}, '', next);
        window.dispatchEvent(new PopStateEvent('popstate'));
        return { ok: true, href: location.href };
      })()`,
    );
    if (!nav.ok || !nav.value) {
      return routeFailure(target, nav.exec.durationMs, describeCommandFailure(nav), navKind);
    }
  } else {
    const nav = await runTauri(ctx, ['navigate', target]);
    if (nav.error || nav.code !== 0) {
      return routeFailure(target, nav.durationMs, describeExecFailure(nav), navKind);
    }
  }
  const startedAt = Date.now();
  const stableNeeded = opts.stableDomPolls ?? 0;
  // `bandEnteredAt` is when the DOM entered the node-count band it then held —
  // the moment the surface stopped growing. The confirmation polls that follow
  // only PROVE it held; charging their wall time to the route would report the
  // instrument's own confirmation window as page latency.
  let bandEnteredAt = 0;
  let bandDomNodes = -1;
  let stableStreak = 0;
  // First poll at which the predicate held at all. If the DOM never settles we
  // still return this as a lower bound rather than discarding a real render.
  let firstMatchAt = 0;
  let lastMatched: RoutePage | null = null;
  for (let i = 0; i < 24; i += 1) {
    await sleep(125, ctx.signal);
    const page = await readRoutePage(ctx);
    if (!page) continue;
    if (!predicate(page)) {
      bandEnteredAt = 0;
      bandDomNodes = -1;
      stableStreak = 0;
      firstMatchAt = 0;
      lastMatched = null;
      continue;
    }
    lastMatched = page;
    if (firstMatchAt === 0) firstMatchAt = Date.now();
    if (stableNeeded === 0) {
      return { ok: true, elapsedMs: Date.now() - startedAt, page, stabilized: true, navKind };
    }
    if (routeDomSettled(page.domNodes, bandDomNodes)) {
      stableStreak += 1;
      if (stableStreak >= stableNeeded) {
        return { ok: true, elapsedMs: Math.max(0, bandEnteredAt - startedAt), page, stabilized: true, navKind };
      }
    } else {
      // Still growing — restart the settle clock at this new size.
      bandDomNodes = page.domNodes;
      stableStreak = 0;
      bandEnteredAt = Date.now();
    }
  }
  // The predicate held but the DOM never quiesced (a permanently-live surface).
  // Report time-to-first-render as a LOWER BOUND — flagged, never silently
  // presented as a full settle time.
  if (lastMatched && firstMatchAt > 0) {
    return {
      ok: true,
      elapsedMs: Math.max(0, firstMatchAt - startedAt),
      page: lastMatched,
      stabilized: false,
      navKind,
    };
  }
  const fallback = await readRoutePage(ctx);
  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    page: fallback ?? makeRoutePage(target, [], 0, false, [`route did not settle for ${target}`]),
    stabilized: false,
    navKind,
  };
}

async function readRoutePage(ctx: SuiteContext): Promise<RoutePage | null> {
  const page = await runTauriEvalJson<{
    href: string;
    h1: string[];
    domNodes: number;
    hasHarnessRoot: boolean;
  }>(
    ctx,
    `(() => ({
      href: location.href,
      h1: Array.from(document.querySelectorAll('h1, h2')).map((node) => (node.textContent || '').trim()),
      domNodes: document.querySelectorAll('*').length,
      hasHarnessRoot: Boolean(document.querySelector('.h-root')),
    }))()`,
    10_000,
  );
  if (!page.ok || !page.value) return null;
  return makeRoutePage(page.value.href, page.value.h1, page.value.domNodes, page.value.hasHarnessRoot);
}

function routeFailure(
  target: string,
  elapsedMs: number,
  detail: string,
  navKind: RouteNavKind,
): RouteMeasurement & { ok: false } {
  return {
    ok: false,
    elapsedMs,
    page: makeRoutePage(target, [], 0, false, [detail]),
    stabilized: false,
    navKind,
  };
}

function makeRoutePage(
  href: string,
  h1: string[],
  domNodes: number,
  hasHarnessRoot: boolean,
  details: string[] = [],
): RoutePage {
  return {
    href,
    h1,
    domNodes,
    hasHarnessRoot,
    details,
    summary: `${href} · h1=${h1.join(' | ') || '(none)'} · domNodes=${domNodes}${hasHarnessRoot ? ' · h-root' : ''}`,
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('Aborted');
  await new Promise<void>((resolve, reject) => {
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
