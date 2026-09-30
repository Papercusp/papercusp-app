/**
 * coord-schema — the SINGLE SOURCE for the coord-injection line protocol
 * (plan `token-efficient-coord-injection-2026-06-06`, D-001/D-002).
 *
 * Coord `[coord] …` blocks are PUSHED into every psu turn continuously, so they
 * are the highest-leverage token surface in the system. A coord line has one
 * FIXED schema, identical every injection, with the operator (renderer) and the
 * model (reader) both ours — so the schema does not belong on the wire. It is
 * declared ONCE, out-of-band, in the psu prompt (`renderCoordLegend`), and only
 * VALUES travel: a positional line `<glyph> <handle> <text>`.
 *
 * Everything downstream derives from the ONE `COORD_LEGEND` map here:
 *   - the server-side injection renderer (`renderInjection`) — what goes on the wire,
 *   - the psu-prompt legend (`renderCoordLegend`) — what the model reads,
 * so the two cannot desync (the anti-desync equality test asserts it). This
 * absorbs the formerly-scattered schema: `CoordKind` (pubsub-substrate),
 * `LIFECYCLE_CATEGORIES` (coord-lifecycle/records), and the glyphs that used to
 * be inline in `coord-lifecycle/render.ts`.
 *
 * Glyphs are SINGLE ASCII chars (1 token each — emoji like ▶ ↪ ⚠ tokenize to 2-3
 * tokens, which is pure waste on a per-injection surface; verified by the P-006
 * benchmark). The glyph is applied here, at render-to-display time, NOT baked
 * into the stored record prose (render.ts is glyph-free) — presentation is a
 * projection of the record, not part of it.
 */

import type { CoordKind } from '@papercusp/coordination/core';
import { LIFECYCLE_CATEGORIES, type LifecycleCategory } from './coord-lifecycle/records';
import { renderAuthoredFieldsSuffix } from './agent-tools/coordination/message-fields';
import { renderStaleBasisSuffix, STALE_BASIS_FIELD } from './agent-tools/coordination/stale-basis';
import { renderMessageAgeSuffix } from './agent-tools/coordination/message-age';
import {
  renderBlockedOnStatusSuffix,
  BLOCKED_ON_STATUS_FIELD,
} from './agent-tools/coordination/blocked-on-status';
import {
  isCueInScopeFor,
  readCueAuthority,
  renderCueAuthorityTag,
  renderOutOfScopeCueTag,
  type RecipientCueScope,
} from './agent-tools/coordination/cue-authority';
import {
  hasSelfReportedConfidence,
  hoistUnverifiedRelay,
  readEvidence,
  readRelayProvenance,
  renderEvidenceTag,
  renderRelayQuoteSuffix,
  SELF_REPORTED_CONFIDENCE_TAG,
  UNVERIFIED_CLAIM_TAG,
  unverifiedAuthorityClaim,
  UNVERIFIED_RELAY_TAG,
} from './agent-tools/coordination/relay-provenance';
import {
  detectEntryBodyRefs,
  isBodyRefEligible,
  readBodyRefsOptOut,
  readGateRefs,
  renderBodyRefsSuffix,
  renderGateRefsSuffix,
  renderReplyQuoteSuffix,
  renderTerminalSubjectSuffix,
  type HydratedRef,
} from './agent-tools/coordination/ref-hydrate';

export interface LegendEntry {
  glyph: string;
  /** Human-readable name shown in the prompt legend. */
  name: string;
}

/**
 * Legend for the LIFECYCLE CATEGORIES — the common, high-volume cases. A lifecycle
 * message (kind=`message` + a lifecycle `category`) is keyed by its category.
 *
 * Typed `Record<LifecycleCategory, …>`, so adding a category to
 * `LIFECYCLE_CATEGORIES` without a glyph fails the BUILD, not a reader.
 */
const LIFECYCLE_LEGEND: Record<LifecycleCategory, LegendEntry> = {
  intent: { glyph: '>', name: 'intent — now working on' },
  completion: { glyph: '*', name: 'completion — finished' },
  claim: { glyph: '+', name: 'claim — taking a work-item' },
  window: { glyph: '#', name: 'scope window — holding / draining / released (the verb says which)' },
  handoff: { glyph: '<', name: 'handoff — passing work to a peer' },
  finding: { glyph: '!', name: 'finding — a discovered problem' },
};

/**
 * Legend for the wire `CoordKind`s, in the D-014 executable/conversational order.
 *
 * Typed `Record<CoordKind, …>` — this is the anti-drift guard, and it is the whole
 * point of P-008. The defect was ONE vocabulary described by TWO hand-maintained
 * maps (the kind union here, the lifecycle categories above), which drift silently
 * because nothing fails when they disagree. Now a `CoordKind` added without a
 * legend entry is a COMPILE error.
 *
 * That guard immediately repaid itself: `handoff_expired` had been a `CoordKind`
 * since F-FIX-037 with NO legend entry, so every expiry line fell through to
 * DEFAULT_GLYPH and rendered as `-` — visually identical to a free-text note, in
 * the one place a reader needs to see that their handoff timed out.
 */
const KIND_LEGEND: Record<CoordKind, LegendEntry> = {
  // ── executable: the runtime acts on these (COORD_EXECUTABLE_KINDS) ──
  subscribe: { glyph: '.', name: 'subscribe' },
  unsubscribe: { glyph: '.', name: 'unsubscribe' },
  notify: { glyph: '.', name: 'notify — subscription delta' },
  handoff: { glyph: '<', name: 'handoff — passing work to a peer' },
  handoff_accepted: { glyph: '<', name: 'handoff accepted' },
  handoff_expired: { glyph: '<', name: 'handoff EXPIRED — your offer timed out un-acked' },
  handoff_repinged: { glyph: '<', name: 'handoff re-ping — your offer is still un-acked' },
  contract: { glyph: '~', name: 'contract' },
  plan_event: { glyph: '~', name: 'plan event' },
  // turn-lifecycle-control Phase 4 (P-019): interrupt = wake's dual. A
  // cooperative turn:interrupt — wrap up at a safe checkpoint + end your turn.
  yield: { glyph: '|', name: 'yield — a peer asks you to wrap up + end your turn (turn:interrupt)' },
  // ── conversational: pure talk, zero authority over runtime state ──
  message: { glyph: '-', name: 'message — free-text note' },
  ack: { glyph: '=', name: 'ack — acknowledgement' },
  unack: { glyph: '=', name: 'unack — acknowledgement reverted' },
  escalation: { glyph: '^', name: 'escalation — needs attention' },
  escalation_resolved: { glyph: '=', name: 'escalation resolved' },
  escalation_reopened: { glyph: '^', name: 'escalation reopened' },
  // context-injection-audit-2026-07-28 P-039 / D-012. Its own glyph, for exactly
  // the reason the `handoff_expired` note above records: a line telling you the
  // peer you are BLOCKED ON just died must not render as `-` (a free-text note).
  presence_alert: { glyph: 'x', name: 'presence alert — a peer YOU are blocked on died or stopped responding' },
};

/**
 * The canonical line type → {glyph, name}, DERIVED from the two typed maps above
 * rather than hand-maintained a third time. Lifecycle categories come first (they
 * are the high-volume cases and lead the rendered legend); `handoff` is
 * deliberately BOTH a lifecycle category and a wire kind, and resolves to one
 * shared entry. Glyphs are 1-token ASCII.
 */
export const COORD_LEGEND: Record<string, LegendEntry> = { ...LIFECYCLE_LEGEND, ...KIND_LEGEND };

/** The default glyph for an unknown line type (defensive — never throws). */
const DEFAULT_GLYPH = '-';

const LIFECYCLE_SET = new Set<string>(LIFECYCLE_CATEGORIES);

/** Minimal shape the injection renderer needs from a coord entry. */
export interface CoordLineSource {
  from: string;
  kind: CoordKind | string;
  /**
   * Lifecycle category (`intent`/`completion`/…). `coord:emit` stamps this on
   * the envelope's `lifecycle` field (NOT `category`, which is reserved for
   * ambient tags like `service-health` — see emit.ts). The glyph keys on this.
   */
  lifecycle?: string;
  /** Ambient classification tag (`service-health`/…) — not a lifecycle category. */
  category?: string;
  /** The envelope's addressee list, when the caller passes it through (inbox does —
   *  entries are cast wholesale). Read ONLY by the directed-question clip (P-004);
   *  `unknown` so a malformed/absent value degrades to "not directed", never throws. */
  to?: unknown;
  /** Audience-selector stamp (`@fleet:…`/'*') — present ⇒ a fan-out, not a directed
   *  message, even though `to` resolved to concrete ownerIds at send time. */
  audience?: unknown;
  summary?: string;
  body?: string;
  ts: string;
  /** What a directed sender expects back; terminal-subject warnings use action/answer only. */
  expects?: unknown;
  plan_slug?: string;
  /** The canonical reply / escalation-resolution back-reference (envelope field).
   *  Read ONLY by the P-005 reply-quote hydration — guarded at use, so a
   *  malformed value degrades to "no quote", never throws. */
  related_msg_id?: string;
  /** The envelope's OWN id (present on every real message — inbox.ts reads it
   *  at `entry.msg_id` throughout). Read ONLY by the WI-2142086 reply-handle
   *  hint below, to surface the exact value a reply should set as
   *  `related_msg_id` to thread onto THIS line. */
  msg_id?: string;
  /** send.ts's wakeOnReply stamp: `true` only when a reply to THIS message
   *  will wake its sender (gated there on directed + `expects !== 'none'`).
   *  Read ONLY by the WI-2142086 reply-handle hint, to decide whether the
   *  hint is worth rendering; `unknown` so a malformed/legacy value degrades
   *  to "no hint", never throws. */
  wakeOnReply?: unknown;
  // digest-notify coalescing fields
  subject?: string;
  digest?: boolean;
  /**
   * Structured authority + scope of a CONTROL cue (drain / pause / steer) — the
   * `cueAuthority` envelope field an emit site stamps via sendMessage.extra
   * (queen-fleet-authority-boundary P-003). When present + well-formed, the line
   * is prefixed with a `[hive-queen(<hive>)→hive-wide]` /
   * `[fleet-leader(<slug>)→fleet-members(<slug>)]` tag so a recipient sees at a
   * glance whether it's a hive-wide Queen pause or a fleet leader draining its own
   * members. `unknown` (validated by readCueAuthority) so a legacy/forged value is
   * simply ignored, never rendered. */
  cueAuthority?: unknown;
}

/**
 * The glyph for one entry: its lifecycle category if it has one, else its kind,
 * else the default. The ONE place a line's glyph is decided — both the wire and
 * the legend route through `COORD_LEGEND`, so they can't disagree.
 */
export function glyphFor(entry: Pick<CoordLineSource, 'kind' | 'lifecycle' | 'category'>): string {
  if (entry.lifecycle && LIFECYCLE_SET.has(entry.lifecycle)) {
    return COORD_LEGEND[entry.lifecycle]?.glyph ?? DEFAULT_GLYPH;
  }
  return COORD_LEGEND[entry.kind as string]?.glyph ?? DEFAULT_GLYPH;
}

/**
 * Short, stable handle from an owner id — shown ONCE per line (the lifecycle
 * prose no longer re-embeds the sender). `su-ab53332d-…` → `ab533`,
 * `omp-<sid>-<pid>` → first 5 of `<sid>`. Deterministic, no DB lookup.
 */
export function shortHandle(from: string): string {
  if (!from) return '?';
  // Strip a known client prefix, then take the first 5 alphanumerics.
  const stripped = from.replace(/^(su|omp|cc|codex)-/, '');
  const m = stripped.match(/[A-Za-z0-9]+/);
  const core = (m ? m[0] : stripped).slice(0, 5);
  return core || from.slice(0, 5);
}

/** Collapse a long summary to one scannable line. */
function clip(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** Extended per-line budget for a DIRECTED question (fleet-leader-frictions P-004):
 *  a question addressed to YOU is the highest-priority line in the block, yet the
 *  200-char clip routinely severed the ask mid-sentence ("…was ON in PostHo…"),
 *  forcing a coord:inbox re-read just to learn what was asked. Bounded — this is a
 *  clip extension for the ask sentence, not an unclipped body channel. */
const DIRECTED_QUESTION_CAP = 500;

/** A line is DIRECTED when the sender enumerated concrete recipients: no '*' / 'human'
 *  in `to`, and no `audience` stamp (selector fan-outs resolve to concrete ownerIds but
 *  are broadcasts in intent). Defensive over `unknown` — malformed ⇒ not directed. */
function isDirected(e: Pick<CoordLineSource, 'to' | 'audience'>): boolean {
  if (e.audience != null) return false;
  const to = e.to;
  if (!Array.isArray(to) || to.length === 0) return false;
  return to.every((t) => typeof t === 'string' && t !== '*' && t !== 'human');
}

/** clip(), except a question sentence survives: when the text overflows `max` and its
 *  last '?' lies past the plain-clip window but within `hardCap`, cut just AFTER that
 *  '?' (the ask stays intact) instead of mid-question. No '?' in reach ⇒ plain clip. */
function clipKeepQuestion(s: string, max: number, hardCap: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  const lastQ = oneLine.lastIndexOf('?', hardCap - 1);
  // A '?' at index ≤ max-2 already survives the plain clip (which keeps max-1 chars).
  if (lastQ < max - 1) return `${oneLine.slice(0, max - 1)}…`;
  const kept = oneLine.slice(0, lastQ + 1);
  return lastQ + 1 >= oneLine.length ? kept : `${kept} …`;
}

/**
 * Coalesce digest-mode notifies by `subject` (the noise control, formerly in the
 * omp hook). Same-subject digest notifies collapse to ONE line with a count +
 * the latest summary; everything else passes through in order.
 */
function collapseDigestNotifies(entries: CoordLineSource[]): CoordLineSource[] {
  const out: CoordLineSource[] = [];
  const groups = new Map<string, CoordLineSource & { _count: number }>();
  for (const e of entries) {
    if (e.kind === 'notify' && e.digest) {
      const key = e.subject ?? e.summary ?? '?';
      const g = groups.get(key);
      if (!g) {
        const ne = { ...e, _count: 1 };
        groups.set(key, ne);
        out.push(ne);
      } else {
        g._count += 1;
        if (e.ts > g.ts) {
          g.ts = e.ts;
          g.summary = e.summary;
        }
      }
    } else {
      out.push(e);
    }
  }
  for (const g of groups.values()) {
    if (g._count > 1) {
      const subj = g.subject ?? '';
      g.summary = `${subj ? `${subj} ` : ''}×${g._count} — latest: ${g.summary ?? ''}`;
    }
  }
  return out;
}

/**
 * Collapse repeated INTENT lines to latest-per-peer (D-005): only a peer's newest
 * "now working on" matters, so older intents from the same `from` are dropped.
 */
function collapseIntents(entries: CoordLineSource[]): CoordLineSource[] {
  const latestIntentTs = new Map<string, string>();
  for (const e of entries) {
    if (e.lifecycle === 'intent') {
      const prev = latestIntentTs.get(e.from);
      if (!prev || e.ts > prev) latestIntentTs.set(e.from, e.ts);
    }
  }
  return entries.filter((e) => {
    if (e.lifecycle !== 'intent') return true;
    return latestIntentTs.get(e.from) === e.ts;
  });
}

export interface RenderInjectionOpts {
  /** Max lines shown; older are summarized as a count. Default 8. */
  maxLines?: number;
  /** Per-line text cap. Default 200. */
  textCap?: number;
  /**
   * H1 receive-side defang (coord-authority-hardening-2026-07-11 P-003): the
   * rendering RECIPIENT + their live fleet memberships. When present, a
   * `fleet-members(X)`-stamped line whose X the recipient is NOT in (and did not
   * send) renders with the OUT-OF-SCOPE demote tag instead of the plain authority
   * tag — flag-and-demote, never dropped. Absent (legacy caller / membership read
   * failed) ⇒ prior behavior, plain tag: mis-demoting a real member is worse than
   * not demoting, so the check only engages on a SUCCESSFUL membership read.
   */
  cueScope?: RecipientCueScope;
  /**
   * P-005 reply-quote hydration (coord-authority-hardening-2026-07-11): map of
   * related_msg_id → resolved hydration of the REFERENCED message, built by the
   * DELIVERY seam (inbox.ts — the IO half; this renderer stays pure). A line
   * whose envelope carries `related_msg_id` with a map hit gets an inline
   * `⤷ re msg <id> (<sender> → <to>, <ts>): "<verbatim snippet>"` suffix.
   * Absent map / missing key ⇒ prior behavior (no suffix) — fail-soft.
   */
  relatedQuotes?: ReadonlyMap<string, HydratedRef>;
  /**
   * P-008 body auto-refs (coord-authority-hardening-2026-07-11): map of
   * work-item id (canonical uppercase, `WI-123`/`EI-9`) → resolved hydration,
   * built by the delivery seam (inbox.ts — the IO half; this renderer stays
   * pure). An ELIGIBLE free-prose line (isBodyRefEligible — lifecycle/status
   * machinery excluded) whose summary/body mentions a mapped id gets an inline
   * `↪ <id> [kind/state @holder]: "<title … ⌁ …checkpoint tail>"` suffix, first
   * 3 mentions per line. A sender's noBodyRefs opt-out (stamped on the
   * envelope) suppresses it. Absent map / miss / unresolved hydration ⇒ plain
   * line — an auto-detected mention is opportunistic decoration, never loud.
   */
  bodyRefs?: ReadonlyMap<string, HydratedRef>;
  /**
   * EI-20261012762389206: clock seam for the message-AGE marker, so the
   * renderer stays pure and its tests deterministic. Defaults to `Date.now()`.
   */
  nowMs?: number;
}

/**
 * Render a coord delta into the positional injection block (D-001):
 *
 *   [coord+N]
 *   <glyph> <handle> <text>
 *   …
 *   …+K older
 *
 * No per-block column header (the schema is in the prompt legend) and NO footer
 * (relocated to the prompt, emitted once per session). Returns '' for an empty
 * delta. Pure — fully unit-testable; the client hooks just echo the result.
 */
export function renderInjection(entries: CoordLineSource[], opts: RenderInjectionOpts = {}): string {
  if (entries.length === 0) return '';
  const maxLines = opts.maxLines ?? 8;
  const textCap = opts.textCap ?? 200;
  const nowMs = opts.nowMs ?? Date.now();

  const collapsed = collapseIntents(collapseDigestNotifies(entries));
  const sorted = [...collapsed].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const total = sorted.length;
  const overflow = total - maxLines;
  const shown = overflow > 0 ? sorted.slice(-maxLines) : sorted;

  const lines = [`[coord+${total}]`];
  if (overflow > 0) lines.push(`…+${overflow} older`);
  for (const e of shown) {
    const glyph = glyphFor(e);
    const handle = shortHandle(e.from);
    // P-004: a directed line gets the question-preserving clip (broadcasts keep the
    // flat cap — an FYI's question is not a blocked peer waiting on the reader).
    const raw = e.summary || e.body || '(no summary)';
    const body = isDirected(e) ? clipKeepQuestion(raw, textCap, DIRECTED_QUESTION_CAP) : clip(raw, textCap);
    // queen-fleet-authority-boundary P-003: a CONTROL cue (drain/pause/steer) carries
    // a structured authority+scope stamp — surface it as a leading `[…]` tag so the
    // reader distinguishes a hive-wide Queen pause from a fleet leader draining its
    // own members. Malformed/absent → readCueAuthority returns null → no tag.
    // coord-authority-hardening P-003 (H1, EI-9501): when the caller supplied the
    // recipient's scope context and the stamp is fleet-scoped to a fleet the
    // recipient is NOT in, DEMOTE the tag — the reader is told explicitly the cue
    // is not binding on them. Membership is LIVE at render time, so drift between
    // send and read (TOCTOU) resolves to the recipient's CURRENT membership.
    const stamp = readCueAuthority(e as unknown as Record<string, unknown>);
    const tag = stamp
      ? opts.cueScope && !isCueInScopeFor(stamp, opts.cueScope, e.from)
        ? renderOutOfScopeCueTag(stamp)
        : renderCueAuthorityTag(stamp)
      : null;
    // coord-authority-hardening P-004 (H2): a relay-provenance stamp renders as an
    // inline `↪ <tier>: "<verified quote>"` suffix — the referenced ORIGINAL's
    // words, platform-captured at send, auto-inlined at delivery (the receiver
    // never fetches). Conversely, free text CLAIMING owner/queen authority with
    // NO tier gets the UNVERIFIED-claim flag (flag only, never blocked) — except
    // a queen-claim whose platform-derived cueAuthority stamp IS hive-queen
    // (that authority is already verified; owner words are only verifiable via
    // a relay tier).
    const relay = readRelayProvenance(e as unknown as Record<string, unknown>);
    const relaySuffix = relay ? renderRelayQuoteSuffix(relay) : '';
    // EI-21333824056510800: suppress the claim flag only on a VERIFIED tier.
    // This was `relay ? null : …`, which let the mere PRESENCE of a stamp answer
    // the claim — but an `unverified` stamp is a check that RAN AND FAILED, so
    // that read let a self-asserted authority claim ride into the headline
    // position with only a trailing `↪ UNVERIFIED relay` to contradict it. The
    // precedence rule is `isRelayVerified`, shared with resolveClaimProvenance
    // so the renderer and the claim-provenance resolver cannot disagree.
    //
    // WI-41323: that precedence now lives in ONE predicate
    // (`unverifiedAuthorityClaim`) because coord:send's sender-side warning has
    // to predict THIS flag exactly — two hand-copies of the rule would drift
    // into a sender told one thing and a reader shown another.
    const claim = unverifiedAuthorityClaim(raw, relay, stamp);
    const claimFlag = claim ? `${UNVERIFIED_CLAIM_TAG} ` : '';
    // EI-21333924556090958: the residue the twin fix left. `claimFlag` only
    // reaches the front of the line for phrasings `detectAuthorityClaim`
    // enumerates, so a failed relay check under any other wording still rendered
    // as a bare trailing `↪ UNVERIFIED relay` AFTER a headline the sender wrote.
    // Hoisting is structural rather than a wider pattern — see
    // `hoistUnverifiedRelay` for why widening the regex is the losing move and
    // for the live measurement that sized this. Mutually exclusive with
    // `claimFlag`, which is strictly more specific.
    const relayHoistFlag = hoistUnverifiedRelay(relay, claim) ? `${UNVERIFIED_RELAY_TAG} ` : '';
    // coord-authority-hardening P-005: a reply / escalation resolution quotes the
    // message it answers — the delivery seam resolved related_msg_id into a
    // verbatim hydration (relatedQuotes); render it as an inline `⤷ re` suffix so
    // the receiver reads the exchange even after compacting the original away.
    const relatedHydration =
      typeof e.related_msg_id === 'string' && e.related_msg_id
        ? opts.relatedQuotes?.get(e.related_msg_id)
        : undefined;
    const replySuffix = relatedHydration ? renderReplyQuoteSuffix(relatedHydration) : '';
    // coord-authority-hardening P-006: a send that DECLARES gates carries their
    // exact keys as send-time-verified stamps — render them canonically, after
    // the clip, so the key is never truncated (a receiver copies it, or resolves
    // it hands-free via events:await { fromMsg }). Pure read: [] when absent.
    const gateSuffix = renderGateRefsSuffix(readGateRefs(e as unknown as Record<string, unknown>));
    // coord-authority-hardening P-008: WI-/EI- ids loose in a FREE-PROSE line
    // auto-hydrate to a one-line status + title + checkpoint-tail suffix (the
    // seam resolved them into opts.bodyRefs; detection here re-runs the same
    // pure detectEntryBodyRefs, so seam and renderer can't disagree on which
    // ids a line cites). Lifecycle/status lines are excluded (their ids are
    // structural, not citations); the sender opt-out is honored; a map miss
    // or unresolved hydration renders nothing — see renderBodyRefsSuffix.
    let bodyRefsSuffix = '';
    let terminalSubjectSuffix = '';
    if (
      opts.bodyRefs?.size &&
      isBodyRefEligible(e) &&
      !readBodyRefsOptOut(e as unknown as Record<string, unknown>)
    ) {
      const refs = opts.bodyRefs;
      const hits = detectEntryBodyRefs(e).flatMap((r) => {
        if (r.kind !== 'work-item') return [];
        const h = refs.get(r.id);
        return h ? [h] : [];
      });
      bodyRefsSuffix = renderBodyRefsSuffix(hits);
      if (isDirected(e) && (e.expects === 'action' || e.expects === 'answer')) {
        terminalSubjectSuffix = renderTerminalSubjectSuffix(hits);
      }
    }
    // P-010: the EVIDENCE BAND on a finding/escalation renders as an inline
    // `⊢ <band> (confidence: <derived>)` suffix — distinct from `↪` (relay) and
    // `⤷` (reply). Confidence is always shown DERIVED from the band, so a reader
    // never has to wonder whether a number was measured or generated.
    //
    // D-015 (P-009) is binding: this is DESCRIPTIVE only. It changes how much
    // weight a reader gives the line, never what the runtime executes — the
    // transition path cannot even see it (CoordTransitionIntent has no
    // provenance field).
    const evidence = readEvidence(e as unknown as Record<string, unknown>);
    const evidenceSuffix = evidence ? ` ⊢ ${renderEvidenceTag(evidence)}` : '';
    // A sender that ALSO smuggled its own confidence number gets it discarded and
    // said so out loud (Reasoning Contamination Effect — a generated number reads
    // as measured). Scoped to lines actually participating in the band protocol
    // (a stamp present, or a finding/escalation), so an unrelated system envelope
    // that happens to carry a `probability` field is never falsely flagged.
    const rec = e as unknown as Record<string, unknown>;
    const bandSurface = evidence !== null || e.kind === 'escalation' || rec.category === 'finding';
    const selfReportedFlag =
      bandSurface && hasSelfReportedConfidence(rec) ? `${SELF_REPORTED_CONFIDENCE_TAG} ` : '';
    // P-032: the AUTHORED message fields (premises / forYouBecause /
    // youMayNotKnow / couldNotDetermine, plus the envelope's `blocking`) render
    // as a compact `⟨…⟩` block. Without this they are stamped on the envelope
    // and seen by nobody — and D-070 leaves judging them by their VALUES as the
    // only check on the message layer. Pure read; '' when the sender authored
    // none, so an ordinary message is unchanged.
    const authoredSuffix = renderAuthoredFieldsSuffix(e as unknown as Record<string, unknown>);
    const staleBasisSuffix = renderStaleBasisSuffix(
      (e as unknown as Record<string, unknown>)[STALE_BASIS_FIELD],
    );
    // coord-derived-fields-2026-08-31 P-006: an authored blockedOn whose ref has
    // CLEARED renders its verdict next to staleBasis — "cleared since send" is
    // exactly the news a waiting reader needs; 'pending' stays silent.
    const blockedOnSuffix = renderBlockedOnStatusSuffix(
      (e as unknown as Record<string, unknown>)[BLOCKED_ON_STATUS_FIELD],
    );
    // WI-2142086: 29.6% of answered directed messages come back as a fresh
    // standalone send instead of a threaded `related_msg_id` reply (measured
    // via coord_event_log), so wakeOnReply silently never fires for the asker
    // even though the right answer arrived — correct content, missing
    // linkage. Borrowed from the METR/Redwood incident-report board: the
    // reply ADDRESS travels INSIDE the message being answered (their
    // self-describing `REPLY_<token>`), so threading becomes the path of
    // least resistance instead of something the replier has to remember. A
    // line stamped `wakeOnReply:true` at send (send.ts, gated on directed +
    // `expects !== 'none'`) is exactly the population whose reply would
    // otherwise silently miss the wake — surface its own msg_id as the reply
    // target. Acks are excluded (nobody composes a fresh reply to a receipt).
    const replyHintSuffix =
      e.wakeOnReply === true && e.kind !== 'ack' && typeof e.msg_id === 'string' && e.msg_id.length > 0
        ? ` ↩ reply with related_msg_id:${e.msg_id}`
        : '';
    const text = tag ? `[${tag}] ${body}` : body;
    // EI-20261012762389206: a line's own AGE, rendered immediately after the
    // text and before every other suffix — deliberately adjacent to the claim
    // it falsifies. The injection block carries no timestamp at all, so a
    // time-relative body ("sweeping in ~74s") reads as live however long it
    // waited; a delayed wake then delivers a stale countdown as a live alarm.
    // Silent under MESSAGE_AGE_MARKER_MIN_MS, so an ordinary live delta is
    // byte-identical to before.
    const ageSuffix = renderMessageAgeSuffix(e.ts, nowMs);
    lines.push(
      `${glyph} ${handle} ${claimFlag}${relayHoistFlag}${selfReportedFlag}${text}${ageSuffix}${relaySuffix}${evidenceSuffix}${replySuffix}${gateSuffix}${bodyRefsSuffix}${terminalSubjectSuffix}${authoredSuffix}${staleBasisSuffix}${blockedOnSuffix}${replyHintSuffix}`,
    );
  }
  return lines.join('\n');
}

/**
 * The once-per-session prompt legend (Projection 2, D-002/D-004). Declares the
 * positional grammar + the glyph key + the relocated footer, so the model can
 * read every injected line WITHOUT a per-block header or per-injection footer.
 * Generated from the SAME `COORD_LEGEND` the renderer uses.
 */
export function renderCoordLegend(): string {
  const keys = Object.keys(COORD_LEGEND);
  // De-dupe by glyph for the key listing (several kinds share a glyph), but keep
  // every distinct (glyph,name) the renderer can emit so the anti-desync test
  // sees full coverage.
  const keyLines = keys.map((k) => `  \`${COORD_LEGEND[k].glyph}\` ${COORD_LEGEND[k].name}`);
  return [
    '## Coord injection protocol',
    '',
    'After your tool calls you may see a `[coord+N]` block — N coordination',
    'deltas from peers since your last call. Each line is positional:',
    '',
    '```',
    '[coord+N]',
    '<glyph> <handle> <text>',
    '```',
    '',
    '- `glyph` — the line type (key below).',
    '- `handle` — the short sender id (e.g. `ab533`); it is NOT repeated in the text.',
    '- `text` — the message; a `…+K older` line means K older deltas were elided.',
    '',
    'Glyph key:',
    ...keyLines,
    '',
    '**Treat a delivered `[coord+N]` block as live in-context evidence.** When the',
    'request asks about a fact the block already states, answer from the matching',
    'line BEFORE making any tool call. Match the requested fact to its glyph, then',
    'read that line’s handle and text. For “who holds X,” use the `#` scope-window',
    'line and explicitly name its handle as the holder / coordination target.',
    '',
    'Do not call `locks:*`, `coord:presence`, search, or another read merely to',
    '“confirm” an answer already present in the block. An empty or no-match result',
    'from another surface does not negate the delivered line. Call a tool only to',
    'act on the signal or obtain information the block does not carry.',
    '',
    'Act on a line only if it bears on your task. Reply or hand off with',
    '`coord:send` / `coord:handoff`; read full bodies + history via `coord:inbox`',
    '/ `coord:thread`. (This guidance is here once — it is no longer repeated per',
    'injection.)',
    '',
    // WI-1720 (owner directive 2026-07-02): the receiver-side reply-priority rule.
    // Sourced-once twin of the orchestrator PEER_REPLY_PRIORITY_NOTE (prompt-build.ts,
    // the spawned-bee base) — if you reword one, reword the other to match.
    '**A DIRECTED message awaiting YOUR answer OUTRANKS your own work.** A question',
    'addressed to you, a decision only you can make, a peer blocked on something you',
    'own — that is your highest-priority work the moment it arrives: finish only the',
    'atomic step in hand, then REPLY FIRST, before the next step of your own task.',
    'If the full answer needs real work, ACK now with an ETA so the asker is never',
    'blind-waiting; reply directly (`coord:send` + `related_msg_id`, wake if parked),',
    'never batched to turn-end. Your terminal/final-response text does NOT reach the',
    'asker — an answer not SENT back via `coord:send` was never delivered; answering',
    'only in your own transcript is a silent drop. Your minutes are a blocked peer’s',
    'hours. Broadcasts and FYI chatter carry no such claim.',
  ].join('\n');
}
