/**
 * dedup-candidates-stamp — the payload contract for file-time dup-detection persistence
 * (silent-intake-central-resolution-2026-09-01, P-001 / D-001 / D-003).
 *
 * WHY: both create paths (improvements:capture → capture-core.ts, work_items:create →
 * _create-core.ts) already RUN dup detection at file time — the cheapest moment (the
 * search already ran, the row is fresh) — but used to return the candidates to the
 * caller and DISCARD them (observed live on EI-22068807981214694: possibleDuplicates
 * listed 5 twins; the row payload carried none). Under silent intake (D-001) the filer
 * is never the consumer of that information — the CENTRAL RESOLVER is. So the twins
 * land on the created row itself, where the resolver reads:
 *
 *   payload->'dedupCandidates'  — this array, stamped ONLY when non-empty
 *   payload->'dedupCoverage'    — what the detection could actually check (already
 *                                 stamped by both paths; distinguishes "checked clean"
 *                                 from "could not check", so an ABSENT dedupCandidates
 *                                 is readable)
 *
 * Compact on purpose: id + similarity + method. Title/state/harness are join-able by id
 * and would go stale on the row. The mapper from each path's own candidate type stays in
 * that path (they carry different method evidence); this module owns only the shared
 * contract so the two writers and the resolver cannot drift apart.
 *
 * Resolver-priority consumers (P-006) key off `payload->'dedupCandidates' IS NOT NULL`.
 */

/** How the candidate was detected — which net caught it, and (for semantic) the band. */
export type DedupCandidateMethod =
  /** capture path: token/Jaccard title match at or above DUP_THRESHOLD */
  | 'lexical'
  /** semantic (embedding cosine) hit in the blocking band */
  | 'semantic-hard'
  /** semantic (embedding cosine) hit in the advisory band */
  | 'semantic-soft'
  /** capture path: title-containment net (always advisory) */
  | 'containment'
  /** capture path: exact watchdogKey match — definitional, not a similarity guess */
  | 'exact-key'
  /** create path: recent-lexical prescreen (EI-9940 pre-embed-backfill window) */
  | 'lexical-recent'
  /** create path: unified full-text search-first prescreen (EI-19298062354262754) */
  | 'lexical-fulltext'
  /** create path: recent-lexical leg, identifier-anchored measurements agree (measurement-tuples.ts) */
  | 'measurement-overlap';

/** One persisted candidate twin. */
export interface DedupCandidateStamp {
  /** The existing item this filing may duplicate (engineer_issues / work_items id). */
  id: string;
  /** 0..1 score in the METHOD'S OWN metric (cosine for semantic, Jaccard/containment
   *  for the lexical nets) — comparable within a method, not across methods. */
  similarity: number;
  method: DedupCandidateMethod;
}

/** The payload key both writers stamp and the resolver reads. */
export const DEDUP_CANDIDATES_PAYLOAD_KEY = 'dedupCandidates';
