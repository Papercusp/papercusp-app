/**
 * Prefix a carry-respawn continuation with the owner it was written for.
 *
 * Carry delivery is owner-keyed, but the continuation text is still the
 * content every delivery path carries. Keeping this guard pure and separate
 * lets every fallback producer apply the same content-level provenance before
 * tagging or injecting the prompt.
 */
export function addressContinuationToOwner(note: string, ownerId: string): string {
  const sid = String(ownerId ?? '').trim();
  if (!sid) return note;
  return (
    `ADDRESSED TO ${sid} — this continuation was written for that session. ` +
    'Verify with coord:whoami BEFORE acting on anything below: if your ownerId differs, ' +
    'this block is not your lane and reached you through a delivery fault — do not act on it, ' +
    'do not claim or progress any work-item it names, report it, and continue from your own ' +
    'loop:checkpoint carry-note instead.\n\n' +
    note
  );
}
