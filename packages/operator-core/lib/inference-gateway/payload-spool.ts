/**
 * Pre-acceptance request-body spool for the inference gateway.
 *
 * D-004 requires that bodies are spooled BEFORE the gateway accepts work, so
 * that queue depth never scales resident memory and a durable receipt can own
 * execution after the originating socket — or the whole process — is gone. The
 * admission contract has always carried a bounded `payloadRef` string
 * (resource-governor/admission.ts) and the queue has always persisted it; what
 * was missing is anything that stores the bytes it refers to. This is that.
 *
 * Per D-011 the POLICY here is not new: hash-verify on write, idempotent dedupe,
 * visibility-gated read and refcounted GC all come from the generic
 * `@papercusp/artifact-registry` BlobStore port. This module contributes only the
 * gateway-shaped facade over it plus a Postgres backend, because a request body
 * is exactly the "bytes addressed by their hash" the port was built for.
 *
 * The ref IS the content hash, which is load-bearing rather than cosmetic: a
 * retried request carrying an identical body hashes to the same key and dedupes
 * onto the same row, so a retry cannot spawn a second stored payload.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  HEX_SHA256_RE,
  getContentAddressed,
  memoryBlobStore,
  putContentAddressed,
  sha256Hex,
  type BlobStore,
  type ContentAddressing,
} from '@papercusp/artifact-registry';
import { activeWorkspaceId } from '../workspace-registry';
import { acquireWithContentionRetry, isWorkspaceContended } from '../agent-tools/locks/contention-retry';

type SqlClient = ReturnType<typeof getOrgPg>['sql'];

/**
 * An IDENTITY content-addressing scheme: the storage key is the bare 64-char hex
 * digest, with no prefix and no extension.
 *
 * Deliberately not `contentAddressing({ prefix: '' })` — that helper always joins
 * with a separator, so an empty prefix yields the key `/<hash>`. A leading slash
 * would then travel as the admission payloadRef and violate the
 * `blob_key ~ '^[0-9a-f]{64}$'` constraint in migration 1022. Keeping key === hash
 * is what lets any holder of the bytes recompute the ref, and keeps it well inside
 * ADMISSION_PAYLOAD_REF_MAX_CHARS.
 */
export const GATEWAY_PAYLOAD_ADDRESSING: ContentAddressing = {
  prefix: '',
  ext: '',
  key: (hash) => hash,
  matches: (key, hash) => key === hash,
  parse: (key) => (HEX_SHA256_RE.test(key) ? key : null),
};

/** 32 MiB. An inference request body above this is a client error, not a spool candidate. */
export const DEFAULT_MAX_SPOOL_BYTES = 32 * 1024 * 1024;
/**
 * How long an UNREFERENCED payload outlives its write: two minutes.
 *
 * The synchronous compatibility path pins a payload only for the request/lease
 * lifetime (seconds-to-minutes, with a bounded 30-minute durable lease), and
 * `ref_count` — not this expiry — is what protects a payload a receipt still
 * names. So this window only governs how long bytes nobody holds linger, and
 * nothing reads them back: a retry carries its own body, so "resurrection" only
 * saves one INSERT.
 *
 * WI-10003469 measured what the old two-hour window cost. Over one 9-minute window
 * (2026-09-28), this table's TOAST produced 48% of all WAL, and 91% of that was
 * full-page images, not body bytes: the GC DELETE and VACUUM's visibility pass each
 * touched a page for the first time since the last checkpoint (15 min). A row that
 * lives two minutes is written and deleted within one checkpoint cycle most of the
 * time, so its pages never need that second and third image.
 */
export const DEFAULT_PAYLOAD_SPOOL_TTL_MS = 2 * 60 * 1000;
/** Keep each lifecycle GC pass row-bounded so it cannot scan an unbounded candidate set. */
export const DEFAULT_PAYLOAD_SPOOL_SWEEP_LIMIT = 2_000;
/**
 * Bound the bytes retired by one GC transaction, not only its row count.
 *
 * WI-10002664 measured 1,045 eligible rows carrying 1.545 GiB while the old
 * 2,000-row limit still called that one "bounded" pass. During the incident,
 * PgBouncer samples showed every server slot active and clients queued for up
 * to 30 seconds while this DELETE and its 24 GiB TOAST vacuum waited on WAL.
 * A count-only bound therefore left one known multi-gigabyte write contributor
 * unbounded even though it looked guarded.
 * 256 MiB is above the observed ~137 MiB/min ingestion rate and eight times the
 * maximum legal single payload, so GC can catch up without one transaction
 * monopolizing the shared write path.
 */
export const DEFAULT_PAYLOAD_SPOOL_SWEEP_MAX_BYTES = 256 * 1024 * 1024;
/** Legacy rows without an expiry are safe to collect after a short idle grace period. */
export const DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS = 2 * 60 * 60 * 1000;
/**
 * How long a REFERENCED payload may sit untouched before the sweep reclaims it anyway.
 *
 * WI-2141342: `release()` runs in a request-scoped `finally`, so a gateway that is
 * SIGKILLed mid-request never decrements. The pin then outlives its expiry with no
 * reaper — `ref_count` is a safety floor with no time dimension, so nothing can ever
 * collect it. Measured before this floor existed: 384 of 404 pinned rows idle past the
 * TTL, the oldest by 80 hours, surviving many gateway restarts; unpinned rows over the
 * same window topped out at exactly 2.00h, which is the rest of the sweep working
 * correctly. Every restart stranded a new cohort and none ever drained.
 *
 * Two hours because a legitimate pin lives for the request/lease lifetime —
 * seconds-to-minutes, bounded by a 30-minute durable lease (see the TTL note above) —
 * so this is ~4x the longest honest hold. It is deliberately measured from
 * `last_accessed_at`, NOT `expires_at`: `retain`/`release`/`get` all refresh
 * last_accessed_at, while expires_at is stamped once in put() and never moved, making
 * it a write-time stamp rather than a liveness signal. Keyed on expires_at this floor
 * would measure the wrong dimension entirely.
 */
export const DEFAULT_PAYLOAD_SPOOL_PINNED_GRACE_MS = 2 * 60 * 60 * 1000;

export interface GatewayPayloadSpoolOptions {
  /** Storage backend. Defaults to the Postgres-backed store. */
  readonly store?: BlobStore<{ body: Uint8Array; size: number }>;
  readonly maxBytes?: number;
  /** Retention backstop for an accepted receipt that never executes. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface SpoolResult {
  /** The admission payloadRef, or null when there was nothing worth spooling. */
  readonly payloadRef: string | null;
  readonly bytes: number;
  /** True when identical bytes were already stored — the retry/idempotency path. */
  readonly deduped: boolean;
}

/**
 * Raised when a body cannot be persisted. It is deliberately distinct from the
 * admission errors: D-003 permits a request to fail for "inability to persist
 * truthfully", and this is the type that says so. It must never be swallowed
 * into a successful receipt.
 */
export class PayloadSpoolPersistenceError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'PayloadSpoolPersistenceError';
    this.status = status;
  }
}

/** Raised for a body the gateway refuses to spool at all (oversize). */
export class PayloadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`inference-gateway: request body exceeds the ${maxBytes}-byte spool limit`);
    this.name = 'PayloadTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export interface GatewayPayloadSpool {
  /**
   * Persist `body` and return its ref. An empty body yields a null ref rather
   * than an error: there is nothing to replay, so admission simply carries no
   * payloadRef and the downstream contract is unchanged.
   */
  spool(body: Buffer, options?: { readonly contentType?: string }): Promise<SpoolResult>;
  /** Read spooled bytes back, or null when the ref no longer resolves. */
  read(payloadRef: string): Promise<Buffer | null>;
  /** Pin the payload while a receipt names it. */
  retain(payloadRef: string): Promise<void>;
  /** Unpin. Does NOT delete: a retry arriving before the sweep can still resurrect it. */
  release(payloadRef: string): Promise<void>;
  /** Reclaim unreferenced/expired blobs. Returns how many rows it removed. */
  sweep(options?: { readonly limit?: number; readonly maxBytes?: number }): Promise<number>;
}

class BlobStoreGatewayPayloadSpool implements GatewayPayloadSpool {
  readonly #store: BlobStore<{ body: Uint8Array; size: number }>;
  readonly #maxBytes: number;
  readonly #refcount: RefcountPort | null;

  constructor(
    store: BlobStore<{ body: Uint8Array; size: number }>,
    maxBytes: number,
    refcount: RefcountPort | null,
  ) {
    this.#store = store;
    this.#maxBytes = maxBytes;
    this.#refcount = refcount;
  }

  async spool(body: Buffer, options: { readonly contentType?: string } = {}): Promise<SpoolResult> {
    if (body.byteLength === 0) return { payloadRef: null, bytes: 0, deduped: false };
    if (body.byteLength > this.#maxBytes) throw new PayloadTooLargeError(this.#maxBytes);

    const hash = await sha256Hex(body);
    const result = await putContentAddressed(this.#store, {
      hash,
      scheme: GATEWAY_PAYLOAD_ADDRESSING,
      readBody: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      declaredLength: body.byteLength,
      maxBytes: this.#maxBytes,
      ...(options.contentType ? { contentType: options.contentType } : {}),
    });

    if (!result.ok) {
      // 413 is the client's fault and keeps its own type; everything else is a
      // failure to persist, which D-003 says must surface rather than become a
      // receipt the gateway cannot honour.
      if (result.status === 413) throw new PayloadTooLargeError(this.#maxBytes);
      throw new PayloadSpoolPersistenceError(
        `inference-gateway: could not spool request body (${result.error})`,
        result.status,
      );
    }
    return { payloadRef: result.key, bytes: result.bytes, deduped: result.deduped };
  }

  async read(payloadRef: string): Promise<Buffer | null> {
    const got = await getContentAddressed(this.#store, {
      hash: payloadRef,
      scheme: GATEWAY_PAYLOAD_ADDRESSING,
    });
    if (!got.ok) return null;
    return Buffer.from(got.object.body);
  }

  async retain(payloadRef: string): Promise<void> {
    await this.#refcount?.retain(GATEWAY_PAYLOAD_ADDRESSING.key(payloadRef));
  }

  async release(payloadRef: string): Promise<void> {
    await this.#refcount?.release(GATEWAY_PAYLOAD_ADDRESSING.key(payloadRef));
  }

  async sweep(options: { readonly limit?: number; readonly maxBytes?: number } = {}): Promise<number> {
    return (
      (await this.#refcount?.sweep(
        options.limit ?? DEFAULT_PAYLOAD_SPOOL_SWEEP_LIMIT,
        options.maxBytes ?? DEFAULT_PAYLOAD_SPOOL_SWEEP_MAX_BYTES,
      )) ?? 0
    );
  }
}

/** The refcount/GC half, which the pure BlobStore port deliberately does not own. */
interface RefcountPort {
  retain(key: string): Promise<void>;
  release(key: string): Promise<void>;
  sweep(limit: number, maxBytes: number): Promise<number>;
}

export interface PgGatewayPayloadStoreOptions {
  readonly sql?: SqlClient;
  readonly workspaceId?: string;
  readonly ttlMs?: number;
  readonly legacyGraceMs?: number;
  /** Idle window after which an expired but still-REFERENCED payload is reclaimed anyway. */
  readonly pinnedGraceMs?: number;
  readonly now?: () => number;
  /** Injectable for tests; production defaults to the shared EI-1720 backoffs/sleep. */
  readonly contentionBackoffsMs?: readonly number[];
  readonly contentionSleep?: (ms: number) => Promise<void>;
}

/**
 * Postgres backend for the spool: the 4-method BlobStore port plus the refcount
 * operations, over harness_shared.gateway_payload_blobs (migration 1022).
 */
export class PgGatewayPayloadStore implements BlobStore<{ body: Uint8Array; size: number }>, RefcountPort {
  readonly #sql: SqlClient;
  readonly #workspaceId: string;
  readonly #ttlMs: number;
  readonly #legacyGraceMs: number;
  readonly #pinnedGraceMs: number;
  readonly #now: () => number;
  readonly #contentionBackoffsMs: readonly number[] | undefined;
  readonly #contentionSleep: ((ms: number) => Promise<void>) | undefined;
  /** The lifecycle sweep currently running, if any — see sweep(). */
  #sweepInFlight: Promise<number> | null = null;

  constructor(options: PgGatewayPayloadStoreOptions = {}) {
    this.#sql = options.sql ?? getOrgPg().sql;
    this.#workspaceId = options.workspaceId?.trim() || activeWorkspaceId();
    this.#ttlMs =
      options.ttlMs === undefined || !Number.isFinite(options.ttlMs)
        ? DEFAULT_PAYLOAD_SPOOL_TTL_MS
        : Math.max(0, options.ttlMs);
    this.#legacyGraceMs =
      options.legacyGraceMs === undefined || !Number.isFinite(options.legacyGraceMs)
        ? DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS
        : Math.max(0, options.legacyGraceMs);
    this.#pinnedGraceMs =
      options.pinnedGraceMs === undefined || !Number.isFinite(options.pinnedGraceMs)
        ? DEFAULT_PAYLOAD_SPOOL_PINNED_GRACE_MS
        : Math.max(0, options.pinnedGraceMs);
    this.#now = options.now ?? (() => Date.now());
    this.#contentionBackoffsMs = options.contentionBackoffsMs;
    this.#contentionSleep = options.contentionSleep;
  }

  /**
   * A HEAD hit IS the dedupe path: putContentAddressed returns the existing row instead of
   * writing one, so this must renew it exactly as a fresh put() would. With a two-minute
   * TTL the row a retry dedupes onto is often already expired, and the sweep could delete
   * it between this call and the caller's retain(). Refreshing expires_at here makes the
   * outer DELETE's READ COMMITTED re-check reject the row, the same self-guard retain()/get()
   * give the abandoned-pin branch. GREATEST ignores a NULL argument, so ttlMs = 0 leaves the
   * expiry untouched.
   */
  async head(key: string): Promise<{ size: number } | null> {
    const expiresAt = this.#ttlMs > 0 ? new Date(this.#now() + this.#ttlMs) : null;
    const rows = await this.#sql<{ byte_length: string | number }[]>`
      UPDATE harness_shared.gateway_payload_blobs
         SET last_accessed_at = now(),
             expires_at = GREATEST(expires_at, ${expiresAt}::timestamptz)
       WHERE workspace_id = ${this.#workspaceId}
         AND blob_key = ${key}
      RETURNING byte_length`;
    const row = rows[0];
    return row ? { size: Number(row.byte_length) } : null;
  }

  async put(key: string, body: ArrayBuffer | Uint8Array, opts?: { contentType?: string }): Promise<void> {
    const bytes = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(new Uint8Array(body));
    const expiresAt = this.#ttlMs > 0 ? new Date(this.#now() + this.#ttlMs) : null;
    // EI-21880026143110293: a bulk-load/VACUUM window on this table can push the
    // write past pg's lock_timeout/statement_timeout (55P03/57014) with nothing
    // committed. The insert is safe to retry as-is: the key is the content hash
    // and ON CONFLICT DO NOTHING makes a retry after a prior silent commit a
    // no-op, not a duplicate. Reuses the shared EI-1720 primitive rather than a
    // second backoff loop — same bug class, one layer down (the git-sync file-lock
    // read and the resource-governor admission write already hit this and were
    // fixed the same way).
    try {
      await acquireWithContentionRetry(
        () =>
          this.#sql`
          INSERT INTO harness_shared.gateway_payload_blobs
            (workspace_id, blob_key, bytes, byte_length, content_type, expires_at)
          VALUES
            (${this.#workspaceId}, ${key}, ${bytes}, ${bytes.byteLength}, ${opts?.contentType ?? null}, ${expiresAt})
          ON CONFLICT (workspace_id, blob_key) DO NOTHING`,
        {
          ...(this.#contentionBackoffsMs ? { backoffsMs: this.#contentionBackoffsMs } : {}),
          ...(this.#contentionSleep ? { sleep: this.#contentionSleep } : {}),
        },
      );
    } catch (error) {
      // EI-21880026143110293: on exhausted contention retries, say so — the prior
      // bare pg timeout gave a caller (e.g. work_items:complete) no signal that (a)
      // this was transient contention rather than a malformed payload, or (b) the
      // effective workaround is a smaller payload, not resending the same one.
      const prefix = isWorkspaceContended(error)
        ? `could not persist gateway payload blob (workspace=${this.#workspaceId}) after contention retries were exhausted`
        : 'could not persist gateway payload blob';
      throw new PayloadSpoolPersistenceError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async get(key: string): Promise<{ body: Uint8Array; size: number } | null> {
    const rows = await this.#sql<{ bytes: Buffer; byte_length: string | number }[]>`
      UPDATE harness_shared.gateway_payload_blobs
         SET last_accessed_at = now()
       WHERE workspace_id = ${this.#workspaceId}
         AND blob_key = ${key}
      RETURNING bytes, byte_length`;
    const row = rows[0];
    if (!row) return null;
    return { body: new Uint8Array(row.bytes), size: Number(row.byte_length) };
  }

  async delete(key: string): Promise<void> {
    await this.#sql`
      DELETE FROM harness_shared.gateway_payload_blobs
       WHERE workspace_id = ${this.#workspaceId}
         AND blob_key = ${key}`;
  }

  async retain(key: string): Promise<void> {
    await this.#sql`
      UPDATE harness_shared.gateway_payload_blobs
         SET ref_count = ref_count + 1, last_accessed_at = now()
       WHERE workspace_id = ${this.#workspaceId}
         AND blob_key = ${key}`;
  }

  async release(key: string): Promise<void> {
    // GREATEST(…, 0) rather than an unguarded decrement: a double-release from a
    // retried settle path must not drive the count negative and make a live blob
    // look collectable.
    await this.#sql`
      UPDATE harness_shared.gateway_payload_blobs
         SET ref_count = GREATEST(ref_count - 1, 0), last_accessed_at = now()
       WHERE workspace_id = ${this.#workspaceId}
         AND blob_key = ${key}`;
  }

  /**
   * ONE lifecycle sweep at a time per store (WI-10002667).
   *
   * The gateway timer fires every 60s and never waited for the previous pass. On
   * 2026-09-23 one DELETE batch was measured open for 6m08s under WAL pressure while a
   * second batch from the same process had already started behind it, blocked on the
   * first one's transactionid, and 142 backends fleet-wide queued on LWLock:WAL*. The
   * byte budget bounds how much ONE pass writes; this guard bounds how many passes run
   * at once, which the byte budget cannot.
   *
   * An overlapping call joins the in-flight pass and resolves with its count, even if it
   * passed a different limit — it does not start a second DELETE. The guard clears when
   * the pass settles, success or failure, so a rejected pass cannot wedge GC.
   */
  sweep(limit: number, maxBytes = DEFAULT_PAYLOAD_SPOOL_SWEEP_MAX_BYTES): Promise<number> {
    if (this.#sweepInFlight) return this.#sweepInFlight;
    const run = this.#sweepOnce(limit, maxBytes).finally(() => {
      this.#sweepInFlight = null;
    });
    this.#sweepInFlight = run;
    return run;
  }

  async #sweepOnce(limit: number, maxBytes: number): Promise<number> {
    const batchLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_PAYLOAD_SPOOL_SWEEP_LIMIT;
    const batchMaxBytes = Number.isFinite(maxBytes)
      ? Math.max(1, Math.floor(maxBytes))
      : DEFAULT_PAYLOAD_SPOOL_SWEEP_MAX_BYTES;

    // Migration 1022 intentionally allowed NULL expires_at, and rows written before the
    // finite-TTL policy therefore need a bounded backfill. Backfill referenced rows too:
    // expiry is a policy timestamp, while ref_count is the independent safety floor that
    // prevents a live receipt from being deleted.
    if (this.#ttlMs > 0) {
      await this.#sql`
        WITH legacy AS (
          SELECT workspace_id, blob_key
            FROM harness_shared.gateway_payload_blobs
           WHERE workspace_id = ${this.#workspaceId}
             AND expires_at IS NULL
           ORDER BY created_at, blob_key
           LIMIT ${batchLimit}
        )
        UPDATE harness_shared.gateway_payload_blobs AS blobs
           SET expires_at = blobs.created_at + (${this.#ttlMs} * interval '1 millisecond')
        FROM legacy
       WHERE blobs.workspace_id = legacy.workspace_id
         AND blobs.blob_key = legacy.blob_key
         AND blobs.expires_at IS NULL`;
    }

    // WI-2141342: the eligibility predicate is TWO branches, and it is repeated verbatim
    // in the outer DELETE and the candidate subquery. Keep them in step — a row selected
    // by the subquery but rejected by the outer predicate makes the sweep silently
    // collect nothing, which is indistinguishable from having nothing to collect.
    //
    // Branch 1 (unchanged): unreferenced and past its retention window.
    // Branch 2 (new): ABANDONED — past expiry AND untouched for pinnedGraceMs, regardless
    // of ref_count. `release()` runs in a request-scoped `finally`, so a SIGKILLed gateway
    // never decrements and the pin outlives its expiry with nothing able to collect it.
    //
    // Branch 2 deliberately omits a ref_count re-check, and the outer DELETE is still safe
    // WITHOUT one: `retain()` and `get()` both set last_accessed_at = now(), so a request
    // that adopts this payload between the subquery and the delete pushes the row OUT of
    // the idle window, and READ COMMITTED re-evaluates the predicate against that updated
    // row. The age test is self-guarding in exactly the way `ref_count = 0` was — which is
    // only true because the floor is keyed on last_accessed_at rather than on expires_at,
    // a write-time stamp that no access ever refreshes.
    const legacyPlusPinnedMs = this.#legacyGraceMs + this.#pinnedGraceMs;
    const rows = await this.#sql<{ blob_key: string }[]>`
      DELETE FROM harness_shared.gateway_payload_blobs AS blobs
       WHERE blobs.workspace_id = ${this.#workspaceId}
         AND (
           (
             blobs.ref_count = 0
             AND (
               (blobs.expires_at IS NOT NULL AND blobs.expires_at <= now())
               OR (
                 blobs.expires_at IS NULL
                 AND blobs.last_accessed_at <= now() - (${this.#legacyGraceMs} * interval '1 millisecond')
               )
             )
           )
           OR (
             (
               blobs.expires_at IS NOT NULL
               AND blobs.expires_at <= now()
               AND blobs.last_accessed_at <= now() - (${this.#pinnedGraceMs} * interval '1 millisecond')
             )
             OR (
               blobs.expires_at IS NULL
               AND blobs.last_accessed_at <= now() - (${legacyPlusPinnedMs} * interval '1 millisecond')
             )
           )
         )
         AND (blobs.workspace_id, blobs.blob_key) IN (
         SELECT ranked.workspace_id, ranked.blob_key
           FROM (
             SELECT candidate.workspace_id,
                    candidate.blob_key,
                    row_number() OVER (
                      ORDER BY candidate.last_accessed_at, candidate.blob_key
                    ) AS sweep_rank,
                    sum(candidate.byte_length) OVER (
                      ORDER BY candidate.last_accessed_at, candidate.blob_key
                    ) AS cumulative_bytes
               FROM harness_shared.gateway_payload_blobs AS candidate
              WHERE candidate.workspace_id = ${this.#workspaceId}
                AND (
                  (
                    candidate.ref_count = 0
                    AND (
                      (candidate.expires_at IS NOT NULL AND candidate.expires_at <= now())
                      OR (
                        candidate.expires_at IS NULL
                        AND candidate.last_accessed_at <= now() - (${this.#legacyGraceMs} * interval '1 millisecond')
                      )
                    )
                  )
                  OR (
                    (
                      candidate.expires_at IS NOT NULL
                      AND candidate.expires_at <= now()
                      AND candidate.last_accessed_at <= now() - (${this.#pinnedGraceMs} * interval '1 millisecond')
                    )
                    OR (
                      candidate.expires_at IS NULL
                      AND candidate.last_accessed_at <= now() - (${legacyPlusPinnedMs} * interval '1 millisecond')
                    )
                  )
                )
              ORDER BY candidate.last_accessed_at, candidate.blob_key
              LIMIT ${batchLimit}
           ) AS ranked
          WHERE ranked.cumulative_bytes <= ${batchMaxBytes}
             OR ranked.sweep_rank = 1
          ORDER BY ranked.sweep_rank
       )
      RETURNING blob_key`;
    return rows.length;
  }
}

/** Production spool: Postgres-backed, content-addressed, refcounted. */
export function createGatewayPayloadSpool(options: GatewayPayloadSpoolOptions & PgGatewayPayloadStoreOptions = {}): GatewayPayloadSpool {
  const pg =
    options.store === undefined
      ? new PgGatewayPayloadStore({
          ...(options.sql ? { sql: options.sql } : {}),
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
          ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
          ...(options.legacyGraceMs !== undefined ? { legacyGraceMs: options.legacyGraceMs } : {}),
          ...(options.pinnedGraceMs !== undefined ? { pinnedGraceMs: options.pinnedGraceMs } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.contentionBackoffsMs ? { contentionBackoffsMs: options.contentionBackoffsMs } : {}),
          ...(options.contentionSleep ? { contentionSleep: options.contentionSleep } : {}),
        })
      : null;
  const store = options.store ?? pg!;
  return new BlobStoreGatewayPayloadSpool(store, options.maxBytes ?? DEFAULT_MAX_SPOOL_BYTES, pg);
}

/**
 * In-memory spool for hermetic tests and for direct startGatewayService callers
 * that must not acquire a Postgres dependency.
 */
export function memoryGatewayPayloadSpool(options: { readonly maxBytes?: number } = {}): GatewayPayloadSpool & {
  readonly data: Map<string, Uint8Array>;
} {
  const store = memoryBlobStore();
  const refs = new Map<string, number>();
  const refcount: RefcountPort = {
    retain: async (key) => {
      refs.set(key, (refs.get(key) ?? 0) + 1);
    },
    release: async (key) => {
      refs.set(key, Math.max(0, (refs.get(key) ?? 0) - 1));
    },
    sweep: async (limit, maxBytes) => {
      let removed = 0;
      let removedBytes = 0;
      for (const key of [...store.data.keys()]) {
        if (removed >= limit) break;
        if ((refs.get(key) ?? 0) === 0) {
          const bytes = store.data.get(key)?.byteLength ?? 0;
          // Always allow the oldest first row so an explicitly tiny byte cap
          // cannot make GC permanently stop making progress.
          if (removed > 0 && removedBytes + bytes > maxBytes) break;
          store.data.delete(key);
          refs.delete(key);
          removed += 1;
          removedBytes += bytes;
        }
      }
      return removed;
    },
  };
  const spool = new BlobStoreGatewayPayloadSpool(store, options.maxBytes ?? DEFAULT_MAX_SPOOL_BYTES, refcount);
  return Object.assign(spool, { data: store.data });
}
