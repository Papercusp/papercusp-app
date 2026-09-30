/**
 * codex-model-refusals.ts — automatic per-(account, model) availability for the Codex
 * ChatGPT-subscription pool (WI-10003306).
 *
 * A ChatGPT account can refuse a model outright:
 *   400 {"detail":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}
 * On 2026-09-26 two of the pool's subscriptions (registered as three entries) refused EVERY
 * premium model while the other four served them. The gateway treated that 400 as final and
 * forwarded it, never rotated, and never remembered it, so every request was a coin flip on which
 * account the health-ranked pick landed on — the owner saw the error "intermittently, on all
 * models", and resending sometimes worked.
 *
 * This module is the memory half of the fix. It records a refusal for the exact (account, model)
 * pair, so selection can route AROUND that account for that model without removing the account
 * from the pool or parking it for models it still serves (owner directive #636: mark it not
 * available, never remove it, and do it automatically).
 *
 * Why per-MODEL rather than parking the whole account: the same 400 is what EVERY account returns
 * for a model id nobody serves (a typo, or a bare family name like `gpt-5.6`). Parking whole
 * accounts on that signal would let one bad request take the entire pool offline. Keyed by model,
 * a genuinely-unsupported id just marks every account for that id, and the request still gets the
 * truthful 400.
 *
 * Recovery is automatic: an entry expires after `ttlMs`, the next request for that model may land
 * on the account again, and a refusal there is failed over transparently and re-recorded. A 2xx
 * for the pair clears it immediately. Nothing here needs a manual flip in either direction.
 */

/** Matches the ChatGPT codex backend's definitive model refusal. Shared with the launch-time
 *  preflight (`preflightCodexModel`) so the two detectors cannot drift apart. */
export const CODEX_MODEL_REFUSAL_RE = /model is not supported|unsupported model|unknown model/i;

/** How long a recorded refusal keeps the account out of selection for that model. After it lapses
 *  the account is eligible again; a still-refusing account costs one transparently-failed-over
 *  attempt per window. Env-tunable. */
export const DEFAULT_CODEX_MODEL_REFUSAL_TTL_MS =
  Number(process.env.PAPERCUSP_GATEWAY_CODEX_MODEL_REFUSAL_TTL_MS) || 30 * 60_000;

/** Upper bound on the error body read to classify a 4xx. Real refusal bodies are ~120 bytes. */
export const CODEX_REFUSAL_BODY_MAX_BYTES = 16 * 1024;

/**
 * Is this upstream response a definitive MODEL refusal (as opposed to an auth failure, a rate
 * limit, a server error, or a malformed request)? Only a 4xx other than 401/403/429 whose body
 * carries the refusal wording qualifies — the same rule the launch-time preflight applies.
 */
export function isCodexModelRefusal(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  if (status === 401 || status === 403 || status === 429) return false;
  return CODEX_MODEL_REFUSAL_RE.test(body);
}

/** The backend's `detail` string when the body is the usual JSON envelope, else the trimmed body. */
export function codexModelRefusalDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: { message?: unknown } };
    if (typeof parsed.detail === 'string') return parsed.detail.slice(0, 300);
    if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 300);
}

export interface CodexModelRefusalEntry {
  accountId: string;
  model: string;
  /** First refusal of the CURRENT episode (epoch ms). */
  since: number;
  /** Most recent refusal (epoch ms). */
  lastAt: number;
  /** When the account becomes eligible for this model again (epoch ms). */
  until: number;
  /** Refusals observed this episode. */
  hits: number;
  detail: string;
}

export interface CodexModelRefusalRegistry {
  /** Record a refusal. Returns true when this STARTS an episode (the pair was not already marked),
   *  so callers can log/alert on the transition instead of on every request. */
  record(accountId: string, model: string, detail: string): boolean;
  /** Is `accountId` currently marked as refusing `model`? */
  isRefused(accountId: string, model: string): boolean;
  /** A 2xx for the pair — clear it now rather than waiting out the TTL. Returns true if it was marked. */
  clear(accountId: string, model: string): boolean;
  /** Live (unexpired) entries, for /admin/stats. */
  snapshot(): CodexModelRefusalEntry[];
}

const keyOf = (accountId: string, model: string): string => `${accountId}\u0000${model.trim().toLowerCase()}`;

export function createCodexModelRefusalRegistry(
  opts: { ttlMs?: number; now?: () => number; maxEntries?: number } = {},
): CodexModelRefusalRegistry {
  const ttlMs = opts.ttlMs ?? DEFAULT_CODEX_MODEL_REFUSAL_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const maxEntries = opts.maxEntries ?? 512;
  const entries = new Map<string, CodexModelRefusalEntry>();

  const live = (key: string, at: number): CodexModelRefusalEntry | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= at) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    record(accountId, model, detail) {
      if (!accountId || !model) return false;
      const at = now();
      const key = keyOf(accountId, model);
      const existing = live(key, at);
      if (existing) {
        existing.lastAt = at;
        existing.until = at + ttlMs;
        existing.hits += 1;
        existing.detail = detail || existing.detail;
        return false;
      }
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { accountId, model, since: at, lastAt: at, until: at + ttlMs, hits: 1, detail });
      return true;
    },
    isRefused(accountId, model) {
      if (!accountId || !model) return false;
      return live(keyOf(accountId, model), now()) !== undefined;
    },
    clear(accountId, model) {
      if (!accountId || !model) return false;
      return entries.delete(keyOf(accountId, model));
    },
    snapshot() {
      const at = now();
      const out: CodexModelRefusalEntry[] = [];
      for (const key of [...entries.keys()]) {
        const entry = live(key, at);
        if (entry) out.push({ ...entry });
      }
      return out;
    },
  };
}
