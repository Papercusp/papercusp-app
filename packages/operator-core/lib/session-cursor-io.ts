/**
 * session-cursor-io — the IO wiring for the P-001 live leg
 * (ambient-semantic-push-2026-07-14): rebuild a session's lexical cursor from
 * its recent journal notes at turn end and persist it.
 *
 * Pure cursor math: ./lexical-cursor.ts. SQL binding: ./session-cursor-store.ts.
 * Seam: journal:record-turn (the turn-end ingest hook) calls
 * {@link boundedBuildAndPersistCursor} — DEFAULT-OFF behind
 * PAPERCUSP_AMBIENT_CURSOR, bounded + fail-soft (same contract as the P-015
 * turn-end sweeps in turn-end-tracking-io: advisory work riding a fire-and-
 * forget hook must never slow down or fail the journal write it rides on).
 */
import { withBoundedTimeout } from './bounded-timeout';
import {
  buildCursor,
  selectCursorNotes,
  type BuildCursorOptions,
  type JournalNoteInput,
  type LexicalCursor,
} from './lexical-cursor';

/** Budget for the turn-end cursor build (mirrors TURN_END_SWEEP_BUDGET_MS). */
export const CURSOR_BUILD_BUDGET_MS = 4_000;

/** Recent journal notes pulled to build the cursor (decay fades the tail). */
const DEFAULT_CURSOR_JOURNAL_LIMIT = 40;

/** DEFAULT-OFF gate. The live leg only runs when explicitly enabled — the pure
 *  core landing does NOT turn it on (ambient plan: live legs are flag-gated
 *  default-off behind a host seam until the delivery rail + drills prove out). */
export function ambientCursorEnabled(): boolean {
  const v = process.env.PAPERCUSP_AMBIENT_CURSOR;
  return v === '1' || v === 'true';
}

export interface BuildAndPersistCursorInput {
  /** REQUIRED — threaded to the cursor upsert (D-005 / P-007). See
   *  UpsertSessionCursorInput.workspaceId. */
  workspaceId: string;
  sessionId: string;
  ownerId: string | null;
  harnessSlug: string | null;
  turnTs: Date | string | null;
  /** Max recent journal notes to consider (default 40). */
  journalLimit?: number;
  /** Passed through to buildCursor (decay / maxTerms / maxNotes overrides). */
  cursorOptions?: Omit<BuildCursorOptions, 'sessionId'>;
}

export interface BuildAndPersistCursorResult {
  persisted: boolean;
  /** The cursor that was persisted (null when there were no eligible notes). */
  cursor: LexicalCursor | null;
  noteCount: number;
  termCount: number;
}

/**
 * Rebuild this session's cursor from its recent journal notes and upsert it.
 *   1. read the session's recent journal rows (newest first);
 *   2. ECHO-GUARD (ambient D-001): keep the agent's OWN 'agent'-source notes,
 *      drop the mechanical/flagged fallback — a push about X must never make the
 *      cursor look like it is about X;
 *   3. buildCursor over the surviving notes (recency-decayed sparse vector);
 *   4. upsert keyed by session_id.
 * No eligible notes ⇒ no write ({ persisted:false }); an empty cursor would just
 * be noise in the collision index. Not bounded/gated here — the CALLER
 * ({@link boundedBuildAndPersistCursor}) owns the budget + the flag.
 */
export async function buildAndPersistCursor(
  input: BuildAndPersistCursorInput,
): Promise<BuildAndPersistCursorResult> {
  const [{ recentTurnJournal }, { upsertSessionCursor }] = await Promise.all([
    import('./turn-journal-store'),
    import('./session-cursor-store'),
  ]);

  const rows = await recentTurnJournal({
    sessionId: input.sessionId,
    limit: input.journalLimit ?? DEFAULT_CURSOR_JOURNAL_LIMIT,
  });
  // recentTurnJournal is newest-first (ORDER BY created_at DESC) — exactly the
  // order buildCursor expects (index 0 = newest, decay^i fades older notes).
  const journalInputs: JournalNoteInput[] = rows.map((r) => ({
    note: r.note,
    source: r.source,
    flagged: r.flagged,
  }));
  const notes = selectCursorNotes(journalInputs);
  if (notes.length === 0) {
    return { persisted: false, cursor: null, noteCount: 0, termCount: 0 };
  }

  const cursor = buildCursor(notes, { ...input.cursorOptions, sessionId: input.sessionId });
  await upsertSessionCursor({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    ownerId: input.ownerId,
    harnessSlug: input.harnessSlug,
    turnTs: input.turnTs,
    cursor,
  });
  return {
    persisted: true,
    cursor,
    noteCount: cursor.noteCount,
    termCount: cursor.terms.length,
  };
}

/**
 * The seam the journal:record-turn hook calls: bounded + fail-soft build. Never
 * throws, never hangs past {@link CURSOR_BUILD_BUDGET_MS}. Returns true iff a
 * cursor was persisted. The caller checks {@link ambientCursorEnabled} BEFORE
 * importing this module, so the default-off path never loads the cursor code.
 */
export async function boundedBuildAndPersistCursor(
  input: BuildAndPersistCursorInput,
): Promise<boolean> {
  const { value } = await withBoundedTimeout(buildAndPersistCursor(input), {
    fallback: { persisted: false, cursor: null, noteCount: 0, termCount: 0 } as BuildAndPersistCursorResult,
    timeoutMs: CURSOR_BUILD_BUDGET_MS,
    label: 'turn-end-cursor-build',
  });
  return value.persisted;
}
