/**
 * Claude billing state + credit-exhaustion walls (plan anthropic-credits-gateway-2026-09-30, P-007).
 *
 * Two independent signals, both read off an upstream Anthropic response:
 *
 * 1. SUBSCRIPTION billing state, from the unified-limiter headers. A Claude subscription serves from
 *    its INCLUDED allowance until a window is exhausted; past that, an organization with usage credits
 *    enabled keeps serving from those credits ("overage", billed per token at API rates). The header
 *    names below are the ones the Claude CLI itself reads (verified in the 2.1.284 bundle, 2026-09-30):
 *      anthropic-ratelimit-unified-status                 allowed | allowed_warning | rejected
 *      anthropic-ratelimit-unified-overage-status         allowed | allowed_warning | rejected
 *      anthropic-ratelimit-unified-overage-in-use         true | false
 *      anthropic-ratelimit-unified-overage-disabled-reason  why overage cannot serve (verbatim)
 *      anthropic-ratelimit-unified-representative-claim   which limit binds (five_hour, seven_day, …)
 *      anthropic-ratelimit-unified-overage-reset / -reset unix seconds
 *
 * 2. API-key CREDIT walls (D-004), from the status + error body. A Console organization that has run
 *    out of prepaid credits, or hit a spend limit it set, cannot serve again until billing changes or
 *    the period resets — so these are walls (pause the account, fail over), never transient retries:
 *      402 billing_error
 *      400 "You have reached your specified … API usage limits"
 *      429 error.details.error_code = enforced_spend_limit_reached
 *    An ordinary API 429 (rate_limit_error with retry-after, no spend-limit code) is NOT a wall — it
 *    stays a transient rate window, handled by the existing 429 ladder.
 *
 * Pure: no I/O, no clock except the injectable `now`.
 */

export const UNIFIED_STATUS_HEADER = 'anthropic-ratelimit-unified-status';
export const UNIFIED_RESET_HEADER = 'anthropic-ratelimit-unified-reset';
export const OVERAGE_STATUS_HEADER = 'anthropic-ratelimit-unified-overage-status';
export const OVERAGE_IN_USE_HEADER = 'anthropic-ratelimit-unified-overage-in-use';
export const OVERAGE_DISABLED_REASON_HEADER = 'anthropic-ratelimit-unified-overage-disabled-reason';
export const OVERAGE_RESET_HEADER = 'anthropic-ratelimit-unified-overage-reset';
export const REPRESENTATIVE_CLAIM_HEADER = 'anthropic-ratelimit-unified-representative-claim';

/** Where a subscription account is being served from right now. */
export type ClaudeBillingStateKind =
  /** Inside the flat-rate subscription allowance. */
  | 'included'
  /** Past the allowance, serving from usage credits (metered, API rates). */
  | 'usage-credits'
  /** Allowance exhausted and overage cannot serve — the account is walled until its reset. */
  | 'walled';

export interface ClaudeBillingState {
  state: ClaudeBillingStateKind;
  /** `walled` only: the overage-disabled-reason header, verbatim, when the upstream sent one. */
  reason?: string;
  /** The binding limit (representative-claim header), verbatim, when present. */
  claim?: string;
  /** Epoch ms the current window resets, when the headers name one. */
  resetAt?: number;
}

type HeaderBag = Record<string, string | undefined>;

const header = (h: HeaderBag, name: string): string | undefined => {
  const v = h[name];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

const unixSecondsToMs = (v: string | undefined): number | undefined =>
  v && /^\d+$/.test(v) ? Number(v) * 1000 : undefined;

const isAllowed = (status: string | undefined): boolean =>
  status === 'allowed' || status === 'allowed_warning';

/**
 * Parse the unified-limiter headers into a billing state. Returns null when the response carries no
 * `anthropic-ratelimit-unified-status` header at all (an api-key account, or an upstream that did not
 * report) — "unknown" is not "included", and a caller must not treat it as one.
 */
export function parseClaudeBillingState(h: HeaderBag): ClaudeBillingState | null {
  const status = header(h, UNIFIED_STATUS_HEADER)?.toLowerCase();
  if (!status) return null;
  const overageStatus = header(h, OVERAGE_STATUS_HEADER)?.toLowerCase();
  const overageInUse = header(h, OVERAGE_IN_USE_HEADER)?.toLowerCase() === 'true';
  const claim = header(h, REPRESENTATIVE_CLAIM_HEADER);
  const withClaim = claim ? { claim } : {};

  if (overageInUse || (status === 'rejected' && isAllowed(overageStatus))) {
    const resetAt = unixSecondsToMs(header(h, OVERAGE_RESET_HEADER));
    return { state: 'usage-credits', ...withClaim, ...(resetAt !== undefined ? { resetAt } : {}) };
  }
  if (status !== 'rejected') return { state: 'included', ...withClaim };

  const reason = header(h, OVERAGE_DISABLED_REASON_HEADER);
  const resetAt =
    unixSecondsToMs(header(h, UNIFIED_RESET_HEADER)) ??
    unixSecondsToMs(header(h, 'anthropic-ratelimit-unified-5h-reset'));
  return {
    state: 'walled',
    ...withClaim,
    ...(reason ? { reason } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/** Why an API-key account hit a credit wall. */
export type ClaudeCreditWallCause = 'billing-error' | 'spend-limit' | 'api-usage-limit';

export interface ClaudeCreditWall {
  cause: ClaudeCreditWallCause;
  /** Epoch ms access returns, when the error names it ("You will regain access on … UTC"). */
  resetAt?: number;
}

export interface ClaudeHttpFailure {
  status: number;
  headers: HeaderBag;
  /** The peeked error body (may be truncated, or empty when the peek timed out). */
  body: string;
}

/** How long a credit wall parks an account when the upstream names no reset — then it is re-probed. */
export const CREDIT_WALL_DEFAULT_PAUSE_MS = 60 * 60 * 1000;

const SPEND_LIMIT_CODE = 'enforced_spend_limit_reached';
const API_USAGE_LIMIT_RE = /reached your specified (?:[a-z]+ )?API usage limits/i;
const REGAIN_ACCESS_RE = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) UTC/i;

interface ParsedErrorBody {
  type?: string;
  message?: string;
  errorCode?: string;
}

function parseErrorBody(body: string): ParsedErrorBody {
  try {
    const j = JSON.parse(body) as { error?: { type?: unknown; message?: unknown; error_code?: unknown; details?: { error_code?: unknown } } };
    const e = j?.error;
    if (e && typeof e === 'object') {
      const code = e.details?.error_code ?? e.error_code;
      return {
        ...(typeof e.type === 'string' ? { type: e.type } : {}),
        ...(typeof e.message === 'string' ? { message: e.message } : {}),
        ...(typeof code === 'string' ? { errorCode: code } : {}),
      };
    }
  } catch {
    /* a truncated peek is not JSON — fall back to text matching below */
  }
  const type = /"type"\s*:\s*"(billing_error)"/.exec(body)?.[1];
  const errorCode = /"error_code"\s*:\s*"([a-z_]+)"/.exec(body)?.[1];
  return { ...(type ? { type } : {}), ...(errorCode ? { errorCode } : {}), message: body };
}

function regainAccessAt(message: string | undefined): number | undefined {
  const m = message ? REGAIN_ACCESS_RE.exec(message) : null;
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}:00Z`);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Classify an upstream failure as an API-key credit wall, or null when it is not one (including an
 * ordinary rate-limited 429, which stays a transient rate window).
 */
export function classifyClaudeCreditWall(input: ClaudeHttpFailure): ClaudeCreditWall | null {
  const { status } = input;
  if (status !== 402 && status !== 400 && status !== 429) return null;
  const err = parseErrorBody(input.body);
  if (status === 402) {
    // Payment Required is a billing wall whatever the body says (and even when the peek was empty).
    return { cause: 'billing-error' };
  }
  if (status === 429) {
    return err.errorCode === SPEND_LIMIT_CODE ? { cause: 'spend-limit' } : null;
  }
  const message = err.message ?? input.body;
  if (!API_USAGE_LIMIT_RE.test(message)) return null;
  const resetAt = regainAccessAt(message);
  return { cause: 'api-usage-limit', ...(resetAt !== undefined ? { resetAt } : {}) };
}

/** The Claude adapter's classification of a credit wall (structurally a `ClaudeResponseClassification`). */
export interface ClaudeCreditWallClassification {
  kind: 'credit-wall';
  /** When the walled account may serve again: the upstream's named reset, else now + the default pause. */
  resetAt: number;
  detail: ClaudeCreditWall;
}

/**
 * The adapter-facing verdict for an upstream failure that is a credit wall, or null when it is not one.
 * gateway.ts's Claude classifier returns this FIRST, before any rate-limit shape, so a 429
 * enforced-spend-limit or a 400 API-usage-limit is never read as a rate window or a forwardable 400.
 */
export function classifyClaudeCreditWallResponse(
  input: ClaudeHttpFailure,
  now: number = Date.now(),
): ClaudeCreditWallClassification | null {
  const wall = classifyClaudeCreditWall(input);
  if (!wall) return null;
  return { kind: 'credit-wall', resetAt: wall.resetAt ?? now + CREDIT_WALL_DEFAULT_PAUSE_MS, detail: wall };
}
