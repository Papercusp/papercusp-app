/**
 * Web-vitals collection for the packaged-binary perf runner.
 *
 * WHY THIS EXISTS (EI-18895065570073000): the smoke spec used to inject
 *
 *     import {onINP, onLCP, onCLS} from "https://esm.sh/web-vitals@4";
 *
 * into a `papercusp://` document, wait 10s, and return `window.__wv`. Inside the
 * packaged app that import cannot resolve — an offline desktop shell has no route
 * to a CDN — and a MODULE SCRIPT IMPORT FAILURE IS SILENT: it does not throw into
 * the evaluating context. So `__wv` stayed `{}`, the spec logged `web-vitals: {}`,
 * asserted only `toBeDefined()`, and PASSED. Every LCP/INP/CLS figure the desktop
 * suite ever published should be read as ABSENT, not as good.
 *
 * That is this repo's recurring defect class: A CHECK WHOSE FAILURE MODE IS
 * INDISTINGUISHABLE FROM ITS SUCCESS MODE. `{}` meant both "the page was idle,
 * nothing to report" (benign) and "the measurement apparatus never loaded" (total
 * failure). The fix is never another assertion on the same value — it is to make
 * the broken state a DIFFERENT VALUE. Hence the `__wv_ready` sentinel below, and
 * hence {@link WebVitalsReading.instrument}, which is `broken` rather than empty
 * when the apparatus did not come up.
 *
 * ── WHAT IS ACTUALLY OBSERVABLE HERE (measured, not assumed) ──────────────────
 *
 * Bundling alone would NOT have been enough, and asserting "metrics are non-empty"
 * would have been red forever. Measured directly against WebKitGTK 2.52.3 with the
 * scheme registered exactly as wry does (probe 4/5, 2026-07-28):
 *
 *   FCP   ✅ reports (38–122 ms on a trivial page)
 *   LCP   ✅ reports
 *   TTFB  ❌ IMPOSSIBLE — the navigation entry exists but is ALL ZEROS under a
 *            custom scheme (`responseStart: 0`, `requestStart: 0`, `duration: 0`).
 *            web-vitals bails on a non-positive responseStart, correctly.
 *   CLS   ❌ IMPOSSIBLE — `layout-shift` is absent from
 *            `PerformanceObserver.supportedEntryTypes` in WebKitGTK entirely.
 *            This is a WebKit limit, not a papercusp:// one.
 *   INP   ⚠️  needs a TRUSTED interaction. A scripted `dispatchEvent` of a full
 *            pointerdown/mousedown/pointerup/mouseup/click sequence produced ZERO
 *            `event` timing entries even at `durationThreshold: 0`. Only real
 *            user-agent input counts — i.e. WebDriver-driven clicks, never
 *            `browser.execute`.
 *
 * So absence has three different meanings here, and collapsing them into one
 * "missing" bucket is how the original bug survived. {@link MetricEnvironment}
 * encodes which is which, and only the `expected` ones can fail a run.
 *
 * ── WHY INJECTION STILL WORKS AT ALL ──────────────────────────────────────────
 * The original injection MECHANISM was fine: an inline `<script>` appended to
 * `document.head` executes normally under `papercusp://` (probe 4 test A). Only the
 * network import failed. So this module keeps the inline-script mechanism — it is
 * the one that was actually measured working — and changes only what is injected:
 * a locally bundled IIFE with no imports and no network access.
 *
 * ── WHY LATE INJECTION STILL CATCHES FIRST PAINT ──────────────────────────────
 * web-vitals registers its paint observers with `buffered: true`, so attaching
 * after `waitForAppMount` still retroactively sees FCP/LCP. Confirmed in probe 4:
 * injection happened well after load and both metrics still reported. (Same
 * property the egress monitor depends on — see WI-6657.)
 */
import path from "node:path";
import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import type { Browser } from "webdriverio";
// Relative, not `@papercusp/gui-readiness`, for the same reason app-mount.ts is:
// this runner is deliberately outside the npm workspace, so a bare specifier is
// hostage to a peer's install landing mid-run.
import {
  classifyInjectedInstrument,
  type InjectedInstrumentState,
} from "../../../libs/generic/gui-readiness/src/injected-instrument";

/** The five metrics this probe registers. */
export type WebVitalName = "FCP" | "LCP" | "CLS" | "INP" | "TTFB";

/**
 * How a metric's ABSENCE should be read in this environment.
 *
 * - `expected`      — observable here; if it is missing, the instrument is not
 *                     working and the run must fail.
 * - `interaction`   — observable only after a TRUSTED user interaction. Absent in a
 *                     spec that does not click is honest, not a failure.
 * - `unavailable`   — structurally impossible in this engine/scheme. Never assert;
 *                     recording a 0 would put a fabricated number in the trend.
 */
export type MetricAvailability = "expected" | "interaction" | "unavailable";

export interface MetricEnvironmentEntry {
  availability: MetricAvailability;
  /** Why — measured, so a future reader can re-test rather than re-guess. */
  why: string;
}

/**
 * The measured availability matrix. Re-derive with probe 4/5 rather than editing
 * from intuition: every entry here was observed, and three of the five contradict
 * what a browser-based expectation would predict.
 */
export const METRIC_ENVIRONMENT: Record<WebVitalName, MetricEnvironmentEntry> = {
  FCP: {
    availability: "expected",
    why: "paint entries are supported and report under papercusp://",
  },
  LCP: {
    availability: "expected",
    why: "largest-contentful-paint is in supportedEntryTypes and reports",
  },
  INP: {
    availability: "interaction",
    why: "needs a trusted interaction; scripted dispatchEvent yields no event timing entries",
  },
  CLS: {
    availability: "unavailable",
    why: "WebKitGTK does not implement the layout-shift entry type at all",
  },
  TTFB: {
    availability: "unavailable",
    why: "custom-scheme navigation timing is all zeros (responseStart: 0)",
  },
};

export interface WebVitalsReading {
  /**
   * `ready` means the apparatus loaded and its observers registered. Every other
   * value is a DIFFERENT way of not working, with a different remedy —
   * classified by `@papercusp/gui-readiness`, see {@link InjectedInstrumentState}:
   *
   *   `replaced`       — the document died under the probe. Says nothing about
   *                      the instrument; fix whatever reloads the webview.
   *   `threw`          — the payload threw. `brokenReason` names the error.
   *   `never-executed` — the script element never ran. Fix the injection.
   *   `incomplete`     — it ran, did not throw, never finished registering.
   *
   * WHY THIS IS NOT JUST `broken` (WI-38449): all four of those produced the
   * identical `{ready:false, metrics:null, errors:[]}` and were reported as
   * "the bundle did not execute or its observers failed to register" — a message
   * that names two of the four and is silent about the other two. Collapsing
   * distinct causes into one value is the very defect this module's header
   * describes; it had simply moved up a level.
   */
  instrument: InjectedInstrumentState;
  /** Populated for every non-`ready` instrument state; the actionable why. */
  brokenReason: string | null;
  /** Metrics that actually reported. */
  metrics: Partial<Record<WebVitalName, number>>;
  /**
   * `expected` metrics that did NOT report. Non-empty means the instrument came
   * up but is seeing nothing — a real failure, distinct from a broken instrument.
   */
  missingExpected: WebVitalName[];
  /** Absent for a documented environmental reason — informational only. */
  absentByEnvironment: WebVitalName[];
  /** Registration errors raised inside the page, if any. */
  errors: string[];
  /** Captured synchronously with metrics; a later IPC await may change LCP. */
  attribution?: { lcp: unknown; lcpAttributionError: string | null };
}

/** Retain real load measurements before asserting a combined native sample. */
export function evaluateRequiredPageLoad(reading: WebVitalsReading) {
  const failures: string[] = [];
  if (reading.instrument !== "ready") {
    failures.push(`web-vitals instrument is ${reading.instrument}: ${reading.brokenReason ?? "no reason recorded"}`);
  }
  failures.push(...reading.errors);
  const measures = [];
  for (const [name, budget] of [["FCP", 3_000], ["LCP", 4_000]] as const) {
    const value = reading.metrics[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      failures.push(`${name} is missing or invalid`);
      continue;
    }
    const ok = value <= budget;
    measures.push({ key: `web-vital:${name}`, value, unit: "ms" as const, budget, ok });
    if (!ok) failures.push(`${name} ${value}ms exceeds ${budget}ms`);
  }
  for (const name of reading.missingExpected) {
    if (!failures.some((failure) => failure.startsWith(`${name} `))) {
      failures.push(`${name} is missing`);
    }
  }
  return { measures, failures };
}

let cachedBundle: string | null = null;

/**
 * Bundle web-vitals + the observer registrations into a single self-contained
 * IIFE with no imports and no network access.
 *
 * Resolution is deliberately anchored to THIS directory: `web-vitals` is a declared
 * devDependency of the wdio runner (which is kept out of the npm workspace on
 * purpose — see its .gitignore), so it resolves from the runner's own
 * `node_modules` rather than from a transitive copy at the repo root that a future
 * prune could remove.
 *
 * Throws — loudly and with the remedy — rather than returning an empty string. A
 * builder that fails quietly would recreate the exact bug this module exists to
 * fix, one level up.
 */
export function buildWebVitalsBundle(): string {
  if (cachedBundle !== null) return cachedBundle;

  // Required lazily so a bundling problem surfaces as this function's error, with
  // its remedy attached, rather than as an opaque module-load failure.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const esbuild = require("esbuild") as typeof import("esbuild");

  let result;
  try {
    result = esbuild.buildSync({
      stdin: {
        contents: `
          import { onINP, onLCP, onCLS, onFCP, onTTFB } from 'web-vitals';
          window.__wv = {};
          window.__wv_errors = [];
          window.__wv_lcp = null;
          window.__wv_lcp_error = null;
          var cap = function (name, fn, opts) {
            try { fn(function (m) {
              window.__wv[name] = m.value;
              if (name === 'LCP') {
                try {
                  var entry = m.entries && m.entries[m.entries.length - 1];
                  var element = entry && entry.element;
                  window.__wv_lcp = entry ? {
                    startMs: entry.startTime,
                    renderMs: entry.renderTime,
                    loadMs: entry.loadTime,
                    size: entry.size,
                    tag: element && element.tagName || null,
                    id: element && typeof element.id === 'string' ? element.id.slice(0, 80) : null,
                    testId: element && element.getAttribute ? element.getAttribute('data-testid')?.slice(0, 80) || null : null,
                    className: element && typeof element.className === 'string' ? element.className.slice(0, 160) : null,
                    startupCandidateMatches: window.__pcStartupStorageProbe?.renderCandidateMatches?.(element) ?? null,
                    startupCandidates: window.__pcStartupStorageProbe?.renderCandidateMatchesBySelector?.(element) ?? null,
                    text: element && element.textContent ? element.textContent.trim().slice(0, 160) : null,
                    url: entry.url ? String(entry.url).slice(0, 240) : null,
                  } : null;
                } catch (e) { window.__wv_lcp_error = String(e).slice(0, 160); }
              }
            }, opts); }
            catch (e) { window.__wv_errors.push(name + ': ' + String(e)); }
          };
          cap('TTFB', onTTFB);
          cap('FCP', onFCP);
          cap('LCP', onLCP, { reportAllChanges: true });
          cap('CLS', onCLS, { reportAllChanges: true });
          cap('INP', onINP, { reportAllChanges: true });
          // Set LAST: the sentinel means "observers are registered", not merely
          // "the script started". That distinction is the whole point.
          window.__wv_ready = true;
        `,
        resolveDir: __dirname,
        loader: "js",
      },
      bundle: true,
      format: "iife",
      target: "es2020",
      write: false,
    });
  } catch (err) {
    throw new Error(
      `[web-vitals-probe] could not bundle web-vitals: ${String(err)}\n` +
        `  Remedy: run \`npm install\` in ${path.relative(process.cwd(), __dirname) || "."} ` +
        `(web-vitals and esbuild are declared devDependencies of this runner).\n` +
        `  Do NOT "fix" this by restoring a CDN import — an offline desktop app must ` +
        `not reach the network to measure itself (EI-18895065570073000).`,
    );
  }

  const text = result.outputFiles?.[0]?.text ?? "";
  if (text.length === 0) {
    throw new Error("[web-vitals-probe] bundle came back empty — refusing to inject a no-op instrument");
  }
  // Guard the actual regression: a bundle that still reaches out to a CDN is the
  // bug, not the fix. Cheap to check, and it fails at build time rather than as a
  // mysterious `{}` inside the packaged binary.
  if (/https?:\/\/[^\s"']*(esm\.sh|unpkg|jsdelivr|cdn)/i.test(text)) {
    throw new Error("[web-vitals-probe] bundle contains a CDN reference — it must be fully self-contained");
  }

  cachedBundle = text;
  return text;
}

/**
 * Inject the instrument, let it settle, and return a CLASSIFIED reading.
 *
 * `settleMs` is time for the paint observers to flush. It does not need to be long
 * — FCP/LCP are buffered and arrive almost immediately — but a little slack keeps
 * the reading stable on a loaded box.
 */
export { installStartupStorageProbe } from './startup-storage-probe';
import type { installStartupStorageProbe } from './startup-storage-probe';

/** Compile a standalone browser payload, including no tsx name helpers. */
export function buildStartupStorageProbeScript(): string {
  const esbuild = require('esbuild') as typeof import('esbuild');
  return esbuild.buildSync({
    stdin: { contents: "import { installStartupStorageProbe } from './startup-storage-probe'; installStartupStorageProbe();",
      resolveDir: __dirname, loader: 'ts' },
    bundle: true, platform: 'browser', format: 'iife', minify: true, keepNames: false, write: false,
  }).outputFiles[0].text;
}

/** Refuse aliasing BEFORE a diagnostic write can change the baseline artifact.
 * Installed app trees may link their entire SPA directory to a frozen build. */
export function writeStartupStorageDiagnosticIndex(spaDirectory: string, baselineIndex: string, script: string): void {
  const directory = path.resolve(spaDirectory);
  const index = path.join(directory, 'index.html');
  const baseline = statSync(baselineIndex);
  const target = statSync(index);
  if (realpathSync(directory) !== directory || lstatSync(index).isSymbolicLink() ||
      (target.dev === baseline.dev && target.ino === baseline.ino)) {
    throw new Error('Diagnostic SPA aliases its baseline; create an independent directory and index before writing');
  }
  const html = readFileSync(baselineIndex, 'utf8');
  if (html.split('<head>').length !== 2 || /<\/script/i.test(script)) {
    throw new Error('Diagnostic SPA requires one head and a standalone inline payload');
  }
  writeFileSync(index, html.replace('<head>',
    '<head>\n<script data-p007-startup-storage-probe="r158">' + script + '</script>'));
}

export async function readPageStartupTrace({ fcpMs, lcpMs, attribution }: {
  fcpMs: number | null; lcpMs: number | null; attribution?: WebVitalsReading['attribution'];
}) {
  // Capture before IPC yields: timeOrigin aligns this document's performance
  // clock with the external native diagnostic's epoch-ms read intervals.
  const documentClock = { timeOriginMs: Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null,
    capturedAtMs: performance.now() };
  // Snapshot and restore before the following IPC await or popup interaction.
  const storage = (window as unknown as {
    __pcStartupStorageProbe?: ReturnType<typeof installStartupStorageProbe>;
  }).__pcStartupStorageProbe?.stop() ?? null;
  const metrics = (window as unknown as {
    __sync_metrics__?: {
      snapshot(): { scheduler?: unknown; ipcAssertTimedOut?: boolean; ipcAssertLastClient?: string | null;
        ipcAssertion?: Array<{ startedAtMs: number; importReadyAtMs: number | null;
          invokeStartedAtMs: number | null; invokeCompletedAtMs: number | null;
          completedAtMs: number | null; client: string | null; error?: string;
          nativeStartedAtMs?: number; nativeDurationMs?: number;
          renderer?: { unit: 'ms'; clock: 'performance.now'; intervalMs: number;
            startedAtMs: number; lastObservedAtMs: number; timerTicks: number; maxGapMs: number;
            gaps: Array<{ startedAtMs: number; completedAtMs: number; durationMs: number }>;
            stoppedAtMs: number | null; stopReason: 'reply' | 'deadline' | null } }>;
        stages?: { recent: Array<{ stage: string; unit: 'ms'; durationMs: number; measuredAtMs: number;
          queryName?: string; traceId?: string }> } };
      queries(): Array<{ name: string; startedAtMs: number; waitMs: number; requestMs: number; outcome: string;
        traceId?: string; stages?: Record<string, number> }>;
    };
  }).__sync_metrics__;
  const snapshot = metrics?.snapshot();
  const queries = metrics?.queries() ?? [];
  // These existing writers use performance.now() for page-local instants.
  // Capture before yielding to IPC, like the LCP subject. The request ring
  // alone cannot distinguish resolver/transfer work from a later React frame.
  const compact = (query: typeof queries[number]) => ({
    name: query.name, startMs: Math.round(query.startedAtMs), waitMs: Math.round(query.waitMs),
    requestMs: Math.round(query.requestMs), endMs: Math.round(query.startedAtMs + query.waitMs + query.requestMs),
    outcome: query.outcome, traceId: query.traceId ?? null, stages: query.stages ?? null,
  });
  const startupQueries = queries.slice().sort((a, b) => a.startedAtMs - b.startedAtMs).slice(0, 12).map(compact);
  const planQueries = queries.filter((query) => query.name === 'plans.list' || query.name === 'advRoster.list').slice(-12);
  const planTraceIds = new Set(planQueries.map((query) => query.traceId).filter(Boolean));
  const planStages = (snapshot?.stages?.recent ?? []).filter((sample) =>
    sample.traceId && planTraceIds.has(sample.traceId)).slice(-64);
  const capturedAttribution = attribution ?? {
    lcp: (window as unknown as { __wv_lcp?: unknown }).__wv_lcp ?? null,
    lcpAttributionError: (window as unknown as { __wv_lcp_error?: string }).__wv_lcp_error ?? null,
  };
  const runtime = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (command: string) => Promise<{ client?: string; ownerIsContentOrigin?: boolean }> };
  }).__TAURI_INTERNALS__;
  const ipcClient = await (async () => {
    if (!runtime?.invoke) return { kind: 'unavailable' as const };
    try {
      const status = await runtime.invoke('endpoint_ipc_status');
      return { kind: 'ok' as const, client: status?.client ?? null, ownerIsContentOrigin: status?.ownerIsContentOrigin ?? null };
    } catch (error) {
      return { kind: 'error' as const, error: String(error).slice(0, 160) };
    }
  })();
  const beforePaint = (paintMs: number | null) => {
    // The ring holds completed requests. A request that finishes after paint
    // contributes no evidence of a blocking pre-paint request interval.
    const started = queries.filter((query) => paintMs !== null && query.startedAtMs <= paintMs);
    const completed = started.filter((query) => query.startedAtMs + query.waitMs + query.requestMs <= paintMs!);
    return {
      paintMs, queryCountCompleted: completed.length, startedCompletedLater: started.length - completed.length,
      longestWaits: completed.slice().sort((a, b) => b.waitMs - a.waitMs).slice(0, 10).map(compact),
      longestRequests: completed.slice().sort((a, b) => b.requestMs - a.requestMs).slice(0, 10).map(compact),
    };
  };
  const fcp = beforePaint(fcpMs);
  const lcp = beforePaint(lcpMs);
  const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .sort((a, b) => b.duration - a.duration).slice(0, 12)
    .map((entry) => ({ path: new URL(entry.name, location.href).pathname, startMs: Math.round(entry.startTime),
      durationMs: Math.round(entry.duration), endMs: Math.round(entry.startTime + entry.duration), initiator: entry.initiatorType }));
  const accountsImport = performance.getEntriesByName('accounts-tab-import', 'measure').at(-1);
  return {
    documentClock, storage, readyState: document.readyState, resources, scheduler: snapshot?.scheduler ?? null,
    startupImports: { accountsTab: accountsImport ? {
      startMs: Math.round(accountsImport.startTime), durationMs: Math.round(accountsImport.duration),
      endMs: Math.round(accountsImport.startTime + accountsImport.duration),
    } : null },
    syncTrace: { unit: 'ms' as const, clock: 'performance.now' as const, startupQueries,
      planQueries: planQueries.map(compact), planStages },
    ...capturedAttribution,
    ipc: { client: ipcClient, assertionTimedOut: snapshot?.ipcAssertTimedOut ?? null,
      assertionLastClient: snapshot?.ipcAssertLastClient ?? null, assertion: snapshot?.ipcAssertion ?? [] },
    queryCountCompletedBeforeFcp: fcp.queryCountCompleted,
    startedBeforeFcpCompletedLater: fcp.startedCompletedLater,
    longestWaitsCompletedBeforeFcp: fcp.longestWaits,
    longestRequestsCompletedBeforeFcp: fcp.longestRequests,
    beforeLcp: lcp,
    longTasksSupported: PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false,
  };
}

/** The shared smoke/combined-load diagnostic runs before popup interaction. */
export async function collectPageStartupTrace(browser: Browser, reading: WebVitalsReading) {
  return browser.execute(readPageStartupTrace, { fcpMs: reading.metrics.FCP ?? null,
    lcpMs: reading.metrics.LCP ?? null, attribution: reading.attribution });
}

export async function collectWebVitals(
  browser: Browser,
  { settleMs = 3_000 }: { settleMs?: number } = {},
): Promise<WebVitalsReading> {
  const bundle = buildWebVitalsBundle();

  // Identity of the document we are about to inject into. Minted here if absent,
  // using the SAME key app-mount.ts uses, so mount and probe agree on what "this
  // document" means rather than each keeping a private notion of it.
  const docTokenAtInjection = (await browser.execute(() => {
    const w = window as unknown as { __papercusp_perf_doc__?: string };
    if (!w.__papercusp_perf_doc__) {
      w.__papercusp_perf_doc__ =
        "doc-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
    }
    return w.__papercusp_perf_doc__;
  })) as string | null;

  // Two sentinels around the payload (see injected-instrument.ts):
  //  - __wv_injected FIRST and OUTSIDE the try, so "the script ran" survives a
  //    throw. It cannot be inferred from the payload's own state: esbuild hoists
  //    the library above the payload's first line (measured: web-vitals 5.3.0 →
  //    9,875 bytes, first payload assignment at offset 9,412), so a throw during
  //    library init leaves every payload-owned global unset.
  //  - __wv_fatal captures the throw. An uncaught error inside an injected
  //    inline <script> goes to the page's error handler, NOT to browser.execute,
  //    so without this the single most diagnostic fact is silently discarded.
  const instrumented =
    `window.__wv_injected = true;\n` +
    `try {\n${bundle}\n} catch (e) {\n` +
    `  window.__wv_fatal = String((e && (e.stack || e.message)) || e);\n` +
    `}`;

  // Inline <script> rather than a module or a CDN fetch: this is the mechanism
  // measured working under papercusp:// (probe 4 test A).
  await browser.execute((src: string) => {
    const el = document.createElement("script");
    el.textContent = src;
    document.head.appendChild(el);
    el.remove();
  }, instrumented);

  await browser.pause(settleMs);

  // Read the token WITHOUT minting: absence must remain observable here, because
  // a fresh document is exactly the evidence of replacement. Minting on read (as
  // the mount probe does) would manufacture a token and disguise the reload.
  const raw = (await browser.execute(() => {
    const w = window as unknown as {
      __wv?: Record<string, number>;
      __wv_ready?: boolean;
      __wv_errors?: string[];
      __wv_injected?: boolean;
      __wv_fatal?: string;
      __wv_lcp?: unknown;
      __wv_lcp_error?: string;
      __papercusp_perf_doc__?: string;
    };
    return {
      ready: w.__wv_ready === true,
      metrics: w.__wv ?? null,
      attribution: { lcp: w.__wv_lcp ?? null, lcpAttributionError: w.__wv_lcp_error ?? null },
      errors: w.__wv_errors ?? [],
      injected: w.__wv_injected === true,
      fatal: w.__wv_fatal ?? null,
      docToken: w.__papercusp_perf_doc__ ?? null,
      // WHERE the document went. Knowing it was replaced identifies the failure;
      // knowing what replaced it identifies the CULPRIT, and that is the next
      // question every single time — without it the finding is "something
      // navigated", which no one can act on.
      url: String(window.location ? window.location.href : "(no location)"),
      readyState: String(document.readyState),
    };
  })) as {
    ready: boolean;
    metrics: Record<string, number> | null;
    attribution: NonNullable<WebVitalsReading['attribution']>;
    errors: string[];
    injected: boolean;
    fatal: string | null;
    docToken: string | null;
    url: string;
    readyState: string;
  };

  const verdict = classifyInjectedInstrument({
    docTokenAtInjection,
    docTokenAfterSettle: raw.docToken,
    injectedSentinel: raw.injected,
    fatal: raw.fatal,
    readySentinel: raw.ready,
  });

  if (verdict.state !== "ready") {
    return {
      instrument: verdict.state,
      brokenReason:
        verdict.reason +
        `\n  now at: ${raw.url} (readyState: ${raw.readyState})` +
        (verdict.replacementChecked
          ? ""
          : " (NOTE: no injection-time document token was readable, so replacement " +
            "could not be ruled out — this verdict assumes the document survived.)"),
      metrics: {},
      missingExpected: [],
      absentByEnvironment: [],
      errors: raw.errors ?? [],
    };
  }

  const metrics = (raw.metrics ?? {}) as Partial<Record<WebVitalName, number>>;
  const missingExpected: WebVitalName[] = [];
  const absentByEnvironment: WebVitalName[] = [];

  for (const name of Object.keys(METRIC_ENVIRONMENT) as WebVitalName[]) {
    const present = typeof metrics[name] === "number" && Number.isFinite(metrics[name]);
    if (present) continue;
    if (METRIC_ENVIRONMENT[name].availability === "expected") missingExpected.push(name);
    else absentByEnvironment.push(name);
  }

  return {
    instrument: "ready",
    brokenReason: null,
    metrics,
    attribution: raw.attribution,
    missingExpected,
    absentByEnvironment,
    errors: raw.errors ?? [],
  };
}

/** Human-readable one-liner for the run log. */
export function describeReading(reading: WebVitalsReading): string {
  if (reading.instrument !== "ready") {
    // The STATE is in the headline, not just the prose: a reader scanning a
    // 15,000-line run log sees which of the four causes this was without
    // parsing the sentence after it.
    return `web-vitals: INSTRUMENT ${reading.instrument.toUpperCase()} — ${reading.brokenReason ?? "unknown"}`;
  }
  const got = (Object.keys(reading.metrics) as WebVitalName[])
    .map((k) => `${k}=${reading.metrics[k]}`)
    .join(" ");
  const skipped = reading.absentByEnvironment
    .map((k) => `${k}(${METRIC_ENVIRONMENT[k].availability})`)
    .join(" ");
  return `web-vitals: ready — observed [${got || "none"}]; not-applicable [${skipped || "none"}]`;
}
