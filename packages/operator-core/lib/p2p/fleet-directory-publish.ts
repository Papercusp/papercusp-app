/**
 * p2p/fleet-directory-publish.ts — the fleet-directory PUBLISH leg (WI-2006,
 * p2p-work-distribution P-101 wiring; agent-allocation-framework P-007/D-005
 * rides on it).
 *
 * P-101 landed the STORE (fleet-directory.ts putFleetRecord), the SCHEMA
 * (fleet-directory-schema.ts) and the member-side PROJECTION
 * (sync/hyperbee/projections/fleet-directory.ts) — but nothing ever AUTHORED a
 * record, so no fleet had a directory card and nothing rode the hive peer-log
 * cross-node. This module is the missing author: it composes the owner-signed
 * record for one LOCAL fleet and puts it through putFleetRecord, from which the
 * mig-476 stamp trigger + hive peer-log federate it and remote projections
 * verify-then-apply.
 *
 * Called (best-effort, never load-bearing) from the agent-fleets-store
 * lifecycle: create/ensure, leader-change, meta-edit, delete(→archived:true).
 * Deliberately fail-soft — a fleet must create/update fine on a box with no
 * shared hive, no gh identity, or a locked keychain:
 *   • no EXACTLY-ONE shared hive  → skipped (the D-005 federation surface is
 *     the shared hive; zero/many = nothing to publish onto / ambiguous);
 *   • no resolvable gh identity   → skipped (the record's owner is the X9
 *     numeric id; guessing one would forge ownership);
 *   • record already up to date   → ok, no version churn (createFleetIfAbsent
 *     runs on EVERY fleet:launch-on-plan — an unconditional bump would spin
 *     record_version and re-federate a byte-identical card each launch).
 *
 * Ownership note (tier-1): the record's owner is THIS MACHINE's github user
 * (resolveUsageActor) — the only identity whose device key we hold, and
 * putFleetRecord's D-006 gate refuses anything else. A fleet row whose coord
 * `owner` is a session of a different gh user cannot be authored here.
 */

import type { Sql } from 'postgres';
import { getFleet } from '../agent-fleets-store';
import { resolveWorkspaceHiveScope } from '../agent-tools/coordination/federation-scope';
import { resolveUsageActor } from '../harness/usage-actor';
import { resolveDeviceKeychainId } from '../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';
import { signWithDeviceKey } from '../identity/sign-with-device-key';
import {
  getFleetRecord,
  putFleetRecord,
  type FleetRecordSigner,
  type StoredFleetRecord,
} from './fleet-directory';
import {
  DEFAULT_FLEET_BILLING,
  type FleetDirectoryRecord,
} from './fleet-directory-schema';

export type FleetDirectoryPublishOutcome =
  /** Published (or already current — `changed:false`). */
  | { ok: true; stored: StoredFleetRecord; changed: boolean }
  /** Benign non-publish (no shared hive / no identity / no fleet row). */
  | { ok: false; skipped: string }
  /** A real authoring failure (putFleetRecord refusal, keychain fault). */
  | { ok: false; error: string };

/** DI seams (usage-actor discipline) so unit tests run without PG/keychain/gh. */
export interface PublishFleetDirectoryDeps {
  resolveScope?: typeof resolveWorkspaceHiveScope;
  resolveActor?: typeof resolveUsageActor;
  getFleetRow?: typeof getFleet;
  getRecord?: typeof getFleetRecord;
  putRecord?: typeof putFleetRecord;
  buildSigner?: (githubUserId: number) => Promise<FleetRecordSigner>;
  /** Where the best-effort wrapper reports its outcome. */
  log?: (msg: string) => void;
}

async function defaultBuildSigner(githubUserId: number): Promise<FleetRecordSigner> {
  const keychainId = resolveDeviceKeychainId(githubUserId);
  const keypair = await loadOrGenerateDeviceKeypair(keychainId);
  return {
    pubkey: keypair.pubkeyBase64,
    sign: (bytes: Buffer) => signWithDeviceKey(keychainId, bytes),
  };
}

export interface PublishFleetDirectoryOpts {
  workspaceId: string;
  fleetSlug: string;
  /** Publish the record archived (the deleteFleet lifecycle leg). The fleet row
   *  may already be gone — meta is carried from the existing record. */
  archived?: boolean;
  sql?: Sql;
}

/**
 * Publish/refresh THIS machine owner's directory record for one local fleet.
 * Composes: existing-record carry (publisher set + knobs are owner-authored
 * state the fleet row knows nothing about) ⊕ fleet-row meta (title/description)
 * ⊕ the requested archived flag; bumps record_version only when bytes change.
 */
export async function publishFleetDirectoryRecord(
  opts: PublishFleetDirectoryOpts,
  deps: PublishFleetDirectoryDeps = {},
): Promise<FleetDirectoryPublishOutcome> {
  const resolveScope = deps.resolveScope ?? resolveWorkspaceHiveScope;
  const resolveActor = deps.resolveActor ?? resolveUsageActor;
  const getFleetRow = deps.getFleetRow ?? getFleet;
  const getRecord = deps.getRecord ?? getFleetRecord;
  const putRecord = deps.putRecord ?? putFleetRecord;
  const buildSigner = deps.buildSigner ?? defaultBuildSigner;

  const scope = await resolveScope(opts.workspaceId);
  if (scope.kind !== 'one') {
    return { ok: false, skipped: `no_single_shared_hive:${scope.kind}` };
  }
  const actor = await resolveActor();
  if (!actor) return { ok: false, skipped: 'no_github_identity' };

  const fleet = await getFleetRow(opts.workspaceId, opts.fleetSlug, opts.sql);
  const existing = await getRecord(
    opts.workspaceId,
    scope.homeSlug,
    actor.githubUserId,
    opts.fleetSlug,
    opts.sql,
  );
  if (!fleet && !opts.archived) {
    // Nothing to describe and not an archive — e.g. a publish raced a delete.
    return { ok: false, skipped: 'fleet_not_found' };
  }
  if (!fleet && opts.archived && !existing) {
    // Deleted a fleet that never had a card — nothing to archive.
    return { ok: false, skipped: 'no_record_to_archive' };
  }

  const carried = existing?.record ?? null;
  const record: FleetDirectoryRecord = {
    fleetSlug: opts.fleetSlug,
    ownerGithubUserId: actor.githubUserId,
    title: fleet?.title?.trim() || carried?.title || opts.fleetSlug,
    description: fleet?.description ?? carried?.description ?? '',
    tags: carried?.tags ?? [],
    publisherGithubUserIds: carried?.publisherGithubUserIds ?? [],
    billingDefault: carried?.billingDefault ?? DEFAULT_FLEET_BILLING,
    successorGithubUserId: carried?.successorGithubUserId ?? null,
    offerRateCapPerHour: carried?.offerRateCapPerHour ?? null,
    unclaimedOfferTtlSec: carried?.unclaimedOfferTtlSec ?? null,
    recordVersion: (existing?.recordVersion ?? 0) + 1,
    archived: opts.archived ?? carried?.archived ?? false,
  };

  // No-churn gate: identical card (all signed fields except the version bump)
  // ⇒ keep the stored row. Every fleet launch runs createFleetIfAbsent, and a
  // version bump per launch would re-federate an unchanged record forever.
  if (existing?.record) {
    const prev = { ...existing.record, recordVersion: record.recordVersion };
    if (JSON.stringify(prev) === JSON.stringify(record)) {
      return { ok: true, stored: existing, changed: false };
    }
  }

  let signer: FleetRecordSigner;
  try {
    signer = await buildSigner(actor.githubUserId);
  } catch (e) {
    return { ok: false, error: `device signer unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const res = await putRecord({
    workspaceId: opts.workspaceId,
    potHomeSlug: scope.homeSlug,
    selfGithubUserId: actor.githubUserId,
    record,
    signer,
    sql: opts.sql,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, stored: res.stored, changed: true };
}

/** One-line, greppable report of a directory publish outcome. The lifecycle
 * caller is fire-and-forget, so a skip or error must remain observable even
 * though it is deliberately not load-bearing. */
export function describeFleetDirectoryOutcome(
  opts: Pick<PublishFleetDirectoryOpts, 'fleetSlug' | 'archived'>,
  outcome: FleetDirectoryPublishOutcome,
): { level: 'info' | 'warn'; msg: string } {
  const what = `fleet:${opts.fleetSlug}${opts.archived ? ' (archive)' : ''}`;
  if (outcome.ok) {
    return {
      level: 'info',
      msg: `${what} → ${outcome.changed ? 'published' : 'already current (no version churn)'}`,
    };
  }
  if ('skipped' in outcome) {
    return { level: 'warn', msg: `${what} → NOT PUBLISHED (skipped: ${outcome.skipped})` };
  }
  return { level: 'warn', msg: `${what} → NOT PUBLISHED (error: ${outcome.error})` };
}

/**
 * The fire-and-forget wrapper the agent-fleets-store lifecycle calls: never
 * throws, never blocks the fleet write it rides on. Kept here (not inline in
 * the store) so the store stays PG-pure and the swallow is one audited place.
 */
export function publishFleetDirectoryRecordBestEffort(
  opts: PublishFleetDirectoryOpts,
  deps: PublishFleetDirectoryDeps = {},
): void {
  const log = deps.log ?? ((m: string) => console.warn(`[fleet-directory-publish] ${m}`));
  void publishFleetDirectoryRecord(opts, deps)
    .then((outcome) => {
      const { msg } = describeFleetDirectoryOutcome(opts, outcome);
      log(msg);
    })
    .catch((e: unknown) => {
      log(`fleet:${opts.fleetSlug} → publish THREW: ${String(e)}`);
    });
}
