/**
 * Wake-word `operator <verb>` intent parser (Phase 5, v4 §2f + §5a).
 *
 * Strict 2-word prefix match: utterance must START with "operator"
 * followed by a whitelisted verb. Anything else returns null and the
 * caller routes to its normal consumer.
 *
 * Verb whitelist:
 *   scan / status / what's pending → fire the `scan` launch blueprint
 *     (unify-agent-launches D-005: the panel + card stream are retired;
 *     findings land as work_items in the self-improvement backlog)
 *   approve <slug> [<cap>] → standing-approval shortcut
 *
 * (`open`/`show` and `across workspaces` were panel verbs — removed with
 * the operator-card panel, D-005.)
 *
 * Cap normalization rules (v4 §2f):
 *   Eligible: 2 segments, alphabetic-only, no _ or .
 *   Ineligible: refuse with "this capability has a complex name; please
 *   approve in /settings/operator"
 */

export type OperatorIntent =
  | { kind: 'scan'; query?: string }
  | { kind: 'approve'; targetSlug: string; capability?: string };

const SCAN_VERBS = new Set(['scan', 'status']);

const CAP_ELIGIBLE_RE = /^[a-z]+:[a-z]+$/;

export function parseOperatorIntent(utterance: string): OperatorIntent | null {
  const trimmed = utterance.trim().toLowerCase();
  if (!trimmed.startsWith('operator')) return null;

  // Multi-word verbs first.
  if (/^operator\s+what'?s\s+pending\b/.test(trimmed)) {
    return { kind: 'scan' };
  }

  const m = trimmed.match(/^operator\s+(\S+)(?:\s+(.+))?$/);
  if (!m) return null;
  const verb = m[1];
  const rest = m[2]?.trim();

  if (SCAN_VERBS.has(verb)) {
    return rest ? { kind: 'scan', query: rest } : { kind: 'scan' };
  }
  if (verb === 'approve') {
    if (!rest) return null;
    const parts = rest.split(/\s+/);
    const targetSlug = parts[0];
    if (!targetSlug) return null;
    let capability: string | undefined;
    if (parts.length > 1) {
      // Cap names spoken with hyphens (`tasks-write`); store with colons.
      const candidate = parts.slice(1).join('-').toLowerCase();
      capability = candidate.replace(/-/g, ':');
    }
    return { kind: 'approve', targetSlug, capability };
  }
  return null;
}

/**
 * Cap-eligibility check per v4 §2f. Returns true when the cap is safe
 * to grant by voice (round-trips cleanly through STT, can't get
 * confused with similar-sounding caps).
 */
export function isCapVoiceEligible(capability: string): boolean {
  return CAP_ELIGIBLE_RE.test(capability);
}

export interface ApproveResolution {
  action: 'approve' | 'refuse-no-match' | 'refuse-not-yet-shown' | 'refuse-ambiguous' | 'refuse-complex-cap';
  /** Set when action=approve. */
  capability?: string;
  /** Set when action=refuse-ambiguous: list of available capabilities. */
  options?: string[];
  /** Always set: target slug from the utterance. */
  targetSlug: string;
}

/** Standing-candidate row (subset; matches operator-standing-candidates.ts). */
export interface StandingCandidateLike {
  capability: string;
  targetHarness: string;
  /** v4 §5d: required non-null for voice-approve eligibility. */
  firstShownAt: string | null;
}

/**
 * Resolve an `operator approve <slug> [<cap>]` utterance against a list
 * of pending candidates.
 *
 * Disambiguation rules (v4 §2f):
 *   1. Filter to candidates with targetHarness === slug
 *   2. Filter out firstShownAt === null (user must have seen it)
 *   3. If explicit cap supplied: require cap to be voice-eligible AND
 *      to match exactly one filtered candidate
 *   4. If no explicit cap: auto-pick when exactly 1 remains; otherwise
 *      refuse with disambiguation prompt
 */
export function resolveApprove(
  intent: { targetSlug: string; capability?: string },
  candidates: StandingCandidateLike[],
): ApproveResolution {
  const matching = candidates.filter(
    (c) => c.targetHarness === intent.targetSlug && c.firstShownAt !== null,
  );

  if (matching.length === 0) {
    return { action: 'refuse-no-match', targetSlug: intent.targetSlug };
  }

  if (intent.capability) {
    if (!isCapVoiceEligible(intent.capability)) {
      return { action: 'refuse-complex-cap', targetSlug: intent.targetSlug };
    }
    const exact = matching.filter((c) => c.capability === intent.capability);
    if (exact.length === 1) {
      return { action: 'approve', capability: exact[0].capability, targetSlug: intent.targetSlug };
    }
    if (exact.length === 0) {
      return { action: 'refuse-no-match', targetSlug: intent.targetSlug };
    }
    // Two candidates with same cap+target shouldn't happen (uniqueness
    // invariant in the candidate detector); treat as ambiguous.
    return { action: 'refuse-ambiguous', targetSlug: intent.targetSlug, options: exact.map((c) => c.capability) };
  }

  // No explicit cap — must be exactly 1.
  if (matching.length === 1) {
    if (!isCapVoiceEligible(matching[0].capability)) {
      return { action: 'refuse-complex-cap', targetSlug: intent.targetSlug };
    }
    return { action: 'approve', capability: matching[0].capability, targetSlug: intent.targetSlug };
  }
  return {
    action: 'refuse-ambiguous',
    targetSlug: intent.targetSlug,
    options: matching.map((c) => c.capability),
  };
}
