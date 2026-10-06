/**
 * Upstream-taught reasoning-effort clamp for the Anthropic lane (WI-10005833).
 *
 * Claude Code sends the requested reasoning effort as `output_config.effort`. Model families accept
 * different levels, and a request carrying a level its model does not accept is a hard 400 that ends
 * the caller's turn:
 *
 *   This model does not support effort level 'xhigh'. Supported levels: high, low, max, medium.
 *
 * Effort reaches a request from several launch paths: an explicit `--effort`, the user settings
 * `effortLevel` fallback on a launch that passes no model, and a resume that inherits its source
 * session's effort. Normalizing each launcher separately kept missing one (EI-24898338997869007 fixed
 * the psu argv path; model-less and release-host launches still sent `xhigh`). The gateway is the one
 * point every Claude request crosses, and the 400 itself lists the supported levels, so the clamp needs
 * no per-model table: it learns the substitution from the first 400, retries that request once, and
 * rewrites later requests for the same (model, level) before they are sent.
 *
 * Direction: the lowest supported level AT OR ABOVE the requested one, else the highest level below
 * it. Rounding up keeps at least the reasoning the caller asked for, and it matches the launch-boundary
 * rule already in force for Opus 5 (`normalizeClaudeModelEffortSpec`: `xhigh` → `max`).
 *
 * Pure module: the gateway owns the cache instance and decides when to apply it.
 */

/** Anthropic reasoning-effort levels, lowest to highest. A level outside this ladder is never clamped. */
export const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

const RANK: ReadonlyMap<string, number> = new Map(EFFORT_LADDER.map((level, index) => [level, index]));

export interface UnsupportedEffortError {
  /** The level the upstream refused, lower-cased. */
  requested: string;
  /** The levels the upstream said it accepts, lower-cased, de-duplicated, on-ladder only. */
  supported: string[];
}

const UNSUPPORTED_EFFORT_RE =
  /does not support effort level\s+['"`]?([a-z]+)['"`]?\s*[.,;]?\s*Supported levels:\s*([a-z][a-z ,]*)/i;

/** The error text to match: the JSON `error.message` when the body is an Anthropic error envelope, else the raw body. */
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === 'string') return parsed.error.message;
  } catch {
    /* not JSON (or a truncated peek) — match the raw text */
  }
  return body;
}

/**
 * Parse an upstream "does not support effort level" 400 body. Returns null for any other body, and
 * for one that names no on-ladder supported level (there is then nothing safe to clamp to).
 */
export function parseUnsupportedEffortError(body: string): UnsupportedEffortError | null {
  if (!body) return null;
  const match = UNSUPPORTED_EFFORT_RE.exec(errorText(body));
  if (!match) return null;
  const supported = [
    ...new Set(
      match[2]
        .split(',')
        .map((level) => level.trim().toLowerCase())
        .filter((level) => RANK.has(level)),
    ),
  ];
  if (supported.length === 0) return null;
  return { requested: match[1].toLowerCase(), supported };
}

/**
 * The level to send instead of `requested`: the lowest supported level at or above it, else the
 * highest supported level below it. Null when `requested` is off-ladder, already supported, or no
 * supported level is on-ladder — in each case there is no basis for a substitution.
 */
export function chooseSupportedEffort(requested: string, supported: readonly string[]): string | null {
  const want = RANK.get(requested.toLowerCase());
  if (want === undefined) return null;
  const ranked = [...new Set(supported.map((level) => level.toLowerCase()))]
    .filter((level) => RANK.has(level))
    .sort((a, b) => RANK.get(a)! - RANK.get(b)!);
  if (ranked.length === 0 || ranked.includes(requested.toLowerCase())) return null;
  return ranked.find((level) => RANK.get(level)! > want) ?? ranked[ranked.length - 1];
}

/** The request body's `output_config.effort`, trimmed and lower-cased; null when absent or the body is not JSON. */
export function readRequestEffort(bodyBuf: Buffer): string | null {
  if (!bodyBuf.length) return null;
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8')) as { output_config?: { effort?: unknown } };
    const effort = parsed?.output_config?.effort;
    return typeof effort === 'string' && effort.trim() ? effort.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite the body's `output_config.effort` to `effort`, returning the re-serialized body — or null
 * when the body is not JSON or carries no string effort there (the caller then forwards unchanged).
 */
export function rewriteRequestEffort(bodyBuf: Buffer, effort: string): Buffer | null {
  if (!bodyBuf.length) return null;
  try {
    const parsed = JSON.parse(bodyBuf.toString('utf8')) as { output_config?: Record<string, unknown> };
    const config = parsed?.output_config;
    if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.effort !== 'string') {
      return null;
    }
    config.effort = effort;
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

export interface EffortClampEntry {
  model: string;
  from: string;
  to: string;
  learnedAt: number;
  /** Requests rewritten from this entry before they were sent. */
  applied: number;
}

export interface EffortClampCache {
  /** Record that `model` refused `from` and should be sent `to`. */
  learn(model: string, from: string, to: string): void;
  /** The learned substitution for (`model`, `from`), counting the hit; null when none or expired. */
  apply(model: string, from: string): string | null;
  /** Live entries, oldest first. */
  entries(): EffortClampEntry[];
}

/** A learned clamp expires so a model that later gains the level is used at it again (one 400 relearns it). */
export const EFFORT_CLAMP_TTL_MS = 6 * 60 * 60 * 1000;
const EFFORT_CLAMP_MAX_ENTRIES = 256;

export function createEffortClampCache(
  opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): EffortClampCache {
  const ttlMs = opts.ttlMs ?? EFFORT_CLAMP_TTL_MS;
  const maxEntries = opts.maxEntries ?? EFFORT_CLAMP_MAX_ENTRIES;
  const now = opts.now ?? Date.now;
  const map = new Map<string, EffortClampEntry>();
  const keyOf = (model: string, from: string) => `${model.toLowerCase()}\u0000${from.toLowerCase()}`;
  const live = (entry: EffortClampEntry, at: number) => at - entry.learnedAt <= ttlMs;

  return {
    learn(model, from, to) {
      const key = keyOf(model, from);
      map.delete(key);
      map.set(key, { model, from: from.toLowerCase(), to: to.toLowerCase(), learnedAt: now(), applied: 0 });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    apply(model, from) {
      const key = keyOf(model, from);
      const entry = map.get(key);
      if (!entry) return null;
      if (!live(entry, now())) {
        map.delete(key);
        return null;
      }
      entry.applied++;
      return entry.to;
    },
    entries() {
      const at = now();
      return [...map.values()].filter((entry) => live(entry, at)).map((entry) => ({ ...entry }));
    },
  };
}
