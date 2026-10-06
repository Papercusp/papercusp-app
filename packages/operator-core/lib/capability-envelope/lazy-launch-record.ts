/**
 * The identity launch record WITHOUT its body — a header plus a loader.
 *
 * WI-10002721. Every kernel preflight used to select the owner's newest
 * `adv_sessions.launch_spec` in full (measured 2026-09-23 on live rows: avg
 * 884KB of text, max 3.9MB) and JSON-parse it on the operator main thread,
 * although `identityResolutionCache` (c260681b19) answers a repeat preflight
 * from `(row id, xmin)` plus two top-level fields. The hot read now carries only
 * those fields; the body is fetched through {@link LazyIdentityLaunchRecord.load}
 * when the cache MISSES.
 *
 * Dependency-free on purpose, for the same reason as `recovery-door.ts`:
 * `projected-tool-deps.ts` reaches `identity-grants-port.ts` through a DYNAMIC
 * import inside a try/catch, so the resolver must be able to build this handle
 * without statically importing the module whose load failure it is guarding
 * against. Do NOT add an import here.
 */

/**
 * A process-wide brand. A launch record is JSON out of PostgreSQL, and JSON can
 * neither carry a symbol key nor a function, so no stored `launch_spec` can ever
 * be mistaken for this handle.
 */
const LAZY_IDENTITY_LAUNCH_RECORD: unique symbol = Symbol.for('@papercusp/operator-core.lazy-identity-launch-record');

/** The full record, read at the row version returned beside it. */
export interface LoadedIdentityLaunchRecord {
  record: unknown;
  /** `xmin` of the row the body was read from; null when it could not be read. */
  rowVersion: string | null;
}

export interface LazyIdentityLaunchRecord {
  readonly [LAZY_IDENTITY_LAUNCH_RECORD]: true;
  /**
   * `jsonb_typeof(launch_spec) = 'object'`, read in the SAME statement (so the
   * same row version) as `identityLaunchRecordVersion`. False for a missing row,
   * a SQL-null or a non-object spec — the gate's existing "no record" branch.
   */
  readonly isObject: boolean;
  /**
   * `launch_spec->'workspaceId'` / `->'harnessSlug'`. Read with `->` (jsonb), not
   * `->>`, so a non-string value keeps its JS type exactly as the full record
   * would. A missing key arrives as `null` where the full record has
   * `undefined`; the gate only compares these against a real workspace string
   * and `typeof === 'string'`, and the cache key JSON-encodes both as `null`,
   * so the two are indistinguishable to every reader.
   */
  readonly workspaceId: unknown;
  readonly harnessSlug: unknown;
  /** Small operation policy read beside the row version, including presence. */
  readonly hasAcceptedOperation: boolean;
  readonly acceptedOperation: unknown;
  /**
   * Read the record. Called at most once per preflight, and only on an
   * identity-resolution cache miss. A throw propagates to the kernel resolver,
   * which fails closed exactly as a failed control-anchor read does.
   *
   * `receipts` (WI-10004801): the revision pairs the caller will select a
   * receipt for. When given, `identityHistory` arrives narrowed to the entries
   * matching one of them (identity-receipt-narrowing.ts); every top-level field
   * is unchanged. Omitted ⇒ the whole record.
   */
  load(receipts?: readonly unknown[]): Promise<LoadedIdentityLaunchRecord | null>;
}

export function lazyIdentityLaunchRecord(
  fields: Omit<LazyIdentityLaunchRecord, typeof LAZY_IDENTITY_LAUNCH_RECORD>,
): LazyIdentityLaunchRecord {
  return {
    [LAZY_IDENTITY_LAUNCH_RECORD]: true,
    isObject: fields.isObject,
    workspaceId: fields.workspaceId,
    harnessSlug: fields.harnessSlug,
    hasAcceptedOperation: fields.hasAcceptedOperation,
    acceptedOperation: fields.acceptedOperation,
    load: fields.load,
  };
}

export function isLazyIdentityLaunchRecord(value: unknown): value is LazyIdentityLaunchRecord {
  return Boolean(value && typeof value === 'object' &&
    (value as Record<PropertyKey, unknown>)[LAZY_IDENTITY_LAUNCH_RECORD] === true);
}
