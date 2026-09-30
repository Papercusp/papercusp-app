/**
 * residual-carry-pass — the TRANSITIONAL residual-LLM pass + its miss-rate gate
 * for P-019 (deterministic-context-carry-2026-07-14, Phase 6).
 *
 * D-002 makes the papercusp-owned DETERMINISTIC carry document (stage-1:
 * buildCarryDoc → renderCarryDoc) the summary a session folds in at a compaction
 * boundary, and declares the LLM summarizer "transitional … retires per session
 * class on ~0 miss-rate evidence (P-008/P-019 gate)". THIS module is that gate.
 *
 * Two cohesive halves of one plan item:
 *
 *   1. The RESIDUAL PASS ({@link runResidualCarryPass}) — a bounded, interactive-
 *      only LLM call that runs AFTER stage-1 and asks one question: does the raw
 *      context stage-1 is DROPPING contain any MATERIAL fact/directive/commitment
 *      that stage-1 failed to represent? It is a SAFETY NET, not the summary — its
 *      only product is a list of stage-1 MISSES. Interactive-only (an autonomous
 *      drone hop does not pay an LLM call for a miss a human would never see),
 *      ≤4K output tokens, routed through the reserved maintenance lane (P-002) so
 *      it cannot starve worker traffic, and a PROVENANCE-TAGGING prompt: every
 *      finding must carry a source tag + an anchor.
 *
 *   2. The MISS-RATE SCORER ({@link scoreResidualMissRate}) — aggregates the
 *      pass's per-boundary verdicts by session class and recommends RETIREMENT of
 *      the pass for a class once the observed miss-rate is ~0 over a sufficient
 *      sample. That retirement signal is what unblocks P-022 (retire native
 *      compaction fleet-wide).
 *
 * The P-008 stage-0 audit (WI-4803, artifact audits/p008-native-summary-baseline)
 * SHAPES the pass: it graded 214 native summaries and found intra-window fidelity
 * already ~0 and the ONE live residual channel to be cross-session `[owner:]`
 * inheritance — a claim whose source turn lives outside the transcript. But that
 * channel is now closed DETERMINISTICALLY by P-014 (provenance stamped from the
 * turn-provenance ledger, manual tags retired), NOT by an LLM. So the pass must
 * NOT re-litigate provenance (stage-1's tags are authoritative) — it measures only
 * CONTENT COMPLETENESS: material state absent from stage-1 entirely. That is why
 * the expected miss-rate is ~0 and this module is fundamentally an INSTRUMENT that
 * proves it per class so P-022 can cut.
 *
 * Split exactly like carry-respawn.ts (P-018) / maintenance-carry.ts (P-017): the
 * PURE cores (prompt assembly, response parsing, scoring) live + are unit-tested
 * here; the LIVE legs — the real maintenance-lane LLM call and the per-class
 * sampling harness that drives real compaction boundaries — ride the Phase-7
 * cold-boot drills (P-020) and land DEFAULT-OFF. A residual pass is only ever a
 * safety net: over-flagging keeps stage-2 alive one class longer (conservative,
 * loses no data); it never gates or blocks a compaction.
 */

/** Output-token ceiling for the residual pass (P-019: "≤4K max_tokens"). */
export const RESIDUAL_MAX_TOKENS = 4000;

/** Default retirement gate params for {@link scoreResidualMissRate}. */
export const DEFAULT_MISS_RATE_PARAMS: MissRateParams = {
  /** "miss-rate ~0": retire only on ZERO observed material misses by default. A
   *  spurious residual flag is either a real miss or an unreliable pass — both are
   *  reasons to KEEP the net, so the safe default is strict zero (configurable up). */
  epsilon: 0,
  /** Do not retire a class we have barely sampled — a clean run of <N is not
   *  evidence of ~0, just of thin data. */
  minSample: 30,
  /** Do not retire on a class whose pass is ERRORING a lot: unparseable responses
   *  are not evidence of "no miss", they are evidence the instrument is blind. */
  maxErrorFraction: 0.1,
};

/** Provenance tag on a residual finding — the compaction-strategy tag vocabulary. */
export type ResidualProvenance = 'owner' | 'self-imposed' | 'peer' | 'inferred' | 'unknown';

const PROVENANCE_VALUES: ReadonlySet<string> = new Set([
  'owner',
  'self-imposed',
  'peer',
  'inferred',
  'unknown',
]);

/** One thing the residual pass says stage-1 dropped. */
export interface ResidualFinding {
  /** The material fact/directive/commitment stage-1 failed to represent. */
  text: string;
  /** Source tag the pass assigned (normalized; unknown when it could not tag). */
  provenance: ResidualProvenance;
  /** Where in the dropped context it came from (a quote/pointer), or null. */
  anchor: string | null;
  /** The pass's judgement that this is genuinely material + genuinely absent from
   *  stage-1. Only material findings count as a stage-1 miss. */
  material: boolean;
}

/** The verdict of one residual pass at one compaction boundary. */
export interface ResidualPassResult {
  /** The session-class label (for per-class aggregation in the scorer). */
  sessionClass: string;
  /** False when the pass was SKIPPED (not an interactive session) — a skipped
   *  boundary is not a sample, so it never enters the miss-rate. */
  ran: boolean;
  /** Why the pass did not run, when `ran` is false. */
  skippedReason?: 'non-interactive';
  /** Findings the pass returned (empty ⇒ stage-1 judged complete). */
  findings: ResidualFinding[];
  /** Any MATERIAL finding ⇒ this boundary is a stage-1 miss. */
  material: boolean;
  /** The LLM response could not be parsed into findings — excluded from the
   *  miss-rate denominator (a blind instrument, not a proof of completeness). */
  parseError: boolean;
  /** Size of the assembled prompt (observability; the caller bounds droppedContext). */
  promptChars: number;
}

/** The reserved-maintenance-lane LLM call, injected so the core stays pure/testable.
 *  Live wiring supplies the P-002 /maintenance/summarize lane (priority:maintenance,
 *  off the agent's own backend); tests supply a stub. Returns the raw model text. */
export type ResidualLlmFn = (
  prompt: string,
  opts: { maxTokens: number; sessionClass: string },
) => Promise<string>;

export interface RunResidualCarryPassInput {
  /** Session-class label — the aggregation key, NOT the interactive gate. */
  sessionClass: string;
  /** The interactive-only gate. The CALLER knows the session kind (psu-launcher /
   *  gateway); we do not guess it from the class string. Non-interactive ⇒ skip. */
  interactive: boolean;
  /** Stage-1 output: the rendered deterministic carry document (the summary). */
  stage1Doc: string;
  /** The raw turns this compaction is DROPPING — the material stage-1 must fully
   *  represent, or the pass flags the gap. The caller bounds its size. */
  droppedContext: string;
  /** The reserved-lane LLM call (seam). */
  llmFn: ResidualLlmFn;
  /** Output-token cap; clamped to ≤ {@link RESIDUAL_MAX_TOKENS}. */
  maxTokens?: number;
}

const EMPTY_SKIP = (sessionClass: string): ResidualPassResult => ({
  sessionClass,
  ran: false,
  skippedReason: 'non-interactive',
  findings: [],
  material: false,
  parseError: false,
  promptChars: 0,
});

/**
 * Build the provenance-tagging residual prompt: stage-1 doc + the dropped context
 * + a strict JSON contract. PURE + exported so a test can assert the contract
 * without an LLM. The instruction is deliberately narrow — measure CONTENT
 * COMPLETENESS, not provenance (stage-1's ledger-stamped tags are authoritative,
 * P-014) — and conservative (flag on doubt: a false positive only delays
 * retirement, it never loses data).
 */
export function buildResidualPassPrompt(stage1Doc: string, droppedContext: string): string {
  return [
    'You audit a DETERMINISTIC compaction summary (STAGE-1) for COMPLETENESS.',
    'STAGE-1 is the authoritative carry document a successor session will receive.',
    'DROPPED CONTEXT below is raw conversation STAGE-1 is discarding at this boundary.',
    '',
    'Your ONLY job: list MATERIAL content in DROPPED CONTEXT that STAGE-1 fails to',
    'represent — a fact, owner/peer directive, open commitment, gate/wall, or live',
    'state a successor would need and could not recover from STAGE-1 alone.',
    '',
    'HARD RULES:',
    '- Do NOT restate anything STAGE-1 already contains (even if worded differently).',
    "- Do NOT dispute STAGE-1's provenance tags — they are stamped mechanically from",
    '  the turn-provenance ledger and are authoritative. Judge CONTENT only.',
    '- Pay special attention to owner directives/claims present in DROPPED CONTEXT',
    '  that STAGE-1 omits — that is the one channel the stage-0 audit found live.',
    '- Do NOT invent. If DROPPED CONTEXT adds nothing material, return no findings.',
    '- When unsure whether STAGE-1 covers something, FLAG it (conservative).',
    '- Every finding carries a provenance tag and an anchor quote from DROPPED CONTEXT.',
    '',
    'Reply with STRICT JSON only, no prose, no markdown fence:',
    '{"findings":[{"text":"<the missed material>",',
    '"provenance":"owner|self-imposed|peer|inferred|unknown",',
    '"anchor":"<short verbatim quote from DROPPED CONTEXT, or null>",',
    '"material":true}]}',
    'Empty findings array = STAGE-1 is complete.',
    '',
    '=== STAGE-1 (deterministic summary) ===',
    stage1Doc,
    '',
    '=== DROPPED CONTEXT (raw turns being discarded) ===',
    droppedContext,
  ].join('\n');
}

/** Normalize a raw provenance string from the model to a known tag. */
function normalizeProvenance(raw: unknown): ResidualProvenance {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (PROVENANCE_VALUES.has(v)) return v as ResidualProvenance;
  }
  return 'unknown';
}

/**
 * Parse the model's residual response into findings. Tolerant: strips a ```json
 * fence and any prose around the first JSON object, keeps only well-formed
 * findings, and drops empty-text ones. Returns null (⇒ parseError) when no JSON
 * object can be recovered — a blind boundary, never a silent "no miss". PURE +
 * exported for direct test.
 */
export function parseResidualResponse(raw: string): ResidualFinding[] | null {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rawFindings = (obj as { findings?: unknown }).findings;
  if (rawFindings === undefined || rawFindings === null) return []; // valid "complete" shape
  if (!Array.isArray(rawFindings)) return null;
  const findings: ResidualFinding[] = [];
  for (const f of rawFindings) {
    if (!f || typeof f !== 'object') continue;
    const rec = f as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (!text) continue;
    const anchorRaw = rec.anchor;
    const anchor =
      typeof anchorRaw === 'string' && anchorRaw.trim() ? anchorRaw.trim() : null;
    findings.push({
      text,
      provenance: normalizeProvenance(rec.provenance),
      anchor,
      // Default TRUE when the flag is absent/garbled: a listed finding is a claimed
      // miss, and the conservative reading keeps the net alive.
      material: rec.material === false ? false : true,
    });
  }
  return findings;
}

/**
 * Run the transitional residual pass for ONE compaction boundary. Fail-soft: a
 * non-interactive session skips (not a sample); an LLM throw or an unparseable
 * response yields parseError (excluded from the miss-rate), never a throw and never
 * a false "no miss". The pass NEVER blocks the compaction — stage-1 already carried.
 */
export async function runResidualCarryPass(
  input: RunResidualCarryPassInput,
): Promise<ResidualPassResult> {
  const { sessionClass, interactive, stage1Doc, droppedContext, llmFn } = input;
  if (!interactive) return EMPTY_SKIP(sessionClass);

  const maxTokens = Math.min(Math.max(1, input.maxTokens ?? RESIDUAL_MAX_TOKENS), RESIDUAL_MAX_TOKENS);
  const prompt = buildResidualPassPrompt(stage1Doc ?? '', droppedContext ?? '');
  const promptChars = prompt.length;

  let raw: string;
  try {
    raw = await llmFn(prompt, { maxTokens, sessionClass });
  } catch {
    return { sessionClass, ran: true, findings: [], material: false, parseError: true, promptChars };
  }

  const findings = parseResidualResponse(raw);
  if (findings === null) {
    return { sessionClass, ran: true, findings: [], material: false, parseError: true, promptChars };
  }
  const material = findings.some((f) => f.material);
  return { sessionClass, ran: true, findings, material, parseError: false, promptChars };
}

// ─────────────────────────────────────────────────────────────────────────────
// Miss-rate scorer + per-class retirement gate (feeds P-022)
// ─────────────────────────────────────────────────────────────────────────────

/** Tuning for the retirement gate. */
export interface MissRateParams {
  /** Max miss-rate that still counts as "~0" and permits retirement. */
  epsilon: number;
  /** Minimum PARSED sample size for a class before retirement is even considered. */
  minSample: number;
  /** Max fraction of samples that may be parseErrors and still permit retirement. */
  maxErrorFraction: number;
}

/** One residual-pass outcome, as fed to the scorer. */
export interface MissRateSample {
  sessionClass: string;
  /** A material stage-1 miss was found at this boundary. */
  material: boolean;
  /** The pass could not parse its response (excluded from the rate denominator). */
  parseError?: boolean;
  /** False ⇒ the pass was skipped (non-interactive) and is not a sample. Default true. */
  ran?: boolean;
}

/** Per-class miss-rate + retirement recommendation. */
export interface ClassMissRate {
  sessionClass: string;
  /** Total ran samples for the class (parsed + errored). */
  n: number;
  /** Parsed samples flagged as a material miss. */
  materialCount: number;
  /** Samples the pass could not parse. */
  errorCount: number;
  /** materialCount / (n − errorCount); 1 when there is no parsed sample (unknown). */
  missRate: number;
  /** True ⇒ retire the residual pass for this class (P-022 consumes this). */
  retire: boolean;
}

export interface MissRateReport {
  perClass: ClassMissRate[];
  params: MissRateParams;
  /** Classes recommended for retirement, for a quick read. */
  retirableClasses: string[];
}

/**
 * Aggregate residual-pass samples by session class and recommend per-class
 * retirement of the transitional pass. PURE. A class retires when it has enough
 * PARSED evidence (≥ minSample), its miss-rate is within epsilon of zero, AND the
 * pass is not blind on it (error fraction ≤ maxErrorFraction). Skipped
 * (non-interactive) samples are dropped; errored samples count toward the blind
 * fraction but not the miss-rate denominator.
 */
export function scoreResidualMissRate(
  samples: MissRateSample[],
  params: MissRateParams = DEFAULT_MISS_RATE_PARAMS,
): MissRateReport {
  const byClass = new Map<string, { n: number; material: number; error: number }>();
  for (const s of samples) {
    if (!s || s.ran === false) continue;
    const cls = s.sessionClass;
    if (typeof cls !== 'string' || !cls) continue;
    const agg = byClass.get(cls) ?? { n: 0, material: 0, error: 0 };
    agg.n += 1;
    if (s.parseError) agg.error += 1;
    else if (s.material) agg.material += 1;
    byClass.set(cls, agg);
  }

  const perClass: ClassMissRate[] = [];
  for (const [sessionClass, agg] of byClass) {
    const parsed = agg.n - agg.error;
    const missRate = parsed > 0 ? agg.material / parsed : 1;
    const errorFraction = agg.n > 0 ? agg.error / agg.n : 1;
    const retire =
      parsed >= params.minSample &&
      missRate <= params.epsilon &&
      errorFraction <= params.maxErrorFraction;
    perClass.push({
      sessionClass,
      n: agg.n,
      materialCount: agg.material,
      errorCount: agg.error,
      missRate,
      retire,
    });
  }
  perClass.sort((a, b) => a.sessionClass.localeCompare(b.sessionClass));

  return {
    perClass,
    params,
    retirableClasses: perClass.filter((c) => c.retire).map((c) => c.sessionClass),
  };
}
