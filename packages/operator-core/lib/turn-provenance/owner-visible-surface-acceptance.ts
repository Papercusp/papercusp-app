/**
 * LIVE-DRIVE ACCEPTANCE for the owner-visibility surface.
 *
 * Plan owner-visibility-provenance-2026-08-11, item P-007 (WI-37958).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * On 2026-08-11 three separate items on this surface were signed off on green
 * unit tests and all three failed live within hours. That is not carelessness;
 * it is a property of the surface, established by P-001:
 *
 *   A unit test here asserts `ownerVisiblePromptText(X) === ''` for an `X` the
 *   AUTHOR invented, out of the author's own model of what machine text looks
 *   like. When that model has a hole, the CODE and the FIXTURE have the SAME
 *   hole. The test cannot surprise its author, so a green suite carries close
 *   to zero information about owner-visible behaviour.
 *
 * The live drive was the only instrument that detected any of it, because it is
 * the only one whose inputs the author did not choose.
 *
 * ── WHY A REGISTRY AND NOT A CHECKLIST ─────────────────────────────────────
 * P-007 asks for a mechanism rather than an exhortation: "a checklist nobody
 * runs is worth less than a gate that refuses." A checklist depends on the one
 * person least able to see the gap — the author who just wrote the fixture that
 * shares the blind spot. So the acceptance is DECLARED here, as data, and read
 * by the completion path; nobody has to remember it.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * It is NOT a claim that unit tests are worthless here — the over-hiding rails
 * (an owner QUOTING machine text must stay visible) are exactly the kind of
 * property a fixture states well, because their inputs are owner text the
 * author is entitled to invent. It is a claim about the HIDING direction only,
 * where the input space belongs to the machine and not to the author.
 */

/**
 * The files whose behaviour is only observable by driving the live surface.
 *
 * SHRINK-ONLY BY INTENT. Adding a file tightens the acceptance; removing one
 * loosens it and needs a plan decision, because every removal is a claim that
 * the file's owner-visible behaviour became unit-observable — which is exactly
 * the claim that was wrong three times on 2026-08-11.
 *
 * Kept as repo-relative suffixes so a caller's `filesChanged` matches whether
 * it recorded an absolute path, a repo-relative one, or a workspace-relative
 * one — the three shapes real completions actually carry.
 */
export const OWNER_VISIBLE_SURFACE_FILES: readonly string[] = [
  // THE predicate every owner-facing surface asks (fact:
  // owner-visible-turn-filter-is-shared-predicate).
  'packages/operator-core/lib/agent-tools/coordination/owner-chat-turn.ts',
  // The ONE curated machine-surface list the predicate routes through (V-003).
  'packages/operator-core/lib/turn-provenance/machine-surface-catalogue.ts',
  // Turn classification + the recorded-turn verdict readers consume.
  'packages/operator-core/lib/turn-provenance/turn-ref.ts',
  'packages/operator-core/lib/turn-provenance/turn-provenance.ts',
  // The rendering consumers — where a correct predicate can still be bypassed.
  'apps/operator/app/_components/chat/session-transcript-mapping.ts',
  'packages/operator-core/lib/adv-session-search.ts',
  'packages/operator-core/lib/adv-agent-detail.ts',
  'packages/operator-core/lib/memory/human-turn-tail.ts',
];

/**
 * `verifiedHow` values that constitute an actual observation of the surface.
 *
 * `live-drove-ui` is the instrument P-007 names. `integration` qualifies
 * because an integration test on this surface reads REAL recorded turns rather
 * than author-invented fixtures — the input-provenance property that makes the
 * live drive informative in the first place, which is the thing being required
 * here rather than any particular tool.
 */
export const LIVE_DRIVE_ACCEPTED_VERIFICATIONS: readonly string[] = [
  'live-drove-ui',
  'integration',
  'manual',
];

export interface LiveDriveAcceptanceGap {
  /** The registered surface files this completion changed. */
  surfaceFiles: string[];
  /** What the completion claimed instead, for the message. */
  verifiedHow: string | undefined;
}

/** Normalize a recorded path to compare against the registry suffixes. */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Which registered surface files does this change touch? */
export function surfaceFilesTouched(filesChanged: readonly string[] | undefined): string[] {
  if (!filesChanged || filesChanged.length === 0) return [];
  const seen = new Set<string>();
  for (const raw of filesChanged) {
    if (typeof raw !== 'string') continue;
    const p = normalizePath(raw);
    for (const surface of OWNER_VISIBLE_SURFACE_FILES) {
      // Suffix match anchored at a path BOUNDARY: `.../repo/<surface>` matches,
      // and a file whose name merely ends the same way (`x-owner-chat-turn.ts`)
      // does not. Deliberately NOT a basename match — two packages may hold a
      // same-named file and only the registered path is the surface.
      if (p === surface || p.endsWith(`/${surface}`)) seen.add(surface);
    }
  }
  return [...seen];
}

/**
 * Does this completion settle a change to the owner-visibility surface WITHOUT
 * having observed the surface?
 *
 * Returns the gap, or null when there is nothing to say — which is the common
 * case, because the registry is small on purpose.
 */
export function liveDriveAcceptanceGap(
  evidence: { verifiedHow?: string; filesChanged?: readonly string[] } | undefined,
): LiveDriveAcceptanceGap | null {
  if (!evidence) return null;
  const surfaceFiles = surfaceFilesTouched(evidence.filesChanged);
  if (surfaceFiles.length === 0) return null;
  const how = evidence.verifiedHow;
  if (how && LIVE_DRIVE_ACCEPTED_VERIFICATIONS.includes(how)) return null;
  return { surfaceFiles, verifiedHow: how };
}

/**
 * ── THE REFUSING TIER (D-019) ───────────────────────────────────────────────
 * The acceptance is two-tiered on purpose, and the tiers are NOT redundant:
 *
 *   WARN at `work_items:complete` — that seam is contractually record-and-warn
 *   (D-005 / EI-24: "a finished completion is normalised, never hard-rejected+
 *   lost"). Rejecting the CALL there would discard the agent's only written
 *   account of what it did. A gate that destroys evidence to enforce evidence
 *   is self-defeating.
 *
 *   REFUSE at `setWorkItemState` — by then the completion is already recorded,
 *   so refusing the TERMINAL FLIP preserves the evidence, leaves the item open,
 *   and tells the agent why. That is what satisfies P-007's "a checklist nobody
 *   runs is worth less than a gate that refuses" without violating EI-24.
 *
 * This function is the DECISION, kept pure and here rather than inline at the
 * call site, for two reasons. It is exhaustively testable — its inputs (a
 * boolean, a path, a `verifiedHow`) are the author's to invent, which is
 * exactly the corollary D-019 draws about what remains legitimately unit-tier
 * on this surface. And it keeps the refusal reading from the SAME registry and
 * message as the warning, so the two tiers cannot drift into disagreeing about
 * what the acceptance is.
 */
export interface LiveDriveTerminalRefusalInput {
  id: string;
  /** The terminal state being written, for the message's re-close instruction. */
  state: string;
  /** Is this actually a transition INTO a settled state? Non-terminal writes are not completions. */
  isCompletingTransition: boolean;
  /** Caller asserts the change cannot alter what is rendered (set_state { force: true }). */
  force?: boolean;
  /** Trusted system path — restore / watchdog / reconcile sweeps, "not completions at all". */
  skipCompletionGate?: boolean;
  evidence: { verifiedHow?: string; filesChanged?: readonly string[] } | undefined;
}

/**
 * The refusal message for a terminal write that settles an owner-visibility
 * change without having observed the surface — or `null` when the write should
 * proceed, which is the overwhelmingly common case.
 */
export function liveDriveTerminalRefusal(input: LiveDriveTerminalRefusalInput): string | null {
  if (!input.isCompletingTransition) return null;
  // Both bypasses are deliberate. `skipCompletionGate` covers the trusted system
  // writes that carry no agent evidence to judge; `force` is the caller asserting
  // the change cannot alter what the owner sees. Neither is a loophole to close:
  // a gate with no override is one that gets deleted the first time it is wrong.
  if (input.force || input.skipCompletionGate) return null;
  const gap = liveDriveAcceptanceGap(input.evidence);
  if (!gap) return null;
  return (
    `live-drive-acceptance: work_item '${input.id}' → '${input.state}' rejected — ` +
    `${liveDriveAcceptanceMessage(input.id, gap)} ` +
    `YOUR COMPLETION IS NOT LOST: it was recorded before this refusal, and the item stays open — ` +
    `drive the surface, then re-close with work_items:complete { id: '${input.id}', ` +
    `state: '${input.state}', completion: { …, verifiedHow: 'live-drove-ui' } }. If the change ` +
    `genuinely cannot alter what the owner sees (a comment, a rename, a type-only edit), override ` +
    `with work_items:set_state { id: '${input.id}', state: '${input.state}', force: true } and say ` +
    `why in the completion's \`deferred\`, so the next reader knows it was considered rather than ` +
    `missed — NOTE work_items:complete does NOT accept a \`force\` arg (WI-4530). ` +
    `Authority: plan owner-visibility-provenance-2026-08-11 D-019.`
  );
}

/** The message the completion path attaches. Written once, here, so the
 *  reasoning travels with the finding instead of being re-derived. */
export function liveDriveAcceptanceMessage(id: string, gap: LiveDriveAcceptanceGap): string {
  return (
    `completion for ${id} changed ${gap.surfaceFiles.length} file(s) on the OWNER-VISIBILITY SURFACE ` +
    `(${gap.surfaceFiles.join(', ')}) but reports \`verifiedHow: ${JSON.stringify(gap.verifiedHow)}\` — ` +
    `no observation of the live surface. On THIS surface a green unit suite is close to zero evidence about ` +
    `owner-visible behaviour, and the reason is structural, not sloppiness: a fixture asserts the predicate ` +
    `against text the AUTHOR invented from the author's own model of machine turns, so when that model has a ` +
    `hole the code and the fixture have the SAME hole and the test cannot surprise you. Measured 2026-08-11: ` +
    `THREE items on this surface were signed off green and all three failed live within hours; the live drive ` +
    `was the only instrument that caught any of them. Before settling this, drive the surface and look at what ` +
    `the owner actually sees (/internal/docs/testing/agent-e2e), then re-close with ` +
    `\`verifiedHow: 'live-drove-ui'\` — or, if the change genuinely cannot alter what is rendered (a comment, a ` +
    `rename), say so in \`deferred\` so the next reader knows it was considered rather than missed. ` +
    `The over-hiding direction is the one to look at hardest: hiding a machine row too few is recoverable, ` +
    `hiding the owner's own words is not.`
  );
}
