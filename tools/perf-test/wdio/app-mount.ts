/**
 * The one place this suite decides "the operator UI is up".
 *
 * WHY THIS IS SHARED (EI-18885442084466501). The wait used to be a `30_000`
 * literal copy-pasted into all four specs with an identical `timeoutMsg`. When
 * the packaged app stopped booting, all four failed the same way — and because
 * the number lived in four places, the failure read as four independent flaky
 * specs rather than one shared precondition. Nobody can tune, justify, or fix a
 * constant that exists four times.
 *
 * WHY IT ASSERTS *WHICH* SCREEN (EI-18889416741921988). The predicate used to be
 * `#root has a first child`. The onboarding screen renders into `#root` too, so
 * that predicate could not tell the operator UI from a first-run lookalike — and
 * on 2026-07-28 every packaged run had been measuring `/onboarding` while
 * reporting numbers labelled as the operator shell (`command-palette-open =
 * 24ms` against a 400ms budget, which is exactly what an empty tutorial screen
 * costs). A mount predicate that matches the wrong screen returns the SAME value
 * whether the app is healthy or the app never got past first-run: it can only
 * ever confirm, never falsify. That is not a check.
 */
import type { Browser } from "webdriverio";
// Imported by PATH, not by package name, on purpose: this runner is deliberately
// outside the npm workspace set (it has its own lockfile so a perf run cannot be
// broken by a peer's install mid-run), so `@papercusp/gui-readiness` does not
// resolve here. The module is dependency-free, which is what makes reaching
// across for it safe.
import {
  classifyMountObservation,
  INITIAL_MOUNT_PROGRESS,
  type DocumentObservation,
  type MountClassifierConfig,
  type MountProgress,
  type MountVerdict,
} from "../../../libs/generic/gui-readiness/src/document-mount";

/**
 * WebdriverIO's `waitUntil` retries rejected predicates until its timeout.
 * That's useful for transient DOM/protocol errors, but an invalid session or a
 * crashed WebKit page cannot recover through another poll. Detect those terminal
 * responses before they are mistaken for ordinary precondition failures.
 */
export function isTerminalWebDriverSessionError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const messages: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      messages.push(current);
      continue;
    }
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    const record = current as Record<string, unknown>;
    for (const key of ["name", "message", "error", "stack"]) {
      if (typeof record[key] === "string") messages.push(record[key] as string);
    }
    for (const key of ["cause", "response", "body", "data"]) {
      if (record[key] !== undefined) pending.push(record[key]);
    }
  }

  const compact = messages.join(" ").toLowerCase().replace(/[^a-z0-9]/g, "");
  return /invalidsessionid|pagecrashorhang|sessionterminatedwithoutreply/.test(compact);
}

/**
 * Run a WDIO wait while turning terminal session errors into an immediate
 * failure. A truthy sentinel ends WDIO's internal Timer; the original error is
 * rethrown after the Timer has stopped, so it cannot issue another dead-session
 * command on the next interval.
 */
export async function waitUntilOrFailOnTerminalSession(
  browser: Browser,
  condition: () => boolean | Promise<boolean>,
  options: Parameters<Browser["waitUntil"]>[1] = {},
): Promise<void> {
  let terminalSessionError: unknown;
  let sawTerminalSessionError = false;

  await browser.waitUntil(async () => {
    try {
      return await condition();
    } catch (error) {
      if (!isTerminalWebDriverSessionError(error)) throw error;
      terminalSessionError = error;
      sawTerminalSessionError = true;
      return true;
    }
  }, options);

  if (sawTerminalSessionError) throw terminalSessionError;
}

/**
 * How long to wait for real app content.
 *
 * DERIVED, not guessed — and deliberately larger than it "looks like it should
 * be". The app's own `operator_boot_timeout` is **120s**
 * (papercusp-desktop/src-tauri/src/main.rs), which bounds how long it may spend
 * bringing up its operator — embedded-PG initdb plus migrations on a first boot,
 * on a box this suite shares with the rest of the fleet. A UI-mount wait shorter
 * than that cannot distinguish "slow but healthy first boot" from "never coming
 * up": it expires while the app is still legitimately working, and reports a UI
 * problem. The old 30s value could not have passed even in principle.
 *
 * The cost of being generous is now bounded twice over: `wdio.conf.ts`'s
 * installation preflight catches the STRUCTURAL failure (an app that can never
 * boot) in ~1ms before any spec runs, and a first-run landing (below) aborts in
 * seconds rather than burning the whole budget. So this timeout is only ever
 * spent on a genuinely slow boot — the case where waiting is the correct
 * behaviour.
 */
export const APP_MOUNT_TIMEOUT_MS = Number(
  process.env.PAPERCUSP_PERF_MOUNT_TIMEOUT_MS ?? 180_000,
);

/** Wait for Tauri's actual document URL before a spec constructs a scoped route.
 * A new WebDriver session can still report `about:blank`; changing its pathname
 * produces `about:blank?ws=...`, which never mounts the packaged operator. */
export async function waitForPackagedAppUrl(
  browser: Browser,
  timeoutMs = APP_MOUNT_TIMEOUT_MS,
): Promise<string> {
  const state = { appUrl: '' };
  let lastUrl = '(unread)';
  try {
    await waitUntilOrFailOnTerminalSession(browser, async () => {
      lastUrl = await browser.getUrl();
      try {
        const parsed = new URL(lastUrl);
        if (!parsed.host || parsed.protocol === 'about:') return false;
        state.appUrl = parsed.toString();
        return true;
      } catch {
        return false;
      }
    }, { timeout: timeoutMs, interval: 500, timeoutMsg: 'packaged app URL did not become ready' });
  } catch (error) {
    throw new Error(`Packaged app URL unavailable; last URL ${lastUrl}: ${String(error)}`, { cause: error });
  }
  if (!state.appUrl) throw new Error(`Packaged app URL unavailable; last URL ${lastUrl}`);
  return state.appUrl;
}

/**
 * Headroom the enclosing test framework must leave ON TOP of the mount wait,
 * so the diagnosis below can actually be produced and printed.
 *
 * WHY THIS EXISTS (run 6, 2026-07-28). `mochaOpts.timeout` was `60_000` while
 * `APP_MOUNT_TIMEOUT_MS` was `180_000`. Mocha therefore killed every spec a full
 * two minutes before the mount wait could expire — so `mountTimeoutDiagnosis`
 * NEVER RAN, not once, and all four specs failed with a bare `Error: Timeout`
 * carrying no information whatsoever. The generous 180s budget justified in such
 * detail above was a fiction: unreachable in principle, in every run since it
 * landed.
 *
 * That is this suite's recurring defect wearing a new hat — a check whose
 * failure mode is indistinguishable from its success mode, here degraded to a
 * DIAGNOSIS THAT CAN NEVER FIRE. The fix is not a bigger number in the config;
 * it is removing the ability of the two numbers to disagree. `wdio.conf.ts`
 * derives its mocha timeout from `SPEC_TIMEOUT_MS`, and `app-mount.test.ts`
 * asserts the ordering, so this cannot silently re-invert.
 *
 * 30s is sized for the WORK the diagnosis does, not padding: `firstRunDiagnosis`
 * polls the gateway for up to 5s, and both paths issue several further
 * `executeScript` round-trips while the app is by definition unhealthy.
 */
export const MOUNT_DIAGNOSIS_HEADROOM_MS = 30_000;

/**
 * The per-spec timeout this suite MUST run with. Never hardcode a spec timeout:
 * import this, so the framework's patience is always strictly greater than the
 * mount wait it encloses.
 */
export const SPEC_TIMEOUT_MS = APP_MOUNT_TIMEOUT_MS + MOUNT_DIAGNOSIS_HEADROOM_MS;

/**
 * How long a destroyed document must persist before we call the webview dead.
 *
 * Short, because this state is not a race: a document REPLACED after we already
 * saw it render is either a navigation (the new document gets its own `#root`
 * within a frame or two) or a death (no `#root`, ever). The dwell only exists so
 * the instant between "old document torn down" and "new document parsed" cannot
 * be mistaken for the terminal case.
 */
const WEBVIEW_DEATH_DWELL_MS = 2_000;

/**
 * How long a first-run landing must persist before we call it terminal.
 *
 * The root route's gateway redirect is one-shot: once TanStack Router has
 * resolved `/` to `/onboarding`, nothing will navigate away on its own. Waiting
 * out the full mount timeout there buys nothing and costs 3 minutes PER SPEC, so
 * a stable first-run landing aborts early. The dwell exists only so a redirect
 * observed mid-flight cannot trip the abort.
 */
const FIRST_RUN_DWELL_MS = 5_000;

/**
 * What proves the OPERATOR shell specifically — not merely "React rendered".
 *
 * Two selectors on purpose. `data-testid="operator-shell"` is the explicit
 * contract (added to `AdvShell` alongside this change); `.pc-advshell` is the
 * class that shell has always carried, and is what a binary built BEFORE the
 * testid landed still exposes. Accepting either means this suite works against
 * the already-packaged deb without a 3-minute rebuild, and keeps working once
 * the testid ships. Drop the class arm once no pre-testid binary is in play.
 */
const OPERATOR_SHELL_SELECTOR = '[data-testid="operator-shell"], .pc-advshell';

/** Routes that are explicitly NOT the operator UI, with why landing there means. */
const NON_SHELL_ROUTES: ReadonlyArray<{ path: string; meaning: string }> = [
  {
    path: "/onboarding",
    meaning:
      "the agent-chat FIRST-RUN console — the root gateway sends you here when " +
      "GET /api/desktop/setup-wizard-state answers without a `finished_at` (a profile that " +
      "has never completed setup) OR answers non-2xx at all (see apps/operator-vite/src/routes/index.tsx)",
  },
  {
    path: "/setup",
    meaning:
      "the classic GUI setup wizard — same gateway condition as /onboarding, taken when " +
      "the ONBOARDING_AGENT_FIRST flag is off",
  },
  { path: "/login", meaning: "the sign-in surface — this instance has no authenticated session" },
  { path: "/signup", meaning: "the sign-up surface — this instance has no account" },
];

/**
 * Routes that ARE the operator app but never render `AdvShell`.
 *
 * The opposite failure from `NON_SHELL_ROUTES` above, and it must not be
 * conflated with it. There, landing on the route means the app never reached the
 * operator UI at all — a product or provisioning bug. Here the app is perfectly
 * healthy and the SPEC is simply standing on the wrong route, so the shell
 * marker can never appear however long the wait runs. Both are terminal (waiting
 * cannot improve either), but they have opposite causes and opposite fixes, so
 * they get opposite diagnoses.
 *
 * WHY THIS LIST EXISTS AT ALL (WI-38449): `broader-interactions.perf.spec.ts`
 * SPA-navigates to `/workbench` in one test and does not navigate back. The next
 * test opened with `waitForAppMount`, which then burned the FULL
 * `APP_MOUNT_TIMEOUT_MS` and reported "the app RENDERED but the operator-shell
 * marker never appeared — suspect the marker". That diagnosis is wrong in the
 * most expensive possible way: the marker was fine, `AdvShell` still carries it,
 * and the reader is sent to audit the app instead of the route. The suite fails
 * as a unit, so the scheduled producer posted NOTHING to
 * `harness_shared.desktop_perf_runs` from 2026-08-02 to 2026-08-16 and
 * `DESKTOP_PERF_GATE` fail-soft PASSED every deploy in that window while
 * measuring nothing at all.
 */
const NON_SHELL_OPERATOR_ROUTES: ReadonlyArray<{ path: string; meaning: string }> = [
  {
    path: "/workbench",
    meaning:
      "the top-level desktop workbench — it mounts <HarnessDock layoutName=\"workbench\"/> " +
      "directly (apps/operator-vite/src/routes/workbench.tsx) and never renders AdvShell, " +
      "so the operator-shell marker cannot appear on this route",
  },
];

const matchRoute = (
  list: ReadonlyArray<{ path: string; meaning: string }>,
  pathname: string,
): { path: string; meaning: string } | null =>
  list.find((r) => pathname === r.path || pathname.startsWith(`${r.path}/`)) ?? null;

/**
 * Everything the suite knows about the document at a point in time.
 *
 * Returned by `waitForAppMount` so a later probe can be compared AGAINST the
 * mount rather than guessed about. `docToken` is the load-bearing field: it is
 * minted into `window` on first read and dies with the document, so
 * `probe.docToken !== mount.docToken` is a DEFINITIVE "the webview was
 * replaced", where `resourceEntries === 0` was only ever an inference (and one
 * that cannot distinguish a replaced document from a webview where resource
 * timing simply is not recorded — see the egress spec).
 */
export interface MountEvidence {
  url: string;
  pathname: string;
  /** Identity of THIS document. Changes iff the document was replaced. */
  docToken: string;
  /** `-1` when `#root` itself is absent — distinct from present-but-empty. */
  rootChildren: number;
  resourceEntries: number;
  shellPresent: boolean;
  readyState: string;
  /**
   * What the document IS, for the case where `#root` is absent.
   *
   * Run 6 spent 94 consecutive polls reporting `rootChildren: -1` — a field that
   * can only ever say what the document is NOT. Identifying the replacement
   * document then required a second run. These three say what it IS in the first
   * one: an error page has a title and body text, a blank crash-replacement page
   * has neither, and a foreign app has both but wrong.
   */
  title: string;
  bodyChildren: number;
  bodyTextHead: string;
}

async function readDocument(browser: Browser): Promise<MountEvidence> {
  return (await browser.execute(function (shellSelector: string) {
    const w = window as unknown as { __papercusp_perf_doc__?: string };
    if (!w.__papercusp_perf_doc__) {
      w.__papercusp_perf_doc__ =
        "doc-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
    }
    const root = document.querySelector("#root");
    const body = document.body;
    // Never let the probe throw: a probe that can fail mid-diagnosis reports
    // nothing exactly when there is most to report.
    let bodyText = "";
    try {
      bodyText = String(body ? body.innerText || body.textContent || "" : "").slice(0, 200);
    } catch {
      bodyText = "(unreadable)";
    }
    return {
      url: String(window.location ? window.location.href : "(no location)"),
      pathname: String(window.location ? window.location.pathname : "(no location)"),
      docToken: w.__papercusp_perf_doc__,
      rootChildren: root ? root.childElementCount : -1,
      resourceEntries: performance.getEntriesByType("resource").length,
      shellPresent: Boolean(document.querySelector(shellSelector)),
      readyState: String(document.readyState),
      title: String(document.title || ""),
      bodyChildren: body ? body.childElementCount : -1,
      bodyTextHead: bodyText,
    };
  }, OPERATOR_SHELL_SELECTOR)) as MountEvidence;
}

/**
 * The decision itself lives in `@papercusp/gui-readiness` — it is a domain-free
 * state machine over document observations, and putting it there is what makes
 * it testable at all (this package is not an npm workspace member, so a test
 * beside this file would run under no framework). Everything below contributes
 * only the I/O, the clock, and this app's routes.
 */
const MOUNT_CLASSIFIER_CONFIG: MountClassifierConfig = {
  // BOTH terminal-wrong-screen families, not just first-run: a spec parked on a
  // non-shell operator route is every bit as unrecoverable as one parked on the
  // onboarding console, and treating it as "still waiting" is what turned a
  // one-line route mistake into a 13-day silent gate outage (WI-38449).
  isTerminalWrongScreen: isTerminalNonShellLanding,
  wrongScreenDwellMs: FIRST_RUN_DWELL_MS,
  documentDeathDwellMs: WEBVIEW_DEATH_DWELL_MS,
};

const toObservation = (ev: MountEvidence): DocumentObservation => ({
  pathname: ev.pathname,
  docToken: ev.docToken,
  rootChildren: ev.rootChildren,
  targetPresent: ev.shellPresent,
});

/**
 * Ask the app's OWN gateway endpoint what it answers, from inside the webview.
 *
 * This is the cheap instrumentation that decides the question the landing alone
 * cannot: a 200 carrying no `finished_at` means "this instance genuinely has no
 * completed profile" (a HARNESS gap — the suite must provision one), whereas a
 * non-2xx means the gateway dumped a set-up user into first-run because its
 * backend answered badly during boot (a PRODUCT bug — `index.tsx` deliberately
 * protects the UNREACHABLE case and then falls through to first-run on a bad
 * status). Guessing between those two cost two wrong diagnoses already.
 *
 * It runs INSIDE the webview on purpose: `fetch` there is the IPC-polyfilled
 * one, so this asks over the same transport the app itself uses, and adds no
 * HTTP egress of its own. Never throws — a diagnosis that can fail is a
 * diagnosis you cannot print.
 */
async function readFirstRunGateway(browser: Browser): Promise<string> {
  try {
    await browser.execute(function () {
      const w = window as unknown as { __papercusp_perf_gate__?: unknown };
      w.__papercusp_perf_gate__ = "pending";
      void fetch("/api/desktop/setup-wizard-state", { credentials: "same-origin" })
        .then(function (r) {
          return r.text().then(function (body) {
            w.__papercusp_perf_gate__ = {
              status: r.status,
              ok: r.ok,
              body: body.slice(0, 300),
            };
          });
        })
        .catch(function (e) {
          w.__papercusp_perf_gate__ = { error: String(e) };
        });
    });
    // Poll rather than one flat pause: a local IPC round-trip is milliseconds,
    // and a wedged backend should not add 5s to an already-failing spec.
    let result: unknown = "pending";
    for (let i = 0; i < 25; i += 1) {
      result = await browser.execute(function () {
        return (window as unknown as { __papercusp_perf_gate__?: unknown }).__papercusp_perf_gate__;
      });
      if (result !== "pending") break;
      await browser.pause(200);
    }
    if (result === "pending") return "GET /api/desktop/setup-wizard-state: no answer within 5s";
    return `GET /api/desktop/setup-wizard-state → ${JSON.stringify(result)}`;
  } catch (err) {
    return `GET /api/desktop/setup-wizard-state: could not be probed (${String(err)})`;
  }
}

function describeLanding(pathname: string): string | null {
  const hit =
    matchRoute(NON_SHELL_ROUTES, pathname) ?? matchRoute(NON_SHELL_OPERATOR_ROUTES, pathname);
  return hit ? hit.meaning : null;
}

function isFirstRunLanding(pathname: string): boolean {
  return matchRoute(NON_SHELL_ROUTES, pathname) !== null;
}

/**
 * Is this an operator route that structurally cannot render the shell?
 *
 * Exported because a SPEC is the only thing that can fix this condition: it has
 * to navigate back to the shell before it waits for it. `broader-interactions`
 * uses it to restore the route between tests rather than blanket-navigating on
 * every non-`/adv` path — a blanket restore would also paper over a genuine
 * first-run landing, which is precisely the false green
 * `waitForAppMount` exists to make impossible (EI-18889416741921988).
 */
export function isNonShellOperatorRoute(pathname: string): boolean {
  return matchRoute(NON_SHELL_OPERATOR_ROUTES, pathname) !== null;
}

function isTerminalNonShellLanding(pathname: string): boolean {
  return isFirstRunLanding(pathname) || isNonShellOperatorRoute(pathname);
}

/**
 * Resolve once the OPERATOR shell is rendered — and throw, loudly and by name,
 * when the app landed anywhere else.
 *
 * Every caller must use this rather than its own predicate: a spec that waits
 * for a weaker condition can start measuring the wrong screen, and the wrong
 * screen trivially satisfies most perf and egress assertions (it does little, so
 * it is fast and makes few requests). A false green there is the most dangerous
 * result this suite can produce — and, until EI-18889416741921988, the result it
 * was actually producing.
 *
 * Returns the mount evidence so a later probe can prove it is still looking at
 * the same document.
 */
export async function waitForAppMount(
  browser: Browser,
  timeoutMs = APP_MOUNT_TIMEOUT_MS,
): Promise<MountEvidence> {
  let last: MountEvidence | null = null;
  let progress: MountProgress = { ...INITIAL_MOUNT_PROGRESS };
  let terminal: MountVerdict | null = null;

  try {
    await waitUntilOrFailOnTerminalSession(
      browser,
      async () => {
        last = await readDocument(browser);
        const step = classifyMountObservation(
          progress,
          toObservation(last),
          Date.now(),
          MOUNT_CLASSIFIER_CONFIG,
        );
        progress = step.state;
        if (step.verdict === "mounted") return true;
        if (step.verdict === "waiting") return false;
        // A terminal verdict will never improve on its own — exit the wait and
        // let the matching diagnosis below do the talking.
        terminal = step.verdict;
        return true;
      },
      { timeout: timeoutMs, interval: 500, timeoutMsg: "app mount timed out" },
    );
  } catch (error) {
    if (isTerminalWebDriverSessionError(error)) {
      throw new Error(
        `WebDriver session terminated while waiting for the operator UI to mount: ${String(error)}`,
      );
    }
    throw new Error(await mountTimeoutDiagnosis(browser, last));
  }

  if (terminal === "wrongScreen") {
    const seen = last as unknown as MountEvidence | null;
    throw new Error(
      seen && isNonShellOperatorRoute(seen.pathname)
        ? wrongRouteDiagnosis(seen)
        : await firstRunDiagnosis(browser, seen),
    );
  }
  if (terminal === "documentDestroyed") throw new Error(webviewDiedDiagnosis(last, progress));
  return last as unknown as MountEvidence;
}

/**
 * The app is healthy; the SPEC is on a route that never renders the shell.
 *
 * Deliberately browser-free and blunt about WHOSE bug this is. The failure it
 * replaces read "the app RENDERED but the operator-shell marker never appeared —
 * suspect the marker", which points the reader at `AdvShell` and the app when
 * the marker is present and correct and the caller is simply standing somewhere
 * else. Naming the route, and naming the test that most likely left the caller
 * there, is the whole value here.
 */
function wrongRouteDiagnosis(seen: MountEvidence): string {
  return (
    `this spec is on a route that NEVER renders the operator shell — the app is fine, the ` +
    `ROUTE is wrong.\n\n` +
    `  standing at: ${seen.url}\n` +
    `  which is:    ${describeLanding(seen.pathname) ?? "not a shell route"}\n` +
    `  #root kids:  ${seen.rootChildren}   (it DID render — this is not a slow boot or a dead webview)\n\n` +
    `Waiting longer cannot fix this: no amount of time makes a route render a shell it does not\n` +
    `mount. Fix the CALLER, one of:\n` +
    `  • SPA-navigate back to the shell (\`/adv\`) before calling waitForAppMount; or\n` +
    `  • drop the waitForAppMount call and use this route's OWN readiness check (e.g. waiting on\n` +
    `    the performance measure the route records), which is what a non-shell route needs.\n\n` +
    `Most common cause: an EARLIER test in the same file navigated away and did not navigate back,\n` +
    `so this test inherited its route. Anything this test then derives from \`location.href\` is\n` +
    `built on the wrong path too, which fails later and far less legibly.\n\n` +
    `(WI-38449 — this exact inheritance wedged the whole packaged perf suite for 13 days. Because\n` +
    `the suite fails as a unit, the scheduled producer wrote NO rows to desktop_perf_runs and\n` +
    `DESKTOP_PERF_GATE fail-soft PASSED every deploy in that window while measuring nothing.)`
  );
}

/** The app is parked on a first-run screen: say so, and say which kind. */
async function firstRunDiagnosis(browser: Browser, seen: MountEvidence | null): Promise<string> {
  const at = seen?.pathname ?? "(unknown)";
  const gateway = await readFirstRunGateway(browser);
  return (
    `the app is on the FIRST-RUN screen, not the operator UI — every measure from this run ` +
    `would be a measurement of the WRONG SCREEN.\n\n` +
    `  landed at:  ${seen?.url ?? "(unknown)"}\n` +
    `  which is:   ${describeLanding(at) ?? "not an operator surface"}\n` +
    `  #root kids: ${seen?.rootChildren ?? "?"}   (it DID render — this is not a blank page)\n` +
    `  ${gateway}\n\n` +
    `Read the gateway answer above — it decides which bug this is:\n` +
    `  • 200 with no \`finished_at\`  → this instance has no completed profile. That is correct app\n` +
    `    behaviour for a fresh install; the SUITE must provision one (or drive onboarding to\n` +
    `    completion) before it measures anything.\n` +
    `  • a non-2xx status            → a set-up user was dumped into first-run because the backend\n` +
    `    answered badly during boot. apps/operator-vite/src/routes/index.tsx deliberately protects\n` +
    `    the UNREACHABLE case (→ /adv) and then falls through to first-run on a bad STATUS. That is\n` +
    `    a product bug, not a harness gap.\n\n` +
    `(EI-18889416741921988 — the old predicate accepted this screen as "mounted", so the suite ` +
    `published perf numbers for the onboarding console labelled as the operator shell.)`
  );
}

/**
 * The app rendered, and then its document was destroyed under us.
 *
 * Deliberately synchronous and browser-free: by definition the webview is gone,
 * so any further probe of it would fail or hang. Everything printed here was
 * captured while it was still alive.
 */
function webviewDiedDiagnosis(seen: MountEvidence | null, progress: MountProgress): string {
  return (
    `the webview DIED after the app had already rendered — this is not a slow boot.\n\n` +
    `  rendered under document: ${progress.renderedDocToken ?? "(unknown)"}\n` +
    `  now looking at document: ${seen?.docToken ?? "(unknown)"}\n` +
    `  url:        ${seen?.url ?? "(unknown)"}   (UNCHANGED — so this was not a navigation)\n` +
    `  #root:      ${seen?.rootChildren === -1 ? "ABSENT ENTIRELY" : String(seen?.rootChildren)}\n` +
    `  title:      ${JSON.stringify(seen?.title ?? "")}\n` +
    `  body kids:  ${seen?.bodyChildren ?? "?"}\n` +
    `  body text:  ${JSON.stringify(seen?.bodyTextHead ?? "")}\n` +
    `  readyState: ${seen?.readyState ?? "?"}\n\n` +
    `A fresh document identity at an UNCHANGED url, with no \`#root\` at all, is the WebKit web\n` +
    `process being replaced — a crash, an OOM kill, or the app tearing its own window down. The\n` +
    `three fields above discriminate: an empty title AND empty body is a blank crash-replacement\n` +
    `page; a populated title/body is an error page and its text names the cause.\n\n` +
    `Check ~/.papercusp/logs/gui.log at the timestamp of this run, and \`journalctl --user\` for a\n` +
    `WebKitWebProcess segfault or an OOM kill.\n` +
    `(First observed in perf run 6, 2026-07-28: the app mounted 10 children, held for ~10s, then\n` +
    `every subsequent poll for 47s saw a new blank document. Before this verdict existed the suite\n` +
    `read that as "still booting" and waited out its entire budget.)`
  );
}

/** Nothing usable ever rendered: the original boot-failure runbook still applies. */
async function mountTimeoutDiagnosis(
  browser: Browser,
  seen: MountEvidence | null,
): Promise<string> {
  const secs = Math.round(APP_MOUNT_TIMEOUT_MS / 1000);
  const where = seen
    ? `  last seen:  ${seen.url}\n` +
      `  #root kids: ${seen.rootChildren}${seen.rootChildren === -1 ? "   (#root itself is ABSENT)" : ""}\n` +
      `  shell:      ${seen.shellPresent ? "present" : "ABSENT"}   (${OPERATOR_SHELL_SELECTOR})\n` +
      `  readyState: ${seen.readyState}\n\n`
    : "  the webview could not be read at all\n\n";

  // Rendered something, on an operator route, but never the shell: the marker
  // is the suspect, not the boot. Worth saying — chasing a boot failure when the
  // app actually booted is the same wasted cycle this file exists to prevent.
  const markerNote =
    seen && seen.rootChildren > 0 && !seen.shellPresent && !isFirstRunLanding(seen.pathname)
      ? `The app RENDERED (${seen.rootChildren} child element(s)) on a non-first-run route, but the ` +
        `operator-shell marker never appeared. Suspect the marker, not the boot: check that AdvShell ` +
        `still carries data-testid="operator-shell" / .pc-advshell, and that this route renders it.\n\n`
      : "";

  return (
    `operator UI did not mount in ${secs}s.\n\n` +
    where +
    markerNote +
    `The app launched and WebDriver attached, so this is about what happened AFTER launch.\n` +
    `Read ~/.papercusp/logs/gui.log first — the app redirects its own stdout there, so the ` +
    `cause is usually stated outright (a sidecar it could not start, an operator that never ` +
    `became ready, the environment it fell back to). ~/.papercusp/logs/serve.log holds the ` +
    `sidecar's own output; if its mtime predates this run, no sidecar ever started.\n` +
    `(EI-18885442084466501 — this used to read as a UI/timeout problem when the real cause ` +
    `was an app built without its sidecar.)`
  );
}
