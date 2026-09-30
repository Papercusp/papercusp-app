/**
 * ensure-host-routines — boot-time seeding of THIS host's p2p maintenance
 * routines (WI-5327/WI-5657, plan p2p-public-release-remaining-lanes-2026-07-16).
 *
 * V1 delegation is seat → signed spawn_request → projection honor. The retired
 * `kind:'work'` intake action is deliberately absent: nothing authored those
 * records, and seeding its 30-second routine only created permanently idle work.
 *
 * SEEDING ORDER (least to most identity-dependent):
 *   1. ensureSweepOrphanedForeignHarnessesRoutine — no identity needed.
 *   2. ensureP2pForeignSupervisionRoutine — needs the local GitHub identity;
 *      the device pubkey is resolved from the existing keychain seam and may be
 *      null when the keychain is temporarily unavailable (the routine itself
 *      retains its fail-closed behavior).
 *
 * The hook is once-per-process, best-effort and fire-and-forget. It seeds under
 * activeWorkspaceId(), never every registry partition: routines still carry the
 * phase-1 GLOBAL UNIQUE(install_slug, name), so looping over `default`, `*`, and
 * the real workspace could permanently strand a singleton row in an invalid
 * partition. Existing rows remain authoritative through each ensure function's
 * ADD-only/upsert contract.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { activeWorkspaceId } from '../workspace-registry';
import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';
import { resolveDeviceKeychainId } from '../identity/device-keychain-id';
import { resolveP2pGrantWorkspace } from './grant-store';
import { ensureSweepOrphanedForeignHarnessesRoutine } from '../harness/routines/sweep-orphaned-foreign-harnesses-action';
import { ensureP2pForeignSupervisionRoutine } from '../harness/routines/foreign-supervision-action';

export interface EnsureP2pHostRoutinesResult {
  workspaceId: string;
  installSlug: string;
  sweepSeeded: boolean;
  supervisionSeeded: boolean;
  /** Human-readable reasons for anything skipped or degraded. */
  skippedReasons: string[];
}

/** Resolve + seed the two v1 p2p host-maintenance routines for one workspace. */
export async function ensureP2pHostRoutinesForWorkspace(
  workspaceId: string,
  sql: Sql = getOrgPg().sql,
): Promise<EnsureP2pHostRoutinesResult> {
  const installSlug = operatorHomeHarnessSlug();
  const skippedReasons: string[] = [];
  let sweepSeeded = false;
  let supervisionSeeded = false;

  try {
    await ensureSweepOrphanedForeignHarnessesRoutine({ workspaceId, installSlug }, sql);
    sweepSeeded = true;
  } catch (err) {
    skippedReasons.push(
      `sweep-orphaned-foreign-harnesses: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const ident = await resolveLocalGithubIdentity().catch(
    () => ({ kind: 'gh_auth_required' as const }),
  );
  if (ident.kind !== 'ok') {
    skippedReasons.push(
      'p2p-foreign-supervision: gh not authenticated (resolveLocalGithubIdentity) — never fabricated; will resolve after `gh auth login` succeeds on this host.',
    );
    return { workspaceId, installSlug, sweepSeeded, supervisionSeeded, skippedReasons };
  }

  let devicePubkeyBase64: string | null = null;
  try {
    const keychainId = resolveDeviceKeychainId(ident.githubUserId);
    const kp = await loadOrGenerateDeviceKeypair(keychainId);
    devicePubkeyBase64 = kp.pubkeyBase64;
  } catch (err) {
    skippedReasons.push(`device keypair: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await ensureP2pForeignSupervisionRoutine(
      {
        workspaceId,
        installSlug,
        host: {
          responderGithubUserId: ident.githubUserId,
          responderDevicePubkey: devicePubkeyBase64,
        },
      },
      sql,
    );
    supervisionSeeded = true;
  } catch (err) {
    skippedReasons.push(`p2p-foreign-supervision: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { workspaceId, installSlug, sweepSeeded, supervisionSeeded, skippedReasons };
}

let seededOnce = false;

/** Test seam: reset the once-guard between test cases. */
export function _resetEnsureP2pHostRoutinesForTests(): void {
  seededOnce = false;
}

/**
 * Once-per-process, best-effort, fire-and-forget boot hook. `workspaceIds` is
 * accepted for call-site symmetry with sibling hygiene hooks but intentionally
 * ignored; these are singleton home-harness routines.
 */
export function ensureP2pHostRoutinesSeededOnce(workspaceIds?: string[]): void {
  void workspaceIds;
  if (seededOnce) return;
  seededOnce = true;
  void (async () => {
    const active = activeWorkspaceId();
    const workspaceId = resolveP2pGrantWorkspace(active);
    if (!workspaceId) {
      console.log(
        `[p2p-host-routines] skipped: activeWorkspaceId() resolved to '${active}', which is not a valid p2p ` +
          'workspace partition (resolveP2pGrantWorkspace) — refusing to seed a routine that would only ever refuse.',
      );
      return;
    }
    try {
      const result = await ensureP2pHostRoutinesForWorkspace(workspaceId);
      if (result.skippedReasons.length) {
        console.log(
          `[p2p-host-routines] ${workspaceId}: partial seed (sweep=${result.sweepSeeded} supervision=${result.supervisionSeeded}) — ${result.skippedReasons.join('; ')}`,
        );
      } else {
        console.log(
          `[p2p-host-routines] ${workspaceId}: seeded sweep+supervision for installSlug '${result.installSlug}'.`,
        );
      }
    } catch (err) {
      console.log(
        `[p2p-host-routines] ${workspaceId}: seed failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}
