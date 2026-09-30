/**
 * Degraded-snapshot provenance for the `learning.*` sync resolvers (WI-6382).
 *
 * ## The defect this exists to close
 *
 * 16 of 25 `learning.*` resolvers caught any read failure and returned a
 * SUCCESSFUL empty snapshot. That instinct — never a 500 for a panel read — is
 * CORRECT and is preserved here. The bug was that the degraded value was
 * byte-identical to the healthy-but-idle one, so `empty` and `unavailable`
 * became the same value and the distinction was unrecoverable downstream:
 *
 *   - the client's `sync.error` never fires for a data-layer fault (the failure
 *     was converted server-side into a success), so every panel's written
 *     `{sync.error ? ...}` branch is UNREACHABLE for this class — it fires only
 *     for TRANSPORT failure;
 *   - on a fresh or half-migrated install (the swallow's own test is named
 *     "degrades to the empty snapshot SILENTLY when the table does not exist
 *     yet (42P01)" — pre-migration IS the fresh-install case) the user is told,
 *     confidently and falsely, "No throughput recorded yet — … Start a pot and
 *     its placement metrics appear here": instructed to go wait for something
 *     that will never arrive.
 *
 * A broken install was therefore indistinguishable from an idle healthy one.
 * The fix is not to remove the catch — it is to make the degraded snapshot
 * SAY SO, so "empty" and "unavailable" stop being the same value.
 *
 * ## Reuse, not invention
 *
 * The shape here is `learning-hive-read.ts`'s EXISTING `unavailable` +
 * `unavailableReason` pair, generalized. That pair was itself added after an
 * owner report (2026-07-25) that a bare "Shared memory unavailable" is a dead
 * end for the reader — the actual cause was a corrupted `mem0ai` install, which
 * the message could not convey. Carrying the reason VERBATIM is the point; an
 * unavailability the user cannot act on is a bug in the message, not just in
 * the backend. `unavailableKind` is added on top so callers can branch on the
 * machine-classifiable case (pre-migration vs a genuine read failure) without
 * parsing prose.
 *
 * This module is also the single home for {@link isUndefinedTable}, which had
 * drifted into two byte-identical copies (`learning-scout-read.ts` and
 * `learning-hive-throughput-read.ts`). One rule, one definition — the same
 * consolidation `routedIdeasPotFilter` needed, and for the same reason: a rule
 * that exists twice is a rule that can come to disagree with itself.
 */

/** SQLSTATE `42P01` — undefined_table. */
export const UNDEFINED_TABLE = '42P01';

/** True when a PG error means "the relation doesn't exist" (pre-migration). */
export function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

/**
 * WHY a snapshot is degraded.
 *
 * - `pre-migration` — the substrate isn't there yet (42P01). Expected on a
 *   fresh/half-migrated install; the honest render is "not available yet",
 *   NOT "nothing has happened yet".
 * - `read-failed` — the substrate exists and the read still failed. Always
 *   worth surfacing: this is the class that used to render as calm and empty.
 */
export type UnavailableKind = 'pre-migration' | 'read-failed';

/** Max stored reason length (mirrors learning-hive-read.ts's existing clamp). */
export const REASON_MAX = 300;

/**
 * Provenance carried by a degraded snapshot. Optional on the snapshot types
 * themselves so healthy reads stay exactly as they were — a snapshot WITHOUT
 * `unavailable` is a genuine, trustworthy empty.
 */
export interface DegradedProvenance {
  /** True when this snapshot is a degraded stand-in, not an observed empty. */
  unavailable: true;
  /** Machine-classifiable cause — branch on this, not on the prose. */
  unavailableKind: UnavailableKind;
  /** The cause verbatim from the backend, clamped. Never swallowed. */
  unavailableReason: string;
}

/** A snapshot shape that MAY carry degraded provenance. */
export type MaybeDegraded<T> = T & Partial<DegradedProvenance>;

/**
 * The PER-LEG analog of {@link DegradedProvenance} (WI-39825).
 *
 * `DegradedProvenance` says "this whole snapshot is a stand-in". A multi-leg
 * fan-out needs the narrower claim: the snapshot IS real, and exactly these
 * named sections are not. Collected into a `degradedFields` array beside the
 * intact data, omitted entirely when every leg succeeded — so, exactly as with
 * `unavailable`, the field's PRESENCE is the signal and a healthy payload stays
 * byte-identical to what it was before the leg was bounded.
 *
 * Populate it from {@link classifyReadFailure}, never by hand: `kind` is what
 * consumers branch on and the prose `reason` is only ever for humans.
 */
export interface DegradedField {
  /** The snapshot key that is empty for a reason — e.g. `'ended'`. */
  field: string;
  /** Machine-classifiable cause — branch on this, not on the prose. */
  kind: UnavailableKind;
  /** The cause verbatim from the backend, clamped. Never swallowed. */
  reason: string;
}

/** Extract a human-readable reason from an unknown thrown value. */
export function reasonOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return (raw || 'unknown read failure').slice(0, REASON_MAX);
}

/** Classify a thrown read failure into the kind + reason pair. */
export function classifyReadFailure(err: unknown): {
  kind: UnavailableKind;
  reason: string;
} {
  return {
    kind: isUndefinedTable(err) ? 'pre-migration' : 'read-failed',
    reason: reasonOf(err),
  };
}

/**
 * The degraded form of `empty`, tagged with why.
 *
 * Use in a resolver's catch INSTEAD of returning the bare empty snapshot:
 *
 *   } catch (err) {
 *     return [degraded({ hives: [] }, err)];
 *   }
 *
 * The empty shape is preserved exactly, so every existing consumer keeps
 * working (a panel that only reads `.hives` still renders an empty list); the
 * provenance is additive, and a consumer that checks `unavailable` can now
 * tell the two apart — which is the whole defect.
 */
export function degraded<T extends object>(
  empty: T,
  err: unknown,
): MaybeDegraded<T> {
  const { kind, reason } = classifyReadFailure(err);
  return { ...empty, unavailable: true, unavailableKind: kind, unavailableReason: reason };
}

/**
 * The degraded form of `empty` for a NON-throw cause — a precondition the
 * resolver can see directly (no pot list available, a rollup this caller can't
 * serve). Same shape, stated cause.
 */
export function degradedBecause<T extends object>(
  empty: T,
  reason: string,
  kind: UnavailableKind = 'read-failed',
): MaybeDegraded<T> {
  return {
    ...empty,
    unavailable: true,
    unavailableKind: kind,
    unavailableReason: (reason || 'unknown').slice(0, REASON_MAX),
  };
}

/**
 * True when a snapshot is a degraded stand-in rather than an observed empty.
 * The one predicate every consumer (client panels included) should branch on.
 */
export function isUnavailable(snap: unknown): snap is DegradedProvenance {
  return Boolean((snap as { unavailable?: unknown } | null)?.unavailable);
}
