/**
 * orient-capture-miss-hint.ts — the coord:orient capture-MISS advisory fold
 * (su-ideate-learning-substrate-2026-07-10 P-022(a), D-017).
 *
 * D-017's observation-system audit found adoption is broad-but-shallow: agents
 * miss knowledge-capture at exactly the high-value moments — a turn shows
 * high-signal markers (an error-retry cluster, an EI-* reference, durable-
 * discovery language in its boundary artifacts) yet the agent filed ZERO
 * lane:observation rows, even while its checkpoint / completion text DID carry
 * the content. This fold is the "capture-miss nudge" half of P-022: a
 * DETERMINISTIC, advisory-only line folded into the agent's NEXT orient when that
 * exact pattern holds.
 *
 * It is a NUDGE, never a quota. D-017 explicitly REJECTS volume quotas and
 * mandatory turn-end filings ("the bounded ritual — only if a future agent
 * benefits — is correct, and quota pressure produces noise the digest must then
 * de-noise"). So the fold: emits AT MOST one advisory line, is purely advisory
 * (it never gates anything), and DISAPPEARS the moment the agent files even one
 * observation in the window.
 *
 * Cost discipline mirrors the P-011 ideate hint: fail-soft (the caller wraps this
 * in try/catch), bounded reads, and — the load-bearing short-circuit — the CHEAP
 * lane-filing count runs FIRST; only a ZERO-filing caller pays the (slightly
 * larger) marker gather, so an agent who filed anything sees nothing and pays
 * almost nothing.
 */
import { getLoopCarryNote, getLoopCarryJournal } from '../../../carry-note';
import { countObservationFilingsSince } from '../../../harness/improvements/read-items';

/** Kill switch — set to 'off' to disable the capture-miss advisory entirely. */
export const CAPTURE_MISS_KILL_ENV = 'PAPERCUSP_SU_CAPTURE_MISS';

/** Look-back window (ms) for both the lane-filing count and the marker gather (default 24h). */
export const CAPTURE_MISS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The three high-signal marker classes D-017 names, detected over the caller's
 * recent boundary text. Each boolean says whether that class fired; `hits` lists
 * the classes that did (for the advisory line).
 */
export interface HighSignalMarkers {
  /** ≥2 error/retry/failure tokens — a cluster, not a single passing mention. */
  errorRetryCluster: boolean;
  /** An EI-* engineer-issue reference (the durable-discovery id namespace). */
  eiReference: boolean;
  /** Durable-discovery language ("root cause", "turns out", "the fix was", …). */
  durableDiscovery: boolean;
  /** Which marker classes fired — a short human-readable list. */
  hits: string[];
}

/** The advisory line, produced ONLY when the capture-miss pattern holds. */
export interface CaptureMissHint {
  /** Always true when present — orient folds this object only when it fires. */
  advise: true;
  /** The marker classes that fired (drives the reason line). */
  markers: string[];
  /** A short, advisory-only "you filed nothing high-signal" line. */
  reason: string;
}

/** Injectable read seam — unit tests drive the verdict with no PG / carry-note store. */
export interface CaptureMissHintDeps {
  /** Count of the caller's lane:observation rows filed strictly after `sinceMs`. */
  countLaneFilingsSince: (ownerId: string, sinceMs: number) => Promise<number>;
  /** The caller's recent high-signal boundary text (carry-note + journal, completion notes …). */
  gatherSignalText: (ownerId: string, harness: string | undefined) => Promise<string[]>;
}

// ── Pure marker detection ────────────────────────────────────────────────────

/** ≥2 total occurrences ⇒ a cluster (a single passing mention never trips it). */
const ERROR_RETRY_RE = /\b(?:errors?|retr(?:y|ied|ies|ying)|fail(?:ed|ing|ure)?|timed?[ -]?out|timeout|flak(?:e|y)|exception|traceback|stack ?trace)\b/gi;
/**
 * NEGATED forms stripped BEFORE the cluster count — a healthy status line like
 * "2482 tests green, 0 failed, no errors" is the OPPOSITE of an error-retry
 * cluster, but naively contributes 2 tokens (the audit-found false positive).
 */
const NEGATED_ERROR_RE = /\b(?:0|no|zero|none|never|without|non-)[\s-]*(?:new\s+)?(?:errors?|retr(?:y|ies)|fail(?:ed|ing|ures?)?|timeouts?|exceptions?|flak(?:es?|y))\b/gi;
/** The engineer-issue id namespace — the durable-discovery reference. */
const EI_REF_RE = /\bEI-\d+\b/i;
/**
 * Durable-discovery language — the phrases an agent uses when it learned
 * something a future agent would waste time re-deriving (D-017's bar).
 */
const DURABLE_DISCOVERY_RE =
  /\b(?:turns? out|root cause|the (?:real )?(?:issue|problem|cause) (?:is|was)|the (?:fix|trick|catch|gotcha) (?:is|was)|gotcha|footgun|foot-gun|non-obvious|red herring|discovered that|learned that|figured out|it turns out|only works if|had to|caveat|subtle(?:ty)?|the culprit)\b/i;

/**
 * PURE: scan the caller's recent boundary text for the three high-signal marker
 * classes (D-017). Case-insensitive; the error-retry class requires a CLUSTER
 * (≥2 occurrences) so a single passing "0 errors" line never trips it.
 */
export function detectHighSignalMarkers(samples: readonly string[]): HighSignalMarkers {
  const text = samples.filter((s) => typeof s === 'string' && s.trim()).join('\n');
  // Strip negated forms first ("0 failed", "no errors") so a healthy status
  // line never counts toward the error-retry cluster.
  const positiveText = text.replace(NEGATED_ERROR_RE, ' ');
  const errorRetryCount = (positiveText.match(ERROR_RETRY_RE) ?? []).length;
  const errorRetryCluster = errorRetryCount >= 2;
  const eiReference = EI_REF_RE.test(text);
  const durableDiscovery = DURABLE_DISCOVERY_RE.test(text);
  const hits: string[] = [];
  if (errorRetryCluster) hits.push('error-retry cluster');
  if (eiReference) hits.push('EI-* reference');
  if (durableDiscovery) hits.push('durable-discovery language');
  return { errorRetryCluster, eiReference, durableDiscovery, hits };
}

/**
 * PURE: the fire decision. The advisory fires IFF the caller filed ZERO
 * lane:observation rows in the window AND at least one high-signal marker class
 * fired. Returns null (no advisory) otherwise — a filer, or a quiet turn, is
 * never nudged. Advisory-only: this object never gates anything (D-017 — teeth
 * live in P-022(b)'s battery gate, NOT here).
 */
export function computeCaptureMissHint(input: {
  markers: HighSignalMarkers;
  laneFilingsSince: number;
}): CaptureMissHint | null {
  const { markers, laneFilingsSince } = input;
  const anyMarker = markers.errorRetryCluster || markers.eiReference || markers.durableDiscovery;
  if (laneFilingsSince !== 0 || !anyMarker) return null;
  return {
    advise: true,
    markers: markers.hits,
    reason:
      `your recent turn shows high-signal markers (${markers.hits.join(', ')}) but you filed no lane:observation — ` +
      `if a future agent would benefit, capture the durable bit via improvements:capture { lane:'observation' } (advisory, not a quota)`,
  };
}

// ── Impure default read seam ─────────────────────────────────────────────────

/** Count the caller's lane:observation rows filed strictly after `sinceMs` (mirrors the P-011 hint). */
async function countLaneFilingsSinceDefault(ownerId: string, sinceMs: number): Promise<number> {
  // P-008 (db-performance-remediation-2026-07-26): was `readObservationItems({})` +
  // an in-memory `.filter(...).length` — up to 500 full candidates (body + entire
  // payload JSONB) materialised on EVERY orient just to produce a count. See the
  // twin fold in orient-ideate-hint; together ~931k calls at ~825 rows/call.
  return countObservationFilingsSince(ownerId, new Date(sinceMs).toISOString());
}

/**
 * Gather the caller's recent high-signal boundary text. The reliable, cheap,
 * author-keyed source is the caller's loop carry-note (its `insight` / `did` /
 * `left` / `next` fields — the exact durable-discovery residual P-020 harvests
 * from, plus the EI-refs / error-retry language the harvest does NOT take) and
 * its recent journal ring. The carry-note scope needs a harness: when the orient
 * call didn't pass one (most su orients don't — the audit-found coverage gap),
 * fall back to the caller's presence `potSlug` (their home pot, the same slug a
 * loop is scoped under). Still-unresolvable ⇒ [] (the advisory silently no-ops —
 * fail-soft, advisory-only). Never throws — a store error degrades to no advisory.
 */
async function gatherSignalTextDefault(ownerId: string, harness: string | undefined): Promise<string[]> {
  let scope = harness;
  if (!scope) {
    try {
      const { getPresence } = await import('../presence');
      scope = (await getPresence(ownerId))?.potSlug ?? undefined;
    } catch {
      /* fall through — no advisory rather than a broken orient */
    }
  }
  if (!scope) return [];
  const ref = { harness: scope, ownerId };
  const [note, journal] = await Promise.all([
    getLoopCarryNote(ref).catch(() => null),
    getLoopCarryJournal(ref).catch(() => [] as Array<{ note: string }>),
  ]);
  const samples: string[] = [];
  if (note && note.trim()) samples.push(note);
  for (const entry of journal) {
    if (entry && typeof entry.note === 'string' && entry.note.trim()) samples.push(entry.note);
  }
  return samples;
}

export const defaultCaptureMissHintDeps: CaptureMissHintDeps = {
  countLaneFilingsSince: countLaneFilingsSinceDefault,
  gatherSignalText: gatherSignalTextDefault,
};

/**
 * Resolve the capture-miss advisory for one caller, or `undefined` when it does
 * not fire (a filer, a quiet turn, disabled, or any read failure). NEVER throws
 * — every failure path returns `undefined` so the orient fold stays fail-soft.
 *
 * Short-circuit: read the CHEAP lane-filing count first; a caller who filed
 * anything (or whose filing read failed — we must not nudge on an unconfirmed
 * zero) returns immediately WITHOUT the marker gather.
 *
 * Kill-switch (`PAPERCUSP_SU_CAPTURE_MISS=off`) and VITEST-inert (unless a test
 * injects `deps`) follow the P-017..P-021 leg conventions.
 */
export async function resolveCaptureMissHint(
  input: { ownerId: string; harness?: string; nowMs?: number; sinceMs?: number },
  deps?: CaptureMissHintDeps,
): Promise<CaptureMissHint | undefined> {
  try {
    if (process.env[CAPTURE_MISS_KILL_ENV] === 'off') return undefined;
    if (process.env.VITEST && !deps) return undefined;
    const ownerId = (input.ownerId ?? '').trim();
    if (!ownerId) return undefined;
    const d = deps ?? defaultCaptureMissHintDeps;
    const nowMs = input.nowMs ?? Date.now();
    const sinceMs = input.sinceMs ?? nowMs - CAPTURE_MISS_WINDOW_MS;

    // Cheap read first: a caller who filed anything is not nudged, and an
    // unconfirmable count (read failure → -1) must NOT nudge either.
    const laneFilingsSince = await d.countLaneFilingsSince(ownerId, sinceMs).catch(() => -1);
    if (laneFilingsSince !== 0) return undefined;

    const samples = await d.gatherSignalText(ownerId, input.harness).catch(() => [] as string[]);
    const markers = detectHighSignalMarkers(samples);
    return computeCaptureMissHint({ markers, laneFilingsSince }) ?? undefined;
  } catch {
    return undefined;
  }
}
