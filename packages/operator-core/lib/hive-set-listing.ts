/**
 * hive-set-listing — the one create/edit/visibility-flip composition for a
 * hive's directory listing (p2p-hive-directory P-004 + hive-from-github-url
 * P-015), shared by the `discovery:set_pot` MCP tool and the
 * `POST /api/discovery/set-pot` HTTP route (the hive header strip's flip).
 *
 *   save meta → private: withdraw (stop re-announce + Cupboard unlist)
 *             → public/invite: full publish set via republishHiveAfterMemberAdd
 *               (announce w/ pubkey + member_repos + links; Cupboard rows for
 *               public — existing rows count as rowsExisted; local bindings)
 */

import { getOwnedHiveMeta, saveOwnedHiveMeta } from './hive-directory-meta';
import type { HiveDirectoryMeta } from './hive-publish';
import { getHiveDirectory } from './hive-directory-deps';
import {
  advanceEpochOnHiveBoundary,
  isHiveRekeyEnabled,
} from './sync/hyperbee/hive-epoch-boundary-wiring';

export interface SetHiveListingInput {
  potId: string;
  title: string;
  description?: string;
  visibility: HiveDirectoryMeta['visibility'];
  memberTopics?: string[];
  memberLinks?: string[];
  inviteSecret?: string;
  createdAt?: number;
}

export interface SetHiveListingResult {
  ok: true;
  potId: string;
  visibility: HiveDirectoryMeta['visibility'];
  saved: true;
  announced: boolean;
  /** Deceptive-publish fix: swarm peers the announce reached (0 = registered but
   *  broadcast into the void — NOT discoverable yet). The UI must distinguish
   *  this from a real broadcast instead of flatly saying "announced". */
  reachablePeers?: number;
  withdrawn?: boolean;
  /** P-005: the signed unlist tombstone reached the wire (false = TTL-only). */
  tombstoneSent?: boolean;
  cupboardUnlist?: Record<string, unknown>;
  publish?: Record<string, unknown>;
  announceError?: string;
}

export async function setHiveListing(
  input: SetHiveListingInput,
  workspaceId: string,
): Promise<SetHiveListingResult> {
  // `saveOwnedHiveMeta` replaces the per-pot entry wholesale. Read the prior
  // listing first so an edit that omits stable/derived fields cannot reset the
  // creation stamp or erase join metadata. Explicit empty arrays still clear
  // their corresponding fields; omission means preserve.
  const previous = await getOwnedHiveMeta(input.potId, workspaceId);
  const inviteSecret = input.inviteSecret ?? (input.visibility === 'invite' ? previous?.inviteSecret : undefined);
  const meta: HiveDirectoryMeta = {
    potId: input.potId,
    title: input.title,
    description: input.description ?? previous?.description ?? '',
    workspaceId, // P-004: the announce-build enricher derives against this
    visibility: input.visibility,
    memberTopics: input.memberTopics ?? previous?.memberTopics ?? [],
    ...(input.memberLinks !== undefined
      ? { memberLinks: input.memberLinks }
      : previous?.memberLinks !== undefined
        ? { memberLinks: previous.memberLinks }
        : {}),
    createdAt: input.createdAt ?? previous?.createdAt ?? Date.now(),
    ...(inviteSecret ? { inviteSecret } : {}),
  };

  // Persist the listing (durable — survives restart, read by the boot-join).
  await saveOwnedHiveMeta(meta, workspaceId);

  // P-015: visibility:private is the WITHDRAWAL flip — stop re-announcing
  // (peers age the listing out via TTL) and unlist the member-repo Cupboard
  // rows. Both best-effort.
  if (meta.visibility === 'private') {
    let unlist: Record<string, unknown> | undefined;
    let tombstoneSent = false;
    try {
      // P-005: ACTIVE withdrawal — broadcast the signed unlist tombstone so
      // peers drop the listing immediately (instead of waiting out the TTL).
      const { withdrawHiveFromDirectory } = await import('./hive-publish');
      const res = await withdrawHiveFromDirectory(getHiveDirectory(), meta.potId);
      tombstoneSent = res.withdrawn;
    } catch {
      /* directory not wired — nothing was announcing */
    }
    try {
      const { unlistHiveCupboardRows } = await import('./cupboard/unlist-hive-rows');
      unlist = (await unlistHiveCupboardRows({
        workspaceId,
        potSlug: meta.potId,
      })) as unknown as Record<string, unknown>;
    } catch (e) {
      unlist = { failed: true, error: e instanceof Error ? e.message : String(e) };
    }
    // P-004 (shared-hive-rekey-2026-06-19): go-private is a READ boundary too. Advance the
    // hive epoch + re-key to ALL current members (no cutOff — every admitted member keeps
    // access) so a peer that grabbed the PUBLIC link but never became a member can't decrypt
    // post-private content. The content topic is immutable (E-001 first half), so the cut is
    // at the CRYPTO layer, not the topic. Flag-gated (papercusp-hive-rekey); best-effort —
    // the directory withdrawal already landed. OFF ⇒ no-op (today's directory-only withdraw).
    try {
      await advanceEpochOnHiveBoundary({
        workspaceId,
        potHomeSlug: meta.potId,
        enabled: await isHiveRekeyEnabled(),
      });
    } catch {
      /* re-key best-effort — the directory withdrawal already succeeded */
    }
    return {
      ok: true,
      potId: meta.potId,
      visibility: 'private',
      saved: true,
      announced: false,
      withdrawn: true,
      /** P-005: whether the signed unlist tombstone went out on the wire
       *  (false = passive TTL withdrawal only — e.g. keychain not wired). */
      tombstoneSent,
      ...(unlist ? { cupboardUnlist: unlist } : {}),
    };
  }

  // public/invite: the FULL publish set (P-007/P-015) rides
  // republishHiveAfterMemberAdd — pubkey + member_repos enrichment, the
  // directory announce, per-member-repo Cupboard rows (public; existing rows
  // count as rowsExisted) + local binding rows. Lazily wire the transport
  // first (a box that gh-authed after boot).
  let announced = false;
  let reachablePeers = 0;
  let publishOutcome: Record<string, unknown> | undefined;
  let announceError: string | undefined;
  try {
    const { ensureHiveDirectoryWired } = await import('./hive-directory-boot');
    await ensureHiveDirectoryWired(workspaceId).catch(() => null);
    const { republishHiveAfterMemberAdd } = await import('./hive-publish-from-repo');
    const res = await republishHiveAfterMemberAdd({ workspaceId, potSlug: meta.potId });
    if ('skipped' in res) {
      announceError = `publish skipped: ${res.skipped}`;
    } else {
      announced = res.announced;
      reachablePeers = res.reachablePeers; // deceptive-publish: real swarm reach
      publishOutcome = res as unknown as Record<string, unknown>;
    }
  } catch (e) {
    announceError = e instanceof Error ? e.message : String(e);
  }

  return {
    ok: true,
    potId: meta.potId,
    visibility: meta.visibility,
    saved: true,
    announced,
    reachablePeers,
    ...(publishOutcome ? { publish: publishOutcome } : {}),
    ...(announceError ? { announceError } : {}),
  };
}
