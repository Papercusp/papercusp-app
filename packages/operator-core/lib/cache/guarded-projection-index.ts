/**
 * GuardedProjectionIndex — a fail-soft wrapper around the generic
 * `ProjectionIndex.applyChange` (caching-layer-tag-eca-2026-06-22 P-016).
 *
 * WHY: `@papercusp/projection-index` is a PURE algorithm — its `applyChange` /
 * `index` correctly THROW on a bad source record (a projector that throws, a
 * duplicate-contribution delta, a transient store error). That is right for the
 * lib (a pure core must surface errors, not swallow them). But on the LIVE
 * event-reaction path a single poison record would otherwise crash the whole
 * maintenance loop and stall every subsequent projection — the audit's "UNGUARDED
 * projector" finding.
 *
 * The durable fix is a guard at the CONSUMER boundary (here), not a swallow inside
 * the pure lib: wrap each `applyChange` in try/catch, route the error to an
 * injectable sink, and keep the loop alive. One bad record is skipped + reported;
 * the index stays consistent for every other source. `index` / `remove` get the
 * same treatment so every entry point is covered.
 */

import { ProjectionIndex, type ChangeEvent } from '@papercusp/projection-index';

/** Where a swallowed projection error is reported. Default: console.error. */
export type ProjectionErrorSink = (err: unknown, ctx: { op: string; sourceId: string }) => void;

const defaultSink: ProjectionErrorSink = (err, ctx) => {
   
  console.error(`[projection-index] ${ctx.op} failed for source ${ctx.sourceId}; skipping record`, err);
};

export interface GuardedProjectionIndexOptions {
  /** Error sink for a poison record. Default logs to console.error. */
  onError?: ProjectionErrorSink;
}

/**
 * Wraps a `ProjectionIndex` so a single bad source record is skipped + reported
 * instead of crashing the maintenance loop. Each guarded method returns `true` on
 * success and `false` when the record was skipped, so a batch driver can meter how
 * many records it dropped.
 */
export class GuardedProjectionIndex<S, E> {
  private readonly inner: ProjectionIndex<S, E>;
  private readonly onError: ProjectionErrorSink;

  constructor(inner: ProjectionIndex<S, E>, opts: GuardedProjectionIndexOptions = {}) {
    this.inner = inner;
    this.onError = opts.onError ?? defaultSink;
  }

  /** Guarded {@link ProjectionIndex.applyChange}. Returns false if the record was skipped. */
  async applyChange(event: ChangeEvent<S>): Promise<boolean> {
    try {
      await this.inner.applyChange(event);
      return true;
    } catch (err) {
      this.onError(err, { op: 'applyChange', sourceId: event.sourceId });
      return false;
    }
  }

  /** Guarded {@link ProjectionIndex.index}. Returns false if the record was skipped. */
  async index(sourceId: string, record: S): Promise<boolean> {
    try {
      await this.inner.index(sourceId, record);
      return true;
    } catch (err) {
      this.onError(err, { op: 'index', sourceId });
      return false;
    }
  }

  /** Guarded {@link ProjectionIndex.remove}. Returns false if the removal failed. */
  async remove(sourceId: string): Promise<boolean> {
    try {
      await this.inner.remove(sourceId);
      return true;
    } catch (err) {
      this.onError(err, { op: 'remove', sourceId });
      return false;
    }
  }

  /** Reads never need guarding (they don't mutate) — pass straight through. */
  query(...args: Parameters<ProjectionIndex<S, E>['query']>): ReturnType<ProjectionIndex<S, E>['query']> {
    return this.inner.query(...args);
  }
}
