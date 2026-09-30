/**
 * possible-secret.ts — the "⚠ may contain a credential" chip for Settings →
 * Memory (EI-10371 stage 1), derived from the write-time stamps the rows
 * already carry (metadata.possible_secret / possible_secret_classes, stamped
 * by every write path: memory:remember/update, this page's POST/PATCH, the
 * transcript miner, and the journal drain).
 *
 * Detection is flag-only: the stored text is never altered, so the chip's job
 * is to get the user to LOOK — rotate the secret, then edit or delete the row.
 * Pure module (not in page.tsx) so the mapping is directly testable — the
 * same idiom as origin.ts / recall-health.ts.
 */

/** The flagged row's pattern classes, or null when the row is not flagged. */
export function possibleSecretClasses(row: { metadata?: Record<string, unknown> }): string[] | null {
  const meta = row.metadata ?? {};
  if (meta.possible_secret !== true) return null;
  const raw = meta.possible_secret_classes;
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
}

/** Hover text for the chip — names the classes and says what to do. */
export function possibleSecretTitle(classes: string[]): string {
  const what = classes.length > 0 ? classes.join(', ') : 'credential-shaped content';
  return (
    `Flagged at write time as possibly containing a credential (${what}). ` +
    `The text was stored unchanged — if it is a real secret, rotate it, then edit or delete this memory.`
  );
}
