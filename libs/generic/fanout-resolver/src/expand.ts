/**
 * Expand a resolved item-set into N outputs — the second half of a generative
 * fan-out (list → N children), with deterministic ids for idempotent re-expansion.
 */
import { DEFAULT_FANOUT_CAP, FanoutCapError } from './types';
import { dedupeTrim } from './resolve';

/**
 * Deterministic short hash (djb2) — stable across runs and processes, so a
 * re-expansion of the same input mints the same id (idempotent fan-out). Returns
 * 7 url-safe base-36 chars.
 */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(7, '0').slice(-7);
}

/**
 * Expand a list of items into N outputs via a per-item builder. The items are
 * trimmed + deduped + emptied-out first (via {@link dedupeTrim}), then capped:
 * over the cap throws `FanoutCapError` (never truncates). The builder owns the
 * output shape and any id derivation (use {@link shortHash} for idempotent ids).
 */
export function expandFanout<T>(
  items: readonly string[],
  build: (item: string) => T,
  opts: { cap?: number } = {},
): T[] {
  const cap = opts.cap ?? DEFAULT_FANOUT_CAP;
  const unique = dedupeTrim(items);
  if (unique.length > cap) throw new FanoutCapError(unique.length, cap);
  return unique.map(build);
}
