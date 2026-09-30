/**
 * logs:read payload-tier shapers (EI-20203342112661815).
 *
 * THE BUG THIS FIXES: `limit` bounds ROWS, not BYTES. Measured 2026-09-05 on
 * `papercusp-dev-api`, `{ since:'-2 hours', limit:120 }` — the tool honoured the
 * row cap and returned 120 entries totalling 34,374 chars; the generic result
 * door then force-trimmed that to 4,162 chars and delivered 12 of 120 entries.
 * The caller asked for 120 and silently received 10% of them.
 *
 * ⚠ AND THE 12 IT DELIVERED WERE THE WRONG END. `entries[]` is ascending
 * (oldest→newest): `journal-read.ts:169` documents "older rows were dropped to
 * honour `limit` (newest are kept)" and line ~898 implements it as
 * `merged.slice(-limit - 1)`. The generic door truncates an over-long array by
 * keeping its HEAD, so under door truncation the tool's own newest-kept
 * guarantee silently INVERTED to oldest-kept. That is the part a caller cannot
 * see: a forensic read looks like it succeeded while handing back the least
 * relevant window.
 *
 * ⚠ THE BUDGET IS IN CHARACTERS, DELIBERATELY NOT IN ROWS. The defect here is
 * precisely that a row count does not bound bytes, so capping rows harder would
 * reproduce it one notch lower: 14 stack traces blow any budget that 14
 * heartbeat lines fit inside, and journal lines vary by ~2 orders of magnitude
 * (`JOURNAL_MESSAGE_MAX_CHARS` alone permits 2,000 chars per message, so the
 * tool's own ceiling of 1,000 rows admits ~2MB). We therefore spend a measured
 * char budget against the ACTUAL serialized row and stop when it is gone.
 * `maxEntries` is only a secondary guard so a flood of tiny lines cannot return
 * hundreds of rows.
 *
 * WHY HERE AND NOT IN `journal-read.ts`: `readJournal` has a non-tool consumer —
 * `system-health/service-restart-rate-watchdog.ts` — which COUNTS restart
 * records. Bounding inside the shared reader would silently corrupt that count.
 * The tool layer is the agent-context surface, which is the thing that needs
 * bounding, and the tier seam already exists for exactly this.
 *
 * ⚠ NOT AN ALLOWLIST PROJECTION. `../locks/list-shape.ts` carries two recorded
 * repairs (EI-21733256625452096, EI-22073686775053989) where an allowlist
 * silently dropped fields added upstream. `logs:read` returns the five-way
 * empty-result diagnosis (`unitsUnknown`, `windowOutsideJournal`,
 * `journalError`, `journalAvailable`, `unitsHistorical`) whose entire purpose is
 * to stop a reader misreading an empty/partial result — dropping any of it at
 * the trimmed tier, the default for the su sessions that read this tool most,
 * would reintroduce that misreading. So: spread every key, touch `entries` only.
 */

/**
 * Per-tier budgets. `entriesChars` is the serialized-JSON budget for
 * `entries[]`; the observed trimmed-tier delivery for this tool was ~4.2KB
 * total, of which the non-entry envelope (window/command/units/diagnosis)
 * accounts for roughly 0.8KB — so ~3.4KB is what entries can actually spend
 * without the door having to trim, which is the condition that inverts the
 * newest-kept guarantee.
 */
export const LOGS_READ_TIER_CAPS = {
  trimmed: { entriesChars: 3_400, message: 160, maxEntries: 60 },
  standard: { entriesChars: 18_000, message: 400, maxEntries: 200 },
} as const;

type LogsTier = keyof typeof LOGS_READ_TIER_CAPS;

interface ShapedEntry extends Record<string, unknown> {
  message?: unknown;
}

/** Clip one entry's `message`, preserving every other key on the row. */
function clipEntry(row: unknown, max: number): ShapedEntry {
  const r = (row ?? {}) as ShapedEntry;
  if (typeof r.message !== 'string' || r.message.length <= max) return r;
  return { ...r, message: `${r.message.slice(0, max - 1)}…`, clipped: true };
}

/**
 * The omission marker. It sits at the HEAD of `entries[]`, not the tail, because
 * that is where the gap actually is: we keep the NEWEST rows, so the rows that
 * went missing are the OLDEST, and a marker appended after the newest row would
 * describe a hole at the wrong end of the window.
 */
function omissionMarker(dropped: number, total: number, tier: LogsTier): ShapedEntry {
  return {
    unit: '(truncated)',
    ts: null,
    level: 'notice',
    repeat: 1,
    _truncated: true,
    message:
      `${dropped} OLDER of ${total} entries omitted to fit the ${tier} payload budget; ` +
      'the NEWEST are kept. This is a payload-size cut, not a journal gap — narrow `since`/`grep`, ' +
      'or pass payloadTier:"full" for the unshaped read.',
  };
}

export function shapeLogsRead(data: unknown, tier: LogsTier): unknown {
  const d = data as ({ entries?: unknown[] } & Record<string, unknown>) | null | undefined;
  if (!d || !Array.isArray(d.entries) || d.entries.length === 0) return data;

  const c = LOGS_READ_TIER_CAPS[tier];
  const all = d.entries;

  // Walk from the NEWEST end backwards, spending the char budget on real
  // serialized rows. `kept` is built newest-first and reversed once at the end,
  // so the returned array keeps the ascending order every caller already parses.
  const keptReversed: ShapedEntry[] = [];
  let spent = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (keptReversed.length >= c.maxEntries) break;
    const entry = clipEntry(all[i], c.message);
    const cost = JSON.stringify(entry).length + 1; // +1 for the array comma
    // Always keep at least one row: a single row wider than the whole budget
    // must still come back (clipped) rather than yielding an empty `entries[]`,
    // which reads exactly like a clean window and is the misreading this tool's
    // five-way empty-result diagnosis exists to prevent.
    if (spent + cost > c.entriesChars && keptReversed.length > 0) break;
    spent += cost;
    keptReversed.push(entry);
  }

  const kept = keptReversed.reverse();
  const dropped = all.length - kept.length;
  if (dropped <= 0) return { ...d, entries: kept };

  return {
    ...d,
    entries: [omissionMarker(dropped, all.length, tier), ...kept],
    // Distinct from `truncated`, which means "older rows dropped to honour
    // `limit`". This says the rows that SURVIVED `limit` were then cut again to
    // fit the payload. Conflating the two would hide a byte-budget cut behind a
    // flag the caller already expects to see set.
    payloadBounded: {
      tier,
      showingEntries: kept.length,
      ofEntries: all.length,
      droppedOldest: dropped,
      entriesChars: spent,
      budgetChars: c.entriesChars,
    },
  };
}
