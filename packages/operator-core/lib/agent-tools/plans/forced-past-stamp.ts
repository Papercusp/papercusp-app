/**
 * forced-past-stamp.ts — record on the plan that a ship was FORCED past the
 * acceptance gate's code-truth checks.
 *
 * WHY. `plan-acceptance-gate.ts` returns `forcedPast` whenever an explicit
 * `force:{ reason }` waived one or more code-truth checks (D-003/D-005), and its
 * own contract says of that field: "The caller stamps this on the plan so the
 * waiver is permanent and visible, never a silent bypass — a force that is easy
 * to hide is worth very little."
 *
 * Nothing stamped it. `set-plan-status.ts` read only `gate.satisfied` /
 * `gate.code` / `gate.message` / `gate.rubricId`, so a forced ship succeeded and
 * left the plan indistinguishable from one that passed the gate honestly. That
 * is the exact failure the gate's comment names: the waiver was easy to hide, so
 * it was worth very little. A reader (or an auditor asking "was this plan ever
 * really audited?") had no surface to consult.
 *
 * WHERE THE STAMP LIVES, and why not the `## Now` block. The Now block is the
 * most-read field on a plan, but it is also REWRITABLE — `plans:set-now`
 * replaces it wholesale, and `stampTerminalNowBlock` rewrites it on every
 * terminal flip. A waiver parked there is one ordinary write away from being
 * erased, which fails the "permanent" half of the contract. So the waiver gets
 * its own append-only section that no existing writer touches.
 *
 * APPEND-ONLY, never rewrite. Each force is a distinct historical event: a plan
 * forced twice must show both, because "which checks were waived, and why" is
 * not answerable from the latest waiver alone. Re-running the SAME call is still
 * idempotent (an identical entry is not appended twice), so the caller's own
 * idempotent-re-application path cannot inflate the history.
 *
 * Pure — no I/O, no clock beyond the injected `today` — so callers splice the
 * result into the same locked write as the status flip and the waiver can never
 * disagree with the status it waived, not even transiently.
 */

/** Heading of the append-only waiver log. */
export const FORCED_PAST_SECTION_HEADING = '## Acceptance waiver';

/** Stable prefix for the machine-readable companion to each human entry. */
export const FORCED_PAST_MACHINE_PREFIX = 'papercusp:forced-past:v1:';

export interface ForcedPastActor {
  ownerId: string;
  ownerLabel: string;
}

/** Shape returned by the acceptance gate when a force waived checks. */
export interface ForcedPastRecord {
  reason: string;
  checks: readonly string[];
  /** ISO timestamp. Older, human-only stamps carry a date string. */
  forcedAt?: string;
  /** The attributable caller. Null only for stamps predating the machine record. */
  forcedBy?: ForcedPastActor | null;
  /** True only when reconstructed from a pre-v1 human-only entry. */
  legacy?: boolean;
}

export interface StoredForcedPastRecord {
  reason: string;
  checks: string[];
  forcedAt: string;
  forcedBy: ForcedPastActor | null;
  legacy: boolean;
}

/** Bounded row projection surfaced by plans:get/list. Full history stays in content. */
export interface ForcedPastSummary {
  count: number;
  latest: StoredForcedPastRecord;
}

/**
 * Flatten caller free-text to a single safe markdown line.
 *
 * The reason is arbitrary caller input landing in a markdown document, so it is
 * neutralised rather than trusted: newlines collapse (a multi-line reason must
 * not fragment the entry into sibling blocks) and leading `#`/`-` are defanged
 * so a reason can never forge a heading or a sibling list entry — i.e. cannot
 * fabricate a SECOND waiver, or a section that outranks this one.
 */
function flattenReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '(no reason given)';
  return oneLine.replace(/^[#>\-*\s]+/, '').trim() || '(no reason given)';
}

/**
 * Render the single log entry for one waiver event.
 *
 * Exported so tests — and any future reader/parser of the log — agree on the
 * shape by construction instead of by a duplicated literal.
 */
function normalizeRecord(forcedPast: ForcedPastRecord, today: Date): StoredForcedPastRecord {
  const supplied = typeof forcedPast.forcedAt === 'string' ? forcedPast.forcedAt.trim() : '';
  const forcedAt = supplied || today.toISOString();
  const forcedBy = forcedPast.forcedBy;
  return {
    reason: flattenReason(forcedPast.reason),
    checks: [...forcedPast.checks].filter((c): c is string => typeof c === 'string' && c.length > 0).sort(),
    forcedAt,
    forcedBy:
      forcedBy && typeof forcedBy.ownerId === 'string' && typeof forcedBy.ownerLabel === 'string'
        ? { ownerId: forcedBy.ownerId, ownerLabel: forcedBy.ownerLabel }
        : null,
    legacy: forcedPast.legacy === true,
  };
}

export function forcedPastEntry(forcedPast: ForcedPastRecord, today: Date = new Date()): string {
  const record = normalizeRecord(forcedPast, today);
  const iso = record.forcedAt.slice(0, 10);
  const checks = record.checks;
  const rendered = checks.length > 0 ? checks.map((c) => `\`${c}\``).join(', ') : '(none recorded)';
  const actor = record.forcedBy
    ? ` Forced by: ${flattenReason(record.forcedBy.ownerLabel)} (\`${flattenReason(record.forcedBy.ownerId)}\`).`
    : '';
  return `- **${iso}** — shipped past ${rendered}. Reason: ${record.reason}${actor}`;
}

function encodeMachineRecord(record: StoredForcedPastRecord): string {
  return Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
}

function decodeMachineRecord(encoded: string): StoredForcedPastRecord | null {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof value.reason !== 'string' || typeof value.forcedAt !== 'string') return null;
    if (!Array.isArray(value.checks) || !value.checks.every((c) => typeof c === 'string')) return null;
    const actor = value.forcedBy;
    if (
      actor !== null &&
      (typeof actor !== 'object' ||
        typeof (actor as Record<string, unknown>).ownerId !== 'string' ||
        typeof (actor as Record<string, unknown>).ownerLabel !== 'string')
    ) {
      return null;
    }
    return {
      reason: value.reason,
      checks: [...(value.checks as string[])].sort(),
      forcedAt: value.forcedAt,
      forcedBy: actor as ForcedPastActor | null,
      legacy: value.legacy === true,
    };
  } catch {
    return null;
  }
}

function machineEntry(record: StoredForcedPastRecord): string {
  return `<!-- ${FORCED_PAST_MACHINE_PREFIX}${encodeMachineRecord(record)} -->`;
}

function recordKey(record: StoredForcedPastRecord): string {
  return JSON.stringify({
    date: record.forcedAt.slice(0, 10),
    reason: record.reason,
    checks: record.checks,
    forcedBy: record.forcedBy,
  });
}

/** Parse v1 machine records plus pre-v1 human-only entries, without double-counting. */
export function parseForcedPastRecords(body: string): StoredForcedPastRecord[] {
  const found: Array<{ index: number; record: StoredForcedPastRecord }> = [];
  const machineHumanLines = new Set<string>();
  const machineRe = new RegExp(`<!--\\s*${FORCED_PAST_MACHINE_PREFIX}([A-Za-z0-9_-]+)\\s*-->`, 'g');
  for (const match of body.matchAll(machineRe)) {
    const record = decodeMachineRecord(match[1] ?? '');
    if (!record) continue;
    found.push({ index: match.index ?? 0, record });
    machineHumanLines.add(forcedPastEntry(record, new Date(record.forcedAt)));
  }

  const legacyRe = /^- \*\*(\d{4}-\d{2}-\d{2})\*\* — shipped past (.+?)\. Reason: (.*)$/gm;
  for (const match of body.matchAll(legacyRe)) {
    const line = match[0] ?? '';
    if (machineHumanLines.has(line)) continue;
    const checksText = match[2] ?? '';
    const checks = [...checksText.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).sort();
    found.push({
      index: match.index ?? 0,
      record: {
        forcedAt: match[1]!,
        checks,
        reason: flattenReason(match[3] ?? ''),
        forcedBy: null,
        legacy: true,
      },
    });
  }

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index)
    .map((x) => x.record)
    .filter((record) => {
      const key = recordKey(record);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function summarizeForcedPast(body: string): ForcedPastSummary | null {
  const records = parseForcedPastRecords(body);
  const latest = records.at(-1);
  return latest ? { count: records.length, latest } : null;
}

/**
 * Return the plan body with the waiver appended, or `null` when there is nothing
 * to do:
 *   - no waiver (the ship passed the gate honestly — the common case)
 *   - the waiver has no waived checks (a `force` that waived nothing is not a
 *     bypass, so recording one would overstate what happened)
 *   - this exact entry is already present (idempotent re-application)
 */
export function stampForcedPastWaiver(
  body: string,
  forcedPast: ForcedPastRecord | undefined | null,
  today: Date = new Date(),
): string | null {
  if (!forcedPast) return null;
  if (!Array.isArray(forcedPast.checks) || forcedPast.checks.length === 0) return null;

  const record = normalizeRecord(forcedPast, today);
  const entry = forcedPastEntry(record, today);
  const machine = machineEntry(record);
  // Idempotency is per-ENTRY, not per-section: a second, genuinely different
  // waiver must still append beneath an existing heading.
  if (parseForcedPastRecords(body).some((existing) => recordKey(existing) === recordKey(record))) return null;

  const trimmed = body.replace(/\s+$/, '');
  if (trimmed.includes(FORCED_PAST_SECTION_HEADING)) {
    // The section exists — append this entry to the END of the document. The
    // heading is append-only and nothing writes below it, so document-end IS
    // the end of the log.
    return `${trimmed}\n${entry}\n${machine}\n`;
  }

  const preamble =
    `_This plan reached a terminal status without fully satisfying its lifecycle gate. Each entry records ` +
    `an explicit, reasoned waiver — what was skipped, and why — so the exception stays visible ` +
    `to anyone who later treats this plan as evidence that the work was verified._`;

  return `${trimmed}\n\n${FORCED_PAST_SECTION_HEADING}\n\n${preamble}\n\n${entry}\n${machine}\n`;
}
