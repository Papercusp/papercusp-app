/**
 * Cross-surface voice lease — elects the single HOST + PLAYER of the ONE shared
 * operator voice session (universal-voice-interface-2026-06-05, Model A / D-003).
 *
 * Re-meaning (was: "only one device may listen at a time", mutual exclusion):
 * the session is now hosted by the voice SERVICE (`OperatorVoiceSession`), and
 * desktop + tui both attach to it as full clients over the voice-node bus —
 * receiving the input transcript AND the response (audio + transcript + tags)
 * and able to drive controls. The lease no longer gates *who is allowed voice*;
 * it elects *who renders the response audio and captures the mic* (Model A: only
 * the elected player plays, so the same audio never doubles/echoes). NON-HOLDERS
 * ARE NEVER REFUSED — they stay receive+display+control clients. `force=1` takes
 * over the host+player role (the user explicitly toggled "play here"); the host's
 * `electPlayer` is the sole interpreter of this primitive (it does NOT steal the
 * role on a plain, non-forcing start while another client hosts).
 *
 * Mechanics (unchanged): a per-workspace row in `harness_shared.voice_lease`
 * with a 12s heartbeat-based expiry. A new/forced owner emits
 * `voiceLease.current` on the sync-invalidate channel so other surfaces re-sync
 * their elected-player flag (and the host re-elects when the player drops, so
 * the session survives either UI closing). The server is the source of truth.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { notifySyncInvalidate } from './sync-sse';

const vl = generated.voiceLeaseInHarnessShared;

const LEASE_MS = 12_000;

export type VoiceLeaseKind = 'desktop' | 'mobile' | 'tui';

export interface VoiceLease {
  workspaceId: string;
  ownerId: string;        // tabId (desktop) | deviceId (mobile) | pui owner id (tui)
  ownerKind: VoiceLeaseKind;
  expiresAtMs: number;
}

// NOTE: the `harness_shared.voice_lease` table + `voice_lease_expires_idx` index
// are defined in `000-baseline.sql` (the 'tui' owner_kind added by migration 166);
// harness_app's grants come from migration 109. The runtime `ensureLeaseTable()`
// `CREATE TABLE/INDEX IF NOT EXISTS` + `GRANT` that used to live here was redundant
// (a "schema = migrations only" no-op) and was removed in
// self-contained-migration-baseline-2026-06-02 (P-008b-remainder).

/**
 * Claim or refresh the lease for a workspace. Behavior:
 *  - No row OR row expired → INSERT/UPSERT this owner; return success.
 *  - Same owner → refresh expiry; return success.
 *  - Different owner with valid lease → return current owner without
 *    modifying. Caller decides whether to pre-empt (mobile always pre-empts;
 *    desktop yields).
 *
 * Pre-emption mode (`force: true`) overwrites any active lease. The phone
 * uses this on user tap; desktops use it when the user explicitly toggles
 * voice on (signaling intent).
 */
export async function claimVoiceLease(opts: {
  workspaceId: string;
  ownerId: string;
  ownerKind: VoiceLeaseKind;
  force?: boolean;
}): Promise<{ granted: boolean; lease: VoiceLease }> {
  const { db } = getOrgPg();
  const now = Date.now();
  const expiresAtMs = now + LEASE_MS;

  if (opts.force) {
    await db
      .insert(vl)
      .values({
        workspaceId: opts.workspaceId,
        ownerId: opts.ownerId,
        ownerKind: opts.ownerKind,
        expiresAtMs: expiresAtMs,
      })
      .onConflictDoUpdate({
        target: vl.workspaceId,
        set: {
          ownerId: dsql`EXCLUDED.owner_id`,
          ownerKind: dsql`EXCLUDED.owner_kind`,
          expiresAtMs: dsql`EXCLUDED.expires_at_ms`,
        },
      });
    void notifySyncInvalidate('voiceLease.current', { workspaceId: opts.workspaceId });
    return {
      granted: true,
      lease: {
        workspaceId: opts.workspaceId,
        ownerId: opts.ownerId,
        ownerKind: opts.ownerKind,
        expiresAtMs,
      },
    };
  }

  const rows = await db
    .select({
      ownerId: vl.ownerId,
      ownerKind: vl.ownerKind,
      expiresAtMs: vl.expiresAtMs,
    })
    .from(vl)
    .where(eq(vl.workspaceId, opts.workspaceId));
  const current = rows[0] as { ownerId: string; ownerKind: VoiceLeaseKind; expiresAtMs: number } | undefined;
  const expired = !current || Number(current.expiresAtMs) < now;
  const same = current && current.ownerId === opts.ownerId;

  if (expired || same) {
    await db
      .insert(vl)
      .values({
        workspaceId: opts.workspaceId,
        ownerId: opts.ownerId,
        ownerKind: opts.ownerKind,
        expiresAtMs: expiresAtMs,
      })
      .onConflictDoUpdate({
        target: vl.workspaceId,
        set: {
          ownerId: dsql`EXCLUDED.owner_id`,
          ownerKind: dsql`EXCLUDED.owner_kind`,
          expiresAtMs: dsql`EXCLUDED.expires_at_ms`,
        },
      });
    if (expired || (current && current.ownerId !== opts.ownerId)) {
      void notifySyncInvalidate('voiceLease.current', { workspaceId: opts.workspaceId });
    }
    return {
      granted: true,
      lease: {
        workspaceId: opts.workspaceId,
        ownerId: opts.ownerId,
        ownerKind: opts.ownerKind,
        expiresAtMs,
      },
    };
  }

  return {
    granted: false,
    lease: {
      workspaceId: opts.workspaceId,
      ownerId: current.ownerId,
      ownerKind: current.ownerKind,
      expiresAtMs: Number(current.expiresAtMs),
    },
  };
}

export async function releaseVoiceLease(opts: {
  workspaceId: string;
  ownerId: string;
}): Promise<void> {
  const { db } = getOrgPg();
  await db.delete(vl).where(and(eq(vl.workspaceId, opts.workspaceId), eq(vl.ownerId, opts.ownerId)));
  void notifySyncInvalidate('voiceLease.current', { workspaceId: opts.workspaceId });
}

export async function readVoiceLease(workspaceId: string): Promise<VoiceLease | null> {
  const { db } = getOrgPg();
  const rows = await db
    .select({
      ownerId: vl.ownerId,
      ownerKind: vl.ownerKind,
      expiresAtMs: vl.expiresAtMs,
    })
    .from(vl)
    .where(and(eq(vl.workspaceId, workspaceId), dsql`${vl.expiresAtMs} >= ${Date.now()}`));
  if (rows.length === 0) return null;
  const r = rows[0] as { ownerId: string; ownerKind: VoiceLeaseKind; expiresAtMs: number };
  return {
    workspaceId,
    ownerId: r.ownerId,
    ownerKind: r.ownerKind,
    expiresAtMs: Number(r.expiresAtMs),
  };
}
