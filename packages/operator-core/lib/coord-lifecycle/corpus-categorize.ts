/**
 * corpus-categorize.ts — the VALIDATION INSTRUMENT for the automation
 * (coord-lifecycle-automation-2026-06-04 D-006).
 *
 * The plan's success criterion is empirical: "re-run the corpus categorization
 * after each phase — the contextual bucket should be the ONLY thing left on
 * coord:send." This module is that re-runnable categorizer. Given a coord
 * `messages`-surface envelope, it buckets it into a lifecycle category (the
 * D-003 table) or `contextual` (the genuinely-unpredictable residual).
 *
 * It is a deliberately ROUGH heuristic over summary/body text — its job is to
 * measure the SHAPE of the corpus (how much is predictable lifecycle vs how much
 * is irreducibly contextual), not to drive any runtime behavior. As automation
 * lands, messages that used to be free-text completion/claim/intent prose become
 * `auto`-stamped `coord:emit`s, which this bucket as `lifecycle-auto` — so the
 * `contextual` share is the headline metric: it should approach the ~5% the plan
 * predicts, and stay there.
 */

/** The categorization buckets (the D-003 table + the two terminal buckets). */
export type CoordBucket =
  | 'lifecycle-auto' // already auto-emitted by this system (auto:true) — the win
  | 'completion'
  | 'claim-start'
  | 'intent-window'
  | 'restart-resource'
  | 'ack'
  | 'finding-health'
  | 'handoff'
  | 'contextual'; // the irreducible residual that SHOULD stay free-text

/** The minimal envelope shape the categorizer reads. */
export interface CoordMsgLike {
  kind?: string;
  summary?: string;
  body?: string;
  /** Set by coord:emit — marks an already-automated lifecycle emission. */
  auto?: boolean;
  lifecycle?: string;
}

const RE = {
  ackStart: /^\s*(ack\b|thanks\b|thank you\b|got it\b|will do\b|noted\b|sounds good\b|agreed\b|accepted\b|👍|🙏)/i,
  restartResource:
    /\b(dev-server|draining|drain\b|back up|restart(ing|ed)?|exclusive hold|release_resource|acquire_resource)\b|🔒|✅ "?[\w-]+"? is back up/i,
  completion:
    /\b(BUILT\+TESTED|BUILT|DONE\b|LANDED\b|shipped\b|complete(d)?\b|all \d+ (phases|decisions)|✅ .*(done|built|landed|tested))\b/i,
  completionCorroborate: /\b(\d+\s+(green\s+)?tests?|migrations?\b|migs?\b|phases?\b|tested\b)\b/i,
  claimStart: /^\s*(taking\b|executing\b|implementing\b|carrying\b|picking up\b|claiming\b|i'?ll take\b|i own\b|owner-)/i,
  intentWindow:
    /\b(heads-?up|holding\b|hold .*(until|till)|i'?ll keep .* (in|on)|coordinate before|about to (edit|touch)|editing\b|window\b|starting (now|on)\b)/i,
  findingHealth:
    /\b(finding\b|root cause\b|collision\b|regression\b|broke\b|broken\b|fails?\b|failing\b|bug\b|⚠|stale\b|leak\b|race\b)\b/i,
  handoff: /\b(hand(ing)?[- ]?off|handoff|over to you|you take|i'?ll hand)\b/i,
};

/**
 * Bucket one coord message. First match wins; ordering encodes precedence
 * (already-automated → typed-op categories → contextual residual).
 */
export function categorizeCoordMessage(m: CoordMsgLike): CoordBucket {
  // Already automated by THIS system — the win we're measuring.
  if (m.auto === true || (typeof m.lifecycle === 'string' && m.lifecycle.length > 0)) {
    return 'lifecycle-auto';
  }
  const text = `${m.summary ?? ''}\n${m.body ?? ''}`;

  if (m.kind === 'ack' || RE.ackStart.test(text)) return 'ack';
  if (RE.restartResource.test(text)) return 'restart-resource';
  // Completion needs a corroborating signal (tests/migs/phases) so a bare
  // "done" inside a sentence doesn't over-claim.
  if (RE.completion.test(text) && RE.completionCorroborate.test(text)) return 'completion';
  if (RE.claimStart.test(text)) return 'claim-start';
  if (RE.intentWindow.test(text)) return 'intent-window';
  if (RE.handoff.test(text)) return 'handoff';
  if (RE.findingHealth.test(text)) return 'finding-health';
  return 'contextual';
}

export interface CategorizationReport {
  total: number;
  byBucket: Record<CoordBucket, number>;
  /** % of the corpus that is the irreducible contextual residual (the headline). */
  contextualPct: number;
  /** % already automated (auto-stamped emissions). */
  automatedPct: number;
  /** % that is predictable-but-not-yet-automated (the remaining automation target). */
  automatablePct: number;
}

const ALL_BUCKETS: CoordBucket[] = [
  'lifecycle-auto',
  'completion',
  'claim-start',
  'intent-window',
  'restart-resource',
  'ack',
  'finding-health',
  'handoff',
  'contextual',
];

/** Aggregate a categorization over many messages into the headline report. */
export function categorizeCorpus(messages: readonly CoordMsgLike[]): CategorizationReport {
  const byBucket = Object.fromEntries(ALL_BUCKETS.map((b) => [b, 0])) as Record<CoordBucket, number>;
  for (const m of messages) byBucket[categorizeCoordMessage(m)]++;
  const total = messages.length || 1;
  const automated = byBucket['lifecycle-auto'];
  const contextual = byBucket['contextual'];
  const automatable = total - automated - contextual;
  return {
    total: messages.length,
    byBucket,
    contextualPct: Math.round((contextual / total) * 1000) / 10,
    automatedPct: Math.round((automated / total) * 1000) / 10,
    automatablePct: Math.round((automatable / total) * 1000) / 10,
  };
}
