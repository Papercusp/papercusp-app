/**
 * fuzzyEnum — the generic CLOSED-SET argument validator (generic-tool-arg-fuzzy-validation-2026-07-03,
 * D-001). The argument analogue of fuzzy tool-NAME resolution: a zod string schema that checks a
 * value against a closed set and, on a miss, returns the NEAREST allowed value(s) + the allowed
 * list — so a weak model that passes a typo'd/invalid value gets a corrective nudge instead of an
 * opaque failure.
 *
 * It composes into any tool's existing `args: z.object({ … })` and rides the EXISTING
 * `standardValidate → formatInvalidArgs` path: the rich `message` surfaces automatically (no
 * formatter change), and structured `params` ride along for structured consumers. Opt-in per arg;
 * generic by composition (works across ALL tools).
 *
 * WHEN to use it:
 *   - DYNAMIC sets that can't be a literal enum — models, harness/plan slugs, flag keys — where
 *     it is the only feasible guard. Back the resolver with an out-of-band-refreshed SYNC cache so
 *     validation stays fast and never blocks (this factory is deliberately SYNC so it works through
 *     every validation path, sync or async).
 * WHEN NOT to use it:
 *   - A STATICALLY-KNOWN set — prefer plain `z.enum([...])`. It rejects invalids too AND advertises
 *     the allowed values in the tool's JSON Schema up front (something a runtime refine can't).
 *     `fuzzyEnum` is the upgrade only where a literal enum is impossible.
 *
 * FAIL-OPEN: when the resolved set is empty (an unavailable/cold resolver), no issue is added — an
 * unavailable validator never blocks a real call.
 */
import { z } from 'zod';

/** Levenshtein edit distance (iterative two-row, O(n·m)). */
function levenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    const cur = [i];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[bl];
}

/** Top-k candidates nearest to `target` by NORMALIZED edit distance (≤ maxRatio) — a wildly-wrong
 *  value returns [] (so the caller shows the full list), a near-miss returns the suggestion(s). */
export function nearestByLevenshtein(
  target: string,
  candidates: readonly string[],
  opts: { k?: number; maxRatio?: number } = {},
): string[] {
  const k = opts.k ?? 3;
  const maxRatio = opts.maxRatio ?? 0.4;
  return candidates
    .map((s) => ({ s, d: levenshtein(s, target) }))
    .filter(({ s, d }) => d / Math.max(s.length, target.length || 1) <= maxRatio)
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map(({ s }) => s);
}

export interface FuzzyEnumOpts {
  /** Only validate when this returns true (default: always). Scopes a set to the values it actually
   *  governs — e.g. only validate a `model` that LOOKS local (a claude alias is an open set). */
  applies?: (value: string) => boolean;
  /** Canonicalize a value + each candidate BEFORE matching (case-fold, strip a provider prefix,
   *  …), so variant spellings of the same member match and are NOT false-rejected. Matching + the
   *  nearest search run on the normalized forms; the ORIGINAL candidate is what's shown as the
   *  suggestion. Default: identity. */
  normalize?: (value: string) => string;
  /** Noun used in the error message, e.g. 'model'. Default 'value'. */
  label?: string;
  /** Nearest-match tuning. */
  k?: number;
  maxRatio?: number;
  /** Cap the allowed-list echoed in the error, to bound the payload. Default 25. */
  maxListed?: number;
}

/**
 * A zod string schema that fuzzy-validates against a closed set (see module header). `allowed` is a
 * STATIC list or a SYNC resolver (cache-backed). Returns a `.custom` issue carrying a rich `message`
 * (`… Did you mean \`x\`? Allowed: [ … ]`) + structured `params { got, nearest, allowed }`.
 */
export function fuzzyEnum(
  allowed: readonly string[] | (() => readonly string[]),
  opts: FuzzyEnumOpts = {},
): z.ZodType<string> {
  const label = opts.label ?? 'value';
  const maxListed = opts.maxListed ?? 25;
  const norm = opts.normalize;
  return z.string().superRefine((value, ctx) => {
    if (opts.applies && !opts.applies(value)) return;
    const list = typeof allowed === 'function' ? allowed() : allowed;
    if (!list || list.length === 0) return; // FAIL-OPEN: nothing to check against
    // Match (and nearest-search) on the normalized forms; suggest the ORIGINAL candidates.
    const target = norm ? norm(value) : value;
    const pairs = list.map((orig) => ({ orig, key: norm ? norm(orig) : orig }));
    if (pairs.some((p) => p.key === target)) return;
    const nearest = nearestByLevenshtein(target, pairs.map((p) => p.key), { k: opts.k, maxRatio: opts.maxRatio })
      .map((key) => pairs.find((p) => p.key === key)?.orig ?? key);
    const shown = list.slice(0, maxListed);
    const more = list.length > shown.length ? ` (+${list.length - shown.length} more)` : '';
    const suggestion = nearest.length ? ` Did you mean ${nearest.map((s) => `\`${s}\``).join(' / ')}?` : '';
    ctx.addIssue({
      code: 'custom',
      params: { fuzzyEnum: true, got: value, nearest, allowed: shown },
      message: `\`${value}\` is not a valid ${label}.${suggestion} Allowed: [${shown.join(', ')}]${more}`,
    });
  });
}

/**
 * Async counterpart for dynamic sets backed by an async store. Standard Schema
 * validation already awaits async Zod refinements; using this variant makes a
 * cold cache load its authoritative set before deciding whether to fail open.
 */
export function fuzzyEnumAsync(
  allowed: readonly string[] | (() => readonly string[] | Promise<readonly string[]>),
  opts: FuzzyEnumOpts = {},
): z.ZodType<string> {
  const label = opts.label ?? 'value';
  const maxListed = opts.maxListed ?? 25;
  const norm = opts.normalize;
  return z.string().superRefine(async (value, ctx) => {
    if (opts.applies && !opts.applies(value)) return;
    const list = typeof allowed === 'function' ? await allowed() : allowed;
    if (!list || list.length === 0) return; // FAIL-OPEN: nothing to check against
    const target = norm ? norm(value) : value;
    const pairs = list.map((orig) => ({ orig, key: norm ? norm(orig) : orig }));
    if (pairs.some((p) => p.key === target)) return;
    const nearest = nearestByLevenshtein(target, pairs.map((p) => p.key), { k: opts.k, maxRatio: opts.maxRatio })
      .map((key) => pairs.find((p) => p.key === key)?.orig ?? key);
    const shown = list.slice(0, maxListed);
    const more = list.length > shown.length ? ` (+${list.length - shown.length} more)` : '';
    const suggestion = nearest.length ? ` Did you mean ${nearest.map((s) => `\`${s}\``).join(' / ')}?` : '';
    ctx.addIssue({
      code: 'custom',
      params: { fuzzyEnum: true, got: value, nearest, allowed: shown },
      message: `\`${value}\` is not a valid ${label}.${suggestion} Allowed: [${shown.join(', ')}]${more}`,
    });
  });
}
