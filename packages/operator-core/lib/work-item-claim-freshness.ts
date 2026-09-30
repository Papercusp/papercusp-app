/**
 * Claim-time freshness envelope + scorer (fleet-member DX P-014).
 *
 * The envelope is evidence, never authority: a likely-stale score routes a bug
 * through a cheap validation pass but can never close it. This is deliberately a
 * payload extension rather than a parallel table — every issue-family row already
 * has a JSON payload and every claim surface already returns it.
 */

export interface WorkItemFreshnessEnvelope {
  observedAt: string;
  observedSourceSha: string | null;
  observedRuntimeSha: string | null;
  reporterSession: string | null;
  reporterRuntimeVersion: string | null;
  toolSchemaVersion: string | null;
  lastSuccessfulReproductionAt: string | null;
  deployBuildIdentity: string | null;
  linkedFixRefs: string[];
}

/**
 * The MEASURED answer to the source axis's real question: "has anything changed
 * in this item's own code since it was observed?"
 *
 * EI-22283949842250645: the axis was previously a sha-equality test between the
 * envelope's `observedSourceSha` and a `current.headSha` that the only caller fed
 * from `getBuildInfo()` — the same value already feeding `runtimeSha`. Two axes,
 * one input: `sourceMatch` and `runtimeMatch` could never disagree, so the axis
 * that exists to notice "someone already fixed this in the tree" affirmed
 * freshness it had never measured. Measured 2026-09-03: seven consecutive items
 * claimed at `likelyStale:false` were every one already fixed in source or
 * working-as-intended; none needed new code.
 *
 * A whole-tree sha compare cannot be repaired into that answer either. This tree
 * takes a git-sync sweep every few minutes across ~100 agents, so the repo tip has
 * ALWAYS moved and a tip-equality axis would simply fire on every item forever —
 * the same non-signal with the opposite sign. The question is only meaningful when
 * it is scoped to the item's OWN paths, which is what this signal carries.
 *
 * `unmeasured` is deliberately NOT a verdict in either direction — see the scorer.
 */
export type SourceGenerationSignal =
  | { kind: 'paths-moved'; paths: string[] }
  | { kind: 'paths-unchanged'; checked: string[] }
  | { kind: 'unmeasured'; reason: string };

export interface CurrentClaimIdentity {
  headSha: string | null;
  runtimeSha: string | null;
  runtimeVersion: string | null;
  /**
   * Measured source-generation evidence. When present it REPLACES the legacy
   * sha-equality source axis; when absent the sha compare still runs, so a caller
   * that cannot measure paths keeps today's behavior rather than silently losing
   * the axis. Deliberately a discriminated union rather than a nullable boolean:
   * "measured nothing moved" and "could not measure" are opposite verdicts, and
   * collapsing them onto `null` is the very ambiguity this fix exists to remove.
   */
  sourceSignal?: SourceGenerationSignal;
}

export interface ClaimFreshnessVerdict {
  lane: 'implementation' | 'validation';
  score: number;
  likelyStale: boolean;
  reasons: string[];
  envelope: WorkItemFreshnessEnvelope | null;
  current: CurrentClaimIdentity;
  instruction: string;
}

/**
 * The kinds that carry a claim-time freshness envelope AND get a claim-time
 * verdict — ONE definition, because this policy has two enforcement points that
 * must agree: the STAMP (`issues-engineer.createIssue`, which writes the
 * envelope at filing time) and the READ (`scheduler:get_next`, which scores it
 * at claim time). Until EI-20264587083609474 those were two hand-maintained
 * `kind === 'bug'` literals in different files, so the policy could only ever be
 * half-changed; a shared predicate makes that class of drift unrepresentable.
 *
 * `change` is included because it is this repo's DEFAULT kind for a code edit
 * (`task` is documented as non-code work), so it is exactly as susceptible to
 * "someone already built this" as a bug. Measured on EI-20264587083609474: of
 * the two already-built items its filer cited, EI-19932168784507536 was a bug
 * and EI-19313376980892266 was a `change` — so the bug-only gate skipped half
 * of the very evidence that motivated the freshness lane.
 *
 * `task` is deliberately EXCLUDED rather than forgotten: the scorer's only
 * item-specific axis is source-generation movement over the item's own paths,
 * and non-code work has no such paths. Including it would emit a verdict driven
 * entirely by the null/unmeasured defaults — a signal that fires identically on
 * every row, which trains readers to ignore the lane it is supposed to sharpen.
 */
export const FRESHNESS_TRACKED_KINDS: ReadonlySet<string> = new Set(['bug', 'change']);

/** Whether a work-item of this kind participates in claim-time freshness. */
export function isFreshnessTrackedKind(kind: string | null | undefined): boolean {
  return typeof kind === 'string' && FRESHNESS_TRACKED_KINDS.has(kind);
}

/**
 * Historical name: this stamps the envelope for every {@link FRESHNESS_TRACKED_KINDS}
 * kind, not bugs alone. Kept as-is because the name is load-bearing at five call
 * sites and the gate — not the label — is what was wrong.
 */
export function createBugFreshnessEnvelope(args: {
  now?: string;
  sourceSha?: string | null;
  runtimeSha?: string | null;
  reporterSession?: string | null;
  reporterRuntimeVersion?: string | null;
  toolSchemaVersion?: string | null;
  lastSuccessfulReproductionAt?: string | null;
  deployBuildIdentity?: string | null;
  linkedFixRefs?: string[];
}): WorkItemFreshnessEnvelope {
  return {
    observedAt: args.now ?? new Date().toISOString(),
    observedSourceSha: args.sourceSha ?? null,
    observedRuntimeSha: args.runtimeSha ?? null,
    reporterSession: args.reporterSession ?? null,
    reporterRuntimeVersion: args.reporterRuntimeVersion ?? null,
    toolSchemaVersion: args.toolSchemaVersion ?? null,
    lastSuccessfulReproductionAt: args.lastSuccessfulReproductionAt ?? null,
    deployBuildIdentity: args.deployBuildIdentity ?? null,
    linkedFixRefs: [...(args.linkedFixRefs ?? [])],
  };
}

function shaMatches(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}

function finiteAgeMs(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, nowMs - at) : null;
}

function readEnvelope(payload: unknown): WorkItemFreshnessEnvelope | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).freshnessEnvelope;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Partial<WorkItemFreshnessEnvelope>;
  if (typeof e.observedAt !== 'string') return null;
  return createBugFreshnessEnvelope({
    now: e.observedAt,
    sourceSha: typeof e.observedSourceSha === 'string' ? e.observedSourceSha : null,
    runtimeSha: typeof e.observedRuntimeSha === 'string' ? e.observedRuntimeSha : null,
    reporterSession: typeof e.reporterSession === 'string' ? e.reporterSession : null,
    reporterRuntimeVersion: typeof e.reporterRuntimeVersion === 'string' ? e.reporterRuntimeVersion : null,
    toolSchemaVersion: typeof e.toolSchemaVersion === 'string' ? e.toolSchemaVersion : null,
    lastSuccessfulReproductionAt:
      typeof e.lastSuccessfulReproductionAt === 'string' ? e.lastSuccessfulReproductionAt : null,
    deployBuildIdentity: typeof e.deployBuildIdentity === 'string' ? e.deployBuildIdentity : null,
    linkedFixRefs: Array.isArray(e.linkedFixRefs) ? e.linkedFixRefs.filter((x): x is string => typeof x === 'string') : [],
  });
}

/** Score freshness against the claimant's current operator HEAD/runtime. */
export function assessClaimFreshness(
  payload: unknown,
  current: CurrentClaimIdentity,
  nowMs = Date.now(),
): ClaimFreshnessVerdict {
  const envelope = readEnvelope(payload);
  const validationInstruction =
    'Cheap validation lane: inspect current HEAD and run the smallest targeted reproduction/test first. ' +
    'If it no longer reproduces, close only with that evidence; this score never auto-closes an item. ' +
    'A FALSIFIER quoted in the item body is an unvalidated instrument authored by the filer, not an oracle: ' +
    'before acting on it FIRING, run it against a negative control you know is NOT done. A broad keyword ' +
    'grep that also matches unrelated identifiers is the common defect, and this one fails toward a false ' +
    'PRESENCE of the fix — silently closing real work instead of causing loud rework.';
  if (!envelope) {
    return {
      lane: 'validation',
      score: 0.2,
      likelyStale: true,
      reasons: ['no freshness envelope (pre-envelope or unknown-generation report)'],
      envelope: null,
      current,
      instruction: validationInstruction,
    };
  }

  let score = 0.5;
  const reasons: string[] = [];
  const signal = current.sourceSignal;
  if (signal) {
    if (signal.kind === 'paths-moved') {
      score -= 0.35;
      const shown = signal.paths.slice(0, 3).map((p) => `\`${p}\``).join(', ');
      const more = signal.paths.length > 3 ? ` (+${signal.paths.length - 3} more)` : '';
      reasons.push(`source moved since observation: newer commits touch ${shown}${more}`);
    } else if (signal.kind === 'paths-unchanged') {
      score += 0.25;
    } else {
      // NEUTRAL, and deliberately so. An unmeasured axis must not be scored in
      // EITHER direction: rewarding it is the original defect (affirming freshness
      // nobody checked), and penalising it would route the ~62% of open bugs that
      // carry no resolvable paths (measured 2026-09-03: 521 of 1,369) into the
      // validation lane on ignorance rather than evidence, which drains the lane
      // of the meaning it is supposed to carry. Only measured movement moves the
      // lane; the caller is told the axis was blind via `reasons` instead.
      reasons.push(`source generation unmeasured (${signal.reason})`);
    }
  } else if (
    // RECURRENCE GUARD for the defect itself, not just this instance of it.
    //
    // The original bug lived in the CALLER — `scheduler:get_next` fed `build.sha` to
    // BOTH `headSha` and `runtimeSha` — so a scorer-side fix alone leaves the class
    // armed: any future caller can re-collapse the inputs and the scorer would again
    // report two independent confirmations of what is really one fact.
    //
    // Detect it from the VALUES, which is possible without knowing the caller's
    // intent: when the observed pair are the same sha AND the current pair are the
    // same sha, `sourceMatch` and `runtimeMatch` are computed from identical inputs
    // and cannot disagree by construction. There is one generation axis present, not
    // two, so scoring both double-counts a single piece of evidence. Score it ONCE,
    // as the runtime axis below, and report the source axis as what it is: unmeasured.
    //
    // This is deliberately NOT triggered when the two sides genuinely differ — a
    // caller that supplies a real source HEAD distinct from the runtime sha keeps
    // both independent axes.
    envelope.observedSourceSha != null &&
    envelope.observedSourceSha === envelope.observedRuntimeSha &&
    current.headSha != null &&
    current.headSha === current.runtimeSha
  ) {
    reasons.push(
      'source generation unmeasured (source and runtime identity are the same value on both sides — ' +
        'the two axes were fed one input and cannot disagree)',
    );
  } else {
    const sourceMatch = shaMatches(envelope.observedSourceSha, current.headSha);
    if (sourceMatch === true) score += 0.25;
    else if (sourceMatch === false) {
      score -= 0.35;
      reasons.push('source HEAD moved since observation');
    } else {
      score -= 0.1;
      reasons.push('source HEAD identity unavailable');
    }
  }
  const runtimeMatch = shaMatches(envelope.observedRuntimeSha, current.runtimeSha);
  if (runtimeMatch === true) score += 0.2;
  else if (runtimeMatch === false) {
    score -= 0.35;
    reasons.push('runtime/deploy generation moved since observation');
  } else {
    score -= 0.1;
    reasons.push('runtime identity unavailable');
  }

  const reproductionAge = finiteAgeMs(envelope.lastSuccessfulReproductionAt, nowMs);
  if (reproductionAge != null && reproductionAge <= 24 * 60 * 60 * 1000) score += 0.2;
  else if (reproductionAge != null && reproductionAge > 7 * 24 * 60 * 60 * 1000) {
    score -= 0.2;
    reasons.push('last successful reproduction is older than seven days');
  } else if (reproductionAge == null) {
    score -= 0.05;
    reasons.push('no successful reproduction timestamp');
  }

  const observationAge = finiteAgeMs(envelope.observedAt, nowMs);
  if (observationAge != null && observationAge > 30 * 24 * 60 * 60 * 1000) {
    score -= 0.2;
    reasons.push('observation is older than thirty days');
  } else if (observationAge != null && observationAge > 7 * 24 * 60 * 60 * 1000) {
    score -= 0.1;
    reasons.push('observation is older than seven days');
  }
  if (envelope.linkedFixRefs.length > 0) {
    score -= 0.45;
    reasons.push(`linked fixing work exists: ${envelope.linkedFixRefs.join(', ')}`);
  }

  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  // A linked fixing ref is direct evidence that the observed failure may have
  // been invalidated, regardless of how recent the original reproduction was.
  // Keep this as a routing verdict only: the validation lane still has to prove
  // the item already fixed before any terminal transition.
  const likelyStale = envelope.linkedFixRefs.length > 0 || score < 0.6;
  return {
    lane: likelyStale ? 'validation' : 'implementation',
    score,
    likelyStale,
    reasons: reasons.length > 0 ? reasons : ['observation matches the current source/runtime generation'],
    envelope,
    current,
    instruction: likelyStale
      ? validationInstruction
      : 'Implementation lane: freshness evidence matches the current generation. Reproduce before editing as usual.',
  };
}
