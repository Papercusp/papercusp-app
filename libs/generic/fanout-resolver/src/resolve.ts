/**
 * Resolve a fan-out spec to its item-set by running its resolver.
 *
 * Pure + injected: the `glob` / `sql` runners are supplied by the caller, so the
 * resolver stays unit-testable and names no host (a repo, a database). An
 * `items` spec needs no runner; a `deferred` spec throws (it is resolved later,
 * by the host, not here).
 */
import {
  DEFAULT_FANOUT_CAP,
  FanoutCapError,
  FanoutResolverError,
  type FanoutSpec,
} from './types';

export interface ResolveFanoutCtx {
  /** Run a glob, returning matching paths. Injected by the host. */
  runGlob?: (pattern: string) => Promise<string[]>;
  /** Run a query, returning the first column of each row as a string. Injected. */
  runSql?: (sql: string) => Promise<string[]>;
  /** Fan-out cap (default `DEFAULT_FANOUT_CAP`). */
  cap?: number;
}

/** Trim, drop empties, and dedupe (insertion order preserved). */
export function dedupeTrim(raw: readonly string[]): string[] {
  return [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
}

/**
 * Resolve a fan-out spec to its deduped, trimmed, non-empty item-set. Throws
 * `FanoutCapError` over the cap and `FanoutResolverError` on any resolver failure
 * (including a `deferred` spec, or a glob/sql spec with no runner) — both signal
 * "escalate", never silent truncation or a silent zero.
 */
export async function resolveFanout(spec: FanoutSpec, ctx: ResolveFanoutCtx = {}): Promise<string[]> {
  const cap = ctx.cap ?? DEFAULT_FANOUT_CAP;
  let raw: string[];
  try {
    if ('deferred' in spec) {
      throw new FanoutResolverError(
        `fan-out spec is deferred (${spec.deferred}) — its item-set is produced by an upstream ` +
          `producer at completion time, not resolvable now`,
      );
    }
    if ('items' in spec) {
      raw = spec.items;
    } else if ('glob' in spec) {
      if (!ctx.runGlob) throw new FanoutResolverError('glob spec needs a glob runner');
      raw = await ctx.runGlob(spec.glob);
    } else if ('sql' in spec) {
      if (!ctx.runSql) throw new FanoutResolverError('sql spec needs a query runner');
      raw = await ctx.runSql(spec.sql);
    } else {
      throw new FanoutResolverError('unknown fan-out spec (expected items/glob/sql)');
    }
  } catch (e) {
    if (e instanceof FanoutResolverError) throw e;
    throw new FanoutResolverError(`fan-out resolver failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const items = dedupeTrim(raw);
  if (items.length > cap) throw new FanoutCapError(items.length, cap);
  return items;
}
