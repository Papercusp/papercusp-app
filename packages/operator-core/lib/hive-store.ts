/**
 * hive-store — PG access to harness_shared.pots, the first-class Hive entity
 * (shared-hive-federation-2026-06-08 P-002, D-008; migration 184).
 *
 * A Hive = a PROJECT, identified by a stable Ed25519 keypair (D-002). This module
 * is the single PG read/write path for the entity and is intentionally CRYPTO-FREE:
 * the keypair is minted/loaded by identity/hive-keypair.ts, and the get-or-mint
 * orchestration lives in hive-identity.ts. PG holds only the PUBLIC key (the
 * dial-able identity + the federation topic key, P-003) plus the OS-keychain id
 * that locates the secret — never the secret itself.
 *
 * The pubkey crosses this module's boundary as base64 (raw 32 bytes) — the exact
 * encoding identity/hive-keypair.ts mints and derive-swarm-topic.ts consumes — and
 * is stored as `bytea` (round-tripped via Buffer). Workspace-scoped: every query
 * carries an explicit `WHERE workspace_id = $1` (RLS is the backstop, mirroring
 * harness_shared.contributors). Every fn takes an optional `sql` client so
 * integration tests can pass a per-file test schema.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** A Hive entity row. `pubkeyBase64` is the raw-32 base64 encoding that
 *  identity/hive-keypair.ts mints and derive-swarm-topic.ts consumes. */
export interface HiveRecord {
  workspaceId: string;
  /** The home `kind:'hive'` harness slug — the local handle. */
  homeSlug: string;
  /**
   * WI-559 — the OWNER-authored (FEDERATED) home slug this Pot's rows travel under
   * on the wire: the scope every hive-home-grained projection persists under, and
   * the target of `pot_members_pot_fkey` (migration 686).
   *
   * EQUALS `homeSlug` on the Pot's owner and on any joiner whose local handle
   * agrees with the owner's — i.e. everywhere except a joiner whose view slug was
   * suffixed by `freeSlug` on a local collision, or derived before the owner's
   * announce was heard. Kept true by `reconcilePotCanonicalSlug`, resolved BY
   * PUBKEY from the signed announce — never by name.
   */
  canonicalHomeSlug: string;
  /** Raw 32-byte Ed25519 public key, base64 — the Hive identity / federation key. */
  pubkeyBase64: string;
  /** OS-keychain id holding the secret (identity/hive-keypair.ts `hiveKeychainId`). */
  keychainId: string;
  title: string | null;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InsertHiveInput {
  workspaceId: string;
  homeSlug: string;
  pubkeyBase64: string;
  keychainId: string;
  title?: string | null;
  description?: string | null;
}

export interface UpsertRemoteHiveIdentityInput extends InsertHiveInput {
  /**
   * Explicit legacy keychain ids that this caller has proven are remote-view
   * artifacts, not locally owned hives. Kept opt-in so owned identities remain
   * immutable by default.
   */
  repairKeychainIds?: string[];
}

/** Raw Ed25519 public key length — asserted on store so a malformed key never
 *  lands as a Hive identity. */
export const ED25519_RAW_PUBKEY_BYTES = 32;

function pubkeyToBytea(pubkeyBase64: string): Buffer {
  const buf = Buffer.from(pubkeyBase64, 'base64');
  if (buf.length !== ED25519_RAW_PUBKEY_BYTES) {
    throw new Error(
      `hive public_key must be ${ED25519_RAW_PUBKEY_BYTES} raw bytes (got ${buf.length}) — ` +
        `expected a raw-32 base64 Ed25519 pubkey from identity/hive-keypair.ts`,
    );
  }
  return buf;
}

/** Decode a candidate id to a 32-byte pubkey Buffer, or null if it is not one
 *  (e.g. it is a home-slug). Lets `getHive` accept slug OR pubkey transparently. */
function tryDecodePubkey(idOrSlug: string): Buffer | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(idOrSlug, 'base64');
  } catch {
    return null;
  }
  // base64 of a non-key string can decode to 32 bytes by coincidence only rarely;
  // a round-trip check rejects slugs that aren't actually this key's encoding.
  if (buf.length !== ED25519_RAW_PUBKEY_BYTES) return null;
  if (buf.toString('base64') !== idOrSlug) return null;
  return buf;
}

interface HiveRow {
  workspace_id: string;
  pot_home_slug: string;
  canonical_pot_home_slug?: string | null;
  public_key: Buffer | Uint8Array;
  keychain_id: string;
  title: string | null;
  description: string | null;
  created_at: string | number;
  updated_at: string | number;
}

function rowToRecord(r: HiveRow): HiveRecord {
  return {
    workspaceId: r.workspace_id,
    homeSlug: r.pot_home_slug,
    // Pre-686 rows (and any INSERT that did not name it) read as the local handle —
    // the same value migration 686 backfills, so the fallback can never disagree
    // with the stored column.
    canonicalHomeSlug: r.canonical_pot_home_slug ?? r.pot_home_slug,
    pubkeyBase64: Buffer.from(r.public_key).toString('base64'),
    keychainId: r.keychain_id,
    title: r.title,
    description: r.description,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/** The INSERT column list — positional, matched by the `VALUES ($1..$7, $7)` in the
 *  writers below. Do NOT add to it without re-numbering those placeholders.
 *  `canonical_pot_home_slug` is deliberately absent: migration 686's
 *  `pots_fill_canonical_slug_trg` fills it from `pot_home_slug`, so every existing
 *  writer keeps canonical == local with no call-site change. */
const COLS = `workspace_id, pot_home_slug, public_key, keychain_id, title, description, created_at, updated_at`;

/** The READ column list — everything in COLS plus the federated scope key, so
 *  `rowToRecord` can populate `canonicalHomeSlug` from the stored column rather
 *  than the local-handle fallback. Used by every SELECT and RETURNING. */
const SELECT_COLS = `${COLS}, canonical_pot_home_slug`;

/** Get one Hive by its pot-home-slug. */
export async function getHiveBySlug(
  workspaceId: string,
  homeSlug: string,
  sql?: Sql,
): Promise<HiveRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${SELECT_COLS} FROM harness_shared.pots WHERE workspace_id = $1 AND pot_home_slug = $2 LIMIT 1`,
    [workspaceId, homeSlug],
  )) as unknown as HiveRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Get one Hive by its raw-32 base64 pubkey (the federation / dial identity). */
export async function getHiveByPubkey(
  workspaceId: string,
  pubkeyBase64: string,
  sql?: Sql,
): Promise<HiveRecord | null> {
  const buf = tryDecodePubkey(pubkeyBase64);
  if (!buf) return null;
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${SELECT_COLS} FROM harness_shared.pots WHERE workspace_id = $1 AND public_key = $2 LIMIT 1`,
    [workspaceId, buf],
  )) as unknown as HiveRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Resolve a Hive by home-slug OR by pubkey (the forward-compat identity). */
export async function getHive(
  workspaceId: string,
  idOrSlug: string,
  sql?: Sql,
): Promise<HiveRecord | null> {
  const bySlug = await getHiveBySlug(workspaceId, idOrSlug, sql);
  if (bySlug) return bySlug;
  if (tryDecodePubkey(idOrSlug)) return getHiveByPubkey(workspaceId, idOrSlug, sql);
  return null;
}

/** Every Hive in the workspace, newest first. */
export async function listHives(workspaceId: string, sql?: Sql): Promise<HiveRecord[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${SELECT_COLS} FROM harness_shared.pots WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  )) as unknown as HiveRow[];
  return rows.map(rowToRecord);
}

/**
 * Get-or-create the Hive identity row. Idempotent: if a row already exists for
 * (workspace, home_slug) it is returned UNCHANGED (the keypair + metadata are an
 * immutable identity — never silently rotated/clobbered by an ensure call);
 * `created` reflects whether a new row was inserted. `title`/`description` apply
 * only on first insert — edit them later via `updateHiveMeta`.
 */
export async function insertHiveIfAbsent(
  input: InsertHiveInput,
  sql?: Sql,
): Promise<{ record: HiveRecord; created: boolean }> {
  const s = pg(sql);
  const pk = pubkeyToBytea(input.pubkeyBase64);
  const now = Date.now();
  // WI-10004191: no conflict target, so EVERY unique key is an arbiter. Callers
  // lazily backfill the same hive concurrently (a Network board refresh racing
  // navigation). With only the slug key as arbiter, a loser that passed the
  // pre-check before the winner's index entries existed raised a unique
  // violation on pots_public_key_key or pots_canonical_home_slug_key instead of
  // returning the winner's row.
  const inserted = (await s.unsafe(
    `INSERT INTO harness_shared.pots (${COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT DO NOTHING
     RETURNING ${SELECT_COLS}`,
    [
      input.workspaceId,
      input.homeSlug,
      pk,
      input.keychainId,
      input.title ?? null,
      input.description ?? null,
      now,
    ],
  )) as unknown as HiveRow[];
  if (inserted[0]) return { record: rowToRecord(inserted[0]), created: true };
  // Conflict: a row already exists — return it unchanged.
  const existing = await getHiveBySlug(input.workspaceId, input.homeSlug, sql);
  if (!existing) {
    // The conflict was on another unique key: this pubkey (or canonical slug)
    // already belongs to a different hive. Never return a phantom, and never
    // bind one identity to two hives.
    throw new Error(
      `insertHiveIfAbsent: no hive (${input.workspaceId}, ${input.homeSlug}) exists, and its pubkey or canonical slug ` +
        `already identifies another hive; refusing to bind it twice`,
    );
  }
  return { record: existing, created: false };
}

/**
 * Get-or-create a REMOTE hive identity row for a joiner view.
 *
 * Owned Hive identities are immutable. A joiner-side remote view is different:
 * its pubkey is learned from the owner's directory announce, so a stale prior
 * join can leave the view slug pointed at an obsolete pubkey. This helper may
 * repair only rows that are already marked `remote:*`; local owned rows are
 * returned unchanged on conflict.
 */
export async function upsertRemoteHiveIdentity(
  input: UpsertRemoteHiveIdentityInput,
  sql?: Sql,
): Promise<{ record: HiveRecord; created: boolean; repaired: boolean }> {
  if (!input.keychainId.startsWith('remote:')) {
    throw new Error('upsertRemoteHiveIdentity requires a remote:* keychain id');
  }
  const s = pg(sql);
  const pk = pubkeyToBytea(input.pubkeyBase64);
  const now = Date.now();
  const repairKeychainIds = (input.repairKeychainIds ?? []).filter(Boolean);
  // WI-10004191: DO UPDATE needs a single conflict target, so a concurrent
  // upsert of the same view can lose the race on pots_public_key_key. One retry
  // sees the winner's committed row and takes the DO UPDATE path; a genuine
  // pubkey clash with another hive fails the retry the same way and surfaces.
  const upsert = () => s.unsafe(
    `INSERT INTO harness_shared.pots (${COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (workspace_id, pot_home_slug) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           keychain_id = EXCLUDED.keychain_id,
           title = COALESCE(EXCLUDED.title, harness_shared.pots.title),
           description = COALESCE(EXCLUDED.description, harness_shared.pots.description),
           updated_at = EXCLUDED.updated_at
       WHERE harness_shared.pots.keychain_id LIKE 'remote:%'
          OR harness_shared.pots.keychain_id = ANY($8::text[])
     RETURNING ${SELECT_COLS}`,
    [
      input.workspaceId,
      input.homeSlug,
      pk,
      input.keychainId,
      input.title ?? null,
      input.description ?? null,
      now,
      repairKeychainIds,
    ],
  );
  const rows = (await upsert().catch((e: unknown) => {
    if ((e as { code?: string } | null)?.code === '23505') return upsert();
    throw e;
  })) as unknown as HiveRow[];
  if (rows[0]) {
    const record = rowToRecord(rows[0]);
    return { record, created: record.createdAt === now, repaired: record.createdAt !== now };
  }
  const existing = await getHiveBySlug(input.workspaceId, input.homeSlug, sql);
  if (!existing) {
    throw new Error(
      `upsertRemoteHiveIdentity: conflict on (${input.workspaceId}, ${input.homeSlug}) but no row found`,
    );
  }
  return { record: existing, created: false, repaired: false };
}

/**
 * WI-559 (migration 686) — stamp the FEDERATED scope key on a Pot's identity row.
 *
 * This is the ONLY writer of `canonical_pot_home_slug`. It exists so a JOINER whose
 * local handle differs from the owner's announced slug can still be the FK parent
 * for the `pot_members` rows its projections persist under the OWNER's slug.
 *
 * Deliberately NARROW — the local handle is never touched, and:
 *  - REMOTE VIEWS ONLY. An owned Pot IS the authority for its own slug; canonical
 *    must stay equal to the local handle there, so this refuses any row whose
 *    keychain_id is not `remote:%`. (`reason: 'not_a_remote_view'`.)
 *  - COLLISION-SAFE. `pots_canonical_home_slug_key` forbids two Pots claiming one
 *    federated scope. A collision returns `reason: 'canonical_taken'` and leaves the
 *    row untouched (fail-open to today's behavior) rather than forcing it — two
 *    identity rows for one wire Pot would make the demux ambiguous, which is a worse
 *    failure than the one being repaired.
 * Never throws for these cases; a genuine PG fault still propagates to the caller,
 * which is best-effort at every call site.
 */
export async function setPotCanonicalHomeSlug(
  workspaceId: string,
  homeSlug: string,
  canonicalSlug: string,
  sql?: Sql,
): Promise<
  | { ok: true; changed: boolean; record: HiveRecord }
  | { ok: false; reason: 'not_found' | 'not_a_remote_view' | 'canonical_taken' }
> {
  const s = pg(sql);
  const current = await getHiveBySlug(workspaceId, homeSlug, sql);
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.canonicalHomeSlug === canonicalSlug) {
    return { ok: true, changed: false, record: current };
  }
  if (!current.keychainId.startsWith('remote:')) {
    return { ok: false, reason: 'not_a_remote_view' };
  }
  // Pre-check the uniqueness invariant so the common collision is a typed result
  // rather than a thrown 23505 the caller has to string-match.
  const clash = (await s.unsafe(
    `SELECT pot_home_slug FROM harness_shared.pots
      WHERE workspace_id = $1 AND canonical_pot_home_slug = $2 AND pot_home_slug <> $3
      LIMIT 1`,
    [workspaceId, canonicalSlug, homeSlug],
  )) as unknown as Array<{ pot_home_slug: string }>;
  if (clash.length > 0) return { ok: false, reason: 'canonical_taken' };

  const rows = (await s.unsafe(
    `UPDATE harness_shared.pots
        SET canonical_pot_home_slug = $3, updated_at = $4
      WHERE workspace_id = $1 AND pot_home_slug = $2
      RETURNING ${SELECT_COLS}`,
    [workspaceId, homeSlug, canonicalSlug, Date.now()],
  )) as unknown as HiveRow[];
  if (!rows[0]) return { ok: false, reason: 'not_found' };
  return { ok: true, changed: true, record: rowToRecord(rows[0]) };
}

/** Edit a Hive's directory metadata (title/description). No identity side effects. */
export async function updateHiveMeta(
  workspaceId: string,
  homeSlug: string,
  meta: { title?: string | null; description?: string | null },
  sql?: Sql,
): Promise<HiveRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.pots
        SET title = COALESCE($3, title),
            description = COALESCE($4, description),
            updated_at = $5
      WHERE workspace_id = $1 AND pot_home_slug = $2
      RETURNING ${SELECT_COLS}`,
    [workspaceId, homeSlug, meta.title ?? null, meta.description ?? null, Date.now()],
  )) as unknown as HiveRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Resolve the workspaceId a Hive's PERSISTED identity row + keypair actually live
 * under, given the CALLER-supplied (ambient) workspaceId + its home slug.
 *
 * WI-5321/WI-5061 design constraint: a hive's row + `hive:<ws>:<slug>` keypair are
 * minted under whatever workspace id was ACTIVE at create time. If the caller's
 * ambient workspace later diverges from that (the ambient-'default' bug class —
 * see WI-2381/WI-5125/WI-5061: a fresh/legacy install's real workspace was minted
 * as the literal id "default", which WI-5321 now fixes going forward, but any hive
 * created BEFORE that fix landed still has its row + key stamped 'default'), an
 * ambient-workspace-scoped lookup (`getHiveBySlug(activeWorkspaceId(), slug)`)
 * silently misses — the row exists, just under a different workspace_id — which
 * `hive-policy-author.ts`'s keypair-ownership gate then reports as `not_owner_swarm`
 * even though this Swarm genuinely holds the key (WI-5061 root cause, confirmed
 * live: `keypair-hive_default_<slug>.enc` present, ambient lookup used the active
 * post-fix workspace id).
 *
 * Fast path (the overwhelmingly common, correct case): a row exists at
 * (ambientWorkspaceId, potHomeSlug) — return ambientWorkspaceId unchanged, zero
 * extra queries beyond the one every caller already does.
 *
 * Fallback: no row at the ambient id. Search by home-slug ACROSS every workspace.
 * If the slug resolves to EXACTLY ONE row workspace-wide, that row's own
 * workspace_id is authoritative — return it (callers should use this resolved id
 * for the keychain lookup AND the policy signature binding, consistently, so both
 * agree with the historical id the key was actually minted under). Zero or
 * MULTIPLE matches (a genuinely ambiguous slug collision across unrelated
 * workspaces, or a genuine non-owner Swarm with no local row at all) fail CLOSED
 * to the original ambientWorkspaceId — preserving today's `not_owner_swarm` for a
 * real non-owner unchanged; this never widens who can pass the ownership gate,
 * it only stops a false negative against the Swarm's OWN historical row.
 */
export async function resolveHiveWorkspaceId(
  ambientWorkspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<string> {
  const direct = await getHiveBySlug(ambientWorkspaceId, potHomeSlug, sql);
  if (direct) return ambientWorkspaceId;
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT DISTINCT workspace_id FROM harness_shared.pots WHERE pot_home_slug = $1 LIMIT 2`,
    [potHomeSlug],
  )) as unknown as Array<{ workspace_id: string }>;
  return rows.length === 1 ? rows[0].workspace_id : ambientWorkspaceId;
}

/** Delete a Hive identity row (create-rollback + pot:dissolve). Idempotent. */
export async function deleteHive(
  workspaceId: string,
  homeSlug: string,
  sql?: Sql,
): Promise<boolean> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `DELETE FROM harness_shared.pots WHERE workspace_id = $1 AND pot_home_slug = $2 RETURNING pot_home_slug`,
    [workspaceId, homeSlug],
  )) as unknown as Array<{ pot_home_slug: string }>;
  return rows.length > 0;
}
