/**
 * Provenance of the candidate a green-checkpoint run is actually judging.
 *
 * `unresolved` intentionally does not belong here. It is a preflight state and
 * must never be serialized as the source of a runnable candidate.
 */
export const CHECKPOINT_CANDIDATE_SOURCES = [
  'pinned',
  'tip',
  'frozen-repair-queue',
  'current-quiet-cut',
] as const;

export type CheckpointCandidateSource = (typeof CHECKPOINT_CANDIDATE_SOURCES)[number];

export function isCheckpointCandidateSource(value: unknown): value is CheckpointCandidateSource {
  return (
    typeof value === 'string' &&
    (CHECKPOINT_CANDIDATE_SOURCES as readonly string[]).includes(value)
  );
}
