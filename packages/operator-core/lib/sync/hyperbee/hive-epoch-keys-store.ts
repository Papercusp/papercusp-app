/**
 * hive-epoch-keys-store — local PG read/write for `harness_shared.pot_epoch_keys`
 * (Brief RE-KEY / Move 2, P-005). Mirrors hive-settings-store: the LOCAL write/read
 * path; federation is the capture trigger's job (mig 316). The wrapped key crosses +
 * is stored as base64 TEXT; this module is the Uint8Array↔base64 boundary.
 *
 *   - putWrappedKeys: the OWNER's boundary trigger persists advanceEpochAndWrap's
 *     per-member rows (origin='local' → the capture trigger federates them).
 *   - createPgWrappedKeyLoader: the member-side `WrappedKeyLoader` the EpochKeyProvider
 *     uses to fetch + decode THIS device's wrapped row.
 */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { WrappedKeyLoader } from './hive-epoch-key-provider';

type Sql = postgres.Sql;
function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/** One wrapped epoch key to persist (the wrapped blob is raw bytes; stored base64). */
export interface WrappedKeyInput {
  memberDevicePubkey: string;
  wrappedKey: Uint8Array;
}

/** Options for putWrappedKeys. */
export interface PutWrappedKeysOptions {
  /**
   * BUG B self-heal (shared-hive-member-content-federation D-028, layer 2). When true,
   * a row that ALREADY exists is RE-WRITTEN via ON CONFLICT DO UPDATE (instead of the
   * write-once DO NOTHING) so the member that MISSED the original federated grant gets
   * the key RE-SENT with a FRESH HLC.
   *
   * MECHANISM (verified against the live triggers, not assumed): the DO UPDATE re-writes
   * `wrapped_key` — a NON-masked content column (re-wrap is a libsodium sealed box with a
   * per-call ephemeral key, so the blob always differs) — and sets origin='local', but
   * does NOT touch fed_ts/fed_hlc. That makes the BEFORE stamp trigger
   * (stamp_local_federated_write, mig 314) take its CONTENT-CHANGED branch and mint a
   * FRESH fed_ts + fed_hlc (origin='local'); the AFTER INSERT OR UPDATE capture trigger
   * (mig 411) then re-enqueues the federation op carrying that fresh HLC, and the
   * member's LWW projection (fed_hlc >= existing) accepts the re-send.
   *
   * Why NOT null fed_ts/fed_hlc (the naive re-stamp): mig-314's stamp trigger treats a
   * MOVED fed_ts (`NEW.fed_ts IS DISTINCT FROM OLD.fed_ts`, which NULL satisfies) as a
   * verbatim projection-apply / explicit repair and returns WITHOUT re-stamping — so
   * nulling fed_ts would leave the row at fed_ts/fed_hlc=NULL and NOT mint a fresh HLC.
   *
   * Default false = the original write-once ON CONFLICT DO NOTHING (behavior unchanged).
   */
  refederate?: boolean;
}

/**
 * Persist the per-member wrapped epoch keys for (hive, epoch) as LOCAL rows — the
 * boundary trigger (advanceEpochAndWrap) calls this on the owner; the capture trigger
 * (mig 316/411) federates them. Idempotent per (hive, epoch, member).
 *
 * `opts.refederate` (default false) switches the ON CONFLICT clause from write-once
 * DO NOTHING to a re-stamping DO UPDATE — the BUG-B reconnect re-grant uses it to
 * RE-SEND a key a member missed (see PutWrappedKeysOptions).
 */
export async function putWrappedKeys(
  workspaceId: string,
  potHomeSlug: string,
  epoch: number,
  rows: readonly WrappedKeyInput[],
  authorPubkey: string | null,
  sql?: Sql,
  opts?: PutWrappedKeysOptions,
): Promise<number> {
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error(`putWrappedKeys: bad epoch ${epoch}`);
  const s = pg(sql);
  // refederate ⇒ DO UPDATE re-writing wrapped_key (a non-masked content column → the
  // BEFORE stamp trigger mints a FRESH fed_ts/fed_hlc on its content-changed branch) +
  // origin='local', WITHOUT touching fed_ts/fed_hlc (nulling them would hit the trigger's
  // "moved fed_ts ⇒ verbatim" branch and skip the re-stamp). The AFTER INSERT OR UPDATE
  // capture (mig 411) then re-federates with the fresh HLC. See PutWrappedKeysOptions.
  // Otherwise the original write-once DO NOTHING.
  const conflict = opts?.refederate
    ? `DO UPDATE SET
         wrapped_key = EXCLUDED.wrapped_key,
         author_pubkey = EXCLUDED.author_pubkey,
         origin = 'local',
         updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint`
    : `DO NOTHING`;
  let written = 0;
  for (const r of rows) {
    if (!r.memberDevicePubkey) continue;
    const wrapped = Buffer.from(r.wrappedKey).toString('base64');
    // origin='local' + fed_ts/fed_hlc left NULL → the BEFORE stamp trigger (mig 214/314)
    // stamps them + the AFTER capture trigger federates. created_at/updated_at default.
    await s.unsafe(
      `INSERT INTO harness_shared.pot_epoch_keys
         (workspace_id, harness_slug, epoch, member_device_pubkey, wrapped_key, author_pubkey, origin)
       VALUES ($1, $2, $3, $4, $5, $6, 'local')
       ON CONFLICT (workspace_id, harness_slug, epoch, member_device_pubkey) ${conflict}`,
      [workspaceId, potHomeSlug, epoch, r.memberDevicePubkey, wrapped, authorPubkey],
    );
    written += 1;
  }
  return written;
}

/** Read THIS device's wrapped key (base64) for (hive, epoch), or null. */
export async function getWrappedKey(
  workspaceId: string,
  potHomeSlug: string,
  epoch: number,
  memberDevicePubkey: string,
  sql?: Sql,
): Promise<string | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT wrapped_key FROM harness_shared.pot_epoch_keys
      WHERE workspace_id = $1 AND harness_slug = $2 AND epoch = $3 AND member_device_pubkey = $4
      LIMIT 1`,
    [workspaceId, potHomeSlug, epoch, memberDevicePubkey],
  )) as unknown as Array<{ wrapped_key: string }>;
  return rows[0]?.wrapped_key ?? null;
}

/**
 * WI-2106: has this hive EVER been re-keyed, as far as this box can locally prove?
 *
 * The discriminator the epoch-0 plaintext bypass is missing. `coerceEpoch`
 * (hive-epoch-state.ts) collapses THREE states into `0` — `unset`, `malformed`, and
 * `genuinely-baseline` — and `setHiveEpoch` is called ONLY from the re-key boundary
 * (hive-epoch-boundary.ts:125), never at hive creation. So a never-re-keyed hive and a
 * fresh joiner of an ALREADY-re-keyed hive whose `hive_settings` epoch row has not
 * backfilled yet BOTH read epoch 0, and `encryptOp` cannot tell them apart: the first
 * must federate plaintext (correct), the second must NOT (a removed member could read
 * it — the read-cut guarantee this module exists to provide).
 *
 * `pot_epoch_keys` supplies a signal that is independent of that row:
 *   - MONOTONIC — rows are only ever INSERTed, so this can only go false→true. It can
 *     never flap back and re-open the window. (Deliberately NOT a `hive_settings` key,
 *     which FEDERATES under LWW: a lower value arriving with a later HLC would overwrite
 *     a higher one and silently re-open exactly this hole.)
 *   - LOCAL — a plain read of an already-projected table. No new durable surface, no
 *     migration, no federation semantics to reason about.
 *   - FAIL-SAFE BY CONSTRUCTION — a never-re-keyed hive has NO epoch>=1 row anywhere, so
 *     this returns false and the plaintext bypass behaves exactly as it does today. That
 *     is what keeps the fix from re-introducing the P-059 wedge: a naive "defer whenever
 *     the epoch is unknown" would defer FOREVER on every never-re-keyed hive, which is
 *     the precise infinite-drain-failure outage the baseline bypass was added to fix
 *     (728+ drain failures, replication dead both directions, gate rig 2026-07-03).
 *
 * ANY epoch>=1 row proves a boundary ran, whichever device it was wrapped for — a joiner
 * is granted keys for epochs [0..current] at admission, so this typically becomes true
 * at admission rather than waiting on opportunistic content arrival.
 *
 * Honest limitation: this BOUNDS the plaintext window, it does not CLOSE it. A joiner
 * that has neither its epoch row nor any wrapped key yet still reads baseline. Closing it
 * entirely needs a join-time epoch handshake at the admission seam (see WI-2106).
 */
export async function hasRekeyEvidence(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<boolean> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT 1 FROM harness_shared.pot_epoch_keys
      WHERE workspace_id = $1 AND harness_slug = $2 AND epoch >= 1
      LIMIT 1`,
    [workspaceId, potHomeSlug],
  )) as unknown as Array<unknown>;
  return rows.length > 0;
}

/**
 * The member-side `WrappedKeyLoader` for the EpochKeyProvider, bound to (workspace,
 * Hive home). `load` returns the device's wrapped blob as bytes (base64-decoded), or
 * null when absent (removed member / not-yet-arrived → the provider fails closed).
 * The `potId` arg is the crypto identity (used by the provider for deriveEpochKey +
 * caching); the PG lookup keys by the bound `potHomeSlug`.
 */
export function createPgWrappedKeyLoader(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): WrappedKeyLoader {
  return {
    async load(_hiveId: string, epoch: number, memberDevicePubkey: string): Promise<Uint8Array | null> {
      const b64 = await getWrappedKey(workspaceId, potHomeSlug, epoch, memberDevicePubkey, sql);
      return b64 == null ? null : new Uint8Array(Buffer.from(b64, 'base64'));
    },
  };
}
