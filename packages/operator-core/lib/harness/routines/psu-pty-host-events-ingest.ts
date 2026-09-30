/**
 * psu-pty host-event ingest + retention (psu-pty-turn-boundary-generalization-2026-09-22,
 * P-007 / D-006).
 *
 * THE PROBLEM THIS SOLVES. The psu-pty host records delivery outcomes with appendHostEvent()
 * into one JSONL file per owner. Two things were wrong with that tier:
 *
 *   1. It was UNQUERYABLE. Measured 2026-09-22: 15,014 files, 139 MB, oldest 2026-07-12. A
 *      fleet-wide "what fraction of wakes actually reached their agent" question meant scanning
 *      139 MB of loose files, so in practice nobody asked it.
 *   2. It had NO RETENTION OF ANY KIND. Each file is front-truncated at 256 KB, so a single
 *      file is bounded -- but the POPULATION is not, and had been growing unbounded for ten
 *      weeks. Retention here is therefore about FILE COUNT, not file size.
 *
 * WHY INGEST RATHER THAN MOVE THE WRITE. appendHostEvent is synchronous and fail-soft by
 * contract and runs on teardown/crash paths, so it must not acquire a pool or block (D-006).
 * The file stays the local write-ahead log; this routine is the tier that makes it queryable
 * and bounded.
 *
 * ORDERING IS THE SAFETY PROPERTY. Ingest happens BEFORE GC, and a file is deleted only if its
 * rows are known-persisted. A GC that ran first -- or that deleted a file whose insert failed --
 * would destroy the only copy of exactly the diagnostic rows this plan exists to preserve.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

/** How long an ingested row is kept in Postgres before the retention sweep drops it. */
export const HOST_EVENT_ROW_RETENTION_DAYS_DEFAULT = 90;

/**
 * How stale a JSONL file must be before GC may delete it.
 *
 * This is NOT a tuning knob -- it is the liveness guard. A running session appends to its file
 * continuously, so mtime is the evidence that no host still owns it. Deleting a file whose host
 * is alive would truncate that session's log mid-flight and lose rows written between the last
 * ingest and the delete. Keep this comfortably longer than the longest plausible idle gap of a
 * live session.
 */
export const HOST_EVENT_FILE_RETENTION_DAYS_DEFAULT = 14;

/** Bound the work per tick so one sweep cannot monopolise a routine tick or the pool. */
export const HOST_EVENT_MAX_FILES_PER_RUN_DEFAULT = 500;

const DAY_MS = 86_400_000;

export interface PsuPtyHostEventsIngestOptions {
  sql?: Sql;
  workspaceId?: string;
  /** Directory holding the per-owner `<owner>.events.jsonl` files. */
  dir?: string;
  rowRetentionDays?: number;
  fileRetentionDays?: number;
  maxFilesPerRun?: number;
  /** Report what would happen without inserting or deleting anything. */
  dryRun?: boolean;
  now?: () => number;
}

export interface PsuPtyHostEventsIngestResult {
  filesScanned: number;
  filesIngested: number;
  rowsRead: number;
  rowsInserted: number;
  /** Rows the file contained that could not be parsed, or lacked `ts`/`kind`. Never fatal. */
  rowsMalformed: number;
  filesDeleted: number;
  /** Files old enough to GC but NOT deleted because their ingest did not succeed. */
  filesRetainedUningested: number;
  rowsExpired: number;
  rowRetentionDays: number;
  fileRetentionDays: number;
  dryRun: boolean;
  /**
   * Files whose INSERT threw. Non-zero means rows were READ but NOT persisted — the state a
   * bare `catch {}` used to render indistinguishable from "there was nothing to ingest"
   * (measured 2026-09-22: 2,016 rows read, 0 inserted, no error surfaced anywhere).
   * `rowsRead > 0 && rowsInserted === 0 && ingestErrors > 0` is the signature of a total
   * write failure, and is what the routine's own health check should assert on.
   */
  ingestErrors: number;
  /** First INSERT failure of the run, for triage without trawling logs. */
  firstIngestError?: string;
  /**
   * Every `.events.jsonl` file present, NOT just the ones this run selected.
   *
   * `filesScanned` is a per-run budget, so on its own it reads as a total and a routine that
   * is structurally blind to most of its input looks healthy (`filesScanned: 500`, no error).
   * Reporting the population beside the sample is what makes a bounded measurement legible
   * as bounded — the same discipline the repo applies to any capped aggregate.
   */
  filesEligible: number;
  /** Eligible files this run did NOT select. Persistently non-zero ⇒ the budget is too small. */
  filesUnprocessed: number;
  /**
   * Files already past the GC cutoff that this run could not select. This is the directory's
   * unbounded-growth signal: it only falls when the drain outruns new arrivals.
   */
  gcBacklog: number;
}

/** Stable stringify so a digest does not change with JS key insertion order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Dedupe key for one event row.
 *
 * The tuple is JSON-encoded as an ARRAY rather than joined with a separator byte, deliberately.
 * A separator has to be a character that cannot occur in the parts, which pushes toward a
 * control byte such as NUL -- and a raw control byte in source is refused by
 * `lint:no-control-bytes` (a green-checkpoint leg), besides making the file unsearchable by
 * ripgrep and binary to `git diff`. JSON encoding makes the boundaries unambiguous with no
 * separator at all: ["a","bc"] and ["ab","c"] encode differently, so two distinct tuples
 * cannot collide into one digest.
 */
export function hostEventDigest(
  ownerId: string,
  ts: string,
  kind: string,
  payload: Record<string, unknown>,
): string {
  return createHash('sha256').update(canonical([ownerId, ts, kind, payload])).digest('hex');
}

/** `su-abc.events.jsonl` -> `su-abc`; anything else -> null (never guess an owner). */
export function ownerIdFromEventLogFilename(filename: string): string | null {
  const m = /^(.+)\.events\.jsonl$/.exec(filename);
  return m && m[1] ? m[1] : null;
}

interface ParsedRows {
  rows: Array<{
    workspace_id: string;
    owner_id: string;
    ts: string;
    kind: string;
    payload: Record<string, unknown>;
    row_digest: string;
  }>;
  malformed: number;
}

export function parseHostEventFile(
  workspaceId: string,
  ownerId: string,
  text: string,
): ParsedRows {
  const rows: ParsedRows['rows'] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Expected, not exceptional: the file is front-truncated mid-line when it exceeds its
      // size cap, so the FIRST line after a truncation is routinely a partial record. Count it
      // and move on -- refusing the whole file over one severed line would discard the other
      // ~thousand good rows in it.
      malformed++;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformed++;
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    const ts = typeof rec.ts === 'string' ? rec.ts : null;
    const kind = typeof rec.kind === 'string' ? rec.kind : null;
    if (!ts || !kind || Number.isNaN(Date.parse(ts))) {
      malformed++;
      continue;
    }
    const payload: Record<string, unknown> = { ...rec };
    delete payload.ts;
    delete payload.kind;
    rows.push({
      workspace_id: workspaceId,
      owner_id: ownerId,
      ts,
      kind,
      payload,
      row_digest: hostEventDigest(ownerId, ts, kind, payload),
    });
  }
  return { rows, malformed };
}

export function defaultHostEventDir(): string {
  return process.env.PAPERCUSP_PSU_PTY_DIR || join(homedir(), '.papercusp', 'psu-pty');
}

export async function ingestPsuPtyHostEvents(
  opts: PsuPtyHostEventsIngestOptions = {},
): Promise<PsuPtyHostEventsIngestResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const dir = opts.dir ?? defaultHostEventDir();
  const now = opts.now ?? Date.now;
  const dryRun = opts.dryRun === true;

  const rowRetentionDays =
    Number.isFinite(opts.rowRetentionDays) && (opts.rowRetentionDays as number) > 0
      ? (opts.rowRetentionDays as number)
      : HOST_EVENT_ROW_RETENTION_DAYS_DEFAULT;
  const fileRetentionDays =
    Number.isFinite(opts.fileRetentionDays) && (opts.fileRetentionDays as number) > 0
      ? (opts.fileRetentionDays as number)
      : HOST_EVENT_FILE_RETENTION_DAYS_DEFAULT;
  const maxFilesPerRun =
    Number.isFinite(opts.maxFilesPerRun) && (opts.maxFilesPerRun as number) > 0
      ? (opts.maxFilesPerRun as number)
      : HOST_EVENT_MAX_FILES_PER_RUN_DEFAULT;

  const result: PsuPtyHostEventsIngestResult = {
    filesScanned: 0,
    filesIngested: 0,
    rowsRead: 0,
    rowsInserted: 0,
    ingestErrors: 0,
    rowsMalformed: 0,
    filesDeleted: 0,
    filesRetainedUningested: 0,
    rowsExpired: 0,
    rowRetentionDays,
    fileRetentionDays,
    dryRun,
    filesEligible: 0,
    filesUnprocessed: 0,
    gcBacklog: 0,
  };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No directory yet (a box that has never run a psu session) is a no-op, not a failure.
    return result;
  }

  const fileGcCutoff = now() - fileRetentionDays * DAY_MS;

  // ⚠ SELECTION IS BY MTIME, NEVER BY READDIR ORDER. This used to be
  // `entries.filter(...).slice(0, maxFilesPerRun)` — an UNSORTED prefix of readdir, which is
  // stable for an unchanging directory. The consequence, measured 2026-09-22: of 15,040
  // eligible files the routine processed the SAME arbitrary 500 every run (3.3%) and could
  // never reach the other 14,540 — including every file written that day. It reported
  // filesScanned:500 and looked perfectly healthy while the table sat frozen at 2,028 rows
  // for 92 minutes across multiple fires. The GC below is inside this same loop, so it was
  // trapped in the same window: that is WHY the directory had grown to 15,040 files. One
  // root cause, two symptoms — a stalled data plane and an unbounded population.
  const eligible = entries.filter((e) => e.endsWith('.events.jsonl'));
  result.filesEligible = eligible.length;

  const stated: Array<{ filename: string; mtimeMs: number }> = [];
  for (const filename of eligible) {
    try {
      stated.push({ filename, mtimeMs: (await stat(join(dir, filename))).mtimeMs });
    } catch {
      // Raced with the owning host (rotation/cleanup). Not selectable this run.
    }
  }

  const byNewest = [...stated].sort((a, b) => b.mtimeMs - a.mtimeMs);
  // A file may only be GC'd AFTER a successful ingest (the retained-uningested invariant
  // below), so draining the backlog requires SELECTING those files. A newest-only window
  // would keep telemetry fresh and still let the directory grow without bound, so the
  // budget is split: freshest first, then the oldest GC-eligible files, then more fresh.
  const gcDrain = stated
    .filter((f) => f.mtimeMs < fileGcCutoff)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const selected = new Set<string>();
  const take = (list: Array<{ filename: string }>, budget: number) => {
    for (const f of list) {
      if (selected.size >= budget) break;
      selected.add(f.filename);
    }
  };
  take(byNewest, Math.max(1, Math.ceil(maxFilesPerRun / 2)));
  take(gcDrain, maxFilesPerRun);
  take(byNewest, maxFilesPerRun);

  const candidates = [...selected];
  result.filesUnprocessed = Math.max(0, stated.length - candidates.length);
  result.gcBacklog = gcDrain.filter((f) => !selected.has(f.filename)).length;

  for (const filename of candidates) {
    const ownerId = ownerIdFromEventLogFilename(filename);
    if (!ownerId) continue;
    const path = join(dir, filename);
    result.filesScanned++;

    let text: string;
    let mtimeMs: number;
    try {
      const st = await stat(path);
      mtimeMs = st.mtimeMs;
      text = await readFile(path, 'utf8');
    } catch {
      // Raced with the owning host (rotation, or the session ended and cleaned up). Skip.
      continue;
    }

    const { rows, malformed } = parseHostEventFile(ws, ownerId, text);
    result.rowsRead += rows.length;
    result.rowsMalformed += malformed;

    let ingested = false;
    if (rows.length === 0) {
      // An empty/unparseable file has nothing to lose, so it is safe to let GC consider it.
      ingested = true;
    } else if (dryRun) {
      ingested = true;
    } else {
      try {
        // Chunked so one enormous file cannot build a single oversized statement.
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          // JSONB BINDING ON THIS CLIENT IS A FOOTGUN WITH TWO OPPOSITE WRONG ANSWERS, so it
          // is spelled out rather than left for the next reader to rediscover:
          //   - sql.json() THROWS on the getOrgPg client ("Buffer.byteLength received Object",
          //     EI-607 / agent-insights/postgres-js-jsonb-binding); and
          //   - on the default-config db() pool the opposite holds -- JSON.stringify there
          //     DOUBLE-ENCODES, storing a jsonb STRING that reads back as a string.
          // This is the getOrgPg client, so it needs the explicit stringify + ::jsonb cast.
          //
          // The multi-row `sql(rows, ...cols)` helper has nowhere to put a per-column cast,
          // which is also why it does not typecheck here (TS2769: a Record<string, unknown>
          // is not a bindable parameter). UNNEST of one array per column keeps it to a single
          // statement per chunk AND makes every column's type explicit at the boundary.
          //
          // ⚠ `ts` IS BOUND AS text[] AND CAST PER-COLUMN, NOT AS ::timestamptz[]. Binding a
          // string[] to ::timestamptz[] THROWS on this client — `TypeError
          // ERR_INVALID_ARG_TYPE: The "string" argument must be of type string or an instance
          // of Buffer or ArrayBuffer. Received an instance of Array` — and it is the ONLY
          // column that does: text[] and jsonb[] both bind fine, and Date[] fails too
          // (42846 `cannot cast type timestamp with time zone to timestamp with time zone[]`).
          // Measured 2026-09-22 by bisecting each column type; the comment above had
          // anticipated a jsonb footgun that does not actually fire here, while this one did,
          // silently, on EVERY row (2,016 read / 0 inserted, table empty for a full day).
          const inserted = await sql`
            INSERT INTO harness_shared.psu_pty_host_events
                        (workspace_id, owner_id, ts, kind, payload, row_digest)
                 SELECT w, o, t::timestamptz, k, p, d
                   FROM unnest(
                          ${chunk.map((r) => r.workspace_id)}::text[],
                          ${chunk.map((r) => r.owner_id)}::text[],
                          ${chunk.map((r) => r.ts)}::text[],
                          ${chunk.map((r) => r.kind)}::text[],
                          ${chunk.map((r) => JSON.stringify(r.payload))}::jsonb[],
                          ${chunk.map((r) => r.row_digest)}::text[]
                        ) AS u(w, o, t, k, p, d)
            ON CONFLICT (row_digest) DO NOTHING
          `;
          result.rowsInserted += inserted.count ?? 0;
        }
        ingested = true;
      } catch (err) {
        // Leave the file alone. An un-ingested file MUST NOT be GC'd below.
        ingested = false;
        // ⚠ NEVER SWALLOW THIS. A bare `catch {}` here is what let a 100%-failing INSERT look
        // exactly like "there was nothing to ingest": the routine reported rowsInserted:0 with
        // no error anywhere, the table stayed empty, and P-007 read as shipped for a full day.
        // The retained-file counter below records that the population is knowingly unbounded,
        // but only this message says WHY, which is the difference between a visible failure
        // and an invisible one.
        result.ingestErrors++;
        if (!result.firstIngestError) {
          result.firstIngestError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
        console.error(
          `[psu-pty-host-events-ingest] INSERT failed for ${ownerId} (${rows.length} row(s) left on disk): ` +
            `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        );
      }
    }
    if (ingested) result.filesIngested++;

    if (mtimeMs < fileGcCutoff) {
      if (!ingested) {
        result.filesRetainedUningested++;
      } else if (!dryRun) {
        try {
          await unlink(path);
          result.filesDeleted++;
        } catch {
          /* another sweep or the host removed it first */
        }
      } else {
        result.filesDeleted++;
      }
    }
  }

  if (!dryRun) {
    const expired = await sql`
      DELETE FROM harness_shared.psu_pty_host_events
       WHERE workspace_id = ${ws}
         AND ts < now() - ${`${rowRetentionDays} days`}::interval
    `;
    result.rowsExpired = expired.count ?? 0;
  }

  return result;
}
