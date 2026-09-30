/**
 * capture-persistence-gate.ts — the su-agent-behavior knowledge-capture "teeth"
 * (su-ideate-learning-substrate-2026-07-10 P-022(b), D-017).
 *
 * D-017: "the M4 GRADE battery graded knowledge-capture-and-memory-routing
 * 'partial, attribution:agent' for the FOURTH consecutive battery" — a persistent
 * agent-fault non-capture that, until now, sat in the scorecard trend as a NOTE
 * with no consequence. This module gives that criterion TEETH: it reads the
 * su-agent-behavior scorecard history for the knowledge-capture-and-memory-routing
 * criterion and, when the last N (default 4) consecutive ASSESSED batteries all
 * rated it a shortfall (partial/fail) attributed to the AGENT, it produces a
 * BLOCKING verdict — the signal a battery-graduation gate consults so persistent
 * non-capture blocks pass/graduation instead of being a note.
 *
 * Two disciplines, deliberately in tension, both honored:
 *   • TEETH — a positive, evidence-backed streak BLOCKS (that is the whole point).
 *   • FAIL-OPEN — a read failure / disabled switch NEVER manufactures a block
 *     (an infra blip must not wedge every graduation, and the block must rest on
 *     POSITIVE evidence of persistent non-capture, never on absence of data).
 *     A capturing battery (a `pass`) immediately RESETS the streak.
 *
 * Attribution: `ObservationRatingEntry` has no structured attribution field, so
 * "attribution:agent" is a convention carried in the rating's `evidence`. The
 * DEFAULT is agent-attribution (D-017's premise — the recurring shortfall WAS
 * attribution:agent); an explicit non-agent tag (attribution:harness/model/…)
 * exempts that battery (it wasn't the agent's fault, so it doesn't count toward
 * the streak — but neither does it reset it; it is simply skipped).
 */
import { SU_AGENT_BEHAVIOR_RUBRIC_ID } from '../agent-tools/behaviour/scorecard';

/** The su-agent-behavior criterion this gate puts teeth on. */
export const KNOWLEDGE_CAPTURE_CRITERION = 'knowledge-capture-and-memory-routing';

/** Kill switch — set to 'off' to disable the teeth (the gate then never blocks). */
export const CAPTURE_TEETH_KILL_ENV = 'PAPERCUSP_SU_CAPTURE_TEETH';

/** Consecutive agent-attributed non-capture batteries that block graduation (D-017 "FOURTH consecutive"). */
export const CAPTURE_NONCAPTURE_STREAK = 4;

/** How many recent su-agent-behavior scorecards to scan by default. */
export const CAPTURE_HISTORY_LIMIT = 50;

/** Whether a battery's knowledge-capture shortfall is attributed to the AGENT (counts) or not (exempt). */
export type CaptureAttribution = 'agent' | 'non-agent';

/** One battery's knowledge-capture rating (newest-first when passed to the evaluator). */
export interface CaptureRatingSample {
  /** The criterion rating (pass/partial/fail/… from the su-agent-behavior scale). */
  rating: string;
  /** Free-text evidence — the attribution convention ("attribution:agent") lives here. */
  evidence?: string;
  /** The scorecard/battery id this sample came from (drill-back). */
  batteryRef?: string;
  /** ISO timestamp the battery was filed. */
  at?: string;
}

/**
 * How one sample counts toward the streak:
 *   - 'non-capture' — a shortfall (partial/fail/…) attributed to the agent: EXTENDS the streak.
 *   - 'capture'     — a pass/healthy: capture happened, RESETS the streak.
 *   - 'neutral'     — unknown/unassessed, or a shortfall NOT attributed to the agent: SKIPPED.
 */
export type CaptureRatingClass = 'non-capture' | 'capture' | 'neutral';

/** The gate verdict — the teeth signal a graduation gate consults. */
export interface CapturePersistenceGate {
  /** True ⇔ ≥ threshold consecutive agent-attributed non-capture batteries lead the history. */
  blocking: boolean;
  /** The leading consecutive non-capture streak (assessed batteries only). */
  consecutiveNonCapture: number;
  /** The streak length that blocks (default {@link CAPTURE_NONCAPTURE_STREAK}). */
  threshold: number;
  /** How many ASSESSED (non-neutral) batteries were in the scanned history. */
  assessed: number;
  /** A short human-readable why. */
  reason: string;
  /** Set when the gate short-circuited (disabled / inert / read error) — always non-blocking then. */
  error?: string;
}

/** Injectable read seam — unit tests drive the gate with no scorecard store. */
export interface CapturePersistenceDeps {
  /** The knowledge-capture criterion history, NEWEST-FIRST, over the su-agent-behavior scorecards. */
  loadCriterionHistory: (opts: {
    rubricRef: string;
    sourceHive?: string;
    since?: string;
    limit: number;
  }) => Promise<CaptureRatingSample[]>;
}

// ── Pure classification + evaluation ─────────────────────────────────────────

/** Ratings that mean capture SUCCEEDED (reset the streak). */
const CAPTURE_RATINGS = new Set(['pass', 'healthy', 'good', 'yes', 'green', 'exemplary', 'exceptional']);
/** Ratings that mean a shortfall (candidate non-capture, pending attribution). */
const SHORTFALL_RATINGS = new Set(['partial', 'degraded', 'mixed', 'warn', 'fail', 'broken', 'bad', 'no', 'red', 'severe', 'poor']);

const AGENT_ATTR_RE = /attribution\s*[:=]\s*(?:agent|self)\b/i;
const NON_AGENT_ATTR_RE = /attribution\s*[:=]\s*(?:harness|model|infra|infrastructure|environment|env|platform|tool|na|n\/a|none)\b/i;

/**
 * PURE: parse the attribution convention out of a rating's evidence. Default
 * 'agent' (D-017's premise — the recurring knowledge-capture shortfall WAS
 * attribution:agent); only an EXPLICIT non-agent tag flips it to 'non-agent'.
 */
export function parseCaptureAttribution(evidence?: string): CaptureAttribution {
  const e = evidence ?? '';
  if (NON_AGENT_ATTR_RE.test(e) && !AGENT_ATTR_RE.test(e)) return 'non-agent';
  return 'agent';
}

/**
 * PURE: classify one battery's knowledge-capture rating for the streak walk.
 * A shortfall counts as 'non-capture' ONLY when attributed to the agent; an
 * unassessed (unknown/idle) or non-agent-attributed rating is 'neutral' (skipped
 * — it neither extends nor resets the streak). A pass is 'capture' (resets).
 */
export function classifyCaptureRating(sample: CaptureRatingSample): CaptureRatingClass {
  const rating = (sample.rating ?? '').trim().toLowerCase();
  if (CAPTURE_RATINGS.has(rating)) return 'capture';
  if (SHORTFALL_RATINGS.has(rating)) {
    return parseCaptureAttribution(sample.evidence) === 'agent' ? 'non-capture' : 'neutral';
  }
  return 'neutral';
}

/**
 * PURE: evaluate the teeth over a NEWEST-FIRST criterion history. Walk from the
 * newest sample, SKIPPING neutral (unassessed / non-agent) batteries, counting
 * the leading run of agent-attributed non-capture batteries, and STOPPING at the
 * first capture (a pass breaks the streak). Blocks iff that run ≥ threshold.
 */
export function evaluateCapturePersistence(
  history: readonly CaptureRatingSample[],
  opts: { threshold?: number } = {},
): CapturePersistenceGate {
  const threshold = opts.threshold && opts.threshold > 0 ? Math.floor(opts.threshold) : CAPTURE_NONCAPTURE_STREAK;
  let consecutiveNonCapture = 0;
  let assessed = 0;
  let streakBroken = false;
  for (const sample of history) {
    const cls = classifyCaptureRating(sample);
    if (cls === 'neutral') continue;
    assessed += 1;
    if (cls === 'capture') {
      streakBroken = true; // a pass anywhere resets the LEADING streak
      break;
    }
    // cls === 'non-capture'
    if (!streakBroken) consecutiveNonCapture += 1;
  }
  const blocking = consecutiveNonCapture >= threshold;
  const reason = blocking
    ? `${KNOWLEDGE_CAPTURE_CRITERION} rated non-capture (shortfall, attribution:agent) in ${consecutiveNonCapture} consecutive batteries (≥ ${threshold}) — battery graduation BLOCKED until a capturing battery lands (D-017 teeth)`
    : `${consecutiveNonCapture}/${threshold} consecutive agent-attributed non-capture batteries (${assessed} assessed) — not blocking`;
  return { blocking, consecutiveNonCapture, threshold, assessed, reason };
}

// ── Impure default read seam ─────────────────────────────────────────────────

/** A non-blocking gate — the fail-open / disabled result (never manufactures a block). */
function openGate(reason: string, threshold: number, error?: string): CapturePersistenceGate {
  return { blocking: false, consecutiveNonCapture: 0, threshold, assessed: 0, reason, ...(error ? { error } : {}) };
}

/**
 * Default history read: the knowledge-capture-and-memory-routing rating from each
 * recent su-agent-behavior scorecard (newest-first, agent emissions only — the
 * synthesized floor is excluded), mapped to a {@link CaptureRatingSample}. A
 * scorecard that did not rate the criterion is skipped.
 */
async function loadCriterionHistoryReal(opts: {
  rubricRef: string;
  sourceHive?: string;
  since?: string;
  limit: number;
}): Promise<CaptureRatingSample[]> {
  const { listScorecards } = await import('../scorecards');
  const rows = await listScorecards({
    rubricRef: opts.rubricRef,
    ...(opts.sourceHive ? { sourceHive: opts.sourceHive } : {}),
    ...(opts.since ? { since: opts.since } : {}),
    limit: opts.limit,
    includeSynthesized: false,
  });
  const out: CaptureRatingSample[] = [];
  for (const row of rows) {
    const entry = row.ratings?.[KNOWLEDGE_CAPTURE_CRITERION];
    if (!entry || typeof entry.rating !== 'string') continue;
    out.push({
      rating: entry.rating,
      ...(entry.evidence ? { evidence: entry.evidence } : {}),
      batteryRef: row.issueId,
      at: row.createdAt,
    });
  }
  return out;
}

const realDeps: CapturePersistenceDeps = { loadCriterionHistory: loadCriterionHistoryReal };

/**
 * Resolve the knowledge-capture teeth gate over the su-agent-behavior scorecard
 * history. FAIL-OPEN — disabled (kill switch), VITEST-inert (unless a test
 * injects `deps`), or any read error returns a NON-BLOCKING gate (a block rests
 * only on positive evidence of a ≥threshold non-capture streak). Never throws.
 */
export async function resolveCapturePersistenceGate(
  opts: {
    rubricRef?: string;
    sourceHive?: string;
    since?: string;
    limit?: number;
    threshold?: number;
  } = {},
  deps?: CapturePersistenceDeps,
): Promise<CapturePersistenceGate> {
  const threshold = opts.threshold && opts.threshold > 0 ? Math.floor(opts.threshold) : CAPTURE_NONCAPTURE_STREAK;
  try {
    if (process.env[CAPTURE_TEETH_KILL_ENV] === 'off') return openGate('disabled', threshold, 'disabled');
    if (process.env.VITEST && !deps) return openGate('vitest-inert', threshold, 'vitest-inert');
    const d = deps ?? realDeps;
    const history = await d.loadCriterionHistory({
      rubricRef: opts.rubricRef ?? SU_AGENT_BEHAVIOR_RUBRIC_ID,
      ...(opts.sourceHive ? { sourceHive: opts.sourceHive } : {}),
      ...(opts.since ? { since: opts.since } : {}),
      limit: opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : CAPTURE_HISTORY_LIMIT,
    });
    return evaluateCapturePersistence(history, { threshold });
  } catch (e) {
    return openGate('read-error', threshold, (e instanceof Error ? e.message : String(e)).slice(0, 200));
  }
}
