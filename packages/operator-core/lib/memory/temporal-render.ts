/**
 * Render temporal-lite validity state on recall text.
 *
 * Default recall excludes closed rows, so this is inert unless a caller opts
 * into history (`include_superseded`). When history is requested, the marker
 * rides the body so compact orient/brief folds cannot accidentally discard the
 * validity metadata while leaving stale guidance looking current.
 */

type ValidityMetadata = {
  status?: unknown;
  invalid_at?: unknown;
};

function validityOf(metadata: unknown): ValidityMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const validity = (metadata as { validity?: unknown }).validity;
  if (!validity || typeof validity !== 'object' || Array.isArray(validity)) return null;
  return validity as ValidityMetadata;
}

/** A stable UTC day label for a closed validity window. */
export function supersededMemoryMarker(metadata: unknown): string | null {
  const validity = validityOf(metadata);
  if (validity?.status !== 'superseded') return null;
  const instant =
    typeof validity.invalid_at === 'string' ||
    typeof validity.invalid_at === 'number' ||
    validity.invalid_at instanceof Date
      ? new Date(validity.invalid_at)
      : null;
  const date = instant && Number.isFinite(instant.getTime())
    ? instant.toISOString().slice(0, 10)
    : 'date unknown';
  return `[SUPERSEDED ${date}]`;
}

/** Prefix a superseded recall body exactly once; current rows are byte-identical. */
export function annotateSupersededMemory(text: string, metadata: unknown): string {
  const marker = supersededMemoryMarker(metadata);
  if (!marker || text.startsWith(`${marker} `)) return text;
  return `${marker} ${text}`;
}
