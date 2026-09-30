/**
 * fs-log.ts — FsCoordLog: the filesystem CoordEventLog, the portable
 * default that lets a detached agent (no operator, no PG) participate by
 * direct fs reads/writes (the v2 plan's portability goal, D-004).
 *
 * Layout under the resolved coord dir (unchanged from the operator's
 * original modules so existing on-disk data + PAPERCUSP_COORD_DIR tests
 * keep working):
 *
 *   messages/<ownerId>.jsonl        per-sender outbox (append)
 *   handoffs/<msg_id>.json          one immutable file per handoff event
 *   escalations/<msg_id>.json       one immutable file per escalation event
 *   plan-events-<YYYY-MM>.jsonl     monthly-rotated single stream
 *   plan-events.jsonl               pre-rotation legacy file (still read)
 *
 * The coord-dir resolver is injected so the host owns repo-root / env
 * resolution; the package carries no `process.cwd()` policy.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoordEnvelope } from '../core/envelope';
import type {
  AppendLineIfAbsentResult,
  CoordEventLog,
  CoordLogCursorPage,
  EventSurface,
  LineSurface,
  ReadLinesOpts,
} from './types';

export interface FsCoordLogOptions {
  /** Resolve the coord/ directory (the host owns env/repo-root policy). */
  coordDir: () => string;
}

const PLAN_EVENTS_MONTHLY_RE = /^plan-events-\d{4}-\d{2}\.jsonl$/;

function sanitise(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function appendJsonl(filepath: string, envelope: CoordEnvelope): Promise<void> {
  await fs.mkdir(dirname(filepath), { recursive: true });
  await fs.appendFile(filepath, JSON.stringify(envelope) + '\n', 'utf8');
}

const LINE_LOCK_RETRY_MS = 10;
const LINE_LOCK_ATTEMPTS = 600;
const LINE_LOCK_STALE_MS = 60_000;

async function readJsonl(filepath: string): Promise<CoordEnvelope[]> {
  let buf: string;
  try {
    buf = await fs.readFile(filepath, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const out: CoordEnvelope[] = [];
  for (const ln of buf.split('\n')) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') out.push(obj as CoordEnvelope);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export class FsCoordLog implements CoordEventLog {
  constructor(private readonly opts: FsCoordLogOptions) {}

  private root(): string {
    return this.opts.coordDir();
  }

  private lineDir(surface: LineSurface): string {
    // 'messages' has a subdir; 'plan-events' lives at the coord root.
    return surface === 'messages' ? join(this.root(), 'messages') : this.root();
  }

  private eventDir(surface: EventSurface): string {
    return join(this.root(), surface);
  }

  private planEventsFile(date: Date = new Date()): string {
    const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    return join(this.root(), `plan-events-${ym}.jsonl`);
  }

  private lineLockFile(surface: LineSurface, msgId: string): string {
    return join(this.root(), '.line-locks', surface, `${sanitise(msgId)}.lock`);
  }

  /** Serialize idempotent line claims across processes sharing the coord dir. */
  private async withLineLock<T>(surface: LineSurface, msgId: string, fn: () => Promise<T>): Promise<T> {
    const filepath = this.lineLockFile(surface, msgId);
    await fs.mkdir(dirname(filepath), { recursive: true });
    for (let attempt = 0; attempt < LINE_LOCK_ATTEMPTS; attempt += 1) {
      try {
        const handle = await fs.open(filepath, 'wx');
        try {
          return await fn();
        } finally {
          await handle.close().catch(() => {});
          await fs.rm(filepath, { force: true }).catch(() => {});
        }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
        // A crashed writer must not strand every future replay forever. Only
        // reclaim a lock whose mtime is well beyond the normal critical section.
        try {
          const stat = await fs.stat(filepath);
          if (Date.now() - stat.mtimeMs > LINE_LOCK_STALE_MS) {
            await fs.rm(filepath, { force: true });
            continue;
          }
        } catch (statError: unknown) {
          if ((statError as NodeJS.ErrnoException)?.code !== 'ENOENT') throw statError;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, LINE_LOCK_RETRY_MS));
      }
    }
    throw new Error(`coord line claim lock timed out for ${surface}/${msgId}`);
  }

  private async appendLineUnlocked(
    surface: LineSurface,
    writerKey: string,
    line: CoordEnvelope,
  ): Promise<number | null> {
    if (surface === 'messages') {
      await appendJsonl(join(this.lineDir('messages'), `${sanitise(writerKey)}.jsonl`), line);
    } else {
      // plan-events: writerKey ignored; rotate by current month.
      await appendJsonl(this.planEventsFile(), line);
    }
    return null;
  }

  /** All plan-events files oldest→newest: legacy first, then monthly. */
  private async planEventsFiles(): Promise<string[]> {
    const dir = this.root();
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw e;
    }
    const out: string[] = [];
    if (entries.includes('plan-events.jsonl')) out.push(join(dir, 'plan-events.jsonl'));
    for (const f of entries.filter((x) => PLAN_EVENTS_MONTHLY_RE.test(x)).sort()) {
      out.push(join(dir, f));
    }
    return out;
  }

  async appendLine(
    surface: LineSurface,
    writerKey: string,
    line: CoordEnvelope,
  ): Promise<number | null> {
    await this.withLineLock(surface, line.msg_id, () => this.appendLineUnlocked(surface, writerKey, line));
    // JSONL-per-writer mints no cross-stream sequence number: a byte offset is
    // not stable across rotation and a line index is per-file, so neither can
    // name this record globally. Null per the contract — the append succeeded.
    return null;
  }

  async appendLineIfAbsent(
    surface: LineSurface,
    writerKey: string,
    line: CoordEnvelope,
  ): Promise<AppendLineIfAbsentResult> {
    return this.withLineLock(surface, line.msg_id, async () => {
      const existing = (await this.readLines(surface)).find((candidate) => candidate.msg_id === line.msg_id);
      if (existing) return { created: false, sequence: null, envelope: existing };
      await this.appendLineUnlocked(surface, writerKey, line);
      return { created: true, sequence: null, envelope: line };
    });
  }

  async readLines(surface: LineSurface, opts: ReadLinesOpts = {}): Promise<CoordEnvelope[]> {
    if (surface === 'messages') {
      const dir = this.lineDir('messages');
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
        throw e;
      }
      const out: CoordEnvelope[] = [];
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        out.push(...(await readJsonl(join(dir, f))));
      }
      return out;
    }
    // plan-events
    const allFiles = await this.planEventsFiles();
    const files =
      typeof opts.filesBack === 'number' && opts.filesBack > 0
        ? allFiles.slice(-opts.filesBack)
        : allFiles;
    const out: CoordEnvelope[] = [];
    for (const f of files) out.push(...(await readJsonl(f)));
    return out;
  }

  async putEvent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<void> {
    const file = join(this.eventDir(surface), `${sanitise(msgId)}.json`);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
  }

  /**
   * `wx` = create-or-fail, which the kernel makes atomic — so this is a real claim
   * even across processes sharing the directory, not a check-then-write that races.
   */
  async putEventIfAbsent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<boolean> {
    const file = join(this.eventDir(surface), `${sanitise(msgId)}.json`);
    await fs.mkdir(dirname(file), { recursive: true });
    try {
      await fs.writeFile(file, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
      throw e;
    }
  }

  async putEvents(
    surface: EventSurface,
    records: ReadonlyArray<{ msgId: string; record: CoordEnvelope }>,
  ): Promise<void> {
    // No fs batch primitive — one file per record, same as putEvent. Semantically
    // equal to N putEvent calls; the PG backend is where the batch collapses to a
    // single multi-row INSERT. An empty array no-ops.
    for (const { msgId, record } of records) {
      await this.putEvent(surface, msgId, record);
    }
  }

  async readEvents(surface: EventSurface): Promise<CoordEnvelope[]> {
    const dir = this.eventDir(surface);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw e;
    }
    const out: CoordEnvelope[] = [];
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const buf = await fs.readFile(join(dir, f), 'utf8');
        const rec = JSON.parse(buf);
        if (rec && typeof rec === 'object') out.push(rec as CoordEnvelope);
      } catch {
        // skip malformed files
      }
    }
    return out;
  }

  async readEventsBounded(
    surface: EventSurface,
    opts: { limit: number; kinds?: string[] },
  ): Promise<CoordEnvelope[]> {
    // Fs stores one file per event with no append-order column, so approximate
    // NEWEST-FIRST by the envelope `ts` (creation time ≈ append order), tie-broken
    // by msg_id for a stable order. (PG/InMemory have true append order; this is
    // the portable best-effort — EI-1548.) Reads the dir once, then bounds.
    const all = await this.readEvents(surface);
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const filtered = kinds && kinds.length ? all.filter((r) => kinds.includes(r.kind)) : all;
    filtered.sort((a, b) => {
      const byTs = String(b.ts ?? '').localeCompare(String(a.ts ?? ''));
      return byTs !== 0 ? byTs : String(b.msg_id ?? '').localeCompare(String(a.msg_id ?? ''));
    });
    const limit = Math.max(1, Math.floor(opts.limit) || 1);
    return filtered.slice(0, limit);
  }

  async readLinesBounded(
    surface: LineSurface,
    opts: { limit: number; sinceTs?: string; planSlug?: string; kinds?: string[] },
  ): Promise<CoordEnvelope[]> {
    // Lines have true append order (jsonl), so read the surface then bound to the
    // newest N. The fs backend is dev/test only; production is PgCoordLog (the SQL
    // pushdown). filesBack is subsumed by the newest-N bound.
    const all = await this.readLines(surface);
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const filtered = all.filter(
      (r) =>
        (!kinds || !kinds.length || kinds.includes(r.kind)) &&
        (!opts.sinceTs || (typeof r.ts === 'string' && r.ts > opts.sinceTs)) &&
        (!opts.planSlug || r.plan_slug === opts.planSlug),
    );
    const limit = Math.max(1, Math.floor(opts.limit) || 1);
    return filtered.slice(-limit).reverse();
  }

  async getEvent(surface: EventSurface, msgId: string): Promise<CoordEnvelope | null> {
    const file = join(this.eventDir(surface), `${sanitise(msgId)}.json`);
    try {
      const buf = await fs.readFile(file, 'utf8');
      const rec = JSON.parse(buf);
      return rec && typeof rec === 'object' ? (rec as CoordEnvelope) : null;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * WI-3880: fs has no real append-order column (one file per event; jsonl
   * has no row id), so the "id" here is SYNTHESIZED per call from a stable
   * full-surface ordering (oldest→newest, position 1..N) — the same
   * ts+msg_id tie-break `readEventsBounded` already uses to approximate
   * append order. It is assigned over the FULL unfiltered surface (not the
   * post-`kinds`-filter subset) so a row's id does not depend on which kind
   * filter a given call happens to pass, keeping a cursor obtained from one
   * call valid across others. Existing rows keep a stable id across calls as
   * long as new writes only ever sort AFTER them (true for ts-ordered
   * appends); this is the documented portable best-effort — production reads
   * go through PgCoordLog, which has a true persistent bigserial id.
   */
  async readEventsBoundedCursor(
    surface: EventSurface,
    opts: { limit: number; kinds?: string[]; beforeId?: number },
  ): Promise<CoordLogCursorPage> {
    const fullAll = await this.readEvents(surface);
    const ordered = [...fullAll].sort((a, b) => {
      const byTs = String(a.ts ?? '').localeCompare(String(b.ts ?? ''));
      return byTs !== 0 ? byTs : String(a.msg_id ?? '').localeCompare(String(b.msg_id ?? ''));
    });
    const withIds = ordered.map((envelope, idx) => ({ id: idx + 1, envelope }));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    let candidates = kinds && kinds.length ? withIds.filter((r) => kinds.includes(r.envelope.kind)) : withIds;
    if (typeof opts.beforeId === 'number') candidates = candidates.filter((r) => r.id < opts.beforeId!);
    candidates = [...candidates].reverse(); // newest-first (highest id first)
    const limit = Math.max(1, Math.floor(opts.limit) || 1);
    return {
      rows: candidates.slice(0, limit),
      exhausted: candidates.length <= limit,
    };
  }

  /** The line-surface sibling — lines already have true fs append order
   *  (jsonl), so the synthesized id is just each line's position in that
   *  order (see the caveat on `readLines`'s `messages` union above: id
   *  stability across calls inherits whatever ordering guarantee that read
   *  already has). */
  async readLinesBoundedCursor(
    surface: LineSurface,
    opts: { limit: number; sinceTs?: string; planSlug?: string; kinds?: string[]; beforeId?: number },
  ): Promise<CoordLogCursorPage> {
    const fullAll = await this.readLines(surface);
    const withIds = fullAll.map((envelope, idx) => ({ id: idx + 1, envelope }));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    let candidates = withIds.filter(
      (r) =>
        (!kinds || !kinds.length || kinds.includes(r.envelope.kind)) &&
        (!opts.sinceTs || (typeof r.envelope.ts === 'string' && r.envelope.ts > opts.sinceTs)) &&
        (!opts.planSlug || r.envelope.plan_slug === opts.planSlug) &&
        (typeof opts.beforeId !== 'number' || r.id < opts.beforeId),
    );
    candidates = [...candidates].reverse(); // newest-first
    const limit = Math.max(1, Math.floor(opts.limit) || 1);
    return {
      rows: candidates.slice(0, limit),
      exhausted: candidates.length <= limit,
    };
  }
}
