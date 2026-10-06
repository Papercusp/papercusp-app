/**
 * @papercusp/model-pricing — canonical model→price table + cost estimation.
 *
 * Single source of truth for agent-model list prices (cross-backend-cost-capture
 * P-003 / D-005). Consumers: the orchestrator (`sumJsonlCost` cost cap,
 * `usage-sample-pg` estimated cost), operator-core (`agent-usage-telemetry`,
 * harness insights), and `@papercusp/testing-shell/llm` (re-export, keeps its
 * public `MODEL_PRICES`/`estimateCost` API).
 *
 * Semantics:
 *   - Prices are USD per 1M tokens (provider LIST prices — an *estimate*, not
 *     billed spend; subscription plans bill differently). Anything computed
 *     from this table must be labeled estimated (`cost_source = 'estimated'`).
 *   - `inputTokens` means UNCACHED input tokens (Anthropic's `usage.input_tokens`
 *     semantics — cache reads/writes are separate fields). Extractors for
 *     OpenAI-style usage (where `input_tokens` includes `cached_input_tokens`)
 *     must subtract both cached-read and cache-write subsets before calling
 *     `costFromTokens`.
 *   - Cache-read defaults to 0.1× input (Anthropic documented multiplier; the
 *     gpt-5 family's cached-input price is also 0.1×). Cache-creation defaults
 *     to 1.25× input (Anthropic 5-minute-TTL write premium; GPT-6 also reports
 *     explicit write tokens with its documented 1.25× rate).
 *   - Unknown model → `priced: false`, usd 0. Never $0-guess a real model:
 *     callers persist NULL cost rather than a fabricated zero.
 *
 * Maintenance reality (accepted in D-002-A): prices drift as providers ship
 * models. Update THIS table only — every consumer follows. Prices verified
 * 2026-06-05 (Anthropic: opus 4.x $5/$25, sonnet 4.6 $3/$15, haiku 4.5 $1/$5;
 * cache read 0.1×, 5-min cache write 1.25×).
 */

export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  in: number;
  /** USD per 1M output tokens. */
  out: number;
  /** USD per 1M cache-read tokens. Default: `in × 0.1`. */
  cacheRead?: number;
  /** USD per 1M cache-creation tokens. Default: `in × 1.25`. */
  cacheWrite?: number;
  /** Full-request input threshold; not an aggregate across multiple requests. */
  longContext?: { above: number; inputMultiplier: number; outputMultiplier: number };
}

/**
 * Keys are BARE model ids (no vendor prefix). `priceFor` normalizes inputs
 * like `openai-codex/gpt-5.5:xhigh` → `gpt-5.5` before lookup, and falls back
 * to a longest-prefix match so dated variants (`claude-opus-4-5-20251101`)
 * resolve to their family entry.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ── Anthropic (per-MTok list price; opus 4.5+ is $5/$25) ──
  // Opus 5 is a fixed id with NO date suffix, and lands at the same $5/$25 as the
  // 4.5+ Opus tier (verified 2026-08-11 against the claude-api model catalog:
  // 1M context, 128K max output, effort low→max, thinking on by default).
  'claude-opus-5': { in: 5.0, out: 25.0 },
  // Verified 2026-09-23: https://platform.claude.com/docs/en/about-claude/pricing
  'claude-opus-5-5': { in: 4.0, out: 20.0, cacheRead: 0.2 },
  'claude-opus-4-8': { in: 5.0, out: 25.0 },
  'claude-opus-4-7': { in: 5.0, out: 25.0 },
  'claude-opus-4-6': { in: 5.0, out: 25.0 },
  'claude-opus-4-5': { in: 5.0, out: 25.0 },
  // Legacy opus (4.1 and earlier) kept the old price point.
  'claude-opus-4-1': { in: 15.0, out: 75.0 },
  'claude-opus-4-0': { in: 15.0, out: 75.0 },
  // Verified 2026-09-29 (same pricing page): $2/$10, cache read 0.1× and 5m write
  // 1.25× — the defaults. Needs its own key: `priceFor` does not prefix-match
  // `claude-sonnet-5-5` onto `claude-sonnet-5`, so without it every sample is unpriced.
  'claude-sonnet-5-5': { in: 2.0, out: 10.0 },
  'claude-sonnet-5': { in: 2.0, out: 10.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-sonnet-4-5': { in: 3.0, out: 15.0 },
  'claude-sonnet-4-0': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-fable-5': { in: 10.0, out: 50.0 },
  'claude-fable-5-1': { in: 10.0, out: 50.0, cacheRead: 0.25 },

  // ── OpenAI (codex CLI models; cached input is 0.1× for the gpt-5 family) ──
  'gpt-5': { in: 1.25, out: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  // Distinct 5.6 tiers; the unsuffixed alias is Sol. Verified 2026-09-09:
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol
  // https://developers.openai.com/api/docs/models/gpt-5.6-luna
  // Standard-context list rates; these are usage estimates, not provider invoices.
  'gpt-5.6': { in: 4.0, out: 20.0, cacheRead: 0.4, cacheWrite: 5.0 },
  'gpt-5.6-sol': { in: 4.0, out: 20.0, cacheRead: 0.4, cacheWrite: 5.0 },
  'gpt-5.6-luna': { in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  // https://developers.openai.com/api/docs/models/compare (verified 2026-09-09)
  'gpt-5.6-terra': { in: 2.0, out: 12.0, cacheRead: 0.2, cacheWrite: 2.5 },
  // Verified 2026-09-23: https://developers.openai.com/api/docs/models/gpt-6-astra
  // https://developers.openai.com/api/docs/models/gpt-6-sol and /gpt-6-luna.
  // Standard, global list prices. Subscription estimates are not invoices.
  // Verified 2026-09-30: https://developers.openai.com/api/docs/models/gpt-6.1-sol
  'gpt-6.1-sol': { in: 2.0, out: 10.0, cacheRead: 0.1, cacheWrite: 2.5,
    longContext: { above: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  'gpt-6-astra': { in: 10.0, out: 50.0, cacheRead: 1.0, cacheWrite: 12.5,
    longContext: { above: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  'gpt-6-sol': { in: 2.0, out: 10.0, cacheRead: 0.2, cacheWrite: 2.5,
    longContext: { above: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  'gpt-6-luna': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    longContext: { above: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  'gpt-5.5': { in: 2.5, out: 20.0, cacheRead: 0.25, cacheWrite: 2.5 },
  // Verified 2026-10-01: https://developers.openai.com/api/docs/models/gpt-5.4
  // (1.05M context; prompts >272K input tokens bill 2x input / 1.5x output).
  // Missing entry made every Scout ideator call throw (WI-10004502).
  'gpt-5.4': { in: 2.5, out: 15.0, cacheRead: 0.25, cacheWrite: 2.5,
    longContext: { above: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  // Verified 2026-10-01: https://developers.openai.com/api/docs/models/gpt-5.4-mini
  // (400K context, max input 272K, so no long-context tier). In the gateway's
  // Codex lineup; found unpriced by configured-models-priced.test.ts (WI-10004506).
  'gpt-5.4-mini': { in: 0.75, out: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  // OpenAI-direct models used by LLM-testing hosts (e.g. Restart's Scout SUT).
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10.0 },
};

/**
 * Revision of the RULES `costFromTokens` applies to a usage (tier selection, floors, refusals).
 * Bump it whenever the same usage under the same table would price differently: a stored estimate
 * is a function of table AND rules, so a rule change must make old stamps stale exactly like a
 * price change does (agent-economy-flywheel-2026-08-30 D-020).
 *   1: the original rules.
 *   2: `unknownTier: 'floor'` — an unknown long-context or cache-write tier prices at its floor.
 */
export const PRICING_RULES_REVISION = 2;

/**
 * Content version of a price table under a rules revision: two 32-bit FNV-1a hashes (different
 * offset bases) of its canonical JSON (keys sorted at every level) plus the revision, as 16 hex
 * characters.
 *
 * Derived, never hand-maintained: ANY edit to a price changes it, so a stored estimate stamped
 * with an older version is detectably stale (WI-10004517). Not a security hash; it only has to
 * change when the table does. No BigInt and no node:crypto, so every consumer target compiles.
 */
export function priceTableVersion(
  table: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
  rulesRevision: number = PRICING_RULES_REVISION,
): string {
  const text = `${canonicalJson(table)}\u0000rules:${rulesRevision}`;
  const fnv1a = (offsetBasis: number): string => {
    let hash = offsetBasis >>> 0;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return fnv1a(0x811c9dc5) + fnv1a(0x050c5d1f);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** The version of the live `MODEL_PRICES` table. Writers stamp it beside every estimate. */
export const PRICE_TABLE_VERSION: string = priceTableVersion(MODEL_PRICES);

/**
 * Normalize a model id for lookup: lowercase, strip a vendor prefix
 * (`openai-codex/gpt-5` → `gpt-5`) and an effort/variant suffix
 * (`gpt-5.5:xhigh` → `gpt-5.5`).
 */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  const colon = m.indexOf(':');
  if (colon >= 0) m = m.slice(0, colon);
  m = m.replace(/\[[^\]]+\]$/, '');
  return m;
}

/** Resolve a price entry. Exact (raw, then normalized), then longest-prefix match. Null when unknown. */
export function priceFor(model: string): ModelPrice | null {
  if (!model) return null;
  if (Object.hasOwn(MODEL_PRICES, model)) return MODEL_PRICES[model];
  const norm = normalizeModelId(model);
  if (Object.hasOwn(MODEL_PRICES, norm)) return MODEL_PRICES[norm];
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICES)) {
    // Only dated snapshots inherit a price. A future family/tier is unknown,
    // not automatically the price of an older prefix (e.g. gpt-5.99 → gpt-5).
    if (norm.startsWith(key) && /^-(?:\d{8}|\d{4}-\d{2}(?:-\d{2})?)$/.test(norm.slice(key.length)) && (best === null || key.length > best.length)) {
      best = key;
    }
  }
  return best ? MODEL_PRICES[best] : null;
}

export interface TokenUsage {
  /** Total input for ONE request, including cache subsets; required for tiered prices. */
  requestInputTokens?: number;
  /** UNCACHED input tokens (see header — subtract cached subsets first). */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** The source did not report writes; any numeric value is only a lower bound. */
  cacheCreationUnreported?: boolean;
  /** Reported Anthropic cache-write tiers; provide both, including measured zeroes. */
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  /** A source knows writes occurred but did not report their TTL. Do not guess a price. */
  cacheCreationTierUnknown?: boolean;
}

export interface CostEstimate {
  /** Estimated USD at list price. 0 when `priced` is false. */
  usd: number;
  /** False for an unknown model or unreconciled write tier — persist NULL, not 0. */
  priced: boolean;
  /**
   * `'lower'` only under `unknownTier: 'floor'`, when a tier the usage cannot establish was
   * priced at its cheapest rate: the true cost is at least `usd`. Persist the bound with the cost.
   */
  bound?: 'lower';
}

export interface CostOptions {
  /**
   * What to do when the usage cannot establish a price TIER: an aggregate with no request size
   * for a model with a long-context tier, or cache writes with no TTL split.
   * `'refuse'` (default) returns `priced: false`. `'floor'` prices the tier at its cheapest rate
   * and returns `bound: 'lower'` — for usage ledgers, where a marked lower bound beats erasing
   * cost that was measured (D-020). An unknown model, unreported cache writes and an inconsistent
   * tier breakdown still refuse: none of them has a floor that is not a guess.
   */
  unknownTier?: 'refuse' | 'floor';
}

/**
 * The options every usage-LEDGER writer prices with (one row per request or per aggregate, kept
 * and re-derived later). One constant, so the writers and their re-pricer cannot drift apart.
 */
export const USAGE_LEDGER_PRICING: Readonly<CostOptions> = Object.freeze({ unknownTier: 'floor' });

/** Estimate cost from token counts at list price. Provider-reported cost always wins over this. */
export function costFromTokens(model: string, usage: TokenUsage, options: CostOptions = {}): CostEstimate {
  const floor = options.unknownTier === 'floor';
  let bounded = false;
  const p = priceFor(model);
  if (!p) return { usd: 0, priced: false };
  if (usage.cacheCreationUnreported) return { usd: 0, priced: false };
  let long: NonNullable<ModelPrice['longContext']> | null = null;
  if (p.longContext) {
    const size = usage.requestInputTokens;
    if (size === undefined || !Number.isFinite(size) || size < 0) {
      // An aggregate cannot establish the request's tier. Its floor takes the cheaper of the
      // two rates per component (multipliers capped at 1), whatever mix of requests it holds.
      if (!floor) return { usd: 0, priced: false };
      bounded = true;
      long = {
        above: p.longContext.above,
        inputMultiplier: Math.min(1, p.longContext.inputMultiplier),
        outputMultiplier: Math.min(1, p.longContext.outputMultiplier),
      };
    } else if (size > p.longContext.above) {
      long = p.longContext;
    }
  }
  const inputMultiplier = long?.inputMultiplier ?? 1;
  const outputMultiplier = long?.outputMultiplier ?? 1;
  const n = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  const cacheRead = p.cacheRead ?? p.in * 0.1;
  const cacheWrite = p.cacheWrite ?? p.in * 1.25;
  let writeCost = n(usage.cacheCreationTokens) * cacheWrite;
  const hasWriteTiers = usage.cacheCreation5mTokens !== undefined || usage.cacheCreation1hTokens !== undefined;
  if (hasWriteTiers) {
    const fiveMinute = usage.cacheCreation5mTokens;
    const oneHour = usage.cacheCreation1hTokens;
    // A partial or inconsistent breakdown is not evidence that the residue used
    // the cheaper tier. Return an unpriced estimate instead of hiding the gap.
    if (
      typeof fiveMinute !== 'number' || !Number.isFinite(fiveMinute) || fiveMinute < 0 ||
      typeof oneHour !== 'number' || !Number.isFinite(oneHour) || oneHour < 0 ||
      (usage.cacheCreationTokens !== undefined && usage.cacheCreationTokens !== fiveMinute + oneHour)
    ) return { usd: 0, priced: false };
    // These tier fields are provider-reported Anthropic quantities. The aggregate
    // is a reconciliation check, not a second set of tokens to charge for.
    writeCost = fiveMinute * p.in * 1.25 + oneHour * p.in * 2;
  } else if (usage.cacheCreationTierUnknown && n(usage.cacheCreationTokens) > 0) {
    if (!floor) return { usd: 0, priced: false };
    // Every write at the 5-minute rate (1.25x input, against 2x for 1-hour) is the floor.
    bounded = true;
    writeCost = n(usage.cacheCreationTokens) * p.in * 1.25;
  }
  const usd =
    ((n(usage.inputTokens) * p.in + n(usage.cacheReadTokens) * cacheRead + writeCost) * inputMultiplier +
      n(usage.outputTokens) * p.out * outputMultiplier) /
    1_000_000;
  return bounded ? { usd, priced: true, bound: 'lower' } : { usd, priced: true };
}

/**
 * Back-compat shape for `@papercusp/testing-shell/llm`'s original API:
 * input+output only, unknown models price at 0.
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  return costFromTokens(model, { inputTokens, outputTokens, requestInputTokens: inputTokens }).usd;
}
