/**
 * hive-membership-store — PG access to harness_shared.pot_members, the per-Hive
 * contributor/device admission record (shared-hive-federation-2026-06-08 P-006,
 * D-004; migration 185).
 *
 * The Hive-grain analog of the per-harness contributor access
 * (load-revoked-pubkeys.ts + write-contributor-row.ts). A contributor/device
 * joins the HIVE once and thereby its harnesses, so admission keys on the Hive
 * (workspace_id, pot_home_slug) instead of a harness slug. The read-admission
 * decider + verifyBinding are REUSED unchanged — only the source of the
 * revoked-set union changes.
 *
 * `loadRevokedHivePubkeys` is the seam the P-004 substrate re-key wires into
 * boot.ts's admission seed/refresh: when an announcing peer's harness belongs to
 * a Hive (the P-004 harness↔Hive membership link), union this into the `revoked`
 * Set passed to makeAdmissionDecider.
 *
 * Crypto-free + PG-only: the keypair/identity live elsewhere; federation of these
 * rows (peer-log publish + projection) is the substrate's job (P-004). Every fn
 * takes an optional `sql` client so integration tests pass a per-file schema, and
 * carries an explicit `WHERE workspace_id = $1` (RLS is the backstop).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { DeviceAttestationEntry } from './harness/contributor-row-types';
// TYPE-ONLY (erased at runtime, so no import cycle with federated-pot-scope, which imports
// the readers below). EI-18777176681958978: the two READ scopes are branded so a LOCAL pot
// handle cannot be passed where the FEDERATED (owner-authored) scope is required.
import type { FederatedPotScope } from './federated-pot-scope';

/** A Hive member row — a contributor admitted to a Hive (all their devices +
 *  the revoked blocklist). Mirrors ContributorRow at Hive grain. */
export interface HiveMemberRecord {
  workspaceId: string;
  /** The Hive's home_slug (the hives PK handle this membership attaches to). */
  potHomeSlug: string;
  githubUserId: number;
  githubUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** This member's bound devices on this Hive. */
  deviceAttestations: DeviceAttestationEntry[];
  /** Pubkeys this member explicitly revoked (e.g. a lost device). The admission
   *  decider MUST refuse any attestation whose pubkey is in the UNION of these
   *  across all members (loadRevokedHivePubkeys). */
  revokedPubkeys: string[];
  bindingStatus: string;
}

export interface UpsertHiveMemberInput {
  workspaceId: string;
  /** ⚠ SCOPE (WI-6312): the FEDERATED (owner-authored) scope. A row written under a
   *  joiner's LOCAL handle is the exact mirror of the read bug — no federated reader will
   *  ever see it, and the write reports success. */
  potHomeSlug: FederatedPotScope;
  githubUserId: number;
  githubUsername: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  deviceAttestations?: DeviceAttestationEntry[];
  revokedPubkeys?: string[];
  bindingStatus?: string;
}

interface HiveMemberPgRow {
  workspace_id: string;
  pot_home_slug: string;
  github_user_id: string | number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  /** jsonb — postgres-js usually parses it to an array, but a string is tolerated. */
  device_attestations: DeviceAttestationEntry[] | string | null;
  revoked_pubkeys: string[] | null;
  binding_status: string;
}

/** jsonb may arrive parsed (array) or, depending on the client/driver, as a raw
 *  JSON string — accept both so the read never silently drops the devices. */
function parseAttestations(v: DeviceAttestationEntry[] | string | null): DeviceAttestationEntry[] {
  if (v == null) return [];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as DeviceAttestationEntry[]) : [];
    } catch {
      return [];
    }
  }
  return v;
}

function rowToRecord(r: HiveMemberPgRow): HiveMemberRecord {
  return {
    workspaceId: r.workspace_id,
    potHomeSlug: r.pot_home_slug,
    githubUserId: Number(r.github_user_id),
    githubUsername: r.github_username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    deviceAttestations: parseAttestations(r.device_attestations),
    revokedPubkeys: r.revoked_pubkeys ?? [],
    bindingStatus: r.binding_status,
  };
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/**
 * WI-892 / EI-3409 write-boundary guard. `'*'` is the unscoped-superuser READ sentinel
 * (`ctx.workspaceId` for a `?superuser=1` session that chose no workspace), never a storable
 * workspace. A hive_members row written under `workspace_id='*'` (or empty) is invisible to
 * EVERY concrete-workspace read — the membership guard, epoch-key grant, and cross-member
 * content federation all filter `WHERE workspace_id = '<concrete>'` — so it silently breaks
 * shared-hive federation. Refuse it LOUDLY here so the leak can never be silent again: the
 * tool sites resolve a concrete workspace (`resolveConcreteWorkspaceId`) before calling in,
 * and migration 406's CHECK constraint is the data-layer backstop for any writer that
 * bypasses this fn (e.g. the projection's own INSERT).
 */
function assertStorableWorkspaceId(workspaceId: string, op: string): void {
  if (!workspaceId || !workspaceId.trim() || workspaceId === '*') {
    throw new Error(
      `[hive-members] ${op}: refusing workspace_id=${JSON.stringify(workspaceId)} — ` +
        `'*'/empty is a read sentinel, not a storable workspace (EI-3409/WI-892). ` +
        `Resolve a concrete workspace (resolveConcreteWorkspaceId) before writing.`,
    );
  }
}

const COLS = `workspace_id, pot_home_slug, github_user_id, github_username,
  display_name, avatar_url, device_attestations, revoked_pubkeys, binding_status`;

/**
 * Load the UNION of revoked device pubkeys for a Hive — the blocklist the
 * read-admission decider checks first. This is the wire-in point for boot.ts's
 * admission seed/refresh at Hive scope (P-004). Mirrors load-revoked-pubkeys.ts.
 *
 * ⚠ SCOPE (EI-18777176681958978): `potHomeSlug` is the FEDERATED (owner-authored) scope the
 * projections WRITE under — NOT a joiner's local handle. Passing the local handle returns an
 * EMPTY set, so a revoked member is never refused. Holding a local handle? Use
 * `loadRevokedHivePubkeysForLocalPot` (federated-pot-scope.ts).
 */
export async function loadRevokedHivePubkeys(
  workspaceId: string,
  potHomeSlug: FederatedPotScope,
  sql?: Sql,
): Promise<Set<string>> {
  const rows = (await pg(sql).unsafe(
    `SELECT revoked_pubkeys FROM harness_shared.pot_members
      WHERE workspace_id = $1 AND pot_home_slug = $2`,
    [workspaceId, potHomeSlug],
  )) as unknown as Array<{ revoked_pubkeys: string[] | null }>;
  const set = new Set<string>();
  for (const r of rows) {
    for (const k of r.revoked_pubkeys ?? []) set.add(k);
  }
  return set;
}

/**
 * Distinct admitted members across ALL hives in a workspace — the "people you can
 * @-assign" set for the (workspace-level) plans UI (shared-hive-collaboration
 * P-016 / offline-member assign). A person in several hives appears ONCE (DISTINCT
 * ON github_user_id, newest binding kept), since the assign address is their
 * identity, not a hive. Ordered by display name for a stable picker.
 */
export async function listWorkspaceMembers(
  workspaceId: string,
  sql?: Sql,
): Promise<HiveMemberRecord[]> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${COLS} FROM (
       SELECT DISTINCT ON (github_user_id) ${COLS}, joined_at
         FROM harness_shared.pot_members
        WHERE workspace_id = $1
        ORDER BY github_user_id, joined_at DESC
     ) m
     ORDER BY COALESCE(display_name, github_username) ASC`,
    [workspaceId],
  )) as unknown as HiveMemberPgRow[];
  return rows.map(rowToRecord);
}

/**
 * Get one Hive member.
 *
 * ⚠ SCOPE (WI-6312, the write/single-row sibling of EI-18777176681958978): `potHomeSlug` is
 * the FEDERATED (owner-authored) scope. A joiner's LOCAL handle returns `null` here — and
 * `null` is indistinguishable from "not a member", so every membership/tier gate built on
 * this silently DENIES (or, read the other way round, never recognises) a real member on a
 * divergent joiner. Holding a local handle? Resolve it first (`resolveFederatedPotScope`).
 */
export async function getHiveMember(
  workspaceId: string,
  potHomeSlug: FederatedPotScope,
  githubUserId: number,
  sql?: Sql,
): Promise<HiveMemberRecord | null> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${COLS} FROM harness_shared.pot_members
      WHERE workspace_id = $1 AND pot_home_slug = $2 AND github_user_id = $3 LIMIT 1`,
    [workspaceId, potHomeSlug, githubUserId],
  )) as unknown as HiveMemberPgRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * All members of a Hive.
 *
 * ⚠ SCOPE (EI-18777176681958978): `potHomeSlug` is the FEDERATED (owner-authored) scope the
 * projections WRITE under — NOT a joiner's local handle, which reads as an empty roster.
 * Holding a local handle? Use `listHiveMembersForLocalPot` (federated-pot-scope.ts).
 */
export async function listHiveMembers(
  workspaceId: string,
  potHomeSlug: FederatedPotScope,
  sql?: Sql,
): Promise<HiveMemberRecord[]> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${COLS} FROM harness_shared.pot_members
      WHERE workspace_id = $1 AND pot_home_slug = $2 ORDER BY joined_at ASC`,
    [workspaceId, potHomeSlug],
  )) as unknown as HiveMemberPgRow[];
  return rows.map(rowToRecord);
}

/**
 * The device pubkeys a member has bound to a Hive (for revoke targeting).
 *
 * ⚠ SCOPE (WI-6312): FEDERATED scope. Attestations and revocations are columns of the SAME
 * row, so this MUST be read under the same scope as `loadRevokedHivePubkeys` — reading one
 * under the local handle and the other under the federated scope is how a revoked device
 * passes an admission check.
 */
export async function loadHiveMemberDevicePubkeys(
  workspaceId: string,
  potHomeSlug: FederatedPotScope,
  githubUserId: number,
  sql?: Sql,
): Promise<string[]> {
  const member = await getHiveMember(workspaceId, potHomeSlug, githubUserId, sql);
  if (!member) return [];
  const out = new Set<string>();
  for (const a of member.deviceAttestations) {
    if (a && typeof a.device_pubkey === 'string' && a.device_pubkey.length > 0) {
      out.add(a.device_pubkey);
    }
  }
  return [...out];
}

/**
 * WI-787 / WI-780 — resolve the OWNER device pubkey the SIGNED, gh-verified hive-announce
 * binds to a `hive_pubkey`, for the owner-log BOOTSTRAP admit on a fresh joiner whose
 * `hive_members` roster is still empty (boot.ts `resolveSameHiveMember`; the bootstrap
 * deadlock — the roster that would admit the owner lives inside the owner's un-merged log).
 *
 * SOURCE = the P2P hive-directory offline cache (`hive_directory_cache`, migration 182).
 * The directory ONLY records a descriptor after it passes `verifyHiveAnnounce` (Ed25519 sig
 * + the `owner_device_pubkey ↔ hive_pubkey` binding), so the `(hivePubkey → ownerDevicePubkey)`
 * entry read here is CRYPTOGRAPHICALLY VERIFIED — never a self-asserted/unverified value. This
 * is the SAME signed binding the bootstrap admit intends to trust; matching is on the base64
 * `hive_pubkey`. Fail-closed: returns null when there is no verified descriptor for that hive
 * in this workspace (→ no bootstrap, the safe default). Never throws.
 */
export async function loadHiveOwnerDevicePubkey(
  workspaceId: string,
  hivePubkeyBase64: string,
): Promise<string | null> {
  if (!hivePubkeyBase64) return null;
  const bindings = await loadHiveOwnerDeviceBindings(workspaceId);
  for (const b of bindings) {
    if (b.hivePubkey === hivePubkeyBase64) return b.ownerDevicePubkey;
  }
  return null;
}

/**
 * WI-787 / D-053 — the FULL set of VERIFIED `(hivePubkey → ownerDevicePubkey)` bindings the
 * P2P hive-directory knows, MERGED from two sources (D-007 — A→B receive-side fix):
 *
 *   (1) the LIVE in-process directory (`getHiveDirectory().listDiscoveredHives`) — the
 *       in-memory set the directory builds the moment it HEARS a peer's announce, and
 *   (2) the PG offline cache (`hive_directory_cache`, migration 182) — the durable,
 *       cross-reboot mirror `saveCache` persists.
 *
 * Why BOTH (the A→B cross-machine bug): a from-repo / direct-link joiner federates fast on
 * the HIVE-PUBKEY topic (via the memberLink) but its `hive_directory_cache` ROW may never
 * land — the PG write is workspace-scoped, best-effort, and races the substrate boot, and
 * the directory ingest itself rides the SEPARATE, slow global-directory DHT topic (D-007).
 * When only the in-memory set has the owner→hive binding, reading the PG cache ALONE returns
 * [] → `ownerDeviceForTopic` is null → the WI-797 owner-log bootstrap-admit never fires → the
 * joiner applies NOTHING from the owner. Consulting the live directory FIRST closes that gap
 * the instant the owner's announce is heard (the admission retry loop re-checks per inbound
 * federation announce). Same cryptographic guarantee from BOTH sources: an entry exists only
 * after the descriptor passed `verifyHiveAnnounce` (Ed25519 sig + the owner_device↔hive_pubkey
 * binding) — `listDiscoveredHives` returns only ingest-admitted descriptors, exactly like the
 * cache it feeds.
 *
 * Returned so a caller that knows only the swarm TOPIC (an invite/link joiner boots on a
 * `kind:'topic'` binding — it learns the Hive's TOPIC HASH, not its pubkey) can recover the
 * owner device by deriving each known hive's topic and matching it. The single-pubkey
 * `loadHiveOwnerDevicePubkey` above is the by-pubkey lookup; this is the by-topic enabler.
 * Fail-closed per-source (a failing source contributes nothing); never throws.
 */
export async function loadHiveOwnerDeviceBindings(
  workspaceId: string,
): Promise<Array<{ hivePubkey: string; ownerDevicePubkey: string }>> {
  const out: Array<{ hivePubkey: string; ownerDevicePubkey: string }> = [];
  const seen = new Set<string>();
  const accept = (hivePubkey?: string, ownerDevicePubkey?: string): void => {
    if (
      typeof hivePubkey === 'string' &&
      hivePubkey.length > 0 &&
      typeof ownerDevicePubkey === 'string' &&
      ownerDevicePubkey.length > 0 &&
      !seen.has(hivePubkey)
    ) {
      seen.add(hivePubkey);
      out.push({ hivePubkey, ownerDevicePubkey });
    }
  };

  // (0) REGISTRY view coords — stamped at JOIN time (join-hive.ts) from the verified
  // discovery descriptor. This is the DETERMINISTIC leg (2026-07-01 Brief-3 live
  // finding): a link/discovery joiner gets the binding the moment it joins, in every
  // process, instead of waiting for its own directory instance to (re-)hear the
  // owner's announce — a multi-minute race that live-blocked owner→joiner federation
  // (owner-admit match=false for 15+ min while the descriptor sat only in ANOTHER
  // process's directory). The registry read is the one store proven to resolve in
  // the substrate sidecar.
  try {
    const { loadHarnessRegistry } = await import('./harness-registry');
    const reg = await loadHarnessRegistry(workspaceId);
    for (const p of reg.projects) {
      if (p.remote_hive === true) accept(p.hive_pubkey, p.owner_device_pubkey);
    }
  } catch {
    /* registry unavailable — fall through to the directory legs */
  }

  // (1) LIVE in-process directory — present the instant the owner's fresh announce is heard,
  // independent of the racy/workspace-scoped PG cache write. This is the leg that unblocks a
  // direct-link/from-repo joiner whose PG cache row never landed (D-007). Best-effort: a
  // missing/unwired singleton (or the SPA bundle, where the directory has no transport) just
  // yields nothing and falls through to the durable cache below.
  try {
    const { getHiveDirectory } = await import('./hive-directory-deps');
    for (const h of getHiveDirectory().listDiscoveredHives({ includeExpired: true })) {
      accept(h?.hivePubkey, h?.ownerDevicePubkey);
    }
  } catch {
    /* directory unavailable — fall through to the PG offline cache */
  }

  // (2) PG offline cache (migration 182) — the durable mirror, deduped against the live set.
  try {
    const { readOperatorState } = await import('./operator-state-pg');
    const row = await readOperatorState<{
      hives?: Array<{ hivePubkey?: string; ownerDevicePubkey?: string }>;
    }>('pot_directory_cache', workspaceId).catch(() => null);
    for (const h of row?.hives ?? []) {
      accept(h?.hivePubkey, h?.ownerDevicePubkey);
    }
  } catch {
    /* cache read failed — return whatever the live directory already contributed */
  }

  return out;
}

/**
 * WI-559 — the CANONICAL (owner-authored) hive-home slug for `hivePubkey` as carried
 * by the owner's signed directory announce (`DiscoveredHive.potId`), else null.
 *
 * WHY THIS EXISTS. A JOINER's local view slug is a LOCAL NAMING AFFORDANCE, not an
 * identity: `join-hive.ts:265` derives it `freeSlug(kebab(opts.potId), taken)`, which
 * deliberately SUFFIXES on a local name collision (`spoon-knife-pot-2`). So the local
 * slug can legitimately differ from the owner's home slug on a perfectly healthy join —
 * and it also differed on the WI-559 rig because `lookup-hive-for-repo` leg 3 fabricated
 * the `potId` from a display TITLE. Either way, the joiner then bound every hive-home-
 * grained projection to a slug the owner never uses, and the demux dropped EVERY inbound
 * row for that hive (~12 projections: pot_members, pot_settings, agent_facts, memories,
 * gym elites, policy, reports, epoch keys, p2p tags). Whole-hive federation blackout;
 * presence was merely where it became visible.
 *
 * The pubkey is the Hive's real identity and already agrees across machines, so it is
 * the only sound key to recover the owner's slug by. The announce is signature-verified
 * upstream (`listDiscoveredHives` returns only ingest-admitted descriptors, exactly like
 * the cache it feeds), so this cannot be steered by an unverified peer.
 *
 * Fail-CLOSED per source and overall: any miss returns null and the caller keeps its
 * local slug (today's behavior) — never throws.
 */
export async function loadAnnouncedHiveHomeSlug(
  workspaceId: string,
  hivePubkey: string,
): Promise<string | null> {
  if (typeof hivePubkey !== 'string' || hivePubkey.length === 0) return null;
  const pick = (h?: {
    hivePubkey?: string;
    potId?: string;
    potIdSynthetic?: boolean;
  }): string | null => {
    if (!h || h.hivePubkey !== hivePubkey) return null;
    // WI-559: SKIP a synthetic descriptor. The D-007 join-link seed mints a verified
    // (hivePubkey → ownerDevicePubkey) binding but DERIVES its potId (`${repoName}-pot`)
    // because it has no announce to read one from, and it is add-if-absent so it can
    // outlive the real beacon. Trusting that guess as the demux key could rebind a
    // joiner whose local slug was already CORRECT onto a wrong one — turning this repair
    // into a regression. A guessed slug is exactly what this function exists to replace.
    if (h.potIdSynthetic === true) return null;
    const potId = typeof h.potId === 'string' ? h.potId.trim() : '';
    return potId.length > 0 ? potId : null;
  };

  // (1) LIVE in-process directory — present the instant the owner's fresh announce is
  // heard, independent of the racy/workspace-scoped PG cache write (same leg ordering
  // and rationale as loadHiveOwnerDeviceBindings above).
  try {
    const { getHiveDirectory } = await import('./hive-directory-deps');
    for (const h of getHiveDirectory().listDiscoveredHives({ includeExpired: true })) {
      const hit = pick(h);
      if (hit) return hit;
    }
  } catch {
    /* directory unavailable — fall through to the PG offline cache */
  }

  // (2) PG offline cache (migration 182) — the durable mirror. This is the leg that
  // answers on a cold boot, before this process has re-heard the owner's announce.
  try {
    const { readOperatorState } = await import('./operator-state-pg');
    const row = await readOperatorState<{
      hives?: Array<{ hivePubkey?: string; potId?: string }>;
    }>('pot_directory_cache', workspaceId).catch(() => null);
    for (const h of row?.hives ?? []) {
      const hit = pick(h);
      if (hit) return hit;
    }
  } catch {
    /* cache read failed — no canonical answer available here */
  }

  return null;
}

/**
 * Upsert a Hive member row (admission). On conflict the scalar fields are
 * updated and the device/revocation sets are MERGED, never replaced
 * (WI-1585, LIVE-1 second-device admission):
 *
 *   - `device_attestations` — UNION by device_pubkey, the SUPPLIED entry wins
 *     per device. The old REPLACE semantics meant a one-device upsert (every
 *     announce admission passes only the ANNOUNCING device) clobbered every
 *     other attested device of the same GitHub user — so a user's tower +
 *     iMac devices could never BOTH stay attested (last announce won), and
 *     M6/H3 content projections then refused the clobbered device's rows:
 *     content federation dead while presence (machine-grain, unattested)
 *     still flowed. Merged entries whose pubkey is in the merged revoked set
 *     are dropped (C-001: a revoked device must not resurface via merge).
 *   - `revoked_pubkeys` — UNION (revocation is STICKY/monotone). The old
 *     REPLACE let any announce-driven upsert (revokedPubkeys defaults to [])
 *     silently wipe revocations — resurrecting revoked devices. Un-revoking
 *     is deliberately NOT expressible through this upsert; that is an
 *     explicit owner surface (none exists today).
 *
 * Device REMOVAL is likewise not this function's job — revoke the pubkey
 * (revokeHiveMemberPubkeys); the merge then drops its attestation.
 */
export async function upsertHiveMember(
  input: UpsertHiveMemberInput,
  sql?: Sql,
): Promise<HiveMemberRecord> {
  assertStorableWorkspaceId(input.workspaceId, 'upsertHiveMember');
  const rows = (await pg(sql).unsafe(
    `INSERT INTO harness_shared.pot_members
       (workspace_id, pot_home_slug, github_user_id, github_username,
        display_name, avatar_url, device_attestations, revoked_pubkeys, binding_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text[], $9)
     ON CONFLICT (workspace_id, pot_home_slug, github_user_id) DO UPDATE SET
       github_username = EXCLUDED.github_username,
       display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url,
       device_attestations = (
         SELECT COALESCE(jsonb_agg(att ORDER BY ord), '[]'::jsonb)
           FROM (
             SELECT DISTINCT ON (t.att->>'device_pubkey') t.att AS att, t.ord AS ord
               FROM jsonb_array_elements(
                      harness_shared.pot_members.device_attestations || EXCLUDED.device_attestations
                    ) WITH ORDINALITY AS t(att, ord)
              ORDER BY t.att->>'device_pubkey', t.ord DESC
           ) merged
          WHERE NOT (merged.att->>'device_pubkey' = ANY (
                  harness_shared.pot_members.revoked_pubkeys || EXCLUDED.revoked_pubkeys))
       ),
       revoked_pubkeys = ARRAY(
         SELECT DISTINCT unnest(harness_shared.pot_members.revoked_pubkeys || EXCLUDED.revoked_pubkeys)
       ),
       binding_status = EXCLUDED.binding_status
     RETURNING ${COLS}`,
    [
      input.workspaceId,
      input.potHomeSlug,
      input.githubUserId,
      input.githubUsername,
      input.displayName ?? null,
      input.avatarUrl ?? null,
      JSON.stringify(input.deviceAttestations ?? []),
      input.revokedPubkeys ?? [],
      input.bindingStatus ?? 'unverified',
    ],
  )) as unknown as HiveMemberPgRow[];
  const record = rowToRecord(rows[0]);
  // Re-key member-add (shared-hive-rekey-2026-06-19): the owner's trust-admit of a member
  // funnels through here, so grant the new member's devices every epoch key [0..current] →
  // they can decrypt EXISTING hive content (the project), closing the join-time gap (content
  // is encrypted-once per epoch + never re-encrypted, so current-epoch-only wouldn't read
  // history — c2a63's correctness call). grantEpochKeysToMembers SELF-GATES to the owner
  // (no-op without the hive key), is flag-gated (papercusp-hive-rekey), and is idempotent per
  // (epoch, member). Best-effort: a grant failure must NOT fail the membership write (the row
  // is the source of truth; the grant retries on the next admission). DYNAMIC import avoids the
  // hive-membership-store ↔ hive-epoch-boundary-wiring cycle.
  try {
    // WI-40537 / D-063 §4 (as refined by c75945): the grant set is the POST-SCRUB `record`'s
    // devices intersected with THIS announce's frame, then filtered against the HIVE-WIDE
    // revoked union — never the raw frame alone. The raw `input.deviceAttestations` is exactly
    // what a banned member's re-announce controls: on the `already_member` branch a hive-wide
    // ban lands on the OWNER's row (addRevokedHivePubkeys), so the row-local merge scrub above
    // (this row's blocklist ∪ EXCLUDED's) cannot see it — and the pre-fix code read the raw
    // frame anyway (never the scrubbed output), re-granting every epoch key [0..current] to the
    // banned device. The structure now mirrors the SAFE sibling leg
    // (reconcileEpochKeysForCurrentMembers :382-406): the announce frame is a FILTER over
    // independently-derived truth, never the authority.
    const announced = new Set(
      (input.deviceAttestations ?? [])
        .map((d) => d.device_pubkey)
        .filter((pk): pk is string => typeof pk === 'string' && pk.length > 0),
    );
    // Post-scrub survivors of THIS announce (`record` is the stored row AFTER the merge dropped
    // row-local-revoked attestations) — announced − row-local-revoked.
    const surviving = (record.deviceAttestations ?? [])
      .map((d) => d.device_pubkey)
      .filter((pk): pk is string => typeof pk === 'string' && pk.length > 0 && announced.has(pk));
    if (surviving.length > 0) {
      const { grantEpochKeysToMembers, isHiveRekeyEnabled } = await import(
        './sync/hyperbee/hive-epoch-boundary-wiring'
      );
      const enabled = await isHiveRekeyEnabled();
      // Hive-wide revoked union — read only when the grant could actually run (flag on), and
      // per-ADMISSION, never per-member-per-epoch (c75945 ruling 1: the hook is the primary fix
      // site precisely because this read is per-admission here). Same FEDERATED scope as the
      // row write above: `input.potHomeSlug` is branded FederatedPotScope, and reading this
      // union under a local handle returns an EMPTY set = silent re-grant
      // (EI-18777176681958978's fail-open trap).
      const revoked = enabled
        ? await loadRevokedHivePubkeys(input.workspaceId, input.potHomeSlug, sql)
        : new Set<string>();
      const newMemberPubkeys = surviving.filter((pk) => !revoked.has(pk));
      if (newMemberPubkeys.length === 0) {
        // Every announced-and-surviving device is hive-wide banned (the WI-40537 shape: a banned
        // member's re-announce). The grant is NOT called; record the same loud queryable skip the
        // grant's own early-returns get below — 0 keys minted must never be silent.
        try {
          const { recordBootEvent } = await import('./sync/hyperbee/boot-history');
          recordBootEvent(
            input.workspaceId,
            input.potHomeSlug,
            'rekey_grant_skipped',
            `grantEpochKeysToMembers on upsertHiveMember skipped for gh=${input.githubUserId}: all-revoked`,
          );
        } catch {
          /* boot-history unavailable */
        }
        return record;
      }
      const grantResult = await grantEpochKeysToMembers({
        workspaceId: input.workspaceId,
        potHomeSlug: input.potHomeSlug,
        enabled,
        newMemberPubkeys,
        sql,
      });
      // WI-280: a SILENT non-throw 0-keys early-return (flag-disabled / no-fresh-members / no-author)
      // must still NAME its cause — the same loud-signal guarantee as the throw path (328af's skip-trace).
      // grantEpochKeysToMembers returns { applied:false, reason } on each early-return; surface it as a
      // queryable rekey_grant_skipped boot-event so an admit/approve that mints 0 keys is never silent
      // (the admit seam routes through here now, so this preserves part-B's skip-trace on that path too).
      // Skip reason==='no-author' (328af): the benign non-owner self-gate fires on EVERY non-owner
      // admit (pure noise); the witness runs on the OWNER box where it won't fire. 'flag-disabled' is
      // the real silent-0-keys signal; 'no-fresh-members' can't fire (gated on newMemberPubkeys above).
      if (!grantResult.applied && grantResult.reason && grantResult.reason !== 'no-author') {
        try {
          const { recordBootEvent } = await import('./sync/hyperbee/boot-history');
          recordBootEvent(
            input.workspaceId,
            input.potHomeSlug,
            'rekey_grant_skipped',
            `grantEpochKeysToMembers on upsertHiveMember skipped for gh=${input.githubUserId}: ${grantResult.reason}`,
          );
        } catch {
          /* boot-history unavailable */
        }
      }
    }
  } catch (e) {
    // WI-280: make this LOUD on EVERY grant path. upsertHiveMember is now the single open-mode
    // grant seam (boot.ts admit routes through it), so the queryable `rekey_grant_failed` boot-event
    // 328af added at the admit seam (part B) must record HERE or it's silently lost when the admit
    // grant is replaced by this upsert. boot-history is a pure in-process buffer (no heavy deps,
    // safe to import into the store). This is a SUPERSET of part-B (admit AND approve), not a regression.
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    try {
      const { recordBootEvent } = await import('./sync/hyperbee/boot-history');
      recordBootEvent(
        input.workspaceId,
        input.potHomeSlug,
        'rekey_grant_failed',
        `grantEpochKeysToMembers on upsertHiveMember failed for gh=${input.githubUserId}: ${detail}`,
      );
    } catch {
      /* boot-history unavailable — the console.error below still surfaces it */
    }
     
    console.error(
      `[hive-rekey] grantEpochKeysToMembers on upsertHiveMember failed (best-effort): ${detail}`,
    );
  }
  return record;
}

/**
 * Add `pubkeys` to a member's revoked_pubkeys (idempotent union). Owner-revocation
 * adds the TARGET's device pubkeys to the OWNER's OWN row (single-writer: a peer
 * can only write its own row; the admission union across all rows is the effective
 * blocklist — see revoke-contributor.ts). Returns the updated row, or null if the
 * owner has no member row yet (must join the Hive before revoking).
 */
export async function addRevokedHivePubkeys(
  workspaceId: string,
  /** ⚠ SCOPE (WI-6312): FEDERATED. A revocation written under the local handle lands where
   *  the admission union never looks — the revocation silently does nothing. */
  potHomeSlug: FederatedPotScope,
  ownerGithubUserId: number,
  pubkeys: string[],
  sql?: Sql,
): Promise<HiveMemberRecord | null> {
  assertStorableWorkspaceId(workspaceId, 'addRevokedHivePubkeys');
  if (pubkeys.length === 0) {
    return getHiveMember(workspaceId, potHomeSlug, ownerGithubUserId, sql);
  }
  // array_cat + dedupe via a fresh distinct set in SQL keeps it a single round-trip.
  const rows = (await pg(sql).unsafe(
    `UPDATE harness_shared.pot_members
        SET revoked_pubkeys = (
          SELECT array_agg(DISTINCT k)
          FROM unnest(revoked_pubkeys || $4::text[]) AS k
        )
      WHERE workspace_id = $1 AND pot_home_slug = $2 AND github_user_id = $3
      RETURNING ${COLS}`,
    [workspaceId, potHomeSlug, ownerGithubUserId, pubkeys],
  )) as unknown as HiveMemberPgRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Delete ONE Hive member's admission row (the membership-teardown leg for a
 * JOINER leaving — G27, shared-hive-public-release-2026-06-22). Single-writer:
 * a peer deletes its OWN row. The mig-189 capture trigger fires AFTER DELETE and
 * enqueues a `del` op (scoped to the Hive home slug) into substrate_outbox, so the
 * departure federates as a membership tombstone (peers' read-merge drops the row).
 * Returns the number of rows deleted (0 = not a member / already gone — idempotent).
 */
export async function removeHiveMember(
  workspaceId: string,
  /** ⚠ SCOPE (WI-6312): FEDERATED. Under the local handle this deletes 0 rows and returns
   *  0 — which is indistinguishable from the idempotent "already gone", so a departure
   *  that never happened reads as a clean one. */
  potHomeSlug: FederatedPotScope,
  githubUserId: number,
  sql?: Sql,
): Promise<number> {
  assertStorableWorkspaceId(workspaceId, 'removeHiveMember');
  const res = await pg(sql).unsafe(
    `DELETE FROM harness_shared.pot_members
      WHERE workspace_id = $1 AND pot_home_slug = $2 AND github_user_id = $3`,
    [workspaceId, potHomeSlug, githubUserId],
  );
  return Number((res as unknown as { count?: number }).count ?? 0);
}

/**
 * Delete ALL of a Hive's member admission rows (the membership-teardown leg for an
 * OWNER dissolving a local hive — G24, shared-hive-public-release-2026-06-22).
 * Without this, a dissolved hive's members lingered in harness_shared.pot_members
 * and kept federating. The mig-189 capture trigger fires per-row AFTER DELETE, so
 * each LOCAL-origin row federates a `del` tombstone (remote-origin rows are removed
 * locally; their federation is owned by their source peer — the trigger's echo
 * guard skips them, by design). Returns the number of rows deleted (idempotent).
 */
export async function removeAllHiveMembers(
  workspaceId: string,
  /** ⚠ SCOPE (WI-6312): FEDERATED. Under the local handle a dissolve drops nothing and the
   *  hive's members keep federating — the G24 teardown silently no-ops. */
  potHomeSlug: FederatedPotScope,
  sql?: Sql,
): Promise<number> {
  assertStorableWorkspaceId(workspaceId, 'removeAllHiveMembers');
  const res = await pg(sql).unsafe(
    `DELETE FROM harness_shared.pot_members
      WHERE workspace_id = $1 AND pot_home_slug = $2`,
    [workspaceId, potHomeSlug],
  );
  return Number((res as unknown as { count?: number }).count ?? 0);
}
