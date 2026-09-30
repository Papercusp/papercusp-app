/**
 * Revision key for the mutable part of persisted operator turns.
 *
 * A chat turn's `tools` JSON can change without the turn count changing (the
 * choice-card answer path is the load-bearing case). React effects that only
 * watch the live-tail length therefore miss the update. Keeping the revision
 * scoped to seq + tools avoids re-running reconciliation for unrelated row
 * fields while still detecting same-array, same-length tool mutations.
 */
export function operatorTurnToolsRevision(
  turns: ReadonlyArray<{ seq: number; tools?: unknown }>,
): string {
  return turns
    .map((turn) => `${turn.seq}:${turn.tools == null ? '' : JSON.stringify(turn.tools)}`)
    .join('\u001f');
}
