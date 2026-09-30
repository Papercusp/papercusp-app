/**
 * Per-run snapshot DELTA adapter (agent-tool-delta-protocol-2026-06-22, Lane D / P-009).
 *
 * The state channel re-emits a run's WHOLE {@link StateSnapshot} (every openCard +
 * toolState) on each mutation. This ships only what moved. Rather than a parallel
 * differ, it ADAPTS the generic keyed-row delta engine Lane B already built
 * ({@link diffFromDigest} / {@link applySemanticDelta} / {@link computeViewChecksum}
 * in `delta-protocol`): openCards are rows keyed by `correlationId`. The adapter adds
 * only the snapshot-specific envelope — version pinning, exact card ORDER, and the
 * toolState replacement — on top of that shared engine.
 *
 * Round-trip invariant (the contract the tests pin):
 *   applySnapshotDelta(prev, diffSnapshot(prev, next)) deep-equals next
 * for any prev/next of the SAME run with next.version > prev.version.
 */
import type { OpenCardSnapshot } from './types';
import type { StateSnapshot, VersionedSnapshot } from './state-channel';
import { computeRowDigest, diffFromDigest, applySemanticDelta, computeViewChecksum, type DeltaChange } from './delta-protocol';

export interface SnapshotDelta {
  runId: string;
  /** The version this delta applies on top of (prev.version). */
  baseVersion: number;
  /** The version this delta produces (next.version). */
  version: number;
  /** Card add/update/remove — the generic delta-protocol shape, keyed by correlationId. */
  cards: DeltaChange<OpenCardSnapshot>[];
  /**
   * The full ordered correlationId list of openCards AFTER this delta. The generic
   * engine returns merged rows in insertion order and defers ordering to the caller;
   * carrying the order (just ids) reconstructs exact order incl. a pure reorder.
   */
  order: string[];
  /** Present only when toolState changed; carries the replacement value. */
  toolState?: { value: unknown };
}

const keyOf = (c: unknown): string => (c as OpenCardSnapshot).correlationId;

/**
 * Diff two consecutive per-run snapshots into a delta, or `null` when a delta can't
 * be computed (the card view exceeds the digest cap) — the caller sends a full
 * snapshot in that case.
 */
export function diffSnapshot(prev: VersionedSnapshot, next: VersionedSnapshot): SnapshotDelta | null {
  const digest = computeRowDigest(prev.snapshot.openCards, keyOf);
  if (digest === null) return null; // too many cards to digest → caller sends full
  const cards = diffFromDigest(digest, next.snapshot.openCards, keyOf) as DeltaChange<OpenCardSnapshot>[];
  const delta: SnapshotDelta = {
    runId: next.runId,
    baseVersion: prev.version,
    version: next.version,
    cards,
    order: next.snapshot.openCards.map(keyOf),
  };
  if (toolStateChanged(prev.snapshot.toolState, next.snapshot.toolState)) {
    delta.toolState = { value: next.snapshot.toolState };
  }
  return delta;
}

/**
 * Apply a delta to a base snapshot. Returns the new {@link VersionedSnapshot}, or
 * `null` when it cannot be applied (different run, or `baseVersion` !== base.version
 * — a gap; the caller must refetch the full snapshot). Reorders by `delta.order`.
 */
export function applySnapshotDelta(base: VersionedSnapshot, delta: SnapshotDelta): VersionedSnapshot | null {
  if (delta.runId !== base.runId || delta.baseVersion !== base.version) return null;
  const merged = applySemanticDelta(base.snapshot.openCards, delta.cards, keyOf);
  const byId = new Map(merged.map((c) => [keyOf(c), c]));
  const openCards: OpenCardSnapshot[] = [];
  for (const id of delta.order) {
    const card = byId.get(id);
    if (card) openCards.push(card); // defensively skip an id with no payload
  }
  const snapshot: StateSnapshot = {
    openCards,
    toolState: delta.toolState ? delta.toolState.value : base.snapshot.toolState,
  };
  return { ...base, version: delta.version, snapshot };
}

/** toolState change-detect via the engine's order-insensitive content checksum. */
function toolStateChanged(a: unknown, b: unknown): boolean {
  return computeViewChecksum([a], () => 't') !== computeViewChecksum([b], () => 't');
}

export type SnapshotEmission =
  | { event: 'snapshot'; data: VersionedSnapshot }
  | { event: 'delta'; data: SnapshotDelta };

/**
 * Choose how to emit `next` on a per-run snapshot stream: a `delta` against `prev`
 * for a delta-aware consumer when one can be computed, else the full `snapshot`
 * (the baseline on first emit, a non-delta consumer, an unchanged version, or an
 * undeltable view). Pure — the caller tracks `prev` per run and updates it to
 * `next` after emitting.
 */
export function chooseSnapshotEmission(
  prev: VersionedSnapshot | undefined,
  next: VersionedSnapshot,
  wantsDelta: boolean,
): SnapshotEmission {
  if (wantsDelta && prev && prev.version !== next.version) {
    const d = diffSnapshot(prev, next);
    if (d) return { event: 'delta', data: d };
  }
  return { event: 'snapshot', data: next };
}
