/**
 * contributor-usage-event-types — types for the append-only
 * `contributor_usage_events` ledger that backs all tier-C activity
 * stats per papercusp-dogfood-v5 §7.1 / D-027 (Phase 5a P-070).
 *
 * Types-only — no I/O, no HYPERBEE driver, no PG client.
 * Source schema is concrete in v5 (~line 494-516) — see
 * `apps/operator/docs/plans/papercusp-dogfood-v5-2026-05-23.md`.
 *
 * Same one-per-design-anchor pattern as the Phase 1b types modules:
 *   - apps/operator/lib/harness/binding-types.ts            (P-068)
 *   - apps/operator/lib/identity/binding-verifier-types.ts  (P-075)
 *   - apps/operator/lib/identity/attestation-types.ts       (P-011)
 *   - apps/operator/lib/identity/contributor-file-types.ts  (P-075 Channel 2)
 *
 * When P-070 runtime ships (Phase 5a), `apps/operator/lib/harness/
 * usage-events.ts` imports these types verbatim; the HYPERBEE write
 * path + PG mirror path + rollup helpers all consume the same shapes.
 *
 * Why types-first here: §7.1 explicitly forbids mutable counter
 * columns on `contributors`. The ledger shape + kind enum + payload
 * discriminator pin the contract that EVERY downstream stat surface
 * (§9.2 Contributors, §9.0 Insights People, §18 User profile, feature
 * card avatars) reads from. Getting that contract wrong silently
 * breaks every surface that aggregates over it; getting it pinned
 * early prevents that.
 */

/**
 * Wire-version of the event-record shape. Bump when adding columns.
 * The PG schema mirror has `schema_version BIGINT NOT NULL DEFAULT 1`
 * (v5 line 510); this const stays in lock-step.
 */
export const USAGE_EVENT_SCHEMA_VERSION = 1 as const;
export type UsageEventSchemaVersion = typeof USAGE_EVENT_SCHEMA_VERSION;

/**
 * The 8 event kinds enumerated in v5 §7.1 schema comment + P-070
 * spec at line 1246. Closed set — extending requires bumping
 * USAGE_EVENT_SCHEMA_VERSION + updating every consumer's payload
 * discriminator.
 *
 *   feature_authored      — `features:create` writer
 *   feature_queued        — feature transitions to `todo` for workers
 *   feature_worked_start  — orchestrator dispatches a worker run
 *   feature_worked_end    — worker run terminates (any outcome)
 *   pr_opened             — PR-daemon observes a new PR
 *   decision_added        — `plans:add-decision` writer
 *   plan_authored         — `plans:new` writer
 *   agent_run_completed   — any agent role completes (worker subset above)
 */
export const USAGE_EVENT_KINDS = [
  'feature_authored',
  'feature_queued',
  'feature_worked_start',
  'feature_worked_end',
  'pr_opened',
  'decision_added',
  'plan_authored',
  'agent_run_completed',
] as const;
export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

/**
 * Kind-specific payload shapes. Each is a small `Record<string, unknown>`-
 * compatible object that round-trips through PG JSONB + HYPERBEE
 * msgpack. Keep payloads small (<2KB serialized) — the ledger is
 * append-only forever and bloat compounds.
 *
 * Payload OPTIONAL by design — read-time rollups should compute
 * primarily from `kind` + `ref_id`. The payload is for context that
 * doesn't fit those, NOT a denormalization of related rows.
 */
export interface UsageEventPayloadByKind {
  feature_authored: { title?: string };
  feature_queued: { from_status?: string };
  feature_worked_start: { run_id?: string; role?: string };
  feature_worked_end: { run_id?: string; outcome?: 'completed' | 'failed' | 'cancelled' | 'timed_out' };
  pr_opened: { pr_number?: number; head_ref?: string; base_ref?: string };
  decision_added: { decision_id?: string };
  plan_authored: { plan_slug?: string };
  agent_run_completed: { run_id?: string; role?: string; duration_ms?: number };
}
export type UsageEventPayload = UsageEventPayloadByKind[UsageEventKind];

/**
 * A single ledger row. Mirrors the v5 schema exactly:
 *
 *   PRIMARY KEY (harness_slug, event_id)
 *
 * `event_id` is a ULID-style monotonically-increasing identifier
 * (HYPERBEE key prefix-sortable by time). See `isUsageEventId` for
 * the shape predicate.
 */
export interface UsageEventRecord<K extends UsageEventKind = UsageEventKind> {
  harness_slug: string;
  /** ULID-shaped 26-char Crockford base32. HYPERBEE key. */
  event_id: string;
  /** Stable numeric GitHub user id. NOT login (login renames). */
  github_user_id: number;
  /** The device that emitted the event — used by Channel 1 verifier
   * to anti-dupe events from forked/cloned identities. */
  device_pubkey: string;
  kind: K;
  /** Kind-specific reference: feature_id, pr_number-as-string,
   * plan_id, run_id. Nullable for kinds that don't carry one. */
  ref_id: string | null;
  payload: UsageEventPayloadByKind[K] | null;
  /** Epoch ms when the event happened on the emitter. NOT when it
   * landed in PG (that's `inserted_ts` on the row, not here). */
  ts: number;
  /** Wire-schema version of THIS row. Per-row so a mixed-version
   * ledger can be range-scanned safely after a bump. */
  schema_version: UsageEventSchemaVersion;
}

/**
 * Anonymous (no-payload) variant — useful when an emitter has no
 * extra context. Equivalent to `payload: null`.
 */
export type AnonymousUsageEventRecord<K extends UsageEventKind = UsageEventKind> =
  UsageEventRecord<K> & { payload: null };

/**
 * Shape of a ULID-style event_id per v5 §7.1 comment.
 *
 * Crockford base32 (`0-9A-HJKMNP-TV-Z`, no I/L/O/U), exactly 26 chars.
 * Re-implementation note: don't use a stdlib ulid generator that
 * outputs Crockford with lowercase — the HYPERBEE prefix scans are
 * case-sensitive.
 */
export const USAGE_EVENT_ID_LENGTH = 26;
const ULID_ALPHABET_RE = /^[0-9A-HJKMNP-TV-Z]+$/;
export function isUsageEventId(id: string): boolean {
  if (typeof id !== 'string') return false;
  if (id.length !== USAGE_EVENT_ID_LENGTH) return false;
  return ULID_ALPHABET_RE.test(id);
}

/**
 * Structural predicate. Verifies required fields are present + typed;
 * payload validity is the responsibility of `isUsageEventPayloadValid`
 * (called separately so an unknown-kind row can be detected and
 * dead-lettered rather than rejected outright).
 */
export function isUsageEventRecordShape(input: unknown): input is UsageEventRecord {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.event_id === 'string' &&
    isUsageEventId(r.event_id) &&
    typeof r.github_user_id === 'number' &&
    Number.isInteger(r.github_user_id) &&
    r.github_user_id > 0 &&
    typeof r.device_pubkey === 'string' &&
    r.device_pubkey.length > 0 &&
    typeof r.kind === 'string' &&
    (USAGE_EVENT_KINDS as readonly string[]).includes(r.kind) &&
    (r.ref_id === null || typeof r.ref_id === 'string') &&
    (r.payload === null || (typeof r.payload === 'object' && r.payload !== null)) &&
    typeof r.ts === 'number' &&
    Number.isFinite(r.ts) &&
    r.ts > 0 &&
    r.schema_version === USAGE_EVENT_SCHEMA_VERSION
  );
}

/**
 * Read-side rollup shape consumed by the four downstream surfaces
 * (§9.2 Contributors row, §9.0 Insights People card, §18 User
 * profile, feature/PR card avatars). Counts only — no per-event
 * detail. Per §9.0 the People card shows aggregated numbers; per
 * §18 the User profile carries them again with harness scoping.
 *
 * Computed by `rollupForContributor(userId, harnessSlug)` (P-070
 * spec at line 1246). Always tier-C per §17 — these numbers reflect
 * HYPERBEE-claimed activity, not GitHub-verified or completion_ref-
 * verified actions.
 */
export interface UsageRollupForContributor {
  github_user_id: number;
  harness_slug: string;
  /** Optional inclusive lower bound for the window. Epoch ms. */
  since_ts?: number;
  /** Optional inclusive upper bound. Epoch ms. */
  until_ts?: number;
  /** Per-kind counts. Every kind appears (zero-count kinds emit
   * `0`, not omitted) so consumers can render fixed grids without
   * defensive `?? 0` checks. */
  counts: Record<UsageEventKind, number>;
  /** Total events across all kinds, == `Σ counts`. Convenience. */
  total: number;
  /** Timestamp of the most-recent event in the window. `null` if
   * no events in window. */
  last_event_ts: number | null;
}

/**
 * Construct a zero-rollup for a (user, harness) pair. Used when the
 * ledger is empty for that scope — gives the UI a render-safe
 * default rather than a missing/`null` rollup.
 */
export function emptyRollup(
  github_user_id: number,
  harness_slug: string,
): UsageRollupForContributor {
  const counts: Record<UsageEventKind, number> = {
    feature_authored: 0,
    feature_queued: 0,
    feature_worked_start: 0,
    feature_worked_end: 0,
    pr_opened: 0,
    decision_added: 0,
    plan_authored: 0,
    agent_run_completed: 0,
  };
  return {
    github_user_id,
    harness_slug,
    counts,
    total: 0,
    last_event_ts: null,
  };
}

/**
 * The `ref_id` field convention per kind. Documented inline so any
 * future emitter knows which id to put where. Verifier callers can
 * use this map to render kind-appropriate links from the ref_id.
 *
 * `null` entries mean "no ref_id makes sense for this kind."
 */
export const USAGE_EVENT_REF_CONVENTION: Record<
  UsageEventKind,
  'feature_id' | 'pr_number' | 'plan_slug' | 'decision_id' | 'run_id' | null
> = {
  feature_authored: 'feature_id',
  feature_queued: 'feature_id',
  feature_worked_start: 'run_id',
  feature_worked_end: 'run_id',
  pr_opened: 'pr_number',
  decision_added: 'decision_id',
  plan_authored: 'plan_slug',
  agent_run_completed: 'run_id',
};

/**
 * Per-row maximum payload byte budget. Enforced at write time by the
 * eventual `usage-events.ts` runtime. The HYPERBEE writer rejects
 * payloads above this; the PG mirror trims gracefully (truncates
 * + records a `payload_truncated: true` audit-log row).
 *
 * 2KB chosen as the upper bound — ledger is append-only forever and
 * even modest per-event bloat compounds (10 events/contributor/day
 * × 50 contributors × 365 days × 2KB = ~365MB/yr; with 16KB payloads
 * that's nearly 3GB/yr per active workspace).
 */
export const USAGE_EVENT_PAYLOAD_MAX_BYTES = 2 * 1024;

/**
 * Idempotency-dedupe predicate. Emitters generate ULID-style ids
 * (lex-sortable by time, globally unique). Re-emit of an event MUST
 * use the same `event_id`; HYPERBEE write path uses `event_id` as
 * its key, so PUT-with-same-key is a no-op.
 *
 * Returns `true` if two records are the same event (same harness,
 * same event_id). The receive-path uses this to decide whether to
 * apply or drop an incoming event.
 */
export function isSameEvent(
  a: Pick<UsageEventRecord, 'harness_slug' | 'event_id'>,
  b: Pick<UsageEventRecord, 'harness_slug' | 'event_id'>,
): boolean {
  return a.harness_slug === b.harness_slug && a.event_id === b.event_id;
}
