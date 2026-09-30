/**
 * relay-provenance.ts — typed, platform-VERIFIED provenance for a RELAYED
 * directive (coord-authority-hardening-2026-07-11 P-004 / H2, owner-ratified
 * three-tier spec in the plan body).
 *
 * The EI-9501 telephone game: an agent re-types "OWNER DIRECTIVE: …" in its own
 * words and the receiver cannot tell owner text from the relayer's paraphrase.
 * H2 kills it with ZERO extra tool calls on either side: the sender passes
 * `relayOf` (a coord msg_id, or the `"owner-turn"` sentinel) or `relayQuote`
 * (a verbatim snippet), and the PLATFORM — at send time, server-side —
 * verifies the reference against its own stores, captures a bounded verbatim
 * quote, and stamps the envelope. Delivery renders the stamped tier + quote;
 * the receiver never fetches anything.
 *
 * Tiers (highest trust first):
 *   owner-verified(turn)             — Tier 2: the caller's CURRENT human turn,
 *                                      read server-side from the session store.
 *   owner-verified(transcript-match) — Tier 3 hit: sender-supplied quote found
 *                                      verbatim as a human turn in the caller's
 *                                      own transcript.
 *   coord-origin                     — Tier 1: origin is a real coord message,
 *                                      loaded + verified by id; chain extends
 *                                      relay-of-relay to root.
 *   unverified                       — Tier 3 miss: delivered, loudly stamped.
 *
 * Pure + import-light (only the pure ref-hydrate helpers): coord-schema (the
 * injection renderer) imports the read/render halves without pulling the DB
 * graph — same house pattern as cue-authority.ts. IO lives in
 * ./relay-provenance-resolve.ts.
 *
 * SECOND AXIS (P-010, see the banner further down): this module also carries the
 * EVIDENCE BAND for findings/escalations — how well-grounded a claim is
 * (observed / tool-output / reported-by / inferred / assumed), with confidence
 * DERIVED from the band and never self-reported. It lives here rather than in a
 * third provenance module because it answers the same reader question — how much
 * weight to give this claim — and `resolveClaimProvenance` composes the two with
 * an explicit precedence (platform-verified relay beats self-declared band).
 */

import { clampSnippet } from './ref-hydrate';

export type RelayProvenanceTier =
  | 'owner-verified-turn'
  | 'owner-verified-transcript'
  | 'coord-origin'
  | 'unverified';

export interface RelayProvenanceStamp {
  tier: RelayProvenanceTier;
  /** Bounded verbatim quote of the referenced original. Tiers 1/2: captured
   *  SERVER-SIDE (never the sender's paraphrase). Tier 3: sender-supplied,
   *  verified (or not) against the caller's transcript. */
  quote: string;
  /** Tier 1: the verified origin coord msg_id. */
  originMsgId?: string;
  /** Tier 1 multi-hop: msg_id chain, ROOT FIRST — a relay of a relay extends
   *  it; every link was verified to exist at ITS send time. */
  chain?: string[];
  /** Whether the verified ROOT is owner text or an agent message. */
  origin?: 'owner' | 'agent';
  /** Tier 2: the caller session whose human turn was captured, + its ts. */
  sessionId?: string;
  turnTs?: string;
}

/** The reserved envelope field the stamp rides on (nested object — same
 *  pass-through contract as cueAuthority). */
export const RELAY_PROVENANCE_FIELD = 'relayProvenance';

/** The `relayOf` sentinel for "the human turn I am currently answering". */
export const OWNER_TURN_SENTINEL = 'owner-turn';

/** Quote budget — bounded so a stamped envelope stays injection-friendly. */
export const RELAY_QUOTE_CHARS = 300;
/** Render-time cap for the inline `↪` suffix on a [coord+N] line. */
export const RELAY_RENDER_CHARS = 160;

const TIERS: ReadonlySet<string> = new Set([
  'owner-verified-turn',
  'owner-verified-transcript',
  'coord-origin',
  'unverified',
]);

/**
 * Read + validate a relay-provenance stamp off an envelope / inbox entry.
 * Defensive — absent/malformed → null, never throws (a forged or legacy
 * envelope can't crash the renderer).
 */
export function readRelayProvenance(
  env: Record<string, unknown> | null | undefined,
): RelayProvenanceStamp | null {
  const raw = env?.[RELAY_PROVENANCE_FIELD];
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.tier !== 'string' || !TIERS.has(s.tier)) return null;
  if (typeof s.quote !== 'string') return null;
  return {
    tier: s.tier as RelayProvenanceTier,
    quote: s.quote,
    ...(typeof s.originMsgId === 'string' && s.originMsgId ? { originMsgId: s.originMsgId } : {}),
    ...(Array.isArray(s.chain) && s.chain.every((c) => typeof c === 'string')
      ? { chain: s.chain as string[] }
      : {}),
    ...(s.origin === 'owner' || s.origin === 'agent' ? { origin: s.origin } : {}),
    ...(typeof s.sessionId === 'string' && s.sessionId ? { sessionId: s.sessionId } : {}),
    ...(typeof s.turnTs === 'string' && s.turnTs ? { turnTs: s.turnTs } : {}),
  };
}

/**
 * Did the PLATFORM actually verify this relay? The one place that rule lives.
 *
 * `unverified` is a tier VALUE, but it records a check that RAN AND FAILED — it
 * is not a weak pass, and it grounds nothing. Callers that mean "provenance
 * answers this claim" must ask THIS, never `stamp !== null`: a stamp is present
 * on a failed check too, so a presence test silently treats the failure as the
 * verification (EI-21333824056510800 — that exact conflation suppressed the
 * unverified-claim flag on a self-asserted "OWNER-VERIFIED DIRECTIVE" carrying
 * `tier:'unverified'`, on a BLOCKING workspace-wide pause).
 */
export function isRelayVerified(stamp: RelayProvenanceStamp | null | undefined): boolean {
  return stamp != null && stamp.tier !== 'unverified';
}

/**
 * Did the platform verify that this relay ultimately came from the human owner?
 *
 * This is intentionally stricter than `isRelayVerified`: a `coord-origin` stamp
 * can prove a real AGENT message exists, which is useful provenance but does not
 * grant that agent permission to cross the manual wake-mode pause gate. Only a
 * verified stamp whose captured origin is `owner` carries that authority.
 *
 * The distinction is load-bearing for resume directives. A paused agent is in
 * manual wake mode, so staging an already owner-verified resume "for owner
 * review" deadlocks the one message meant to lift the pause. Conversely, treating
 * every verified coord origin as owner authority would let an ordinary peer relay
 * bypass the gate. Keep the rule centralized here so local and federated wake
 * paths cannot drift.
 */
export function isOwnerVerifiedRelay(
  stamp: RelayProvenanceStamp | null | undefined,
): boolean {
  return isRelayVerified(stamp) && stamp?.origin === 'owner';
}

/** The short trust tag a reader scans: `owner-verified(turn)` /
 *  `owner-verified(transcript-match)` / `coord-origin(<root msg_id>)` /
 *  `UNVERIFIED relay`. */
export function renderRelayProvenanceTag(stamp: RelayProvenanceStamp): string {
  switch (stamp.tier) {
    case 'owner-verified-turn':
      return 'owner-verified(turn)';
    case 'owner-verified-transcript':
      return 'owner-verified(transcript-match)';
    case 'coord-origin': {
      const root = stamp.chain?.[0] ?? stamp.originMsgId;
      const originMark = stamp.origin === 'owner' ? 'owner via ' : '';
      return `coord-origin(${originMark}${root ?? '?'})`;
    }
    case 'unverified':
      return 'UNVERIFIED relay';
  }
}

/**
 * The inline `↪` suffix appended to an injection line: the verified quote,
 * render-capped. Empty quote → tag-only suffix (still shows the tier).
 */
export function renderRelayQuoteSuffix(stamp: RelayProvenanceStamp): string {
  const tag = renderRelayProvenanceTag(stamp);
  const q = clampSnippet(stamp.quote, RELAY_RENDER_CHARS);
  return q ? ` ↪ ${tag}: "${q}"` : ` ↪ ${tag}`;
}

/**
 * Heuristic flag (spec last line): free text CLAIMING owner/queen authority
 * with NO VERIFIED provenance tier. Flag only — never blocks, never demotes;
 * word-bound conservative patterns to keep false positives low. The renderer
 * prefixes `[UNVERIFIED authority claim]` when this fires on a message carrying
 * no VERIFIED relay tier (see `isRelayVerified` — an `unverified` stamp is a
 * FAILED check and must not suppress the flag) — except a QUEEN-claim on a line
 * whose platform-derived cueAuthority stamp IS hive-queen (that authority is
 * already platform-verified; an OWNER-claim has no such stamp and always needs
 * a relay tier).
 *
 * SEPARATOR CLASS (EI-21333824056510800): the claim verb is joined by
 * `[\s-]+`, not `\s+`. The live incident that motivated this — a BLOCKING
 * workspace-wide pause whose summary read `OWNER-VERIFIED DIRECTIVE — pause all
 * agent work now` against a `tier:'unverified'` stamp — went UNFLAGGED because
 * `owner\s+directive` cannot match across the hyphen in `OWNER-VERIFIED`, and
 * `verified` was not a claim verb at all. Both are fixed here; the hyphen never
 * widens the leading `\bowner` boundary, so `landowner`/`downer` stay quiet.
 */
const OWNER_CLAIM_RE =
  /\bowner[\s-]+directive\b|\bowner[\s-]+(?:said|says|asked|wants|approved|verified|told|directed|ordered)\b|\bper\s+the\s+owner\b/i;
const QUEEN_CLAIM_RE =
  /\bqueen[\s-]+directive\b|\bqueen[\s-]+(?:said|says|approved|verified|ordered)\b/i;

export function detectAuthorityClaim(text: string): 'owner' | 'queen' | null {
  if (OWNER_CLAIM_RE.test(text)) return 'owner';
  if (QUEEN_CLAIM_RE.test(text)) return 'queen';
  return null;
}

/**
 * WOULD A READER SEE THE UNVERIFIED-CLAIM FLAG ON THIS TEXT? The ONE place that
 * precedence lives — `detectAuthorityClaim` answers "does this text CLAIM
 * authority", this answers "does that claim ship UNBACKED".
 *
 * Two call sites depend on agreeing exactly: the delivery renderer
 * (`coord-schema`, which prefixes `UNVERIFIED_CLAIM_TAG`) and the SENDER-side
 * warning on `coord:send`'s result (WI-41323). A sender warned about a flag the
 * reader does not render — or, worse, NOT warned about one the reader does — is
 * the same defect class as EI-21333824056510800 one level up: two copies of a
 * precedence rule drifting apart. Hence one predicate, two callers.
 *
 * Precedence, in order:
 *  - a VERIFIED relay tier answers the claim ⇒ no flag. `isRelayVerified`, never
 *    `stamp != null`: an `unverified` stamp is a check that RAN AND FAILED.
 *  - an OWNER claim has no platform-derived stamp that can vouch for it, so it
 *    always needs a relay tier ⇒ flag.
 *  - a QUEEN claim on a line whose cueAuthority stamp IS `hive-queen` is already
 *    platform-verified ⇒ no flag.
 */
export function unverifiedAuthorityClaim(
  text: string,
  relay: RelayProvenanceStamp | null | undefined,
  cueAuthority?: { authority?: string } | null,
): 'owner' | 'queen' | null {
  const claim = isRelayVerified(relay) ? null : detectAuthorityClaim(text);
  if (claim === 'owner') return 'owner';
  if (claim === 'queen' && cueAuthority?.authority !== 'hive-queen') return 'queen';
  return null;
}

/** The renderer's prefix tag for a claim the platform could not verify. */
export const UNVERIFIED_CLAIM_TAG = '[UNVERIFIED authority claim]';

/** The renderer's prefix tag for a relay whose check RAN AND FAILED, on a line
 *  whose text did not itself trip the authority-claim detector. */
export const UNVERIFIED_RELAY_TAG = '[UNVERIFIED relay]';

/**
 * SHOULD THE FAILED RELAY CHECK BE HOISTED TO THE FRONT OF THE LINE?
 *
 * EI-21333924556090958 — the residue its twin (EI-21333824056510800) left behind.
 * That fix made the text detector CORRECT; this one makes the line's EMPHASIS
 * correct, which is a different property and the one the reporter actually named.
 *
 * The delivered line is `<glyph> <handle> <flags><summary> … ↪ <tier>`, so the
 * loud half is caller-controlled free text and the authoritative half is a
 * trailing suffix. When the two disagree the format gives the wrong half the
 * emphasis. `detectAuthorityClaim` closes that ONLY for phrasings it enumerates,
 * and free text is unbounded: measured against live traffic on 2026-09-06, of 99
 * delivered messages carrying `tier:'unverified'`, 78 mention the owner and only
 * 44 trip the detector — the 34-line remainder includes several blocking
 * `⛔ OWNER STAND-DOWN` orders and one `OWNER AUTHORIZED containment` that lifts
 * a stated safety boundary. Sharpest of all, the detector matches `owner
 * verified` but not `verified owner`, so "VERIFIED OWNER PAUSE" and "Verified
 * owner-turn relay" — agents sending a CORRECTION to back an earlier flagged
 * claim — sailed through unflagged while themselves unverified.
 *
 * So the rule is deliberately NOT a wider regex (that is an arms race free text
 * wins). It is structural and phrasing-independent: IF THE SENDER ATTEMPTED A
 * RELAY AND THE PLATFORM'S CHECK FAILED, THE READER IS TOLD BEFORE THE CLAIM.
 *
 * Scope limit, stated so it is not mistaken for more: this hoists only when a
 * stamp is PRESENT and failed. A message carrying no stamp at all made no relay
 * claim for the platform to contradict, so it stays with the text detector.
 *
 * Bounded by construction: relay-stamped messages are 199 of 453,494 delivered
 * lines, and the hoisted subset is 99 — 0.022% of the stream, far below the
 * density at which a marker becomes wallpaper.
 */
export function hoistUnverifiedRelay(
  relay: RelayProvenanceStamp | null | undefined,
  claim: 'owner' | 'queen' | null,
): boolean {
  // The authority-claim flag is strictly more specific and already owns the
  // front of the line; two stacked prefixes would dilute both.
  if (claim) return false;
  return relay != null && !isRelayVerified(relay);
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence band (P-010, agent-protocol-authority-semantics-2026-07-26)
//
// Lives HERE, extending the existing provenance module, because the item is
// explicit that coord-schema already imports relay-provenance + cue-authority and
// a THIRD provenance surface is the failure to avoid. Relay-provenance answers
// "is this relayed directive really from whom it claims"; the evidence band
// answers "how well-grounded is this finding/escalation". Same axis — how much
// weight a reader should give a claim — so they compose here (see
// resolveClaimProvenance) rather than diverging into parallel vocabularies.
//
// D-015 (P-009) is BINDING on this: the band is DESCRIPTIVE. It informs a
// reader's confidence and NEVER grants transition authority. Concretely, nothing
// below is readable from `CoordTransitionIntent` (which has no provenance field
// by construction) and no transition may branch on a band. `cue-authority` is
// deliberately untouched: that is the CONTROL axis, and wiring evidence into it
// is exactly the route P-009 closed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a claim is grounded, weakest-to-strongest grounding made explicit:
 *   observed     — the sender directly saw it in its own execution
 *   tool-output  — backed by a tool result (the strongest routinely available)
 *   reported-by  — relayed from another agent; carries `reportedBy`
 *   inferred     — reasoned from other facts, not directly witnessed
 *   assumed      — a working assumption with no grounding (incl. self-imposed
 *                  discipline an agent wrote for itself)
 */
export const EVIDENCE_BANDS = [
  'observed',
  'tool-output',
  'reported-by',
  'inferred',
  'assumed',
] as const;

export type EvidenceBand = (typeof EVIDENCE_BANDS)[number];

const EVIDENCE_BAND_SET: ReadonlySet<string> = new Set(EVIDENCE_BANDS);

export interface EvidenceStamp {
  band: EvidenceBand;
  /** REQUIRED for `reported-by` — who the claim is attributed to. */
  reportedBy?: string;
  /** Optional grounding pointer: a tool name, `file:line`, msg_id, or work-item id. */
  ref?: string;
}

/** The reserved envelope field the stamp rides on (nested object — same
 *  pass-through contract as cueAuthority / relayProvenance). */
export const EVIDENCE_FIELD = 'evidence';

/**
 * Confidence is DERIVED from the band and is NEVER self-reported as a number.
 *
 * This is the Reasoning Contamination Effect the plan cites: a model asked to
 * emit a numeric confidence produces one poorly correlated with accuracy, and the
 * number then contaminates every downstream reader — who treats "0.9" as measured
 * when it was generated. A closed band with a fixed mapping cannot be inflated:
 * to claim high confidence you must claim you OBSERVED it or have TOOL OUTPUT,
 * which is a checkable statement about the world rather than a vibe.
 */
export type DerivedConfidence = 'high' | 'medium' | 'low';

const BAND_CONFIDENCE: Record<EvidenceBand, DerivedConfidence> = {
  observed: 'high',
  'tool-output': 'high',
  'reported-by': 'medium',
  inferred: 'low',
  assumed: 'low',
};

/** The ONLY way to obtain a confidence for a claim. Total over the closed band
 *  set, so a new band without a mapping is a COMPILE error (the D-004 pattern
 *  P-008's legend already uses). */
export function deriveConfidence(band: EvidenceBand): DerivedConfidence {
  return BAND_CONFIDENCE[band];
}

/** Envelope fields a sender might use to smuggle a self-reported confidence past
 *  the band. Detected so the renderer can flag + drop them rather than let a
 *  fabricated number reach a reader. */
const SELF_REPORTED_CONFIDENCE_FIELDS = ['confidence', 'certainty', 'probability'] as const;

/**
 * True if the envelope carries a SELF-REPORTED confidence/certainty value.
 * Such a value is never read as authoritative — `deriveConfidence` is the only
 * source — and the renderer surfaces it as fabricated.
 */
export function hasSelfReportedConfidence(
  env: Record<string, unknown> | null | undefined,
): boolean {
  if (!env) return false;
  return SELF_REPORTED_CONFIDENCE_FIELDS.some((f) => {
    const v = env[f];
    return typeof v === 'number' || (typeof v === 'string' && /^[\d.]+%?$/.test(v.trim()));
  });
}

/** The renderer's tag for a self-reported confidence the platform discarded. */
export const SELF_REPORTED_CONFIDENCE_TAG = '[self-reported confidence DISCARDED — see band]';

/**
 * Read + validate an evidence stamp off an envelope. Defensive — absent/malformed
 * → null, never throws. A `reported-by` band WITHOUT a `reportedBy` attribution is
 * rejected: an unattributed relay is exactly the provenance collapse this field
 * exists to prevent, so it degrades to null (no stamp) rather than a stamp that
 * silently loses its source.
 */
export function readEvidence(
  env: Record<string, unknown> | null | undefined,
): EvidenceStamp | null {
  const raw = env?.[EVIDENCE_FIELD];
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.band !== 'string' || !EVIDENCE_BAND_SET.has(s.band)) return null;
  const band = s.band as EvidenceBand;
  const reportedBy =
    typeof s.reportedBy === 'string' && s.reportedBy.trim() ? s.reportedBy.trim() : undefined;
  if (band === 'reported-by' && !reportedBy) return null;
  return {
    band,
    ...(reportedBy ? { reportedBy } : {}),
    ...(typeof s.ref === 'string' && s.ref.trim() ? { ref: s.ref.trim() } : {}),
  };
}

/**
 * The scannable tag for an injection line, e.g.
 * `tool-output (confidence: high)` or `reported-by:su-709bb (confidence: medium)`.
 * Confidence is always rendered DERIVED, so a reader never has to wonder whether
 * a number was measured or generated.
 */
export function renderEvidenceTag(stamp: EvidenceStamp): string {
  const band =
    stamp.band === 'reported-by' && stamp.reportedBy
      ? `reported-by:${stamp.reportedBy}`
      : stamp.band;
  const ref = stamp.ref ? ` ${stamp.ref}` : '';
  return `${band}${ref} (confidence: ${deriveConfidence(stamp.band)})`;
}

/**
 * The legacy prose tags from the compaction-strategy doc — `[owner:<name>]`,
 * `[self-imposed]`, `[peer:<sid>]`, `[inferred]` — mapped onto the band.
 *
 * These were a PROSE CONVENTION, which is the same provenance-collapse failure
 * the literature names and which the compaction doc itself documents rotting in
 * practice (WI-3532: an agent's own note-to-self was re-read across seven
 * compactions until it rendered as an owner directive). Parsing them into the
 * typed field is the migration path; the tags stay readable, but the authority
 * now lives in a field instead of in punctuation.
 *
 * Note `[owner:…]` maps to `reported-by`, NOT to anything higher: a prose tag is
 * a CLAIM of owner origin. Only a platform-verified relay tier can establish that
 * (see resolveClaimProvenance), which is precisely the EI-9501 telephone game.
 */
const LEGACY_TAG_RE = /\[(owner:[^\]]+|peer:[^\]]+|self-imposed|inferred)\]/i;

export function parseLegacyProvenanceTag(text: string): EvidenceStamp | null {
  const m = LEGACY_TAG_RE.exec(text ?? '');
  if (!m) return null;
  const tag = m[1];
  const lower = tag.toLowerCase();
  if (lower.startsWith('owner:')) {
    return { band: 'reported-by', reportedBy: tag.trim() };
  }
  if (lower.startsWith('peer:')) {
    const sid = tag.slice('peer:'.length).trim();
    return sid ? { band: 'reported-by', reportedBy: sid } : null;
  }
  if (lower === 'self-imposed') return { band: 'assumed' };
  if (lower === 'inferred') return { band: 'inferred' };
  return null;
}

/**
 * The combined provenance view for one envelope, with PRECEDENCE made explicit:
 * a platform-VERIFIED relay tier outranks a SELF-DECLARED evidence band, because
 * the former was checked server-side against real stores and the latter is the
 * sender's own assertion. When a verified relay stamp is present the reported
 * confidence is 'high' regardless of band; an `unverified` relay tier does NOT
 * outrank anything (it is a failed check, not a weak pass).
 *
 * Returns `selfReportedConfidenceDiscarded` so the renderer can flag a sender
 * that tried to supply its own number.
 */
export function resolveClaimProvenance(env: Record<string, unknown> | null | undefined): {
  evidence: EvidenceStamp | null;
  relay: RelayProvenanceStamp | null;
  confidence: DerivedConfidence | null;
  basis: 'relay-verified' | 'evidence-band' | 'none';
  selfReportedConfidenceDiscarded: boolean;
} {
  const relay = readRelayProvenance(env);
  const evidence = readEvidence(env);
  const relayVerified = isRelayVerified(relay);
  const basis = relayVerified ? 'relay-verified' : evidence ? 'evidence-band' : 'none';
  const confidence = relayVerified
    ? 'high'
    : evidence
      ? deriveConfidence(evidence.band)
      : null;
  return {
    evidence,
    relay,
    confidence,
    basis,
    selfReportedConfidenceDiscarded: hasSelfReportedConfidence(env),
  };
}
