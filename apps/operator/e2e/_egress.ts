/**
 * The shared network-egress fixture (egress-monitor-origin-axis-2026-08-02 P-005).
 *
 * WHAT THIS IS. Every spec in this directory imports `test` from HERE instead of
 * from `@playwright/test`. That single swap turns all 46 existing specs into
 * network-egress tests at zero authoring cost: whatever the spec clicks through,
 * an auto fixture watches every request the browser makes and fails the test if
 * one went to an origin we do not own. This is the automated, maintained form of
 * "click through the whole app watching the network" — the click coverage already
 * exists and is already kept up to date by everyone who adds a spec.
 *
 * WHY THIS LEG EXISTS AT ALL (plan D-003). Three legs, each blind where the
 * others see:
 *   - `lint:no-cdn-egress` (P-004) greps the BUILT bundle. It catches code that
 *     is never exercised, and it CANNOT prove any of it actually runs.
 *   - THIS fixture observes the live browser. It catches dynamically constructed
 *     URLs a grep cannot see, and — the part the static scan structurally cannot
 *     do — it proves LIVENESS. Per the sibling plan's D-004, a URL in the bundle
 *     is a DISCOVERY, never a verdict: every fix in this class overrides a URL at
 *     runtime, so the library's default string survives in the bundle whether the
 *     fix worked or not.
 *   - CSP (P-006) prevents rather than observes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONLY THE `foreignOrigin` AXIS IS ASSERTED HERE, AND THAT IS NOT AN OVERSIGHT.
 *
 * `classifyEgress` reports two orthogonal invariants (P-002). The `ipc-escape`
 * axis says an `/api/*` call reached the network stack instead of travelling over
 * IPC — a real bug INSIDE THE TAURI SHELL, where the webview has no usable
 * network stack. Playwright drives a plain Chromium browser, where HTTP to
 * `/api/*` is the sanctioned transport. Asserting that axis here would fail every
 * single spec for doing exactly the right thing.
 *
 * So: the transport axis belongs to the desktop shell's own monitor, the
 * destination axis belongs here. `report.foreignOrigin` is the one we read.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A CONTROL REQUEST (this is the load-bearing part).
 *
 * A watcher that observes nothing and a watcher that is broken report the same
 * number: zero. An egress fixture is therefore the textbook shape of a vacuous
 * pass — silently observe nothing, assert "no foreign origins", go green forever.
 * That failure is not hypothetical in this repo: a fixture that drifted out of a
 * production filter's accept set turned every negative assertion downstream into
 * a tautology and reported a healthy gate for three weeks
 * (/internal/docs/agent-insights/fixture-drift-produces-vacuous-passes).
 *
 * `classifyEgress` already refuses to launder that zero: its verdict is
 * THREE-valued, and it returns `clean` only once `sensor.controlObserved` proves
 * the sensor was alive. We do not re-implement that rule, we satisfy it — at
 * teardown the fixture makes ONE deliberate request carrying
 * `EGRESS_CONTROL_PARAM` and checks that its own observer saw it. If it did not,
 * the verdict is `unknown` and this fixture FAILS THE TEST rather than passing it.
 *
 * `unknown` is a failure, not a pass. Do not "fix" a SENSOR FAILURE by relaxing
 * it into a skip — that converts this file back into the thing it exists to
 * prevent.
 *
 * (The control request can never mask a real escape: `classifyEgress` skips
 * entries carrying that query parameter, so a genuine offender would have to
 * carry the exact control parameter to hide behind it.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECLARING A LEGITIMATE FOREIGN ORIGIN.
 *
 * There is no ambient allowlist here on purpose — a shared one is where "just
 * this once" quietly becomes the norm. A spec that legitimately reaches a foreign
 * origin declares it AT THE SPEC, where a reviewer reads it next to the reason:
 *
 *     test.use({ egressAllowedOrigins: ['https://example.com'] });
 *
 * Loopback is never foreign and is not expressed that way — see LOCAL_HOSTNAMES
 * in egress-monitor.ts.
 */
import { test as base, expect, type Page } from '@playwright/test';
import {
  classifyEgress,
  EGRESS_CONTROL_PARAM,
  type EgressReport,
  type EgressSensorState,
  type ResourceTimingLike,
} from '../../../libs/generic/desktop-ipc/src/egress-monitor';

// Re-exported so a spec's import line is a pure module-specifier swap: every
// symbol the specs took from '@playwright/test' is available from here.
export {
  expect,
  devices,
  request,
  type Page,
  type Locator,
  type Route,
  type APIRequestContext,
  type BrowserContext,
  type TestInfo,
} from '@playwright/test';

/**
 * Assert that the shell/dock/SPA a spec depends on actually mounted — use this
 * instead of `test.skip(!mounted, msg)` for a mount/render precondition.
 *
 * WHY THIS EXISTS (EI-19917451944474469). `test.skip()` exits the process with
 * status 0. That is indistinguishable from a genuine pass to anything reading
 * only the exit code — CI, a wrapper script, or an agent claiming "e2e green" —
 * so a spec whose only local invocation path can silently no-op is *worse* than
 * one that fails outright: it launders a real problem (the shell didn't mount)
 * into a green checkmark. Same class as the zero-work false-greens already
 * fixed for `tsc -p .`, `test:affected`, and `test:file -t <no match>`.
 *
 * A handful of skips in this directory are genuinely conditional and are NOT
 * this class — "no superuser token, can't auth /api/admin/*", "no non-legacy
 * plan with items exists" — those describe a fixture/credential that legitimately
 * may not exist and `test.skip()` remains correct for them. This helper is only
 * for "the SPA/dock/shell failed to mount", which is always either a real
 * regression or a genuine environment misconfiguration — either way, loud.
 *
 * Do NOT bake a specific root cause into `context` (e.g. "stale HMR-disabled
 * :3055 serves a blank #root"). That was the ORIGINAL wording here and it was
 * measured wrong at least once: HMR was confirmed live (a real `/@vite/client`
 * module, not the noop stub) while the mount still failed for an undiagnosed
 * reason. State only what is actually known — the route/slug attempted and
 * where to look — never a canned diagnosis nobody has re-verified recently.
 */
export function assertMounted(mounted: boolean, context: string): asserts mounted {
  if (mounted) return;
  throw new Error(
    `${context}\n\n` +
      'This is a hard failure, not a skip — a mount failure here used to exit 0 ' +
      '(a false green; see EI-19917451944474469). If this truly is an unrunnable ' +
      'local environment, fix the environment (OPERATOR_E2E_REUSE_SERVER pointed at ' +
      'an HMR-enabled vite, a free :3055, correct route stubs) rather than relying on ' +
      'this spec to silently no-op past it.',
  );
}

/** What a spec may configure, via `test.use({ ... })`. */
export interface EgressFixtureOptions {
  /**
   * Non-local origins this spec is ALLOWED to reach, as exact origins
   * (`https://example.com`). Each entry is a declared, reviewed hole in the
   * destination invariant — state the reason in a comment at the call site.
   */
  egressAllowedOrigins: readonly string[];
}

export interface EgressFixtures {
  /**
   * The audit itself. Auto-runs for every test; a spec never has to touch it.
   * Exposed so a spec can read the live report mid-test (rarely needed).
   */
  egressAudit: {
    /** Classify what has been observed SO FAR. Does not run the control. */
    report(): EgressReport;
    /** Every request URL observed so far, in order. */
    observed(): readonly string[];
  };
}

/**
 * Requests we deliberately do not count, because they are the browser's own
 * behaviour rather than the application's. Kept as a short, explicit list: an
 * entry here is a blind spot, so it must be worth naming.
 */
const IGNORED_URL_PREFIXES: readonly string[] = [
  // Chromium asks its own update/variations services in some environments. Not
  // our page's traffic and not something the app can cause.
  'https://accounts.google.com/ListAccounts',
  'https://optimizationguide-pa.googleapis.com/',
  'https://update.googleapis.com/',
];

function isIgnored(url: string): boolean {
  return IGNORED_URL_PREFIXES.some((p) => url.startsWith(p));
}

/**
 * Render the failure a human has to act on. The rollup is per-ORIGIN because a
 * CDN offender is one host serving many paths (monaco alone pulls a dozen
 * chunks), so listing entries would bury one bug under fifteen rows.
 */
function describeBreach(report: EgressReport): string {
  const lines: string[] = [
    `Network egress to ${Object.keys(report.foreignOrigin.byOrigin).length} foreign origin(s) ` +
      `(${report.foreignOrigin.total} request(s)) during this test.`,
    '',
    'A request left for a host we do not own. In the desktop app that is a',
    'privacy + offline-correctness bug: the shipped product must not depend on a',
    'third-party CDN being reachable, and must not tell one what our users open.',
    '',
  ];
  for (const [origin, agg] of Object.entries(report.foreignOrigin.byOrigin)) {
    lines.push(`  ${origin}  (${agg.count} request(s), first at ${Math.round(agg.firstAtMs)}ms)`);
    lines.push(`    e.g. ${agg.sampleUrl}`);
  }
  lines.push('');
  lines.push('Fix it at the source (vendor the asset locally / point the library at a');
  lines.push('local path), or — if this origin is genuinely legitimate for this spec —');
  lines.push("declare it: test.use({ egressAllowedOrigins: ['<origin>'] })");
  return lines.join('\n');
}

/** The message for a sensor that could not prove itself. */
function describeSensorFailure(sensor: EgressSensorState, observedCount: number): string {
  return [
    'EGRESS SENSOR FAILURE — this test did NOT pass an egress check, it failed to run one.',
    '',
    `The fixture observed ${observedCount} request(s) but never saw its own control`,
    'request, so it cannot tell "nothing escaped" from "the watcher was broken".',
    'Both look like zero, which is exactly why this is a failure and not a pass.',
    '',
    `sensor.blindTo: ${sensor.blindTo.join(' | ') || '(nothing declared)'}`,
    '',
    'This usually means the page was closed or navigated away before teardown.',
    'Fix the sensor (or the spec), never the assertion.',
  ].join('\n');
}

export const test = base.extend<EgressFixtureOptions & EgressFixtures>({
  // Declared per-spec via test.use(). Empty by default and it should stay that
  // way — see the header.
  egressAllowedOrigins: [[], { option: true }],

  egressAudit: [
    async ({ context, page, baseURL, egressAllowedOrigins }, use, testInfo) => {
      const t0 = Date.now();
      const observed: ResourceTimingLike[] = [];
      const blindTo: string[] = [];
      const browserDiagnostics = {
        pageErrors: [] as string[],
        failedScripts: [] as Array<{ path: string; error: string }>,
      };

      const record = (url: string, via: ResourceTimingLike['via']): void => {
        if (isIgnored(url)) return;
        observed.push({ name: url, startTime: Date.now() - t0, duration: 0, via });
      };

      // CONTEXT level, not page level: this also covers popups and any page the
      // spec opens later, which a page-level listener would miss entirely.
      const onRequest = (req: { url(): string }): void => record(req.url(), 'resource-timing');
      context.on('request', onRequest);
      const onRequestFailed = (req: {
        url(): string;
        resourceType(): string;
        failure(): { errorText: string } | null;
      }): void => {
        if (req.resourceType() !== 'script') return;
        // Diagnostic URLs retain the module path, never query credentials.
        browserDiagnostics.failedScripts.push({
          path: new URL(req.url()).pathname,
          error: req.failure()?.errorText ?? 'unknown',
        });
      };
      context.on('requestfailed', onRequestFailed);

      // WebSockets are a SEPARATE event in Playwright — they do not arrive as
      // 'request'. Desktop sync is SSE-primary but the browser fallback is WS, so
      // without this the fixture would be blind to the app's own live transport.
      const onWebSocket = (ws: { url(): string }): void => record(ws.url(), 'websocket');
      const onPageError = (error: Error): void => { browserDiagnostics.pageErrors.push(error.message); };
      const attachPage = (p: Page): void => {
        p.on('websocket', onWebSocket);
        p.on('pageerror', onPageError);
      };
      for (const p of context.pages()) attachPage(p);
      context.on('page', attachPage);

      const state: EgressSensorState = {
        controlObserved: false,
        resourceTiming: true,
        transportsWrapped: true,
        blindTo,
      };
      const options = { documentOrigin: baseURL, allowedOrigins: egressAllowedOrigins };

      await use({
        report: () => classifyEgress(observed, options, state),
        observed: () => observed.map((o) => o.name),
      });

      // A mount/sync assertion can fail before the spec reaches its own error
      // checks. Preserve those errors before touching a potentially closed page
      // for the sensor control, without replacing the original failure.
      if (testInfo.status !== undefined && testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('browser-diagnostics', {
          body: JSON.stringify(browserDiagnostics, null, 2),
          contentType: 'application/json',
        });
      }

      // ---- teardown: prove the sensor was alive, then judge ------------------
      // The control must be issued from the PAGE: context.request.* is a
      // Node-side fetch that never emits a page 'request' event, so using it
      // would leave the sensor permanently unproven — a false SENSOR FAILURE on
      // every test.
      const controlUrl = `${baseURL ?? 'http://localhost:3055'}/favicon.ico?${EGRESS_CONTROL_PARAM}=1`;
      try {
        await page.evaluate(
          (u) => fetch(u, { cache: 'no-store' }).catch(() => undefined),
          controlUrl,
        );
        // The event is delivered asynchronously; give it a beat to arrive rather
        // than racing teardown and reporting a spurious sensor failure.
        await page.waitForTimeout(50);
      } catch (err) {
        blindTo.push(
          `control request could not be issued (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      state.controlObserved = observed.some((o) => o.name.includes(EGRESS_CONTROL_PARAM));

      context.off('request', onRequest);
      context.off('requestfailed', onRequestFailed);
      context.off('page', attachPage);
      for (const p of context.pages()) {
        p.off('websocket', onWebSocket);
        p.off('pageerror', onPageError);
      }

      // A test that already failed gets no extra noise piled on: the spec's own
      // failure is the one to act on, and an egress breach behind it will surface
      // as soon as that is fixed. Recorded rather than silently dropped.
      if (testInfo.status !== undefined && testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('egress-report', {
          body: JSON.stringify(classifyEgress(observed, options, state), null, 2),
          contentType: 'application/json',
        });
        return;
      }

      const report = classifyEgress(observed, options, state);
      const axis = report.foreignOrigin;

      if (axis.verdict === 'breach') {
        await testInfo.attach('egress-report', {
          body: JSON.stringify(report, null, 2),
          contentType: 'application/json',
        });
        expect(axis.entries, describeBreach(report)).toEqual([]);
      }

      // `unknown` is a dead detector reporting a zero. Fail it.
      expect(axis.verdict, describeSensorFailure(state, observed.length)).not.toBe('unknown');
    },
    { auto: true },
  ],
});
