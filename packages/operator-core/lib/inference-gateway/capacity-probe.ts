/**
 * capacity-probe.ts — the UPSTREAM ground-truth probe for an account's unified budget windows
 * (plan gateway-clamp-advisory-capacity-probe-2026-07-09, P-001).
 *
 * THE GAP THIS CLOSES. The account-pool projection (`rate.utilization7d` / `windowResetAt7d`) is the
 * signal `drainUtil7d()` → `usageWalled` → `accountFull` → spawn-eligibility all read. It is written in
 * exactly ONE place: `makeAccountWindowRecorder` (launch.ts), off the response headers of a LIVE request
 * routed through that account. `drainUtil7d` self-heals on either (a) the projected reset passing, or
 * (b) a fresh sub-cap reading.
 *
 * But a WALLED account is routed no traffic — so it sees no responses, so it gets no fresh reading, so it
 * stays walled until its PROJECTED reset. Nothing in the tree ever re-asks upstream "what is my real
 * budget?". That is a chicken-and-egg: an account whose window ACTUALLY reset (an upstream/plan change, a
 * support credit, a mis-parsed `unified-7d-reset` header) stays stranded for DAYS on a stale projection,
 * and the ONLY levers were `accounts:reset-rate` — which deliberately PRESERVES the windows
 * (`recordAccountReset`, account-pool.ts) and so structurally cannot unwall — or waiting.
 *
 * THE KEY FACT THAT MAKES THIS CHEAP: `anthropic-ratelimit-unified-*` headers ride on 200s, not only 429s
 * (see `parseUnifiedWindow`). So ONE minimal request per account yields authoritative budget state. Even
 * better, a 429 is equally informative — it CONFIRMS a real wall and carries the true reset. So we record
 * the headers off ANY HTTP response and only treat a TRANSPORT failure as "no signal".
 *
 * EVIDENCE BEFORE FORCE (plan D-001). This probe exists so an unwall can be JUSTIFIED rather than
 * asserted. `accounts:reset-rate { resetWindows }` is the deliberate override for when the probe cannot
 * run; this is the detector that should make reaching for it rare. A genuine `utilization7d: 1.0` staying
 * walled is CORRECT behavior — forcing it just makes the fleet hammer a capped account into real 429s.
 *
 * OUT-OF-PROCESS BY DESIGN (plan D-002). This module talks to upstream directly through the account's own
 * egress + credential — it does NOT go through the running :8788 gateway. So it works against a gateway
 * that is wedged, walled, or (as on 2026-07-09) too old to have the routes you need, with no restart. The
 * in-gateway periodic self-heal calls this same code path.
 *
 * PURE-CORE + INJECTED DEPS, mirroring `egress-probe.ts`: `parseCapacityHeaders` is a pure
 * header→projection map (trivially unit-testable), and every I/O edge (fetch, credential resolve,
 * dispatcher build) is a `deps` seam, so the probe is testable with zero network.
 */
import { egressEntries, type AccountEgress, type ClaudeAccount } from '../deployment/account-pool';
import { parseUnifiedWindow, parseUnified7dWindow } from './gateway';
import { claudeAttemptHeaders, claudeAuthModeForRef } from './credential-store';
import { resolveAccountEgress } from './egress-dispatcher';
import { parseCodexCliRef } from './codex-cli-bridge';
import {
  CODEX_CHATGPT_BACKEND_BASE,
  CODEX_OPENAI_BETA,
  CODEX_ORIGINATOR,
  parseCodexRateLimitHeaders,
  resolveCodexAccessToken,
  type CodexRateLimitBucket,
} from './codex-oauth-proxy';
import { describeFetchError } from '../loopback-fetch';

/** Upstream root. Mirrors gateway.ts DEFAULT_UPSTREAM; env-tunable for a staging/mock upstream. */
const UPSTREAM = process.env.PAPERCUSP_GATEWAY_UPSTREAM || 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** The cheapest model that still returns the unified budget headers. Env-tunable in case the id moves. */
export const CAPACITY_PROBE_MODEL = process.env.PAPERCUSP_CAPACITY_PROBE_MODEL || 'claude-haiku-4-5';
/** A probe must never hang a sweep. This bounds the WHOLE account path, not just response headers. */
export const CAPACITY_PROBE_ACCOUNT_TIMEOUT_MS = Number(process.env.PAPERCUSP_CAPACITY_PROBE_TIMEOUT_MS) || 15_000;
/** Keep the all-account MCP call below the ~55s transport deadline, including token/dispatcher setup. */
export const CAPACITY_PROBE_SWEEP_TIMEOUT_MS = Number(process.env.PAPERCUSP_CAPACITY_PROBE_SWEEP_TIMEOUT_MS) || 45_000;
/** Bound the fan-out so an 8-account sweep doesn't open 8 simultaneous proxy connections. */
const PROBE_CONCURRENCY = Number(process.env.PAPERCUSP_CAPACITY_PROBE_CONCURRENCY) || 3;
export const CAPACITY_PROBE_TIMEOUT_ERROR = 'capacity probe deadline exceeded';
export const CAPACITY_PROBE_NOT_STARTED_ERROR = `${CAPACITY_PROBE_TIMEOUT_ERROR} before account probe started`;

/** The unified-window projection a probe recovered from upstream response headers. */
export interface CapacityWindows {
  utilization?: number;
  windowResetAt?: number;
  utilization7d?: number;
  windowResetAt7d?: number;
  usageCreditsAvailable?: boolean;
  /** Codex only: which METER the reading came from — `premium` (the meter the pool projection
   *  describes) or `base_model_inference` (the Luna reserve tier, a separate budget that must
   *  never be projected into the premium slots — EI-22103680502746318). Absent for Anthropic. */
  bucket?: CodexRateLimitBucket;
}

export interface CapacityProbeResult {
  accountId: string;
  /** False when the sweep returned a deterministic row without starting this account. */
  attempted?: boolean;
  /** True when we got an HTTP response carrying at least one unified header — i.e. a usable reading.
   *  A 429 counts: it CONFIRMS a wall and carries the real reset. Only transport failures are `false`. */
  ok: boolean;
  /** Upstream HTTP status, when a response was received at all. */
  status?: number;
  /** What upstream says RIGHT NOW. Empty when `ok` is false. */
  windows: CapacityWindows;
  /** The projection as it stood BEFORE this probe — the evidence half of a before/after. */
  before: CapacityWindows;
  /** True when upstream's 7d reading is materially below the stored one ⇒ the stored wall was STALE. */
  unwalls: boolean;
  /** Transport/credential failure detail. Non-fatal: one bad account never fails the sweep. */
  error?: string;
}

export interface CapacityProbeDeps {
  fetchImpl?: typeof fetch;
  /** Resolve a bearer token for the account's credentialRef. Injected in tests. */
  resolveToken?: (account: ClaudeAccount) => Promise<string>;
  /** Resolve a ChatGPT-subscription codex OAuth token for a `codex-cli:<home>` account (WI-38582). Injected in tests. */
  resolveCodexAuth?: (home: string) => Promise<{ accessToken: string; accountId: string | null }>;
  /** Build the per-account egress dispatcher (per-account IP). Injected in tests. */
  buildDispatcher?: (egress: AccountEgress | undefined) => Promise<unknown>;
  now?: () => number;
  /** Internal shared deadline supplied by the bounded multi-account sweep. */
  deadlineAt?: number;
  /** Optional Codex model to probe. Use `gpt-reserve` to measure the Luna
   * reserve bucket instead of the default Sol/generic bucket. */
  codexModel?: string;
}

/**
 * PURE: upstream response headers → the unified-window projection. Delegates to the SAME parsers the
 * gateway's live recorder uses (`parseUnifiedWindow` / `parseUnified7dWindow`) so a probe reading and a
 * live-traffic reading can never diverge in interpretation.
 */
export function parseCapacityHeaders(h: Record<string, string | undefined>): CapacityWindows {
  const anthropic = { ...parseUnifiedWindow(h), ...parseUnified7dWindow(h) };
  if (Object.keys(anthropic).length > 0) return anthropic;
  // WI-38582: not the Anthropic dialect — try the ChatGPT codex backend's x-codex-* headers,
  // so a codex-account probe reading and a live-traffic reading share ONE interpretation too.
  return parseCodexRateLimitHeaders(h);
}

/** The stored projection, as `CapacityWindows`. */
export function storedWindows(a: ClaudeAccount): CapacityWindows {
  const r = a.rate;
  return {
    utilization: r.utilization,
    windowResetAt: r.windowResetAt,
    utilization7d: r.utilization7d,
    windowResetAt7d: r.windowResetAt7d,
    ...(r.usageCreditsAvailable !== undefined ? { usageCreditsAvailable: r.usageCreditsAvailable } : {}),
  };
}

/** How far below the stored reading upstream must be before we call the stored wall STALE. Matches the
 *  `significant` epsilon the live recorder uses, so probe + traffic agree on what counts as a real move. */
export const UNWALL_EPSILON = 0.03;

/**
 * PURE: did this probe prove the stored projection was a STALE wall? True only when the stored 7d (or 5h)
 * reading was at/over the drain-full threshold AND upstream now reports materially lower. Deliberately
 * conservative — a probe that merely FAILS never unwalls anything.
 */
export function provesUnwall(before: CapacityWindows, now: CapacityWindows, fullUtil: number): boolean {
  // EI-22103680502746318: a Luna reserve-meter reading (`gpt-reserve` probe) is NOT the meter the
  // stored wall describes — 4% of the reserve bucket says nothing about the exhausted premium weekly.
  if (now.bucket === 'base_model_inference') return false;
  const wasWalled = (before.utilization7d ?? 0) >= fullUtil || (before.utilization ?? 0) >= fullUtil;
  if (!wasWalled) return false;
  const u7 = now.utilization7d;
  const u5 = now.utilization;
  const freed7 = u7 !== undefined && u7 < (before.utilization7d ?? 1) - UNWALL_EPSILON;
  const freed5 = u5 !== undefined && u5 < (before.utilization ?? 1) - UNWALL_EPSILON;
  return freed7 || freed5;
}

/** The egress this account starts on — see `resolveAccountEgress`, the canonical selector in
 * egress-dispatcher.ts. Re-exported under the historical name used here. */
export const probeEgressFor: (a: ClaudeAccount) => AccountEgress | undefined = resolveAccountEgress;

/**
 * The ordered egress candidates the gateway can use for this account. A pool entry may be `{}` to
 * mean the box-direct IP, so preserve it; an account with no configured entries still gets one
 * `undefined` candidate for the default shared egress. Capacity probes must walk these candidates
 * because the pool head can be transport-dead while a sibling route still returns authoritative
 * budget headers (the gateway's normal per-IP failover behavior).
 */
function probeEgressCandidates(account: ClaudeAccount): Array<AccountEgress | undefined> {
  const entries = egressEntries(account);
  return entries.length > 0 ? entries : [undefined];
}

function describeEgress(egress: AccountEgress | undefined): string {
  return egress?.proxyUrl ?? (egress?.localAddress ? `src ${egress.localAddress}` : 'default-egress');
}

class CapacityProbeTimeoutError extends Error {
  constructor(readonly phase: string) {
    super(`${CAPACITY_PROBE_TIMEOUT_ERROR} during ${phase}`);
    this.name = 'CapacityProbeTimeoutError';
  }
}

function timeoutError(phase: string): CapacityProbeTimeoutError {
  return new CapacityProbeTimeoutError(phase);
}

function isTimeoutError(error: unknown): error is CapacityProbeTimeoutError {
  return error instanceof CapacityProbeTimeoutError;
}

/** Bound an operation that has no cancellation seam of its own (credential refresh or dispatcher import). */
function withDeadline<T>(operation: () => Promise<T> | T, timeoutMs: number, phase: string, onTimeout?: () => void): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(timeoutError(phase));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(timeoutError(phase));
      }
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function remainingMs(deadlineAt: number, now: () => number): number {
  return Math.max(0, deadlineAt - now());
}

function noReadingResult(account: ClaudeAccount, error: string): CapacityProbeResult {
  return {
    accountId: account.id,
    attempted: false,
    ok: false,
    windows: {},
    before: storedWindows(account),
    unwalls: false,
    error,
  };
}

function describeProbeError(error: unknown, phase: string, deadlineAt: number, now: () => number): string {
  if (isTimeoutError(error) || now() >= deadlineAt) return `${CAPACITY_PROBE_TIMEOUT_ERROR} during ${phase}`;
  return describeFetchError(error);
}

/**
 * Probe ONE account's live budget windows. Never throws — a credential/transport failure is captured on
 * the result so a sweep over N accounts always returns N rows. When an account has an egress pool, walk
 * the ordered candidates on transport/no-header failure so one dead proxy cannot hide a usable sibling
 * route (including the valid `{}` box-direct fallback).
 *
 * We send the smallest possible VALID request (1 output token, a one-char prompt). The response BODY is
 * irrelevant and never read; only headers matter. A 4xx/429 still carries the unified headers, so we treat
 * ANY HTTP response as signal and only a thrown transport error as "no reading".
 */
export async function probeAccountCapacity(
  account: ClaudeAccount,
  deps: CapacityProbeDeps = {},
  fullUtil = 0.97,
): Promise<CapacityProbeResult> {
  const before = storedWindows(account);
  const now = deps.now ?? Date.now;
  const deadlineAt = deps.deadlineAt ?? now() + CAPACITY_PROBE_ACCOUNT_TIMEOUT_MS;
  const base: Omit<CapacityProbeResult, 'ok' | 'windows' | 'unwalls'> = { accountId: account.id, attempted: true, before };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveToken =
    deps.resolveToken ??
    (async (a: ClaudeAccount) => {
      const { makeCredentialResolver } = await import('./credential-store');
      return makeCredentialResolver(a.credentialRef, a.id).current();
    });
  const buildDispatcher =
    deps.buildDispatcher ??
    (async (eg: AccountEgress | undefined) => {
      const { buildEgressDispatcher } = await import('./egress-dispatcher');
      return (await buildEgressDispatcher(eg)).dispatcher;
    });

  let token: string;
  try {
    token = await withDeadline(
      () => resolveToken(account),
      remainingMs(deadlineAt, now),
      'credential resolution',
    );
  } catch (e) {
    return {
      ...base,
      ok: false,
      windows: {},
      unwalls: false,
      error: describeProbeError(e, 'credential resolution', deadlineAt, now),
    };
  }

  const failures: string[] = [];
  for (const egress of probeEgressCandidates(account)) {
    const route = describeEgress(egress);
    const routeTimeoutMs = remainingMs(deadlineAt, now);
    if (routeTimeoutMs <= 0) {
      failures.push(`${route}: ${CAPACITY_PROBE_TIMEOUT_ERROR} during egress dispatcher`);
      break;
    }
    let phase = 'egress dispatcher';
    try {
      const dispatcher = await withDeadline(
        () => buildDispatcher(egress),
        routeTimeoutMs,
        'egress dispatcher',
      );
      phase = 'fetch';
      const fetchTimeoutMs = remainingMs(deadlineAt, now);
      if (fetchTimeoutMs <= 0) throw timeoutError('fetch');
      const ac = new AbortController();
      let res: Response;
      res = await withDeadline(
        () => fetchImpl(`${UPSTREAM}/v1/messages`, {
          method: 'POST',
          signal: ac.signal,
          // P-006: an API-key account is probed with `x-api-key` and no OAuth beta; a Bearer
          // probe would 401/400 and read as a dead account.
          headers: claudeAttemptHeaders(
            { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
            claudeAuthModeForRef(account.credentialRef),
            token,
          ),
          body: JSON.stringify({
            model: CAPACITY_PROBE_MODEL,
            max_tokens: 1,
            messages: [{ role: 'user', content: '.' }],
          }),
          // undici honours `dispatcher` on the RequestInit; the DOM lib type doesn't know it.
          ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
        } as RequestInit),
        fetchTimeoutMs,
        'fetch',
        () => ac.abort(),
      );
      // Drain the body so the socket releases cleanly — we never inspect it.
      void res.text().catch(() => undefined);

      const h: Record<string, string | undefined> = {};
      res.headers.forEach((v, k) => {
        h[k.toLowerCase()] = v;
      });
      const windows = parseCapacityHeaders(h);
      const sawHeader = Object.keys(windows).length > 0;
      // A real upstream quota refusal wins over a positive wallet balance.
      if (res.status === 429) windows.usageCreditsAvailable = false;
      if (sawHeader) {
        return {
          ...base,
          ok: true,
          status: res.status,
          windows,
          unwalls: provesUnwall(before, windows, fullUtil),
        };
      }
      failures.push(`${route}: HTTP ${res.status} carried no anthropic-ratelimit-unified-* header`);
    } catch (e) {
      failures.push(`${route}: ${describeProbeError(e, phase, deadlineAt, now)}`);
      if (isTimeoutError(e) || now() >= deadlineAt) break;
    }
  }

  return {
    ...base,
    ok: false,
    windows: {},
    unwalls: false,
    error: failures.join('; '),
  };
}

/** The cheapest codex model that still returns the x-codex-* budget headers. Env-tunable because the
 *  ChatGPT backend REFUSES unknown ids per plan ("The '<id>' model is not supported when using Codex
 *  with a ChatGPT account") — verified working on subscription plans 2026-08-13. */
export const CODEX_CAPACITY_PROBE_MODEL = process.env.PAPERCUSP_CODEX_CAPACITY_PROBE_MODEL || 'gpt-5.6-sol';

/**
 * Probe ONE ChatGPT-subscription codex account (credentialRef `codex-cli:<home>`) — WI-38582.
 * Same contract as `probeAccountCapacity`: never throws, any HTTP response with a usable header is
 * signal, only transport/credential failures are `ok:false`. The request is a minimal streaming
 * Responses call; we read HEADERS and cancel the stream immediately (the body is irrelevant).
 */
export async function probeCodexAccountCapacity(
  account: ClaudeAccount,
  deps: CapacityProbeDeps = {},
  fullUtil = 0.97,
): Promise<CapacityProbeResult> {
  const before = storedWindows(account);
  const now = deps.now ?? Date.now;
  const deadlineAt = deps.deadlineAt ?? now() + CAPACITY_PROBE_ACCOUNT_TIMEOUT_MS;
  const base: Omit<CapacityProbeResult, 'ok' | 'windows' | 'unwalls'> = { accountId: account.id, attempted: true, before };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const buildDispatcher =
    deps.buildDispatcher ??
    (async (eg: AccountEgress | undefined) => {
      const { buildEgressDispatcher } = await import('./egress-dispatcher');
      return (await buildEgressDispatcher(eg)).dispatcher;
    });

  const home = parseCodexCliRef(account.credentialRef ?? '');
  if (!home) {
    return {
      ...base,
      ok: false,
      windows: {},
      unwalls: false,
      error: `codex account '${account.id}' has no codex-cli:<home> credentialRef — bearer codex accounts are not capacity-probed`,
    };
  }

  let accessToken: string;
  let chatgptAccountId: string | null;
  try {
    const auth = await withDeadline(
      () => (deps.resolveCodexAuth ?? resolveCodexAccessToken)(home),
      remainingMs(deadlineAt, now),
      'credential resolution',
    );
    accessToken = auth.accessToken;
    chatgptAccountId = auth.accountId ?? null;
  } catch (e) {
    return {
      ...base,
      ok: false,
      windows: {},
      unwalls: false,
      error: describeProbeError(e, 'credential resolution', deadlineAt, now),
    };
  }

  const failures: string[] = [];
  const probeModel = deps.codexModel?.trim() || CODEX_CAPACITY_PROBE_MODEL;
  for (const egress of probeEgressCandidates(account)) {
    const route = describeEgress(egress);
    const routeTimeoutMs = remainingMs(deadlineAt, now);
    if (routeTimeoutMs <= 0) {
      failures.push(`${route}: ${CAPACITY_PROBE_TIMEOUT_ERROR} during egress dispatcher`);
      break;
    }
    let phase = 'egress dispatcher';
    try {
      const dispatcher = await withDeadline(() => buildDispatcher(egress), routeTimeoutMs, 'egress dispatcher');
      phase = 'fetch';
      const fetchTimeoutMs = remainingMs(deadlineAt, now);
      if (fetchTimeoutMs <= 0) throw timeoutError('fetch');
      const ac = new AbortController();
      const res = await withDeadline(
        () =>
          fetchImpl(`${CODEX_CHATGPT_BACKEND_BASE}/responses`, {
            method: 'POST',
            signal: ac.signal,
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              authorization: `Bearer ${accessToken}`,
              ...(chatgptAccountId ? { 'chatgpt-account-id': chatgptAccountId } : {}),
              'openai-beta': CODEX_OPENAI_BETA,
              originator: CODEX_ORIGINATOR,
            },
            body: JSON.stringify({
              model: probeModel,
              stream: true,
              store: false,
              instructions: 'You are a capacity probe.',
              input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '.' }] }],
              tools: [],
              tool_choice: 'auto',
              parallel_tool_calls: false,
              reasoning: { effort: 'low' },
              include: [],
            }),
            ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
          } as RequestInit),
        fetchTimeoutMs,
        'fetch',
        () => ac.abort(),
      );
      // Headers are the whole signal — cancel the SSE stream instead of draining a model turn.
      try {
        ac.abort();
      } catch {
        /* already settled */
      }
      void res.body?.cancel().catch(() => undefined);

      const h: Record<string, string | undefined> = {};
      res.headers.forEach((v, k) => {
        h[k.toLowerCase()] = v;
      });
      const windows = parseCapacityHeaders(h);
      const sawHeader = Object.keys(windows).length > 0;
      if (sawHeader) {
        return {
          ...base,
          ok: true,
          status: res.status,
          windows,
          unwalls: provesUnwall(before, windows, fullUtil),
        };
      }
      failures.push(`${route}: HTTP ${res.status} carried no x-codex-* rate-limit header`);
    } catch (e) {
      failures.push(`${route}: ${describeProbeError(e, phase, deadlineAt, now)}`);
      if (isTimeoutError(e) || now() >= deadlineAt) break;
    }
  }

  return {
    ...base,
    ok: false,
    windows: {},
    unwalls: false,
    error: failures.join('; '),
  };
}

/** Should this account be probed under `walledOnly`? Pure, so the selection rule is unit-testable. */
export function isWalledCandidate(a: ClaudeAccount, fullUtil: number): boolean {
  const r = a.rate;
  return (r.utilization7d ?? 0) >= fullUtil || (r.utilization ?? 0) >= fullUtil;
}

/**
 * Probe MANY accounts with bounded concurrency. `claude` accounts read the Anthropic unified-window
 * dialect; ChatGPT-subscription `codex` accounts (credentialRef `codex-cli:<home>`) read the x-codex-*
 * dialect (WI-38582). A bearer-only codex account has no probeable subscription window and is skipped.
 */
export async function probeCapacityForAccounts(
  accounts: ClaudeAccount[],
  opts: { walledOnly?: boolean; fullUtil?: number; timeoutMs?: number; codexModel?: string } = {},
  deps: CapacityProbeDeps = {},
): Promise<CapacityProbeResult[]> {
  const fullUtil = opts.fullUtil ?? 0.97;
  const now = deps.now ?? Date.now;
  const requestedSweepMs = opts.timeoutMs ?? CAPACITY_PROBE_SWEEP_TIMEOUT_MS;
  const sweepTimeoutMs = Number.isFinite(requestedSweepMs) ? Math.max(0, Math.min(requestedSweepMs, CAPACITY_PROBE_SWEEP_TIMEOUT_MS)) : CAPACITY_PROBE_SWEEP_TIMEOUT_MS;
  const sweepDeadlineAt = now() + sweepTimeoutMs;
  const targets = accounts
    .filter((a) => {
      const provider = a.provider ?? 'claude';
      if (provider === 'claude') return true;
      // WI-38582: ChatGPT-subscription codex accounts are probeable via their OAuth home.
      return provider === 'codex' && parseCodexCliRef(a.credentialRef ?? '') !== null;
    })
    .filter((a) => !opts.walledOnly || isWalledCandidate(a, fullUtil));

  const out: CapacityProbeResult[] = [];
  const queue = [...targets];
  const probeDeps = opts.codexModel ? { ...deps, codexModel: opts.codexModel } : deps;
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(1, queue.length)) }, async () => {
    for (;;) {
      const a = queue.shift();
      if (!a) return;
      const startedAt = now();
      if (startedAt >= sweepDeadlineAt) {
        out.push(noReadingResult(a, CAPACITY_PROBE_NOT_STARTED_ERROR));
        continue;
      }
      const accountDeadlineAt = Math.min(sweepDeadlineAt, startedAt + CAPACITY_PROBE_ACCOUNT_TIMEOUT_MS);
      const probe = (a.provider ?? 'claude') === 'codex' ? probeCodexAccountCapacity : probeAccountCapacity;
      out.push(await probe(a, { ...probeDeps, now, deadlineAt: accountDeadlineAt }, fullUtil));
    }
  });
  await Promise.all(workers);
  // Stable order for a legible report / deterministic tests.
  const rank = new Map(targets.map((a, i) => [a.id, i]));
  out.sort((x, y) => (rank.get(x.accountId) ?? 0) - (rank.get(y.accountId) ?? 0));
  return out;
}
