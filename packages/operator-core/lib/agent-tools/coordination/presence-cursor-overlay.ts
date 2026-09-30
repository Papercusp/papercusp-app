/**
 * presence-cursor-overlay — the P-002 leg of ambient-semantic-push-2026-07-14:
 * make a session's lexical cursor (P-001, session_cursor store) readable by
 * peers/leader THROUGH coord:presence.
 *
 * The cursor is a CONTINUOUS per-session signal (it churns every turn as the
 * agent's journal moves), so it rides the presence surface the SAME way the
 * modes / parkedOn / coordHook overlays do: a best-effort, batched, fail-soft
 * stamp applied to the `active` rows AFTER the byte-stable snapshot — NEVER in
 * the identity/state (etag/delta) lane (a cursor delta on every turn is exactly
 * the churn D-005/D-006 keep off the delta channel).
 *
 * DOUBLE DEFAULT-OFF: the overlay only runs when the caller opts in
 * (coord:presence { include_cursor:true }) AND the ambient feature flag is on
 * (PAPERCUSP_AMBIENT_CURSOR) — the caller computes `enabled` from both, so the
 * default coord:presence read is byte-identical and pays nothing (no import, no
 * query). Provenance is data-not-directive: a peer's cursor is what they are
 * working on, never an instruction to the reader (ambient D-008).
 */
import type { SessionCursorRow } from '../../session-cursor-store';
import type { CursorTerm } from '../../lexical-cursor';

/** How many top-weighted terms the published cursor carries — a legible "what
 *  this session is about" digest, not the full sparse vector (P-004's collision
 *  index reads the full cursor from the store directly, not via presence). */
export const PUBLISHED_CURSOR_MAX_TERMS = 8;

/** The compact, legible cursor a peer/leader reads off the roster. */
export interface PublishedCursor {
  /** Top-weighted terms (term + class + rounded weight), descending. */
  terms: Array<{ term: string; termClass: CursorTerm['termClass']; weight: number }>;
  /** Notes that fed the cursor (post echo-guard). */
  noteCount: number;
  /** When the cursor was last rebuilt (ISO). */
  updatedAt: string;
  /** A peer's cursor is DATA (what they're working on), never a directive. */
  provenance: 'data-not-directive';
}

/** Round a weight to 3 dp — legible on the roster, still ordering-faithful. */
function round3(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 1000) / 1000;
}

/**
 * Project a stored cursor row into its compact published form: the top
 * `maxTerms` terms (the row's `terms` is already stored descending by weight),
 * with rounded weights + the note count + the update time, stamped
 * data-not-directive. PURE — no IO, deterministic.
 */
export function projectPublishedCursor(
  row: Pick<SessionCursorRow, 'terms' | 'note_count' | 'updated_at'>,
  maxTerms: number = PUBLISHED_CURSOR_MAX_TERMS,
): PublishedCursor {
  const cap = Math.max(1, maxTerms);
  const terms = (Array.isArray(row.terms) ? row.terms : [])
    .filter((t) => t && typeof t.term === 'string')
    .slice(0, cap)
    .map((t) => ({ term: t.term, termClass: t.termClass, weight: round3(t.weight) }));
  return {
    terms,
    noteCount: row.note_count ?? 0,
    updatedAt: row.updated_at,
    provenance: 'data-not-directive',
  };
}

/** A minimal roster-row shape the overlay reads/stamps (structural — decoupled
 *  from the full RosterRow; a roster row always carries an ownerId). */
type CursorOverlayRow = { ownerId?: unknown };

export interface OverlayPresenceCursorsOptions {
  /** include_cursor && ambientCursorEnabled() — the caller pre-computes both. */
  enabled: boolean;
  maxTerms?: number;
}

/**
 * Stamp each active roster row with its owner's current cursor (`cursor`
 * field). Batched (one cursorsByOwner query) + best-effort: any failure leaves
 * the roster untouched (a cursor read must never degrade presence, same
 * contract as the modes/parkedOn/coordHook overlays). Returns the rows
 * unchanged when `enabled` is false — no import, no query on the default path.
 */
export async function overlayPresenceCursors<T extends CursorOverlayRow>(
  active: T[],
  opts: OverlayPresenceCursorsOptions,
): Promise<T[]> {
  if (!opts.enabled || active.length === 0) return active;
  try {
    const ownerIds = active.map((r) => String(r.ownerId ?? '')).filter(Boolean);
    if (ownerIds.length === 0) return active;
    const { cursorsByOwner } = await import('../../session-cursor-store');
    const byOwner = await cursorsByOwner(ownerIds);
    if (byOwner.size === 0) return active;
    return active.map((r) => {
      const row = byOwner.get(String(r.ownerId ?? ''));
      return row ? ({ ...r, cursor: projectPublishedCursor(row, opts.maxTerms) } as T) : r;
    });
  } catch {
    return active; // fail-soft — never degrade the roster
  }
}
