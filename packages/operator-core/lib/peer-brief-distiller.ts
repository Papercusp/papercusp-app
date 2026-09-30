/**
 * peer-brief-distiller — the collision-handle → PEER BRIEF resolver for
 * ambient-semantic-push-2026-07-14 (Phase 4/5 P-012), built to plan D-007
 * (distilled-surfaces-only) + D-008 (fleet journals read-visible, matcher-
 * delivered).
 *
 * A collision push (P-004) points at a peer via handle.ref = the peer's session
 * id. RESOLVING that handle produces this brief: a deterministic, cursor-scoped
 * digest of the peer's ALREADY-FETCHED surface — their active claim, on-topic
 * journal slice, latest checkpoint, dead-end facts, touched files — RANKED by
 * relevance to the READER's own cursor and bounded to distilled snippets, never
 * full content (D-007). It is the third consumer of the one shared surface
 * builder (successor/carry, self/cursor, peer/brief — deterministic-context-
 * carry P-009); this pure core consumes the built PeerSurface and never fetches.
 *
 * The cross-agent WI-3532 guard is the load-bearing invariant: every surface
 * fragment carries a SOURCE provenance tag (owner / self-imposed / peer / …),
 * and the distiller PRESERVES it end-to-end and renders it under a receiver-
 * facing `peer-*` label — so a peer's self-imposed note-to-self can NEVER read
 * to the receiver as an owner directive, and an owner directive given to the
 * PEER is delivered as the peer's context, not the reader's own order. The whole
 * brief is stamped `data-not-directive` (mirrors PushObject.provenance): a peer
 * brief is DATA about a neighbor, never an instruction to act.
 *
 * Delivery is pull-first: the brief is resolved on demand (the reader pulls the
 * handle) and auto-injected ONLY at confirmed-collision severity (critical);
 * {@link briefDeliveryMode} encodes that decision purely. The live legs — the
 * real surface fetch behind {@link PeerSurfaceSource} and the injection-door
 * tally — ride later phases DEFAULT-OFF; nothing here calls them. PURE, no-LLM.
 */

import {
  buildCursor,
  scoreCursorOverlap,
  type LexicalCursor,
  type BuildCursorOptions,
} from './lexical-cursor';
import type { PushObject, PushSeverity } from './ambient-push';

// ─────────────────────────────────────────────────────────────────────────────
// Provenance — the cross-agent WI-3532 guard
// ─────────────────────────────────────────────────────────────────────────────

/** Where a surface fragment's authority comes from — carried end-to-end so the
 *  receiver can never mistake the PEER's context for their OWN directive. */
export type SurfaceProvenance = 'owner' | 'self-imposed' | 'peer' | 'inferred' | 'system';

/** What kind of surface a fragment is (the peer's already-fetched raw material). */
export type PeerSurfaceKind = 'claim' | 'journal' | 'checkpoint' | 'dead-end' | 'touched-file';

/** One already-fetched fragment of a peer's surface. */
export interface PeerSurfaceFragment {
  kind: PeerSurfaceKind;
  /** The artifact id / path / fact ref this fragment resolves to. */
  ref: string;
  /** The fragment's raw text (distilled to a bounded snippet in the brief). */
  text: string;
  /** SOURCE provenance — preserved verbatim end-to-end, never upgraded. */
  provenance: SurfaceProvenance;
}

/** A peer's ALREADY-FETCHED surface — the raw material for a brief. Built by the
 *  shared surface builder (deterministic-context-carry P-009); this pure core
 *  never fetches it. The `claim` fragment is the collision identity. */
export interface PeerSurface {
  /** The peer session this surface describes. */
  sessionId: string;
  fragments: PeerSurfaceFragment[];
}

/**
 * Receiver-facing provenance label. EVERY label is prefixed `peer-` so nothing
 * in a delivered brief can read as the READER's own directive: an owner
 * directive given to the PEER becomes `peer-owner-directive` (their context, not
 * your order), a peer's note-to-self becomes `peer-self-imposed` (context, not
 * authority). This is the cross-agent WI-3532 guard, rendered. PURE.
 */
export function deliveredProvenanceLabel(p: SurfaceProvenance): string {
  switch (p) {
    case 'owner':
      return 'peer-owner-directive';
    case 'self-imposed':
      return 'peer-self-imposed';
    case 'peer':
      return 'peer-cited';
    case 'inferred':
      return 'peer-inferred';
    case 'system':
      return 'peer-system';
    default:
      return 'peer-unknown';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The distilled brief
// ─────────────────────────────────────────────────────────────────────────────

export interface DistilledFragment {
  kind: PeerSurfaceKind;
  ref: string;
  /** A bounded, distilled snippet — NEVER the full fragment text (D-007). */
  snippet: string;
  /** SOURCE provenance, preserved verbatim (the WI-3532 guard). */
  provenance: SurfaceProvenance;
  /** Receiver-facing label — always `peer-*` (deliveredProvenanceLabel). */
  deliveredLabel: string;
  /** Relevance to the reader's cursor ∈ [0,1] (the always-included claim keeps
   *  its true score, which may be 0 when the claim shares no term). */
  score: number;
  /** The shared terms that scored it — the legible "why it's relevant". */
  sharedTerms: string[];
}

export interface DistilledPeerBrief {
  sessionId: string;
  /** The peer's active claim — the collision IDENTITY, always included when the
   *  surface has one (never floor-dropped). */
  claim?: DistilledFragment;
  /** The ranked, floored, capped remainder (journal, checkpoint, dead-ends,
   *  touched files), strongest-relevance first. */
  fragments: DistilledFragment[];
  /** ALWAYS 'data-not-directive' — a brief is data about a neighbor, never an
   *  order (mirrors PushObject.provenance). */
  provenance: 'data-not-directive';
  /** How many non-claim fragments the surface offered (before flooring/capping). */
  totalCandidates: number;
  /** How many non-claim fragments were dropped below the relevance floor. */
  droppedBelowFloor: number;
}

export interface DistillPeerBriefOptions {
  /** Relevance floor for ranked (non-claim) fragments. */
  minScore?: number;
  /** Cap on ranked fragments kept (the claim is always additional). */
  maxFragments?: number;
  /** Per-fragment snippet cap — the distilled-not-full guarantee (D-007). */
  maxSnippetChars?: number;
  cursorOptions?: BuildCursorOptions;
  idf?: (term: string) => number;
}

/** The brief is PULLED (or auto-injected only at a confirmed collision), so its
 *  floor sits below the ambient-push drone floor (0.4): the reader has already
 *  collided with this peer — show the relevant slice even at moderate overlap.
 *  Matcher proposes, the pull/inject policy disposes. */
export const DEFAULT_PEER_BRIEF_MIN_SCORE = 0.15;
export const DEFAULT_PEER_BRIEF_MAX_FRAGMENTS = 6;
export const DEFAULT_PEER_BRIEF_SNIPPET_CHARS = 140;

/**
 * Distill a peer's already-fetched surface into a bounded, cursor-scoped brief.
 * Scores every fragment's relevance to the reader (lexical-cursor buildCursor +
 * scoreCursorOverlap), always keeps the claim (the collision identity), floors
 * and caps the rest, and renders each as a distilled snippet under its preserved
 * `peer-*` provenance label. The whole brief is stamped data-not-directive. PURE.
 */
export function distillPeerBrief(
  readerCursor: LexicalCursor,
  surface: PeerSurface,
  opts: DistillPeerBriefOptions = {},
): DistilledPeerBrief {
  const minScore = opts.minScore ?? DEFAULT_PEER_BRIEF_MIN_SCORE;
  const maxFragments = Math.max(0, opts.maxFragments ?? DEFAULT_PEER_BRIEF_MAX_FRAGMENTS);
  const maxSnippetChars = Math.max(1, opts.maxSnippetChars ?? DEFAULT_PEER_BRIEF_SNIPPET_CHARS);
  const overlapOpts = opts.idf ? { idf: opts.idf } : {};
  const fragments = surface.fragments ?? [];

  const scoreFragment = (f: PeerSurfaceFragment): DistilledFragment => {
    const overlap = scoreCursorOverlap(readerCursor, buildCursor([f.text], opts.cursorOptions), overlapOpts);
    return {
      kind: f.kind,
      ref: f.ref,
      snippet: distillSnippet(f.text, maxSnippetChars),
      provenance: f.provenance,
      deliveredLabel: deliveredProvenanceLabel(f.provenance),
      score: overlap.score,
      sharedTerms: overlap.sharedTerms.map((t) => t.term),
    };
  };

  const usable = (f: PeerSurfaceFragment): boolean =>
    !!f && !!f.ref && typeof f.text === 'string' && f.text.trim().length > 0;

  // The claim is the collision identity — always included, never floored.
  const claimSource = fragments.find((f) => usable(f) && f.kind === 'claim');
  const claim = claimSource ? scoreFragment(claimSource) : undefined;

  // Everything else is ranked by relevance to the reader, floored, then capped.
  const candidates = fragments.filter((f) => usable(f) && f !== claimSource);
  const scored = candidates.map(scoreFragment).filter((d) => d.score > 0 && d.score >= minScore);
  scored.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));

  return {
    sessionId: surface.sessionId,
    claim,
    fragments: scored.slice(0, maxFragments),
    provenance: 'data-not-directive',
    totalCandidates: candidates.length,
    droppedBelowFloor: candidates.length - scored.length,
  };
}

/** Collapse whitespace and bound the text to a single distilled snippet — the
 *  D-007 "distilled surfaces only, never full content" guarantee, mechanically. */
function distillSnippet(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxChars ? collapsed : collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant guard (defense-in-depth, mirrors push-volume-guard)
// ─────────────────────────────────────────────────────────────────────────────

export interface BriefProvenanceViolation {
  kind: 'brief-not-data-not-directive' | 'fragment-missing-provenance' | 'label-not-peer-scoped' | 'snippet-over-cap';
  detail: string;
}

/**
 * Independent invariant check of the cross-agent WI-3532 guard over a RENDERED
 * brief: the whole brief must be `data-not-directive`, every fragment (claim
 * included) must carry a source provenance AND a receiver-facing `peer-*` label,
 * and no snippet may exceed the distillation cap (a leaked full-content payload).
 * Defense-in-depth — it does NOT trust distillPeerBrief; it re-checks the output,
 * the same way push-volume-guard re-checks selectPushes. Never throws. PURE.
 */
export function checkBriefProvenanceSafe(
  brief: DistilledPeerBrief,
  maxSnippetChars: number = DEFAULT_PEER_BRIEF_SNIPPET_CHARS,
): BriefProvenanceViolation[] {
  const violations: BriefProvenanceViolation[] = [];
  if (brief.provenance !== 'data-not-directive') {
    violations.push({ kind: 'brief-not-data-not-directive', detail: `brief.provenance = ${String(brief.provenance)}` });
  }
  const all = brief.claim ? [brief.claim, ...brief.fragments] : brief.fragments;
  for (const f of all) {
    if (!f.provenance) {
      violations.push({ kind: 'fragment-missing-provenance', detail: `fragment ${f.ref} carries no source provenance` });
    }
    if (!f.deliveredLabel || !f.deliveredLabel.startsWith('peer-')) {
      violations.push({
        kind: 'label-not-peer-scoped',
        detail: `fragment ${f.ref} label "${f.deliveredLabel}" is not peer-scoped (could read as the reader's own directive)`,
      });
    }
    if (f.snippet.length > maxSnippetChars) {
      violations.push({
        kind: 'snippet-over-cap',
        detail: `fragment ${f.ref} snippet ${f.snippet.length} > cap ${maxSnippetChars} (full content leaked)`,
      });
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery mode + collision-handle resolution
// ─────────────────────────────────────────────────────────────────────────────

export type BriefDeliveryMode = 'pull' | 'auto-inject';

/** Pull-first: a peer brief resolves on demand (the reader pulls the handle) and
 *  auto-injects ONLY at confirmed-collision severity (critical). Everything else
 *  stays pull. The injection-door tally that meters the auto-inject path is a
 *  live leg (DEFAULT-OFF); this only decides the MODE. PURE. */
export function briefDeliveryMode(severity: PushSeverity): BriefDeliveryMode {
  return severity === 'critical' ? 'auto-inject' : 'pull';
}

/**
 * Resolve a collision push's handle into the peer brief it points at. Refuses a
 * surface that describes a DIFFERENT peer than the push targets (handle.ref !==
 * surface.sessionId) — a mismatch means the wrong surface was fetched, and we
 * will not brief the reader on a stranger. Returns { mode, brief }: `mode` is
 * briefDeliveryMode(push.severity), so a confirmed collision (critical) auto-
 * injects while a weaker signal stays pull-first. PURE.
 */
export function resolveCollisionBrief(
  push: PushObject,
  surface: PeerSurface,
  readerCursor: LexicalCursor,
  opts: DistillPeerBriefOptions = {},
): { mode: BriefDeliveryMode; brief: DistilledPeerBrief } {
  if (push.handle.ref !== surface.sessionId) {
    throw new Error(
      `peer-brief surface mismatch: push points at ${push.handle.ref}, surface describes ${surface.sessionId}`,
    );
  }
  return { mode: briefDeliveryMode(push.severity), brief: distillPeerBrief(readerCursor, surface, opts) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deferred live seam (DEFAULT-OFF — later phases, behind the host boundary)
// ─────────────────────────────────────────────────────────────────────────────

/** The live leg this pure distiller defers to: fetch a peer's real PeerSurface
 *  (the shared surface builder's third consumer) and record an auto-inject
 *  against the injection door. Named so the host boundary is explicit; the pure
 *  core never touches it, and it ships DEFAULT-OFF until the acceptance drills
 *  (P-005/P-007) exist. */
export type PeerSurfaceSource = {
  fetchSurface(sessionId: string): Promise<PeerSurface | null>;
  tallyAutoInject(brief: DistilledPeerBrief): Promise<void>;
};
