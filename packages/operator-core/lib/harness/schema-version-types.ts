/**
 * schema-version-types — types for the D-024 Hyperbee-op schema-
 * versioning gate per papercusp-dogfood-v5 line 416 + line 975.
 *
 * Types-only and PURE. No PG, no Hyperbee.
 *
 * Twentieth module in the dogfood-arc types-only spine.
 *
 * Per v5 D-024:
 *   - Every Autobase op carries `schema_version BIGINT`.
 *   - Each peer maintains LOCAL `known_schema_versions` per harness.
 *   - Receiving an op with `schema_version > my_max_known` → ignore +
 *     emit "newer Papercusp" toast.
 *   - Schema-version increments bundled with Papercusp release versions.
 *
 * Closes the Hyperbee-op-versioning loop: pure `decideOpAcceptance()`
 * function + LOCAL row shape + threshold helpers. P-030 runtime
 * imports these for both the gate AND the toast-emit decision.
 */

/**
 * The LOCAL row shape per v5 line 599.
 *
 *   known_schema_versions(harness_slug, max_known_version, updated_at)
 *
 * One row per (workspace, harness). Updated whenever the local
 * Papercusp boots — its compiled-in `MAX_SUPPORTED_OP_SCHEMA_VERSION`
 * pushed to PG so subsequent receive-paths consult a single source.
 */
export interface KnownSchemaVersionRow {
  harness_slug: string;
  /** Highest op schema-version this peer can produce + understand. */
  max_known_version: number;
  /** Epoch ms when this row was last written (e.g. operator boot). */
  updated_at: number;
}

/**
 * Structural predicate. PG mirror's typecheck before applying rows.
 */
export function isKnownSchemaVersionRow(input: unknown): input is KnownSchemaVersionRow {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.max_known_version === 'number' &&
    Number.isInteger(r.max_known_version) &&
    r.max_known_version >= 1 &&
    typeof r.updated_at === 'number' &&
    Number.isFinite(r.updated_at) &&
    r.updated_at > 0
  );
}

/**
 * Discriminated decision returned by `decideOpAcceptance()`. Three
 * outcomes:
 *
 *   `accept`              — op's schema_version is known; apply normally.
 *   `ignore_newer`        — op's schema_version > my_max_known; drop the
 *                           op + fire the "upgrade Papercusp" toast (idempotent
 *                           per `toastFiredForVersionAlready` predicate so
 *                           successive ops at the same newer version don't
 *                           spam the user).
 *   `ignore_invalid`      — op's schema_version is malformed (≤0, non-integer,
 *                           missing). Drop the op + log.
 */
export type OpAcceptanceDecision =
  | { kind: 'accept' }
  | { kind: 'ignore_newer'; op_version: number; my_max_known: number }
  | { kind: 'ignore_invalid'; raw_version: unknown };

/**
 * Pure decision function. Inspects the op's schema_version field
 * against the peer's max-known. Used by the Hyperbee receive path
 * (apply or drop) AND by the toast emitter (decide whether to
 * fire "upgrade" copy).
 */
export function decideOpAcceptance(args: {
  op_schema_version: unknown;
  my_max_known: number;
}): OpAcceptanceDecision {
  const v = args.op_schema_version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    return { kind: 'ignore_invalid', raw_version: v };
  }
  if (v > args.my_max_known) {
    return { kind: 'ignore_newer', op_version: v, my_max_known: args.my_max_known };
  }
  return { kind: 'accept' };
}

/**
 * Aggregate the max seen-newer version across multiple ignored ops.
 * Used by the toast emitter so the toast copy can name the actual
 * newer-version number ("v3 is in use; you're on v2") rather than
 * just "newer." Returns 0 if no ignored-newer ops.
 */
export function maxNewerVersionSeen(decisions: ReadonlyArray<OpAcceptanceDecision>): number {
  let max = 0;
  for (const d of decisions) {
    if (d.kind === 'ignore_newer' && d.op_version > max) {
      max = d.op_version;
    }
  }
  return max;
}

/**
 * Predicate: should the toast fire for this newer-version? Toasts
 * dedupe per (harness, newer-version). Callers track which versions
 * they've already toasted for and pass the set in.
 */
export function shouldFireNewerVersionToast(args: {
  newer_version: number;
  already_toasted_versions: ReadonlySet<number>;
}): boolean {
  if (args.newer_version <= 0) return false;
  return !args.already_toasted_versions.has(args.newer_version);
}

/**
 * The lowest valid schema_version. v1 is the baseline; all current
 * runtime modules' `XXX_SCHEMA_VERSION` constants are 1.
 */
export const MIN_OP_SCHEMA_VERSION = 1;

/**
 * Predicate: is this op schema_version structurally valid? (Doesn't
 * check against known-max — that's `decideOpAcceptance`.)
 */
export function isValidOpSchemaVersion(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_OP_SCHEMA_VERSION;
}

/**
 * Build a fresh known_schema_versions row. The boot path calls this
 * with the compiled-in `MAX_SUPPORTED_OP_SCHEMA_VERSION`.
 */
export function buildKnownSchemaVersionRow(args: {
  harness_slug: string;
  max_known_version: number;
  now: number;
}): KnownSchemaVersionRow {
  if (!args.harness_slug) throw new TypeError('harness_slug required');
  if (!Number.isInteger(args.max_known_version) || args.max_known_version < MIN_OP_SCHEMA_VERSION) {
    throw new TypeError('max_known_version must be a positive integer ≥ MIN_OP_SCHEMA_VERSION');
  }
  return {
    harness_slug: args.harness_slug,
    max_known_version: args.max_known_version,
    updated_at: args.now,
  };
}

/**
 * Pure helper: should the PG row be updated on this boot? True iff
 * the compiled-in version differs from what PG currently holds.
 * Avoids no-op writes that would bump updated_at unnecessarily.
 */
export function shouldBumpKnownVersionRow(
  existing: KnownSchemaVersionRow | null,
  compiled_in: number,
): boolean {
  if (existing === null) return true;
  return existing.max_known_version !== compiled_in;
}
