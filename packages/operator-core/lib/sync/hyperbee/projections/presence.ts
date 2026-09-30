/**
 * Hyperbee → PG projection for `harness_shared.shared_presence`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * One row per (workspace, harness, github_user_id, machine_label).
 * The Hyperbee key inside one harness's Hyperbee is
 * `<github_user_id>/<machine_label>` — matches v5 §7.1's
 * `presence/<github_user_id>/<machine_label>` shape after the
 * substrate's tag-prefix is stripped.
 *
 * Distinct from `coord_presence` (the operator-internal per-owner_id
 * dashboard presence). This is the shared, multi-engineer presence
 * surface: which contributors are looking at this harness right now,
 * from which machine, and what they're doing.
 *
 * LWW: ON CONFLICT DO UPDATE always overwrites (last writer wins on
 * the substrate's merge order). del-ops hard-delete the row.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

export interface SharedPresenceRow {
  harness_slug: string;
  github_user_id: number;
  machine_label: string;
  device_pubkey: string;
  intent: string | null;
  current_view: string | null;
  last_seen_at: number;            // epoch ms
  schema_version: number;
  /** The harness's home Hive slug (shared-hive-federation-2026-06-08 P-008/P-009),
   *  or null for a non-Hive harness. Denormalizes the membership onto each
   *  presence row so the per-Hive lock authority can scope by Hive
   *  (lockAuthorityForHive's `WHERE hive_slug=?`, mig 187) without a registry join
   *  on the hot path. Optional on DECODE so pre-P-008 peer-log rows (which lack
   *  it) still validate; the presence publisher stamps it (resolved via
   *  potHomeSlugForHarness) at announce time. */
  hive_slug?: string | null;
  /** EI-18761517980514694 — the per-Hive RUNNER-election capability bit: true when
   *  this node's routine host is live AND it has an ACTIVE cadence-runner routine
   *  (gym-cycle / scout-cycle) for this harness. Stamped by the presence publisher
   *  (see lib/cadence-runner-capability.ts) and consumed via
   *  LockAuthorityDeps.routineHostsOnly, which drops non-capable PEERS from
   *  candidacy — the election previously had no notion of whether the node it
   *  elected could run the loop, so a peer that never fires `gym-cycle` won every
   *  tick and the gym went dark. Optional on DECODE (mirrors hive_slug) so a
   *  pre-upgrade peer's record still validates; absent ⇒ that peer is not a runner
   *  candidate, which is safe because the selectors add SELF unconditionally. */
  runs_routines?: boolean | null;
  /** EI-19330771435294981 (mig 724) — the ACTIVE routine NAMES this node runs for
   *  this harness, at the `(workspace_id, install_slug)` grain of
   *  `harness_shared.routines`. Published so each election asks its OWN capability
   *  question instead of sharing one coarse bit: the cadence-runner election
   *  intersects it with CADENCE_RUNNER_ROUTINES, the git-sync INTEGRATOR election
   *  tests for `'git-sync'`. Pointing the second election at `runs_routines` (the
   *  first one's bit) measurably turned integrator peer arbitration OFF — the bit
   *  was null on every live row because gym-cycle was inactive here.
   *
   *  Stamped by the presence publisher (see lib/cadence-runner-capability.ts
   *  `nodeActiveRoutines`), deduped + sorted so an unchanged set produces
   *  byte-identical signed frames. Optional on DECODE (mirrors `runs_routines`)
   *  so a pre-upgrade peer's record still validates; absent/empty ⇒ that peer is
   *  not a candidate for either election, which is safe because both selectors
   *  re-add SELF unconditionally after the exclusion filter. */
  active_routines?: readonly string[] | null;
}

export interface PresenceProjectionOpts {
  /** Test/multi-peer seam — write to THIS postgres-js client instead of the
   *  process-global `getOrgPg().sql`. Production leaves this undefined. */
  sql?: postgres.Sql;
  workspaceId: string;
  harnessSlug: string;
}

function composeKey(row: SharedPresenceRow): string {
  return `${row.github_user_id}/${row.machine_label}`;
}

export function isSharedPresenceRow(input: unknown): input is SharedPresenceRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' && r.harness_slug.length > 0 &&
    typeof r.github_user_id === 'number' && Number.isInteger(r.github_user_id) && r.github_user_id > 0 &&
    typeof r.machine_label === 'string' && r.machine_label.length > 0 &&
    typeof r.device_pubkey === 'string' && r.device_pubkey.length > 0 &&
    (r.intent === null || typeof r.intent === 'string') &&
    (r.current_view === null || typeof r.current_view === 'string') &&
    typeof r.last_seen_at === 'number' && Number.isFinite(r.last_seen_at) &&
    typeof r.schema_version === 'number' && Number.isInteger(r.schema_version) &&
    // hive_slug is optional (absent on pre-P-008 rows) + nullable (non-Hive harness).
    (r.hive_slug === undefined || r.hive_slug === null || typeof r.hive_slug === 'string') &&
    // runs_routines is optional (absent on pre-EI-18761517980514694 peer records) +
    // nullable (publisher could not resolve it) — never reject an older peer's row.
    (r.runs_routines === undefined ||
      r.runs_routines === null ||
      typeof r.runs_routines === 'boolean') &&
    // active_routines is optional (absent on pre-mig-724 peer records) + nullable
    // (publisher could not resolve it) — never reject an older peer's row. When
    // present it must be an array of non-empty strings: this rides the SIGNED
    // frame and lands in a text[] column, so a malformed payload from a peer is
    // rejected here rather than at the INSERT.
    (r.active_routines === undefined ||
      r.active_routines === null ||
      (Array.isArray(r.active_routines) &&
        r.active_routines.every((n) => typeof n === 'string' && n.length > 0)))
  );
}

function decodeValue(raw: unknown): SharedPresenceRow | null {
  return isSharedPresenceRow(raw) ? raw : null;
}

async function writeToPg(
  opts: PresenceProjectionOpts,
  row: SharedPresenceRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  // D-013 author-scope: persist the writer's unforgeable provenance author so
  // deleteFromPg can scope a leave-tombstone to it (the hyperbee-log transport
  // supplies the log-source key, the presence-gossip transport the signer device
  // pubkey — each transport writes AND deletes with the SAME identity). Mirrors
  // the proven coord_event_log author_pubkey pattern.
  const authorPubkey = provenance?.authorPubkey ?? null;
  await sql`
    INSERT INTO harness_shared.shared_presence
      (workspace_id, harness_slug, github_user_id, machine_label, device_pubkey,
       intent, current_view, last_seen_at, schema_version, pot_slug, fed_ts, fed_hlc,
       author_pubkey, runs_routines, active_routines)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.github_user_id}, ${row.machine_label},
       ${row.device_pubkey}, ${row.intent}, ${row.current_view},
       to_timestamp(${row.last_seen_at} / 1000.0),
       ${row.schema_version}, ${row.hive_slug ?? null}, ${fedTs}, ${fedHlc},
       ${authorPubkey}, ${row.runs_routines ?? null},
       ${row.active_routines ? [...row.active_routines] : null})
    ON CONFLICT (workspace_id, harness_slug, github_user_id, machine_label) DO UPDATE SET
      device_pubkey = EXCLUDED.device_pubkey,
      intent = EXCLUDED.intent,
      current_view = EXCLUDED.current_view,
      last_seen_at = EXCLUDED.last_seen_at,
      schema_version = EXCLUDED.schema_version,
      pot_slug = EXCLUDED.pot_slug,
      fed_ts = EXCLUDED.fed_ts,
      fed_hlc = EXCLUDED.fed_hlc,
      author_pubkey = EXCLUDED.author_pubkey,
      runs_routines = EXCLUDED.runs_routines,
      active_routines = EXCLUDED.active_routines
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(shared_presence.fed_hlc, shared_presence.fed_ts)
  `;
}

async function deleteFromPg(
  opts: PresenceProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
  provenance?: ProvenanceContext,
): Promise<void> {
  // key shape: `<github_user_id>/<machine_label>`
  const sepIdx = key.indexOf('/');
  if (sepIdx <= 0) return;
  const userIdStr = key.slice(0, sepIdx);
  const machineLabel = key.slice(sepIdx + 1);
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId) || userId <= 0 || !machineLabel) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  // H2 (audit D-013): when the caller author-scopes the tombstone, restrict the
  // delete to rows written by that SAME provenance author — a member can only
  // tombstone its own presence rows, never evict a peer's (the de-presence DoS
  // that breaks lock-authority election). Scoped by the stored `author_pubkey`
  // (persisted by writeToPg from provenance), NOT device_pubkey: the two agree on
  // the gossip transport (author = signer device) but DIVERGE on the hyperbee-log
  // transport (author = log-source key, device_pubkey = the row value's self-
  // declared device) — comparing device_pubkey there scoped out every legit
  // log-path leave-tombstone. Each transport writes AND deletes with the same
  // author identity, so a self-tombstone matches and a forged one never does.
  // Author-scoped tombstones must fail closed when a legacy/direct caller
  // omits provenance. The canonical apply path always supplies it; refusing
  // here prevents an absent author from widening the delete to every row.
  if (!provenance) return;
  const authorDevice = provenance.authorPubkey;
  await sql`
    DELETE FROM harness_shared.shared_presence
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      AND machine_label = ${machineLabel}
      AND author_pubkey = ${authorDevice}::text
      -- EI-79 step 2 + D-001: guard the delete by the SAME fed_order_key() order (EI-1698)
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildPresenceProjection(opts: PresenceProjectionOpts): TableProjection<SharedPresenceRow> {
  return {
    tableTag: 'presence',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc, provenance) => deleteFromPg(opts, key, delTs, delHlc, provenance),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isSharedPresenceRow,
};
