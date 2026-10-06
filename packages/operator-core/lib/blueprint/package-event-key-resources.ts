/** Bundled event keys as package resources (portable identities P-017, D-042).
 * An identity that vendors an `event` package claims its key through the same
 * D-026 claim a standalone Cupboard event install makes; the resource journal
 * owns dependency/retry state, and this adapter owns only the
 * `event_key_registry` row. It never takes over, edits back or deletes a key
 * another contributor holds or a later claim re-stamped. */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { claimEventKey, getEventKey, normalizeEventKey, type EventKeyRow } from '../event-key-registry-store';
import { packageResourceKey, preparePackageResource,
  type PackageExternalResource, type PackageResourceAddress, type PackageResourceDriver,
  type PackageResourceReceipt } from './package-resource-receipts';

export const EVENT_KEY_RESOURCE_KIND = 'event-key';

/** One bundled event package's curated registry half, read from its release pin. */
export interface BundledEventKey {
  eventRef: string;
  version: string;
  /** The pin's exact SHA-256 hex (no `sha256:` prefix). */
  packageHash: string;
  eventKey: string;
  title: string;
  description: string;
  keyPattern: string | null;
  tags: readonly string[];
}

/** A key arrives from the identity listing that bundles it, never from a publisher's claim (D-026). */
export function bundledEventKeyContributor(blueprintId: string): string {
  return 'cupboard:blueprint:' + blueprintId;
}

/** The operation key the registry row carries in `created_by`, stamped in the claiming transaction. */
export function eventKeyWriteStamp(writeKey: string): string {
  return 'cupboard:install-blueprint#' + writeKey;
}

type CuratedKey = Pick<EventKeyRow, 'eventKey' | 'title' | 'description' | 'keyPattern' | 'contributor'> & { tags: readonly string[] };

function fingerprint(key: CuratedKey): string {
  return createHash('sha256').update(canonicalJson({ eventKey: key.eventKey, title: key.title,
    description: key.description, keyPattern: key.keyPattern ?? null, contributor: key.contributor ?? null,
    tags: [...key.tags].sort() })).digest('hex');
}

/** PURE: the bundled event packages among a release's pins. A pin that does not
 * carry a readable curated key is refused, never guessed at. */
export function bundledEventKeys(pins: readonly { packageKind: string; ref: string; revision: string;
  contentHash: string; value?: unknown }[]): BundledEventKey[] {
  return pins.flatMap((pin) => {
    if (pin.packageKind !== 'event') return [];
    const value = (pin.value ?? {}) as Record<string, unknown>;
    const text = (field: string) => typeof value[field] === 'string' ? value[field] as string : '';
    const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const packageHash = pin.contentHash.replace(/^sha256:/, '');
    if (!text('eventKey') || !text('title') || !text('description') || !/^[a-f0-9]{64}$/.test(packageHash)) {
      throw new Error(`bundled event package ${pin.ref}@${pin.revision} does not carry a readable event key`);
    }
    return [{ eventRef: pin.ref, version: pin.revision, packageHash, eventKey: normalizeEventKey(text('eventKey')),
      title: text('title'), description: text('description'), keyPattern: text('keyPattern') || null, tags }];
  });
}

export function planEventKeyResource(workspaceId: string, blueprintId: string, key: BundledEventKey): {
  address: PackageResourceAddress;
  claim: Parameters<typeof claimEventKey>[1];
  resourceKey: string;
} {
  const contributor = bundledEventKeyContributor(blueprintId);
  const claim = { workspaceId, eventKey: key.eventKey, title: key.title, description: key.description,
    keyPattern: key.keyPattern, contributor, tags: [...key.tags] };
  // The key is workspace-wide: one resource however many pots install the release.
  const address: PackageResourceAddress = {
    workspaceId, memoryScope: workspaceId, packageKind: 'event', packageRef: key.eventRef,
    packageVersion: key.version, packageHash: key.packageHash, resourceKind: EVENT_KEY_RESOURCE_KIND,
    itemKey: key.eventKey, installedHash: fingerprint(claim),
  };
  return { address, claim, resourceKey: packageResourceKey(address) };
}

export function packageEventKeyHeld(address: PackageResourceAddress, holder: string | null): Error {
  return new Error(`event-key-held: event key "${address.itemKey}" is registered by ${holder ?? 'an unattributed contributor'}; ` +
    'an identity may claim a key or refresh its own, never take over another contributor\'s');
}

/** A claim is one PG transaction (upsert + stamp), so the journal's locked
 * intent is its cancellation fence, as for pot bindings. Only a row this exact
 * operation stamped is recovered; a null claim is a release-only driver. */
export function packageEventKeyDriver(
  sql: postgres.Sql,
  address: PackageResourceAddress,
  claim: Parameters<typeof claimEventKey>[1] | null,
): PackageResourceDriver {
  const ref = (row: EventKeyRow): PackageExternalResource => {
    const current = fingerprint(row);
    return { id: address.itemKey, fingerprint: current,
      ...(current === address.installedHash ? {} : { disposition: 'changed' as const }) };
  };
  return {
    async recover(writeKey) {
      const row = await getEventKey(sql, address.workspaceId, address.itemKey);
      return row && row.createdBy === eventKeyWriteStamp(writeKey) ? [ref(row)] : [];
    },
    async create(writeKey) {
      if (!claim) throw new Error(`event key "${address.itemKey}" was released; reinstall the release to claim it again`);
      return sql.begin(async (tx) => {
        const claimed = await claimEventKey(tx, { ...claim, createdBy: eventKeyWriteStamp(writeKey) });
        if (!claimed.claimed) throw packageEventKeyHeld(address, claimed.holder);
        // A refresh of this listing's own earlier claim takes it over: the prior
        // release's cleanup then sees a re-stamped row and leaves it alone.
        await tx`UPDATE harness_shared.event_key_registry SET created_by = ${eventKeyWriteStamp(writeKey)}
          WHERE workspace_id = ${address.workspaceId} AND event_key = ${address.itemKey}
            AND contributor = ${claim.contributor}`;
        return [{ id: address.itemKey, fingerprint: fingerprint(claimed.row) }];
      });
    },
    async cancel() {},
    async removeIfUnchanged(resource) {
      return sql.begin(async (tx) => {
        const [receipt] = await tx<{ write_key: string }[]>`SELECT write_key
          FROM harness_shared.blueprint_package_resources
          WHERE workspace_id = ${address.workspaceId} AND resource_key = ${packageResourceKey(address)}`;
        if (!receipt) throw new Error('event key ownership receipt is missing');
        // Lock the row through deletion so a concurrent claim cannot be erased.
        const [locked] = await tx`SELECT 1 FROM harness_shared.event_key_registry
          WHERE workspace_id = ${address.workspaceId} AND event_key = ${address.itemKey} FOR UPDATE`;
        if (!locked) return 'absent';
        const row = (await getEventKey(tx, address.workspaceId, address.itemKey))!;
        if (fingerprint(row) !== resource.fingerprint || row.createdBy !== eventKeyWriteStamp(receipt.write_key)) return 'changed';
        const removed = await tx`DELETE FROM harness_shared.event_key_registry
          WHERE workspace_id = ${address.workspaceId} AND event_key = ${address.itemKey}
            AND created_by = ${eventKeyWriteStamp(receipt.write_key)}`;
        return removed.count > 0 ? 'removed' : 'changed';
      });
    },
  };
}

export async function prepareEventKeyResource(
  sql: postgres.Sql,
  input: { workspaceId: string; blueprintId: string; key: BundledEventKey; dependentId: string },
): Promise<PackageResourceReceipt> {
  const planned = planEventKeyResource(input.workspaceId, input.blueprintId, input.key);
  const driver = packageEventKeyDriver(sql, planned.address, planned.claim);
  return preparePackageResource(sql, planned.address, input.dependentId, {
    ...driver,
    // Admission refuses a foreign holder below, so a key a later claim of this
    // same listing re-stamped can be claimed afresh once that claim is gone.
    readmitsChanged: true,
    async recover(writeKey) {
      const refs = await driver.recover(writeKey);
      if (refs.length && !refs.some((entry) => entry.disposition === 'changed')) return refs;
      // Refuse a foreign holder at admission; this listing's own row is re-claimed by create.
      const row = await getEventKey(sql, input.workspaceId, planned.address.itemKey);
      if (row && row.contributor !== planned.claim.contributor) throw packageEventKeyHeld(planned.address, row.contributor);
      return [];
    },
  });
}
