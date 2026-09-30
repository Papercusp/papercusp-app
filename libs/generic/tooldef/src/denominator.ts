/**
 * guidance.denominator — result-aware base-rate stamping.
 *
 * THE DEFECT THIS EXISTS FOR (EI-19375528138828761): every read an agent makes
 * is a FILTERED one — the 10 rows it asked for. Nothing supplies the POPULATION
 * those rows were drawn from, so "these 8 sessions ended close together" cannot
 * be compared against "how often do 8 sessions end close together". Agents
 * therefore reason forward from a cluster without ever testing whether the
 * cluster is remarkable. The filed evidence is a whole investigation (WI-7126,
 * two causal hypotheses, reported) dissolved by ONE query: a minute-histogram
 * that was flat everywhere. There was no event to explain.
 *
 * WHY THIS IS NOT PART OF `projectBoundedPayload` (the question this design
 * had to answer, settled by reading it): that projector runs POST-HOC over an
 * already-serialized blob and receives only transport opts — toolName, tier,
 * args, recovery. It never sees the query, the filter, or the source set, so it
 * is structurally incapable of counting a population. Its `omittedCount` is a
 * denominator for TRUNCATION ("I dropped N fields to fit"), which is a
 * different question wearing similar clothes. Only the tool that issued the
 * query knows what it selected FROM.
 *
 * So the VALUE is authored per-tool and the CONTRACT is shared — the exact
 * split `guidance.seeAlso` already uses (see-also.ts): declared on the tool,
 * resolved from the actual result at dispatch, rendered uniformly into every
 * transport envelope. One seam, all tools, self-gating, never throws.
 *
 * DESIGN RULE — an unknown population must be LOUD, never absent. The failure
 * mode is not "a wrong denominator"; it is a filtered slice being read as a
 * census. An omitted stamp reads as "no denominator concept applies here",
 * which is indistinguishable from "this IS the whole population" — so a tool
 * that cannot count its source set says `population: 'unknown'` and the
 * renderer says so in words. A bounded measurement rendered as a confident
 * number is the thing we are trying to stop.
 */
import type { ToolResult } from './wire';

/**
 * A base-rate stamp: what the caller is seeing, against what it was drawn from.
 */
export interface Denominator {
  /** How many rows/items the caller is actually being shown. */
  matched: number;
  /**
   * How many existed in the set the filter selected FROM.
   *
   * `'unknown'` is a first-class, RENDERED value — use it whenever the tool
   * cannot honestly count the source set (an unbounded stream, a remote page,
   * a cap hit before counting). Never omit the stamp to mean this: absence
   * reads as "this is the whole set".
   */
  population: number | 'unknown';
  /**
   * What the population COUNTS, named in the caller's own vocabulary —
   * `'sessions'`, `'coord messages'`, `'open work-items'`. Renders as
   * "8 of 392 sessions", which is what makes the ratio legible.
   */
  of?: string;
  /**
   * The bound the population was counted over — a time window, a scope, a
   * harness. Without it "8 of 392" is unanchored: 392 over an hour and 392
   * over a month support opposite conclusions.
   */
  window?: string;
  /** Any caveat the ratio alone would misrepresent. Kept short. */
  note?: string;
}

/**
 * Result-aware denominator guidance. Either a STATIC value (rare — most
 * denominators are computed from the result) or, normally, a FUNCTION reading
 * the actual result so it can report the real counts and self-gate (return
 * `null`/`undefined` to emit nothing).
 *
 * `args`/`ctx` are intentionally `unknown` to keep this leaf module free of
 * host/role coupling; adopters narrow with a cast. Read the semantic output of
 * a content-encoded tool with `readJsonResult` from './see-also'.
 */
export type DenominatorSpec =
  | Denominator
  | ((
      result: ToolResult,
      args: unknown,
      ctx: unknown,
    ) => Denominator | null | undefined);

/** A finite, non-negative integer count. Anything else is not a count. */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Normalize a candidate into a valid stamp, or `null`.
 *
 * A malformed stamp is DROPPED rather than half-rendered: a partially-true
 * denominator is worse than none, because it still reads as authoritative.
 */
function normalize(d: unknown): Denominator | null {
  if (!d || typeof d !== 'object') return null;
  const raw = d as Partial<Denominator>;
  if (!isCount(raw.matched)) return null;
  // Narrow via the value, not a boolean flag — TS cannot carry a guard through
  // an intermediate `const ok = ...`.
  const population = raw.population;
  if (population !== 'unknown' && !isCount(population)) return null;

  // A population smaller than what we matched from it is arithmetically
  // impossible, so one of the two numbers is measuring something other than it
  // claims. Reporting the ratio anyway would launder that bug into a confident
  // ">100%" base rate, so refuse the stamp instead.
  if (typeof population === 'number' && population < raw.matched) return null;

  const out: Denominator = { matched: raw.matched, population };
  if (typeof raw.of === 'string' && raw.of.trim()) out.of = raw.of.trim();
  if (typeof raw.window === 'string' && raw.window.trim()) out.window = raw.window.trim();
  if (typeof raw.note === 'string' && raw.note.trim()) out.note = raw.note.trim();
  return out;
}

/**
 * Resolve a `guidance.denominator` against a concrete result.
 *
 * Evaluating the function form NEVER throws out — a broken denominator
 * callback must never fail the underlying tool call.
 */
export function resolveDenominator(
  spec: DenominatorSpec | undefined,
  result: ToolResult,
  args: unknown,
  ctx: unknown,
): Denominator | null {
  if (!spec) return null;
  let value: Denominator | null | undefined;
  if (typeof spec === 'function') {
    try {
      value = spec(result, args, ctx);
    } catch {
      return null;
    }
  } else {
    value = spec;
  }
  return normalize(value);
}

/** Percentage rendered at a precision that cannot imply false resolution. */
function ratioText(matched: number, population: number): string {
  if (population === 0) return '0 exist';
  const pct = (matched / population) * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/**
 * Render a stamp to one line.
 *
 * The `'unknown'` branch deliberately spends more words than the known one:
 * that is the case where a reader is most likely to mistake a slice for a
 * census, so it says the quiet part out loud.
 */
export function renderDenominatorText(d: Denominator): string {
  const of = d.of ? ` ${d.of}` : '';
  const inWindow = d.window ? ` in ${d.window}` : '';
  const note = d.note ? ` — ${d.note}` : '';

  if (d.population === 'unknown') {
    return (
      `Denominator: ${d.matched}${of} matched${inWindow}; population UNKNOWN. ` +
      `This is a FILTERED SLICE, not a census — it cannot support a base-rate ` +
      `or "unusual/anomalous" claim without counting the population first.${note}`
    );
  }
  return (
    `Denominator: ${d.matched} of ${d.population}${of}${inWindow} ` +
    `(${ratioText(d.matched, d.population)}).${note}`
  );
}

/**
 * Apply `guidance.denominator` to a tool result: inject structured
 * `_meta._denominator` + append the one-line stamp to `content`.
 *
 * Returns the result UNCHANGED when the tool declares no denominator, when the
 * callback self-gates, when the stamp is malformed, or when the result is a
 * soft error — so unrelated / failed calls pay nothing. Never throws.
 */
export function applyDenominator(
  result: ToolResult,
  spec: DenominatorSpec | undefined,
  args: unknown,
  ctx: unknown,
): ToolResult {
  if (!spec || result.isError) return result;
  const d = resolveDenominator(spec, result, args, ctx);
  if (!d) return result;
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), _denominator: d },
    content: [...result.content, { type: 'text' as const, text: renderDenominatorText(d) }],
  };
}
