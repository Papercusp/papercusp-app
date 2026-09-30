/** Exact doc-part ownership for portable identity package installs
 * (portable-identity-packages P-009 / D-022). A knowledge pack's `docs/` items
 * install as harness_doc_parts rows addressed `package:<resourceKey>`, so only
 * a wearer whose installation holds that exact key is ever delivered one. The
 * resource journal owns dependency/retry state; this adapter owns only the row,
 * and never deletes a part a user edited — it re-owns it instead. */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { packageContentHash, type ResolvedPackageInput } from '@papercusp/orchestrator/blueprint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { KnowledgePack, PackDocItem } from '../knowledge-packs/pack-format';
import { packageResourceKey, preparePackageResource,
  type PackageExternalResource, type PackageResourceAddress, type PackageResourceDriver,
  type PackageResourceReceipt } from './package-resource-receipts';
import { resolveWearerPackageDocKeys } from './package-memory-visibility';

/** The composed guide doc a package part belongs to (addressed parts never project into it). */
export const PACKAGE_DOC_ID = 'claude-md';
export const PACKAGE_DOC_ORIGIN = 'identity-package';
/** Author stamp of an edited part the uninstall preserved: the user now owns it. */
export const PACKAGE_DOC_USER_OWNED = 'user-owned';
/** Package parts render after the guide's own addressed parts. */
const PACKAGE_DOC_ORDINAL_BASE = 100_000;

export interface PackageDocRow {
  harnessSlug: string;
  partKey: string;
  kind: PackDocItem['kind'];
  title: string;
  body: string;
  targetSection: string;
  ordinal: number;
  stackScope: string[];
}

/** The pin's exact pack, refused unless the content hash and manifest identity hold. */
export function knowledgePackFromPin(pin: ResolvedPackageInput): KnowledgePack {
  const { contentHash, ...content } = pin;
  if (pin.packageKind !== 'knowledge-pack' || packageContentHash(content) !== contentHash) {
    throw new Error('package-hash-mismatch: knowledge resource pin is not intact');
  }
  const pack = pin.value as KnowledgePack;
  if (!pack?.manifest || pack.manifest.id !== pin.ref || pack.manifest.version !== pin.revision ||
      !Array.isArray(pack.items) || new Set(pack.items.map((item) => item.id)).size !== pack.items.length ||
      (pack.docs !== undefined && (!Array.isArray(pack.docs) ||
        new Set(pack.docs.map((doc) => doc.id)).size !== pack.docs.length))) {
    throw new Error('knowledge resource requires an exact pack id/version and unique items');
  }
  return pack;
}

/** `pack:<ref>@<version>:<doc-id>` — distinct per exact version, shared across dependents. */
export function packageDocPartKey(packageRef: string, packageVersion: string, docId: string): string {
  return `pack:${packageRef}@${packageVersion}:${docId}`;
}

function docScope(harnessSlug: string): string {
  return `harness-doc:${harnessSlug}/${PACKAGE_DOC_ID}`;
}

/** The fingerprint of every field the package authored, so ANY user edit reads as changed. */
export function packageDocFingerprint(row: {
  kind: string; body: string; target_section: string | null; client_scope: readonly string[];
  stack_scope: readonly string[]; tombstone: boolean;
}): string {
  return createHash('sha256').update(canonicalJson({
    kind: row.kind, body: row.body, section: row.target_section,
    clientScope: [...row.client_scope].sort(), stackScope: [...row.stack_scope].sort(), tombstone: row.tombstone,
  })).digest('hex');
}

/** The body a doc item installs as: its title as the lead line, then the authored body. */
function docBody(doc: PackDocItem): string {
  return `**${doc.title}**\n\n${doc.body}`;
}

/** Pure expected doc-part set for one pin, reused at the atomic activation boundary. */
export function planKnowledgeDocResources(input: {
  pin: ResolvedPackageInput; workspaceId: string; harnessSlug: string;
}): Array<{ address: PackageResourceAddress; resourceKey: string; row: PackageDocRow }> {
  if (!input.workspaceId.trim() || !input.harnessSlug.trim()) throw new Error('doc resource requires a workspace and harness');
  const pack = knowledgePackFromPin(input.pin);
  return (pack.docs ?? []).map((doc, index) => {
    const base = { workspaceId: input.workspaceId, memoryScope: docScope(input.harnessSlug),
      packageKind: input.pin.packageKind, packageRef: input.pin.ref, packageVersion: input.pin.revision,
      packageHash: input.pin.contentHash, resourceKind: 'doc-part', itemKey: doc.id };
    // The key never hashes installedHash, and the row's address token IS the key, so
    // the key is derived first and the fingerprint (which covers stack_scope) after it.
    const resourceKey = packageResourceKey({ ...base, installedHash: '0'.repeat(64) });
    const row: PackageDocRow = { harnessSlug: input.harnessSlug,
      partKey: packageDocPartKey(input.pin.ref, input.pin.revision, doc.id), kind: doc.kind, title: doc.title,
      body: docBody(doc), targetSection: doc.section, ordinal: PACKAGE_DOC_ORDINAL_BASE + index,
      stackScope: [`package:${resourceKey}`] };
    const installedHash = packageDocFingerprint({ kind: row.kind, body: row.body, target_section: row.targetSection,
      client_scope: ['all'], stack_scope: row.stackScope, tombstone: false });
    return { address: { ...base, installedHash }, resourceKey, row };
  });
}

function harnessOf(address: PackageResourceAddress): string {
  const m = /^harness-doc:([^/]+)\//.exec(address.memoryScope);
  if (!m || address.resourceKind !== 'doc-part') throw new Error('doc resource address is malformed');
  return m[1]!;
}

interface DocPartRow {
  part_key: string; kind: string; body: string; target_section: string | null;
  client_scope: string[]; stack_scope: string[]; tombstone: boolean; author: string | null;
}

/** A single harness_doc_parts INSERT is one PG statement, so the journal's
 * locked intent is its cancellation fence; a crash leaves no row or a row
 * recoverable by its author stamp. A null row is a release-only driver:
 * cleanup replays from the durable address alone and can never create one. */
export function packageDocDriver(
  sql: postgres.Sql,
  address: PackageResourceAddress,
  row: PackageDocRow | null,
): PackageResourceDriver {
  const harnessSlug = harnessOf(address);
  const partKey = packageDocPartKey(address.packageRef, address.packageVersion, address.itemKey);
  const key = packageResourceKey(address);
  const read = async (writeKey: string): Promise<PackageExternalResource[]> => {
    const [current] = await sql<DocPartRow[]>`SELECT part_key, kind, body, target_section, client_scope,
        stack_scope, tombstone, author FROM harness_shared.harness_doc_parts
      WHERE workspace_id = ${address.workspaceId} AND harness_slug = ${harnessSlug}
        AND doc_id = ${PACKAGE_DOC_ID} AND part_key = ${partKey}`;
    if (!current) return [];
    const fingerprint = packageDocFingerprint(current);
    return [{ id: current.part_key, fingerprint,
      ...(current.author === `blueprint-package-resource:${writeKey}` ? {} : { owned: false }),
      ...(fingerprint === address.installedHash ? {} : { disposition: 'changed' as const }) }];
  };
  return {
    recover: read,
    async create(writeKey) {
      if (!row) throw new Error('doc release driver cannot create package resources');
      const prior = await read(writeKey);
      if (prior.length) {
        if (prior[0]!.disposition || prior[0]!.owned === false) {
          throw new Error('package-pin-conflict: doc part differs or is not package-owned; explicit review is required');
        }
        return prior;
      }
      await sql`INSERT INTO harness_shared.harness_doc_parts
          (workspace_id, harness_slug, doc_id, part_key, kind, body, ordinal, origin, author,
           client_scope, target_section, stack_scope)
        VALUES (${address.workspaceId}, ${harnessSlug}, ${PACKAGE_DOC_ID}, ${partKey}, ${row.kind}, ${row.body},
          ${row.ordinal}, ${PACKAGE_DOC_ORIGIN}, ${`blueprint-package-resource:${writeKey}`},
          ${['all']}, ${row.targetSection}, ${row.stackScope})
        ON CONFLICT (workspace_id, harness_slug, doc_id, part_key) DO NOTHING`;
      const created = await read(writeKey);
      // A concurrent writer of the same exact part is safe to depend on only when it is ours and pristine.
      if (!created.length || created[0]!.disposition || created[0]!.owned === false) {
        throw new Error('package-pin-conflict: doc part slot is held by a different part; explicit review is required');
      }
      return created;
    },
    async cancel() {},
    async removeIfUnchanged(resource) {
      return sql.begin(async (tx) => {
        const [receipt] = await tx<{ write_key: string }[]>`SELECT write_key
          FROM harness_shared.blueprint_package_resources
          WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key}`;
        if (!receipt) throw new Error('doc package ownership receipt is missing');
        const owner = `blueprint-package-resource:${receipt.write_key}`;
        // Lock the committed row so a concurrent edit cannot land between compare and delete.
        const [current] = await tx<DocPartRow[]>`SELECT part_key, kind, body, target_section, client_scope,
            stack_scope, tombstone, author FROM harness_shared.harness_doc_parts
          WHERE workspace_id = ${address.workspaceId} AND harness_slug = ${harnessSlug}
            AND doc_id = ${PACKAGE_DOC_ID} AND part_key = ${resource.id} FOR UPDATE`;
        if (!current) return 'absent';
        if (packageDocFingerprint(current) === resource.fingerprint && current.author === owner) {
          await tx`DELETE FROM harness_shared.harness_doc_parts
            WHERE workspace_id = ${address.workspaceId} AND harness_slug = ${harnessSlug}
              AND doc_id = ${PACKAGE_DOC_ID} AND part_key = ${resource.id} AND author = ${owner}`;
          return 'removed';
        }
        // Edited: PRESERVE it as the user's. stack_scope stays as it was (its previous
        // visibility) — with no holder of the key it reaches nobody until the user
        // re-addresses it, so it never silently becomes a default-guide part.
        if (current.author === owner) {
          await tx`UPDATE harness_shared.harness_doc_parts
            SET author = ${PACKAGE_DOC_USER_OWNED}, origin = ${`identity-package-detached:${key}`},
                updated_at = (EXTRACT(epoch FROM now()) * 1000)::bigint
            WHERE workspace_id = ${address.workspaceId} AND harness_slug = ${harnessSlug}
              AND doc_id = ${PACKAGE_DOC_ID} AND part_key = ${resource.id} AND author = ${owner}`;
        }
        return 'changed';
      });
    },
  };
}

export interface WearerPackageDocHit {
  partKey: string;
  harnessSlug: string;
  section: string | null;
  title: string;
  excerpt: string;
  score: number;
}

/** docs:search's pack-doc source (D-022): the query's lexemes OR-matched over
 * ONLY the parts addressed to the wearer's applied doc keys. A non-wearer holds
 * no key, so it reads nothing — the same boundary as the transition channel. */
export async function searchWearerPackageDocs(sql: postgres.Sql, input: {
  workspaceId: string; ownerId: string; query: string; limit: number;
}): Promise<WearerPackageDocHit[]> {
  const keys = await resolveWearerPackageDocKeys(sql, input);
  if (!keys.length || !input.query.trim()) return [];
  const rows = await sql<Array<{ part_key: string; harness_slug: string; target_section: string | null; body: string; score: number }>>`
    SELECT p.part_key, p.harness_slug, p.target_section, p.body,
           ts_rank_cd(to_tsvector('english', coalesce(p.target_section, '') || ' ' || p.body), q.q)::float8 AS score
      FROM harness_shared.harness_doc_parts p
      CROSS JOIN LATERAL (SELECT replace(plainto_tsquery('english', ${input.query})::text, '&', '|')::tsquery AS q) q
     WHERE p.workspace_id = ${input.workspaceId} AND p.doc_id = ${PACKAGE_DOC_ID} AND p.tombstone = false
       AND p.stack_scope && ${keys.map((key) => `package:${key}`)}::text[]
       AND to_tsvector('english', coalesce(p.target_section, '') || ' ' || p.body) @@ q.q
     ORDER BY score DESC, p.ordinal, p.part_key
     LIMIT ${Math.max(1, input.limit)}`;
  return rows.map((row) => {
    const lead = /^\*\*(.+?)\*\*\n+/.exec(row.body);
    const text = lead ? row.body.slice(lead[0].length) : row.body;
    return { partKey: row.part_key, harnessSlug: row.harness_slug, section: row.target_section,
      title: lead?.[1] ?? row.part_key, excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 240), score: row.score };
  });
}

export async function prepareKnowledgeDocResources(
  sql: postgres.Sql,
  input: { pin: ResolvedPackageInput; workspaceId: string; harnessSlug: string; dependentId: string },
): Promise<PackageResourceReceipt[]> {
  const receipts: PackageResourceReceipt[] = [];
  // Bounded sequential preparation; every step is journaled, and a failure is
  // compensated for the whole dependent by the lifecycle caller.
  for (const { address, row } of planKnowledgeDocResources(input)) {
    const driver = packageDocDriver(sql, address, row);
    receipts.push(await preparePackageResource(sql, address, input.dependentId, {
      ...driver,
      async recover(writeKey) {
        const refs = await driver.recover(writeKey);
        // Admission refuses an edited part; cleanup still needs its changed disposition.
        if (refs.some((ref) => ref.disposition === 'changed')) {
          throw new Error('package-pin-conflict: installed doc part was edited; explicit review is required');
        }
        return refs;
      },
    }));
  }
  return receipts;
}
