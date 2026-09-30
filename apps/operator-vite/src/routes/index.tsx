import { createFileRoute, redirect } from '@tanstack/react-router';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlagSnapshot, loadFlags } from '@papercusp/flags/client';
import { fetchWithTimeout } from '../lib/route-fetch';

/**
 * Root route — gateways the desktop's first-run experience.
 *
 * Translated from `apps/operator/app/page.tsx`. The original was a server
 * component that called `readOperatorState('setup_wizard_state')` directly
 * and redirected via `next/navigation`'s `redirect()`. Under Vite/SPA there
 * is no server render, so we fetch the same state via the public-API
 * endpoint `/api/desktop/setup-wizard-state` (port of the same DB read,
 * `apps/operator/lib/endpoint-route/routes/desktop/setup-wizard-state.ts`)
 * inside `beforeLoad` and throw a TSR redirect.
 *
 * Behavior parity with the Next root page:
 *   - If `finished_at` is unset → redirect to `/setup`.
 *   - Otherwise → redirect to `/adv` (the primary surface; `/harness` is
 *     retired as a landing and itself redirects to `/adv`).
 *   - On fetch failure → treat as "wizard not finished" and redirect to
 *     `/setup`. The wizard surface is the safer landing (it gracefully
 *     handles partial PG state); `/harness` assumes a fully-bootstrapped
 *     workspace and would render an empty/broken shell.
 */
/**
 * Where an UNFINISHED first-run lands (agent-first-onboarding-2026-07-03
 * P-003): the agent-chat Onboarding Console when ONBOARDING_AGENT_FIRST is
 * on, else the classic GUI wizard. Pure; exported for tests.
 */
export function firstRunTarget(onboardingAgentFirst: boolean): '/onboarding' | '/setup' {
  return onboardingAgentFirst ? '/onboarding' : '/setup';
}

/** Resolve ONBOARDING_AGENT_FIRST client-side (same pattern as requireFlag). */
async function onboardingFlagEnabled(): Promise<boolean> {
  await loadFlags().catch(() => {
    // flags unreachable → FLAG_DEFAULTS via getFlagSnapshot (default ON)
  });
  const snapshot = getFlagSnapshot();
  return (
    snapshot.flags[FLAGS.ONBOARDING_AGENT_FIRST] ?? FLAG_DEFAULTS[FLAGS.ONBOARDING_AGENT_FIRST]
  );
}

/**
 * What the gateway endpoint actually told us.
 *
 * The distinction this type exists to force: **"you are a new user" and "I could
 * not find out" are different answers**, and only the first may route to
 * first-run. `GET /api/desktop/setup-wizard-state` answers a genuine fresh
 * install with **200 + `{ step_status: {} }`** — it defaults the row rather than
 * erroring (see the route handler) — so a non-2xx is NEVER evidence of a first
 * run. It only ever means the backend could not answer.
 */
export type GatewayAnswer =
  | { kind: 'finished' }
  | { kind: 'first-run' }
  | { kind: 'inconclusive'; why: string; transient: boolean };

/**
 * Classify one gateway response. Pure; exported for tests.
 *
 * `transient` decides whether waiting can help: a 5xx is the sidecar still
 * booting (the packaged app serves this SPA from the `papercusp://` protocol
 * handler ON DISK, so the UI can render seconds before its sidecar listens, and
 * the shell's proxy answers 502 in the gap). A 4xx will not fix itself, so it is
 * inconclusive-and-permanent: stop waiting, but still never first-run.
 */
export function classifyGatewayResponse(status: number, body: unknown): GatewayAnswer {
  if (status >= 500) {
    return { kind: 'inconclusive', why: `backend answered ${status}`, transient: true };
  }
  if (status < 200 || status >= 300) {
    return { kind: 'inconclusive', why: `backend answered ${status}`, transient: false };
  }
  // A 2xx whose body did not parse is not a statement about the user either.
  // `PARSE_FAILED` is passed for that case rather than `null`, because `null` is
  // also what a literal `null` body would produce and the two must not merge.
  if (body === PARSE_FAILED || typeof body !== 'object' || body === null) {
    return { kind: 'inconclusive', why: 'backend answered 2xx with an unreadable body', transient: false };
  }
  const finishedAt = (body as { finished_at?: unknown }).finished_at;
  return typeof finishedAt === 'string' && finishedAt ? { kind: 'finished' } : { kind: 'first-run' };
}

/** Sentinel for "the response body could not be parsed" — see above. */
export const PARSE_FAILED = Symbol('gateway-body-parse-failed');

/**
 * How long to keep waiting on a transient-inconclusive gateway before landing on
 * the recoverable surface.
 *
 * Bounded by what the two wrong answers cost. Waiting too long shows
 * "Connecting…" on a genuinely broken box, where `/adv` would at least render
 * and reconnect itself via the resilient transports + OfflineIndicator. Waiting
 * too little re-opens the bug this constant exists for. The app's own
 * `operator_boot_timeout` is 120s, so 30s does not claim the sidecar is dead —
 * it claims we have waited long enough to stop blocking the UI on it.
 */
const GATEWAY_SETTLE_BUDGET_MS = 30_000;
const GATEWAY_RETRY_BACKOFF_MS = 750;

/**
 * A wedged/mid-restart backend used to hang this gateway fetch forever (bare
 * `fetch`, no timeout) → the router stayed `status:'pending'` → blank content
 * under a stuck `bprogress-busy` bar → "desktop isn't launching, it's stalling;
 * needs a manual relaunch" (WI-2817). `fetchWithTimeout` bounds each attempt and
 * retries a transient outage so the app auto-recovers; if the gateway is slow
 * enough to be an actual outage the `pendingComponent` shows an honest
 * "Connecting…" instead of a blank screen (never on the sub-second happy path,
 * gated by `pendingMs`).
 *
 * THE FIRST-RUN RULE (EI-18889416741921988, found by the packaged perf suite
 * 2026-07-28). Only a CONCLUSIVE 2xx answer may route to first-run. This used to
 * treat any non-2xx as "unfinished wizard" — so a returning user whose sidecar
 * was a few seconds behind the webview got a 502 from the shell's own proxy and
 * was dumped into the onboarding tutorial. That is the exact outcome the
 * unreachable branch below was written to prevent, and it leaked through the
 * *answered-badly* door beside it: `fetchWithTimeout` deliberately hands a
 * non-2xx straight back for the caller to interpret, and the caller read it as a
 * verdict about the USER. Every packaged perf run had been measuring
 * `/onboarding` for this reason.
 */
/** Where the gateway decided to land. `/adv` is always the harnesses tab. */
export type Landing = '/adv' | '/onboarding' | '/setup';

/**
 * Injectable seams, following `fetchWithTimeout` / `loadOnboardConcierge`.
 * Present so the decision can be tested WITHOUT sitting out a real 30s budget —
 * a resolver whose only test path is "wait 30 real seconds" does not get tested.
 */
export interface GatewayDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
}

/**
 * Decide the landing. Exported and dependency-injected so every branch is
 * cheaply testable; `beforeLoad` below is only the redirect wiring.
 */
export async function resolveLanding(deps: GatewayDeps = {}): Promise<Landing> {
  const {
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    budgetMs = GATEWAY_SETTLE_BUDGET_MS,
  } = deps;
  const deadline = now() + budgetMs;

  for (;;) {
    let answer: GatewayAnswer;
    try {
      const res = await fetchWithTimeout('/api/desktop/setup-wizard-state', {
        timeoutMs: 4000,
        retries: 2,
        init: { credentials: 'same-origin' },
        fetchImpl,
        sleep,
      });
      // A malformed/non-JSON body is inconclusive too — it is not a statement
      // about the user either, and it must not fall through to first-run.
      const body = await res.json().catch(() => PARSE_FAILED);
      answer = classifyGatewayResponse(res.status, body);
    } catch {
      // Backend UNREACHABLE after retries (timeout/network). The
      // substrate-restart / cold-start blip: keep waiting within the budget,
      // then land on /adv — never on first-run.
      answer = { kind: 'inconclusive', why: 'backend unreachable', transient: true };
    }

    // /adv is the operator's primary surface; /harness is retired as a landing
    // (it now redirects here too).
    if (answer.kind === 'finished') return '/adv';
    if (answer.kind === 'first-run') return firstRunTarget(await onboardingFlagEnabled());
    // Inconclusive. Waiting only helps a transient one, and only inside the
    // budget; otherwise take the recoverable surface, which reconnects on its
    // own without a manual relaunch.
    if (!answer.transient || now() >= deadline) return '/adv';
    await sleep(GATEWAY_RETRY_BACKOFF_MS);
  }
}

export const Route = createFileRoute('/')({
  pendingMs: 700,
  pendingComponent: ConnectingScreen,
  beforeLoad: async () => {
    const landing = await resolveLanding();
    // Land on the harnesses tab — the mission-control / feature-queue surface.
    if (landing === '/adv') throw redirect({ to: '/adv', search: { tab: 'harnesses' } });
    throw redirect({ to: landing });
  },
});

/** Shown only while the first-run gateway fetch is slow (an outage) — past
 *  `pendingMs`. The happy path redirects in well under a second, so this never
 *  flashes on a healthy launch. Honest "loading", not a blank stall. */
function ConnectingScreen() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.6rem',
        height: '100vh',
        width: '100%',
        opacity: 0.65,
        fontSize: '0.9rem',
      }}
    >
      <span>Connecting to Papercusp…</span>
    </div>
  );
}
