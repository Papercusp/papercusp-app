/**
 * memory-log.ts — InMemoryCoordLog: the test double + the proof that
 * CoordEventLog is genuinely swappable. Passes the same conformance
 * suite as FsCoordLog (the P-050 gate).
 *
 * It does not model per-writer files or time rotation — those are
 * fs-specific concerns. It just stores lines per line-surface and
 * records per (event-surface, msg_id), which is all the contract
 * requires.
 */

import type { CoordEnvelope } from '../core/envelope';
import type {
  AppendLineIfAbsentResult,
  CoordEventLog,
  CoordLogCursorPage,
  EventSurface,
  LineSurface,
} from './types';

/** An envelope tagged with its (synthetic, monotonic) append-order id — see
 *  `nextSeq`. Kept internal: `readLines`/`readEvents`/`readEventsBounded`/
 *  `readLinesBounded` still return bare `CoordEnvelope[]` (unchanged contract);
 *  only the new `*BoundedCursor` reads expose the id. */
interface Seq {
  id: number;
  envelope: CoordEnvelope;
}

export class InMemoryCoordLog implements CoordEventLog {
  private lines = new Map<LineSurface, Seq[]>();
  private lineByMsgId = new Map<LineSurface, Map<string, Seq>>();
  private events = new Map<EventSurface, Map<string, Seq>>();
  // WI-3880: one monotonic counter across every surface/kind, assigned at
  // first-write time — the true, stable append-order cursor for this backend
  // (a re-put of an existing event msg_id keeps its ORIGINAL id, mirroring
  // PgCoordLog's ON CONFLICT upsert, which never changes the row's bigserial id).
  private seq = 0;
  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  async appendLine(
    surface: LineSurface,
    _writerKey: string,
    line: CoordEnvelope,
  ): Promise<number | null> {
    const arr = this.lines.get(surface) ?? [];
    // This store DOES mint a monotonic sequence, so it can answer the contract's
    // "point AT this record" question rather than degrading to null.
    const id = this.nextSeq();
    const row = { id, envelope: line };
    arr.push(row);
    this.lines.set(surface, arr);
    const byMsgId = this.lineByMsgId.get(surface) ?? new Map<string, Seq>();
    // Keep the first row for replay lookup while preserving appendLine's
    // historical behavior of allowing deliberate duplicate appends.
    if (!byMsgId.has(line.msg_id)) byMsgId.set(line.msg_id, row);
    this.lineByMsgId.set(surface, byMsgId);
    return id;
  }

  async appendLineIfAbsent(
    surface: LineSurface,
    writerKey: string,
    line: CoordEnvelope,
  ): Promise<AppendLineIfAbsentResult> {
    const byMsgId = this.lineByMsgId.get(surface) ?? new Map<string, Seq>();
    const existing = byMsgId.get(line.msg_id);
    if (existing) {
      return { created: false, sequence: existing.id, envelope: existing.envelope };
    }
    const sequence = await this.appendLine(surface, writerKey, line);
    return { created: true, sequence, envelope: line };
  }

  async readLines(surface: LineSurface): Promise<CoordEnvelope[]> {
    return (this.lines.get(surface) ?? []).map((r) => r.envelope);
  }

  async putEvent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<void> {
    const m = this.events.get(surface) ?? new Map<string, Seq>();
    const existing = m.get(msgId);
    m.set(msgId, { id: existing?.id ?? this.nextSeq(), envelope: record });
    this.events.set(surface, m);
  }

  /** Atomic by construction: single-threaded, in-process, no await between check and set. */
  async putEventIfAbsent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<boolean> {
    const m = this.events.get(surface) ?? new Map<string, Seq>();
    if (m.has(msgId)) return false;
    m.set(msgId, { id: this.nextSeq(), envelope: record });
    this.events.set(surface, m);
    return true;
  }

  async putEvents(
    surface: EventSurface,
    records: ReadonlyArray<{ msgId: string; record: CoordEnvelope }>,
  ): Promise<void> {
    if (records.length === 0) return;
    const m = this.events.get(surface) ?? new Map<string, Seq>();
    for (const { msgId, record } of records) {
      const existing = m.get(msgId);
      m.set(msgId, { id: existing?.id ?? this.nextSeq(), envelope: record });
    }
    this.events.set(surface, m);
  }

  async readEvents(surface: EventSurface): Promise<CoordEnvelope[]> {
    return [...(this.events.get(surface)?.values() ?? [])].map((r) => r.envelope);
  }

  async readEventsBounded(
    surface: EventSurface,
    opts: { limit: number; kinds?: string[] },
  ): Promise<CoordEnvelope[]> {
    const all = [...(this.events.get(surface)?.values() ?? [])].map((r) => r.envelope);
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const filtered = kinds && kinds.length ? all.filter((r) => kinds.includes(r.kind)) : all;
    // Newest-first (insertion order = append order), bounded — mirrors PgCoordLog.
    const limit = Math.max(1, Math.floor(opts.limit) || 1);
    return filtered.reverse().slice(0, limit);
  }

  async readLinesBounded(
    surface: LineSurface,
    opts: { limit: number; sinceTs?: string; planSlug?: string; kinds?: string[] },
  ): Promise<CoordEnvelope[]> {
    const all = (this.lines.get(surface) ?? []).map((r) => r.envelope);
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const filtered = all.filter(
      (r) =>
        (!kinds || !kinds.length || kinds.includes(r.kind)) &&
        (!opts.sinceTs || (typeof r.ts === 'string' && r.ts > opts.sinceTs)) &&
        (!opts.planSlug || r.plan_slug === opts.planSlug),
    );
    // Newest-first (insertion order = append order), bounded — mirrors PgCoordLog.
    const limit = Math.max(1, Math.floor(opts.limit) || 1);
    return filtered.slice(-limit).reverse();
  }

  async getEvent(surface: EventSurface, msgId: string): Promise<CoordEnvelope | null> {
    return this.events.get(surface)?.get(msgId)?.envelope ?? null;
  }

  async readEventsBoundedCursor(
    surface: EventSurface,
    opts: { limit: number; kinds?: string[]; beforeId?: number; beforeTs?: string; beforeMsgId?: string },
  ): Promise<CoordLogCursorPage> {
    const all = [...(this.events.get(surface)?.values() ?? [])];
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const beforeMs = opts.beforeTs ? Date.parse(opts.beforeTs) : null;
    let candidates = kinds && kinds.length ? all.filter((r) => kinds.includes(r.envelope.kind)) : all;
    if (beforeMs !== null) {
      candidates = candidates.filter((r) => {
        const ts = Date.parse(r.envelope.ts);
        return Number.isFinite(beforeMs) && Number.isFinite(ts) && (opts.beforeMsgId ? ts <= beforeMs : ts < beforeMs);
      });
    }
    if (typeof opts.beforeId === 'number') candidates = candidates.filter((r) => r.id < opts.beforeId!);
    candidates = [...candidates].sort((a, b) => b.id - a.id); // newest-first
    const limit = Math.max(1, Math.floor(opts.limit) || 1);
    return {
      rows: candidates.slice(0, limit),
      exhausted: candidates.length <= limit,
    };
  }

  async readLinesBoundedCursor(
    surface: LineSurface,
    opts: {
      limit: number;
      sinceTs?: string;
      planSlug?: string;
      kinds?: string[];
      beforeId?: number;
      beforeTs?: string;
      beforeMsgId?: string;
    },
  ): Promise<CoordLogCursorPage> {
    const all = this.lines.get(surface) ?? [];
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const beforeMs = opts.beforeTs ? Date.parse(opts.beforeTs) : null;
    let candidates = all.filter(
      (r) =>
        (!kinds || !kinds.length || kinds.includes(r.envelope.kind)) &&
        (!opts.sinceTs || (typeof r.envelope.ts === 'string' && r.envelope.ts > opts.sinceTs)) &&
        (!opts.planSlug || r.envelope.plan_slug === opts.planSlug) &&
        (beforeMs === null ||
          (Number.isFinite(beforeMs) &&
            Number.isFinite(Date.parse(r.envelope.ts)) &&
            (opts.beforeMsgId ? Date.parse(r.envelope.ts) <= beforeMs : Date.parse(r.envelope.ts) < beforeMs))) &&
        (typeof opts.beforeId !== 'number' || r.id < opts.beforeId),
    );
    candidates = [...candidates].sort((a, b) => b.id - a.id); // newest-first
    const limit = Math.max(1, Math.floor(opts.limit) || 1);
    return {
      rows: candidates.slice(0, limit),
      exhausted: candidates.length <= limit,
    };
  }
}
