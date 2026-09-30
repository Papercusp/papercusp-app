/**
 * Hyperbee → PG projection for `harness_shared.pot_members` — per-Hive
 * contributor/device admission federated across a Hive's Swarms
 * (shared-hive-federation-2026-06-08 P-006, D-004). MULTI-SWARM ONLY (P-010/P-011):
 * it replicates the admission record (who's admitted + the revoked_pubkeys
 * blocklist) so a revocation written on one Swarm reaches another Swarm's
 * admission union (loadRevokedHivePubkeys → boot.ts seam-1). Single-box + the
 * per-Hive gate work without it.
 *
 * Mirrors projections/contributors.ts (the harness-grain analog) + the federation
 * shape of projections/hive-settings.ts (the freshest per-Hive template). The
 * federated subset = the Hive scope (`pot_home_slug` = the Hive's home_slug, the
 * per-projection demux key), the contributor identity, and the admission-bearing
 * fields (device_attestations + the revoked_pubkeys blocklist + binding_status).
 * NOT federated (machine-local): joined_at/last_seen_at/the channel timestamps.
 *
 * The per-projection guard (`row.pot_home_slug !== opts.harnessSlug`, where
 * opts.harnessSlug is the registered Hive HOME harness slug) demuxes: a Hive home
 * harness's projection applies its Hive's member ops; everyone else drops them.
 * No hard dependency on the local hives row (a member can land before the hive
 * identity materializes on a peer — cross-machine join ordering).
 *
 * ── WIRING THIS NEEDS (su-02ae39's register-all/op-keys lane, mirrors hive_settings) ──
 *   1. Migration on hive_members adding the standard federation columns
 *      `fed_ts bigint`, `origin text NOT NULL DEFAULT 'local'`, `author_pubkey text`
 *      (this projection's writeToPg reads/writes them for the echo-guard + LWW).
 *   2. The capture trigger. NOTE: capture_substrate_outbox reads `NEW.harness_slug`
 *      for the outbox scope (000-baseline), but hive_members' scope column is
 *      `pot_home_slug`. So EITHER a thin custom capture fn that sets
 *      outbox.harness_slug := NEW.pot_home_slug, OR align the column to
 *      `harness_slug` like hive_settings did. (Read-side here is column-agnostic.)
 *   3. feature-issue-op-keys.ts: `hive_members → 'hive-members'` + a toHiveMemberValue
 *      mapper (the to_jsonb row → HiveMemberRow; device_attestations stays an array).
 *   4. register-all.ts: register buildHiveMembersProjection per Hive home harness.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import type { DeviceAttestationEntry } from '../../../harness/contributor-row-types';
import { invalidateHiveMemberDeviceSet } from '../hive-member-identity-set';
import { invalidatePresenceGossipMemberCache } from '../presence-gossip-wiring';
import { recordBootEvent } from '../boot-history';
import {
  reapplyDrainedMemberContent,
  type PendingMembershipContent,
} from '../pending-membership-content';

/** Wire-shape of a hive_members row in Hyperbee — the federated subset. Defensive
 *  on every field; a malformed remote op is dropped (decodeValue → null). */
export interface HiveMemberRow {
  /** The Hive's home_slug — the per-projection demux key. */
  pot_home_slug: string;
  github_user_id: number;
  github_username: string;
  /** This member's bound devices on this Hive (the admission material). */
  device_attestations: DeviceAttestationEntry[];
  /** The revoked-pubkey blocklist (federates → admission union denies these). */
  revoked_pubkeys: string[];
  binding_status: string;
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function isHiveMemberRow(input: unknown): input is HiveMemberRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.pot_home_slug !== 'string' || r.pot_home_slug.length === 0) return false;
  if (!isPosInt(r.github_user_id)) return false;
  if (typeof r.github_username !== 'string' || r.github_username.length === 0) return false;
  if (!Array.isArray(r.device_attestations)) return false;
  if (!Array.isArray(r.revoked_pubkeys)) return false;
  if (typeof r.binding_status !== 'string') return false;
  return true;
}

export interface HiveMembersProjectionOpts {
  workspaceId: string;
  /** The registered Hive HOME harness slug — the demux scope. */
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** WI-259 P-004: the content-before-membership defer buffer. When THIS member's row applies
   *  (a join / device-change), drain + re-apply any cross-member content ops that were deferred
   *  waiting on this member's device pubkeys (the onMemberApplied hook). Undefined ⇒ no drain
   *  (buffer not wired / non-hive). Threaded via RegisterAllOpts (the `hiveScoped` spread). */
  pendingMemberContent?: PendingMembershipContent;
  /** WI-259 P-002 admission map (sourceLogKeyHex → verified device pubkey), threaded via
   *  RegisterAllOpts (the `hiveScoped` spread). Used by the F1-5 revocation purge to cover
   *  the DEVICE grain (revoked_pubkeys hold device keys; foreign-elite rows are keyed by
   *  source-log key). Undefined ⇒ log-grain-only purge. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
}

/** Within a Hive's peer-log the member key is `<github_user_id>` (the Hive is
 *  implicit), mirroring contributors' per-harness `<github_user_id>` key. */
function composeKey(row: HiveMemberRow): string {
  return String(row.github_user_id);
}

function decodeValue(raw: unknown): HiveMemberRow | null {
  return isHiveMemberRow(raw) ? raw : null;
}

/**
 * EI-18771324701216281 — the cross-Hive roster drop below used to be observable ONLY
 * under `PAPERCUSP_A003_TRACE=1`, i.e. off by default and off in every real install. On
 * WI-559 that meant ~49,762 roster rows were discarded in total silence while the
 * joiner's roster read EMPTY, and the emptiness was nearly taken as evidence of health.
 * A drop that makes the roster permanently wrong must be audible WITHOUT a debug env var.
 *
 * It cannot be an unconditional warn either: the drop is per-op and fires in the tens of
 * thousands, so an ungated line is its own outage. Hence the standard sync-layer throttle
 * (cf. outbox-drain.ts's probe throttles): the FIRST occurrence of each distinct mismatch
 * emits immediately — that is the one a human needs — and subsequent ones coalesce into at
 * most one line per window, carrying the count suppressed since the last emission so the
 * true magnitude is never hidden.
 *
 * Keyed per (bound slug → row's hive-home) so a NEW mismatch is never masked by an
 * already-throttled one.
 */
const A003_DROP_WARN_WINDOW_MS = 60_000;
const a003DropThrottle = new Map<string, { lastWarnAt: number; suppressed: number }>();

/** Test seam: reset the throttle so a test never inherits another test's window. */
export function __resetA003DropWarnThrottleForTest(): void {
  a003DropThrottle.clear();
}

function warnCrossHiveRosterDrop(boundSlug: string, rowHiveHome: string, now: number): void {
  const key = `${boundSlug}\x00${rowHiveHome}`;
  const prev = a003DropThrottle.get(key);
  if (prev && now - prev.lastWarnAt < A003_DROP_WARN_WINDOW_MS) {
    prev.suppressed += 1;
    return;
  }
  const suppressed = prev?.suppressed ?? 0;
  a003DropThrottle.set(key, { lastWarnAt: now, suppressed: 0 });
  console.warn(
    `[hive-members] DROPPING federated roster rows: this projection is bound to ` +
      `'${boundSlug}' but the incoming row's hive-home is '${rowHiveHome}'. ` +
      `The roster for '${rowHiveHome}' will stay INCOMPLETE on this node — an empty ` +
      `pot_members is NOT evidence of health. Usual cause: the hive-home rebind did not ` +
      `engage, so the projection is bound to the local slug instead of the owner-authored ` +
      `one (resolve hive scope by PUBKEY, never by name).` +
      (suppressed > 0
        ? ` [${suppressed} further drop(s) suppressed in the last ${A003_DROP_WARN_WINDOW_MS / 1000}s]`
        : '') +
      ` Set PAPERCUSP_A003_TRACE=1 for the per-op trace.`,
  );
}

async function writeToPg(
  opts: HiveMembersProjectionOpts,
  row: HiveMemberRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.pot_home_slug !== opts.harnessSlug) {
    // A→B roster diagnostic (PAPERCUSP_A003_TRACE, off by default/in tests): the owner's
    // hive_members rows drop SILENTLY here when this projection is bound to the MEMBER slug
    // instead of the hive-home slug (the rekey-rebind didn't engage) → the joiner's roster
    // stays EMPTY even though B admitted + drained the owner log. This is the apply-side twin
    // of the owner-LOG bootstrap-admit; a mismatch on the live trace pins the rebind gap. The
    // line carries an ISO wall-clock timestamp right after the `[A-003]` tag for cross-frame
    // timeline correlation.
    if (process.env.PAPERCUSP_A003_TRACE === '1') {

      console.error(
        `[A-003] ${new Date().toISOString()} hive-members-drop own=${opts.harnessSlug} row.hive_home=${row.pot_home_slug} ` +
          `(cross-Hive: projection NOT bound to hive-home → roster row dropped)`,
      );
    }
    // EI-18771324701216281: audible WITHOUT the debug env var (rate-limited — see above).
    warnCrossHiveRosterDrop(opts.harnessSlug, row.pot_home_slug, Date.now());
    return; // cross-Hive op — drop
  }
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  // D-001: the op's HLC ordering key — the SAME causal key the merge fold uses.
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.pot_members
      (workspace_id, pot_home_slug, github_user_id, github_username,
       device_attestations, revoked_pubkeys, binding_status,
       author_pubkey, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.pot_home_slug}, ${row.github_user_id}, ${row.github_username},
       -- jsonb: JSON.stringify(x)::text::jsonb — sql.json THROWS under getOrgPg
       ${JSON.stringify(row.device_attestations ?? [])}::text::jsonb,
       ${row.revoked_pubkeys as unknown as string},
       ${row.binding_status},
       ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, pot_home_slug, github_user_id) DO UPDATE SET
      github_username     = EXCLUDED.github_username,
      device_attestations = EXCLUDED.device_attestations,
      revoked_pubkeys     = EXCLUDED.revoked_pubkeys,
      binding_status      = EXCLUDED.binding_status,
      author_pubkey       = EXCLUDED.author_pubkey,
      origin              = EXCLUDED.origin,
      fed_ts              = EXCLUDED.fed_ts,
      fed_hlc             = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.pot_members.fed_hlc, harness_shared.pot_members.fed_ts)
  `;
  // WI-259 P-003 fast-path invalidation (the onMemberApplied hook): a member join /
  // device-change may change the hive's member DEVICE set, so drop the P-002 guard's
  // cached set for this hive — the next applied content op re-checks membership against
  // a FRESH set instead of waiting out the 30s TTL backstop (during which a just-joined
  // member's content would be wrongly dropped). opts.harnessSlug IS the pot_home_slug =
  // the (ws, hiveHome) cache key. Shared hook: P-004's PendingMembershipContent drain
  // hangs off this same apply point (ee7e9 P-003 review refinement #1).
  invalidateHiveMemberDeviceSet(opts.workspaceId, opts.harnessSlug);
  // WI-40905: presence-gossip keeps a distinct admitted-device cache over the
  // same pot_members rows. Invalidate it at the SAME source-of-truth hook so a
  // just-applied attestation admits the next presence frame immediately instead
  // of leaving a 30s fail-closed/no-device gap during late boot adoption.
  invalidatePresenceGossipMemberCache(opts.workspaceId, opts.harnessSlug);
  // WI-259 P-004 (the onMemberApplied DRAIN): this member just federated, so any cross-member
  // content op deferred waiting on one of THIS member's device pubkeys can now apply. Drain those
  // entries and re-run their writeToPg — the membership guard re-checks against the now-fresh set
  // (invalidated just above), so it applies them instead of re-dropping. Runs AFTER the invalidate
  // so the re-apply reads the up-to-date member set. NON-RE-ENTRANT: a content writeToPg never
  // fires a hive_members apply, so re-applying deferred content cannot recurse into this drain.
  // Best-effort: a re-apply throw must not abort this member apply (the op stays in the peer log).
  if (opts.pendingMemberContent) {
    const devices = memberDevicePubkeys(row);
    if (devices.size > 0) {
      await reapplyDrainedMemberContent(opts.pendingMemberContent.drainForDevices(devices, Date.now()));
    }
  }
  // F1-5 revocation cleanup (federated-scout-gym-learning-2026-07-02 D-005): a
  // membership apply may carry NEW revoked_pubkeys — purge every foreign QD elite
  // contributed by a now-revoked source so a revoked peer's artifacts stop priming
  // ideation. Covers both grains: source-log keys directly in the blocklist, and
  // device pubkeys resolved via the admission map (opts.resolveAuthorDevice).
  // DYNAMIC import (avoids widening the static projection graph); best-effort — a
  // purge failure must not abort the member apply (rows re-purge on the next one).
  if (row.revoked_pubkeys.length > 0) {
    try {
      const { purgeRevokedForeignElites } = await import('./gym-qd-elites');
      await purgeRevokedForeignElites({
        workspaceId: opts.workspaceId,
        potHomeSlug: opts.harnessSlug,
        revokedPubkeys: row.revoked_pubkeys,
        resolveAuthorDevice: opts.resolveAuthorDevice,
        sql: opts.sql,
      });
    } catch {
      /* best-effort — never fail the member apply on an elite-purge hiccup */
    }
  }
  // WI-887 self-heal epoch-key distribution (the onMemberApplied hook). A membership change can
  // mean a member federated in AFTER an epoch advanced — or was missed while papercusp-hive-rekey
  // was dark — leaving it without the CURRENT epoch key, so it DROPS all current-epoch content at
  // the decrypt gate (the live federation gap, plan shared-hive-member-content-federation D-018).
  // Re-grant [0..current] to the FULL current member set so the stuck member is backfilled the
  // moment any membership op applies. Owner-only (the grant self-gates: loadHivePubkey null on a
  // non-owner box → no-op), flag-gated, idempotent per (epoch, member), C-001-safe (revoked devices
  // excluded). DYNAMIC import avoids the projection ↔ boundary-wiring cycle. Best-effort: a grant
  // failure must NOT abort the member apply (the row is the source of truth; it retries next apply).
  //
  // WI-3828: this used to be a bare `catch {}` — a thrown grant failure was completely
  // invisible (no console, no boot-history), indistinguishable from a healthy no-op self-heal.
  // Mirrors the established rekey_grant_failed/rekey_grant_skipped convention already used at
  // the sibling upsertHiveMember grant call-site (hive-membership-store.ts): record a
  // queryable boot-history event on both the throw path AND a meaningful (non-benign) skip, so
  // a stuck member missing its epoch key is diagnosable from boot-history instead of silent.
  // 'no-gap' (this call's own perf-guard steady state — every live device already holds the
  // current key) and 'no-author' (expected on every non-owner box) are excluded as pure noise —
  // recording either on EVERY membership apply would drown the 200-entry buffer.
  try {
    const { reconcileEpochKeysForCurrentMembers, isHiveRekeyEnabled } = await import(
      '../hive-epoch-boundary-wiring'
    );
    const result = await reconcileEpochKeysForCurrentMembers({
      workspaceId: opts.workspaceId,
      potHomeSlug: opts.harnessSlug,
      enabled: await isHiveRekeyEnabled(),
      sql: opts.sql,
    });
    if (!result.applied && result.reason && result.reason !== 'no-author' && result.reason !== 'no-gap') {
      try {
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'rekey_grant_skipped',
          `reconcileEpochKeysForCurrentMembers on onMemberApplied self-heal skipped: ${result.reason}`,
        );
      } catch {
        /* boot-history unavailable */
      }
    }
  } catch (e) {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    try {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'rekey_grant_failed',
        `reconcileEpochKeysForCurrentMembers on onMemberApplied self-heal failed: ${detail}`,
      );
    } catch {
      /* boot-history unavailable — best-effort, never fail the member apply on this hiccup */
    }
  }
}

/** This member's bound device pubkeys (base64), deduped — the identity grain the P-004 buffer
 *  keys cross-member content deferrals on (matches resolveHiveMemberDeviceSet's grain). */
function memberDevicePubkeys(row: HiveMemberRow): Set<string> {
  const devices = new Set<string>();
  for (const a of row.device_attestations ?? []) {
    if (a && typeof a.device_pubkey === 'string' && a.device_pubkey.length > 0) {
      devices.add(a.device_pubkey);
    }
  }
  return devices;
}

async function deleteFromPg(
  opts: HiveMembersProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  const userId = Number(key);
  if (!Number.isFinite(userId) || userId <= 0) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.pot_members
    WHERE workspace_id = ${opts.workspaceId}
      AND pot_home_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      -- guard the delete by the SAME fed_order_key() order as the put guard (EI-1698).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
  // WI-259 P-003: a member LEAVE removes a device from the hive member set — invalidate
  // the P-002 guard's cache so a just-left member's NEW content stops applying immediately
  // (not after the 30s TTL). Same (ws, hiveHome) key as the put path above.
  invalidateHiveMemberDeviceSet(opts.workspaceId, opts.harnessSlug);
  invalidatePresenceGossipMemberCache(opts.workspaceId, opts.harnessSlug);
}

export function buildHiveMembersProjection(
  opts: HiveMembersProjectionOpts,
): TableProjection<HiveMemberRow> {
  return {
    tableTag: 'hive-members',
    // EI-117: CDC-captured table (mig 189 custom capture) — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isHiveMemberRow };
