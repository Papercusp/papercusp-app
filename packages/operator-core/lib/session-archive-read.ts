/**
 * session-archive-read.ts — sessions:read's ARCHIVE fall-through
 * (plan session-db-archive-retire-dirs-2026-07-10 P-009).
 *
 * session_turns is a bounded 45d index; the session_archives blob store is
 * the permanent copy (D-001). When the index has NO rows for a session —
 * pruned past 45d, or the session predates ingest — this reader decompresses
 * the archived transcript(s), re-parses them with the SAME per-CLI line
 * parsers the ingest uses, and re-applies the SAME cap+redaction
 * (cleanTurnText), so nothing verbatim-secret leaks through the fall-through
 * that the index would have redacted.
 *
 * sessions:search stays index-bounded BY DESIGN — full-text over compressed
 * blobs is not a search index; the archive is for reads, resume, and rebuild.
 */

import {
  cleanTurnText,
  parseClaudeLine,
  parseCodexLine,
  parseOmpLine,
  type TurnTextParseOptions,
} from './search/session-ingest';
import {
  decompressArchiveBlobBounded,
  pgSessionArchiveStore,
  SESSION_ARCHIVE_MAX_FILES,
  SESSION_ARCHIVE_MAX_TOTAL_RAW_BYTES,
  sha256Hex,
  type ArchiveSourceKind,
  type SessionArchiveStore,
} from './session-archive';

export interface ArchivedTurn {
  source_kind: string;
  turn_idx: number;
  speaker: string;
  owner: string | null;
  ts: string | null;
  text: string;
}

export interface ArchivedFileError {
  path: string;
  error: string;
}

const PARSERS: Record<
  ArchiveSourceKind,
  (line: string, options?: TurnTextParseOptions) => { speaker: string; text: string; ts?: Date | null } | null
> = {
  claude: parseClaudeLine,
  omp: parseOmpLine,
  codex: parseCodexLine,
};

export interface ReadArchivedSessionTurnsOptions extends TurnTextParseOptions {
  /** Retain only these parsed turn indexes while scanning the archive. */
  turnIndices?: readonly number[];
}

/** Turns of one archived session, index-equivalent by default (capped + redacted).
 *  Returns null when the session has no archive under any (or the given)
 *  source kind. `fullSource` removes only the per-turn index cap; redaction
 *  and the parser's normal turn filtering still apply. */
export async function readArchivedSessionTurns(
  sessionId: string,
  sourceKind?: ArchiveSourceKind,
  store: SessionArchiveStore = pgSessionArchiveStore(),
  options: ReadArchivedSessionTurnsOptions = {},
): Promise<{
  sourceKind: ArchiveSourceKind;
  owner: string | null;
  turns: ArchivedTurn[];
  errors: ArchivedFileError[];
} | null> {
  const kinds: ArchiveSourceKind[] = sourceKind ? [sourceKind] : ['claude', 'codex', 'omp'];
  for (const kind of kinds) {
    const stamp = await store.readStamp(kind, sessionId);
    if (!stamp) continue;
    const rows = (await store.readFiles(kind, sessionId))
      .filter((r) => r.relpath.endsWith('.jsonl'))
      .sort((a, b) => (a.relpath < b.relpath ? -1 : 1));
    const turns: ArchivedTurn[] = [];
    const errors: ArchivedFileError[] = [];
    const totalRawBytes = rows.reduce((total, row) => total + row.bytes_raw, 0);
    if (
      rows.length > SESSION_ARCHIVE_MAX_FILES ||
      rows.some((row) => !Number.isSafeInteger(row.bytes_raw) || row.bytes_raw < 0) ||
      !Number.isSafeInteger(totalRawBytes) ||
      totalRawBytes > SESSION_ARCHIVE_MAX_TOTAL_RAW_BYTES
    ) {
      return {
        sourceKind: kind,
        owner: stamp.owner,
        turns,
        errors: [{ path: '(archive)', error: 'archive exceeds the admitted file or raw-byte limit' }],
      };
    }
    const wantedTurnIndices = options.turnIndices ? new Set(options.turnIndices) : null;
    let turnIndex = 0;
    for (const row of rows) {
      try {
        const raw = await decompressArchiveBlobBounded(row, SESSION_ARCHIVE_MAX_TOTAL_RAW_BYTES);
        if (sha256Hex(raw) !== row.sha256) throw new Error('archive sha256 mismatch');
        for (const line of raw.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          let parsed: ReturnType<(typeof PARSERS)['claude']> = null;
          try {
            parsed = PARSERS[kind](line, options);
          } catch {
            continue; // one malformed line never kills the read
          }
          if (!parsed) continue;
          const currentTurnIndex = turnIndex++;
          if (wantedTurnIndices && !wantedTurnIndices.has(currentTurnIndex)) continue;
          const text = cleanTurnText(parsed.text, options);
          if (!text) continue;
          turns.push({
            source_kind: kind,
            turn_idx: currentTurnIndex,
            speaker: parsed.speaker,
            owner: stamp.owner,
            ts: parsed.ts ? parsed.ts.toISOString() : null,
            text,
          });
        }
      } catch (error) {
        errors.push({
          path: row.relpath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { sourceKind: kind, owner: stamp.owner, turns, errors };
  }
  return null;
}
